/**
 * Lua scope-capture emitter (RFC #909 Ring 3).
 *
 * Minimal grouping: parse (or reuse the worker's cached AST) → run the scope
 * query → group each match's captures into a CaptureMatch keyed by `@name`.
 * No Ruby-style decomposition, no YARD, and no static type inference. Lua
 * require imports are collected structurally so positional local/RHS pairing
 * remains correct for multi-assignment and parenthesis-free forms. Lua
 * callable-value-flow facts are synthesized
 * through the shared provider contract below.
 *
 * Side effect: also runs the heritage + method-owner queries against the same
 * AST and stashes the pairs into the capture-side-channel map, so the main-
 * thread `emitLuaHeritageEdges` hook can emit EXTENDS + HAS_METHOD edges
 * WITHOUT re-reading or re-parsing the file (#1983 no-main-thread-re-parse).
 *
 * The central ScopeExtractor partitions the capture output by prefix
 * (@scope.* / @declaration.* / @import.* / @reference.*) and builds the scope
 * tree, declarations, imports, and reference sites that finalize turns into
 * CALLS + IMPORTS edges.
 */
import Parser from 'tree-sitter';
import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { nodeToCapture, syntheticCapture } from '../../utils/ast-helpers.js';
import { getLuaParser, getLuaScopeQuery, getHeritageQuery, getMethodOwnerQuery } from './query.js';
import {
  setLuaHeritageFacts,
  clearLuaHeritageFactsForFile,
  type LuaExtendsPair,
  type LuaMethodOwnerPair,
  type LuaReturnedField,
} from './capture-side-channel.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';
import { synthesizeCallableFlowCaptures } from '../../utils/callable-flow-captures.js';
import {
  collectLuaPathFacts,
  isLuaRequireCall,
  isNestedInLuaFunction,
  simpleVariableName,
  type LuaLexicalFacts,
} from './path-env.js';

const LUA_CALLABLE_CAPTURE_OPTIONS = {
  functionNodeTypes: new Set([
    'function_definition_statement',
    'local_function_definition_statement',
    'function_definition',
  ]),
  callNodeTypes: new Set(['call']),
  parameterListNodeTypes: new Set(['parameter_list', 'argument_list']),
  parameterNodeTypes: new Set(['identifier', 'vararg_expression']),
  bindingNodeTypes: new Set(['local_variable_declaration']),
  assignmentNodeTypes: new Set(['variable_assignment']),
  identifierNodeTypes: new Set(['identifier']),
  functionScopedValueBindings: true,
  extractAssignment: (node: Parser.SyntaxNode) => {
    if (node.type !== 'local_variable_declaration' && node.type !== 'variable_assignment') {
      return undefined;
    }
    const destinations =
      node.namedChildren.find((child) => child.type === 'variable_list')?.namedChildren ?? [];
    const sources =
      node.namedChildren.find((child) => child.type === 'expression_list')?.namedChildren ?? [];
    if (destinations.length === 0 || sources.length === 0) return [];
    return destinations.slice(0, sources.length).flatMap((destination, index) => {
      const source = sources[index];
      const simpleDestination =
        destination.type === 'variable' &&
        destination.childForFieldName('name')?.type === 'identifier' &&
        destination.childForFieldName('table') === null &&
        destination.childForFieldName('field') === null;
      const simpleSource =
        source?.type === 'variable' &&
        source.childForFieldName('name')?.type === 'identifier' &&
        source.childForFieldName('table') === null &&
        source.childForFieldName('field') === null;
      return simpleDestination && simpleSource && source !== undefined
        ? [{ destination, source }]
        : [];
    });
  },
} as const;

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, '');
}

function requireStringNode(call: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  const args = call.childForFieldName('arguments');
  if (args === null) return undefined;
  const first = args.namedChildren[0];
  if (first?.type === 'string') return first;
  if (first?.type === 'expression_list' && first.namedChildren[0]?.type === 'string') {
    return first.namedChildren[0];
  }
  return undefined;
}

function importCapture(
  statement: Parser.SyntaxNode,
  source: Parser.SyntaxNode,
  localName?: Parser.SyntaxNode,
): CaptureMatch {
  const match: Record<string, Capture> = {
    '@import.statement': nodeToCapture('@import.statement', statement),
    '@import.source': nodeToCapture('@import.source', source),
  };
  if (localName !== undefined) {
    match['@import.localName'] = nodeToCapture('@import.localName', localName);
  }
  return match;
}

function collectLuaImportCaptures(root: Parser.SyntaxNode): readonly CaptureMatch[] {
  const out: CaptureMatch[] = [];

  const visit = (node: Parser.SyntaxNode, suppressed: ReadonlySet<Parser.SyntaxNode>): void => {
    if (node.type === 'local_variable_declaration') {
      const variables =
        node.namedChildren.find((child) => child.type === 'variable_list')?.namedChildren ?? [];
      const expressions =
        node.namedChildren.find((child) => child.type === 'expression_list')?.namedChildren ?? [];
      const names = variables
        .map((variable) => variable.childForFieldName('name'))
        .filter((name): name is Parser.SyntaxNode => name?.type === 'identifier');

      // Pair by source position. Never reuse an RHS for multiple LHS names.
      for (let i = 0; i < Math.min(names.length, expressions.length); i++) {
        const expression = expressions[i];
        if (!isLuaRequireCall(expression)) continue;
        const source = requireStringNode(expression);
        if (source !== undefined) out.push(importCapture(node, source, names[i]));
      }

      // Keep walking all initializer descendants. Direct require calls are
      // suppressed because they already have their positional local binding;
      // nested calls (function bodies, wrappers, and other expressions) still
      // need their own IMPORTS edge.
      const directRequires = new Set<Parser.SyntaxNode>();
      for (const expression of expressions) {
        if (isLuaRequireCall(expression) && requireStringNode(expression) !== undefined) {
          directRequires.add(expression);
        }
      }
      for (const child of node.namedChildren) visit(child, directRequires);
      return;
    }

    if (isLuaRequireCall(node)) {
      if (suppressed.has(node)) {
        for (const child of node.namedChildren) visit(child, suppressed);
        return;
      }
      const source = requireStringNode(node);
      if (source !== undefined) {
        out.push(importCapture(node, source));
        return;
      }
    }

    for (const child of node.namedChildren) visit(child, suppressed);
  };

  visit(root, new Set());
  return out;
}

/**
 * Capture callable local bindings by source/destination position.
 *
 * A tree-sitter query that independently matches `variable_list` and a
 * function-valued `expression_list` cross-pairs Lua multi-assignment:
 * `local value, callback = 1, function() end` must name only `callback` as a
 * closure. Keep the positional pairing in the same structural walk used by
 * import capture collection.
 *
 * A closure declaration is anchored on the `function_definition` VALUE node —
 * the node that is also its `@scope.function` — so the def is owned by its own
 * body scope (calls inside it are attributed to it, not to the enclosing
 * scope) and lines up with the `LUA_QUERIES` graph node on the same node.
 * A local closure is file-private: `@declaration.is-exported` is `false`.
 */
function collectLuaCallableBindingCaptures(root: Parser.SyntaxNode): readonly CaptureMatch[] {
  const out: CaptureMatch[] = [];
  const visit = (node: Parser.SyntaxNode): void => {
    if (node.type === 'local_variable_declaration') {
      const variables =
        node.namedChildren.find((child) => child.type === 'variable_list')?.namedChildren ?? [];
      const sources =
        node.namedChildren.find((child) => child.type === 'expression_list')?.namedChildren ?? [];
      const count = Math.min(variables.length, sources.length);
      for (let index = 0; index < count; index++) {
        const destination = variables[index];
        const source = sources[index];
        const name = simpleVariableName(destination);
        if (destination?.type !== 'variable' || name === undefined || source === undefined) {
          continue;
        }
        if (source.type === 'function_definition') {
          const match: Record<string, Capture> = {
            '@declaration.function': nodeToCapture('@declaration.function', source),
            '@declaration.name': nodeToCapture('@declaration.name', name),
            '@declaration.is-exported': syntheticCapture('@declaration.is-exported', name, 'false'),
          };
          addLuaArityCaptures(match, source);
          out.push(match);
        } else if (source.type === 'variable') {
          out.push({
            '@declaration.variable': nodeToCapture('@declaration.variable', node),
            '@declaration.name': nodeToCapture('@declaration.name', name),
          });
        }
      }
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return out;
}

function collectLuaReturnedNames(root: Parser.SyntaxNode): readonly string[] {
  const returnedNames: string[] = [];
  for (const node of root.namedChildren) {
    if (node.type !== 'return_statement') continue;
    const expressionList = node.namedChildren.find((child) => child.type === 'expression_list');
    const first = expressionList?.namedChildren[0];
    const name = first?.childForFieldName('name');
    if (name?.type === 'identifier') returnedNames.push(name.text);
  }
  return returnedNames;
}

function collectLuaReturnedFields(root: Parser.SyntaxNode): readonly LuaReturnedField[] {
  const returnedFields: LuaReturnedField[] = [];
  for (const node of root.namedChildren) {
    if (node.type !== 'return_statement') continue;
    const expressionList = node.namedChildren.find((child) => child.type === 'expression_list');
    const table = expressionList?.namedChildren[0];
    if (table?.type !== 'table') continue;
    const fields = table.namedChildren.find((child) => child.type === 'field_list');
    for (const field of fields?.namedChildren ?? []) {
      if (field.type !== 'field') continue;
      const key = field.childForFieldName('key');
      const value = field.childForFieldName('value');
      if ((key?.type !== 'identifier' && key?.type !== 'string') || value?.type !== 'variable')
        continue;
      const localName = value.childForFieldName('name');
      if (localName?.type !== 'identifier') continue;
      returnedFields.push({
        exportName: stripQuotes(key.text),
        localName: localName.text,
      });
    }
  }
  return returnedFields;
}

/**
 * Module-level `X = function … end` and `T.f = function … end` (also
 * `T["f"] = …`), paired by position so a multi-assignment never cross-pairs.
 * Nested assignments (inside a function body) are skipped: they only exist
 * once that function runs.
 *
 * - Table member (`T.f`): a `Method` whose qualified and binding names are the
 *   written dotted path, so a bare `f()` never binds to it (see
 *   `markLuaTableMember`).
 * - Plain name (`X`): a `Function`. It is file-private when `X` resolves to a
 *   lexical local (the forward-declared `local X` … `X = function` idiom) and
 *   a Lua global otherwise.
 *
 * Both anchor on the value `function_definition`, which the scope query also
 * captures as `@scope.function`.
 */
function collectLuaAssignedFunctionCaptures(
  root: Parser.SyntaxNode,
  lexical: LuaLexicalFacts,
): readonly CaptureMatch[] {
  const out: CaptureMatch[] = [];
  const visit = (node: Parser.SyntaxNode): void => {
    if (node.type === 'variable_assignment' && !isNestedInLuaFunction(node)) {
      const variables =
        node.namedChildren.find((child) => child.type === 'variable_list')?.namedChildren ?? [];
      const values =
        node.namedChildren.find((child) => child.type === 'expression_list')?.namedChildren ?? [];
      for (let index = 0; index < Math.min(variables.length, values.length); index++) {
        const variable = variables[index];
        const value = values[index];
        if (variable?.type !== 'variable' || value?.type !== 'function_definition') continue;
        const plainName = simpleVariableName(variable);
        if (plainName !== undefined) {
          const match: Record<string, Capture> = {
            '@declaration.function': nodeToCapture('@declaration.function', value),
            '@declaration.name': nodeToCapture('@declaration.name', plainName),
            '@declaration.is-exported': syntheticCapture(
              '@declaration.is-exported',
              plainName,
              String(!lexical.localIdentifierStarts.has(plainName.startIndex)),
            ),
          };
          addLuaArityCaptures(match, value);
          out.push(match);
          continue;
        }
        const owner = variable.childForFieldName('table');
        const method = variable.childForFieldName('field');
        if (owner === null || (method?.type !== 'identifier' && method?.type !== 'string')) {
          continue;
        }
        const methodName = method.type === 'string' ? stripQuotes(method.text) : method.text;
        const match: Record<string, Capture> = {
          '@declaration.method': nodeToCapture('@declaration.method', value),
          '@declaration.name': { ...nodeToCapture('@declaration.name', method), text: methodName },
        };
        markLuaTableMember(match, method, owner, methodName);
        addLuaArityCaptures(match, value);
        out.push(match);
      }
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return out;
}

/**
 * A table member (`function T.f`, `function T:m`, `T.f = function`) is reached
 * only through its table, never by the bare name `f`: qualify the def with the
 * written owner path (`T.f`), bind it lexically under that dotted name (no
 * identifier can spell it), and mark it unexported by bare name. The
 * resolver's `mergeBindings` keeps dotted defs out of the finalize bucket and
 * `isFileLocalDef` keeps them out of the workspace name guess.
 */
function markLuaTableMember(
  match: Record<string, Capture>,
  nameNode: Parser.SyntaxNode,
  owner: Parser.SyntaxNode,
  memberName: string,
): void {
  const dotted = `${owner.text.replace(/\s+/g, '')}.${memberName}`;
  match['@declaration.qualified_name'] = syntheticCapture(
    '@declaration.qualified_name',
    nameNode,
    dotted,
  );
  match['@declaration.binding-name'] = syntheticCapture('@declaration.binding-name', nameNode, dotted);
  match['@declaration.is-exported'] = syntheticCapture('@declaration.is-exported', nameNode, 'false');
}

function addLuaArityCaptures(
  match: Record<string, Capture>,
  functionNode: Parser.SyntaxNode,
): void {
  const parameters = functionNode.childForFieldName('parameters');
  if (
    parameters === null ||
    !LUA_CALLABLE_CAPTURE_OPTIONS.parameterListNodeTypes.has(parameters.type)
  )
    return;
  const hasVararg = parameters.namedChildren.some((child) => child.type === 'vararg_expression');
  const fixedCount = parameters.namedChildren.filter(
    (child) => child.type !== 'vararg_expression',
  ).length;
  match['@declaration.parameter-count'] = {
    ...nodeToCapture('@declaration.parameter-count', parameters),
    text: hasVararg ? '' : String(fixedCount),
  };
  match['@declaration.required-parameter-count'] = {
    ...nodeToCapture('@declaration.required-parameter-count', parameters),
    text: String(fixedCount),
  };
  match['@declaration.parameter-types'] = {
    ...nodeToCapture('@declaration.parameter-types', parameters),
    text: JSON.stringify(hasVararg ? ['params'] : []),
  };
}

export function emitLuaScopeCaptures(
  sourceText: string,
  filePath: string,
  cachedTree?: unknown,
): readonly CaptureMatch[] {
  let tree: Parser.Tree;
  if (cachedTree !== undefined && cachedTree !== null) {
    tree = cachedTree as Parser.Tree;
  } else {
    tree = parseSourceSafe(getLuaParser(), sourceText, undefined, {
      bufferSize: getTreeSitterBufferSize(sourceText),
    });
  }

  const facts = collectLuaPathFacts(tree.rootNode);
  const out: CaptureMatch[] = [];
  for (const match of getLuaScopeQuery().matches(tree.rootNode)) {
    const grouped: Record<string, Capture> = {};
    for (const c of match.captures) {
      const tag = '@' + c.name;
      // Skip tree-sitter predicate captures (e.g. @_req used by #eq?).
      if (tag.startsWith('@_')) continue;
      if (grouped[tag] === undefined) grouped[tag] = nodeToCapture(tag, c.node);
    }
    if (Object.keys(grouped).length === 0) continue;
    // middleclass `class("Name", ...)`: strip surrounding quotes from the name
    // so the Class node is named `BattleSkill`, not `"BattleSkill"`. tree-sitter-lua's
    // string node has no content child, so .text carries the quotes.
    const nameCap = grouped['@declaration.name'];
    if (grouped['@declaration.class'] !== undefined && nameCap !== undefined) {
      const stripped = nameCap.text.replace(/^["']|["']$/g, '');
      if (stripped !== nameCap.text) {
        grouped['@declaration.name'] = { ...nameCap, text: stripped };
      }
    }
    // The path the callee names (`MyMod.Client.Tx.create`, a local alias's
    // target, …) rides on the site as its qualified name; the resolver maps it
    // through the workspace path index (see `path-env.ts` for the encoding).
    const callNode = match.captures.find((capture) =>
      capture.name.startsWith('reference.call.'),
    )?.node;
    const callKey =
      callNode === undefined
        ? undefined
        : facts.callKeys.get(`${callNode.startIndex}:${callNode.endIndex}`);
    if (callNode !== undefined && callKey !== undefined) {
      grouped['@reference.qualified-name'] = syntheticCapture(
        '@reference.qualified-name',
        callNode.childForFieldName('function') ?? callNode,
        callKey,
      );
    }
    const declarationNode = match.captures.find(
      (capture) => capture.name === 'declaration.function' || capture.name === 'declaration.method',
    )?.node;
    const declarationName = match.captures.find(
      (capture) => capture.name === 'declaration.name',
    )?.node;
    if (declarationNode !== undefined) addLuaArityCaptures(grouped, declarationNode);
    if (declarationNode !== undefined && declarationName !== undefined) {
      const owner = declarationNode.childForFieldName('name')?.childForFieldName('table');
      if (grouped['@declaration.method'] !== undefined && owner != null) {
        markLuaTableMember(grouped, declarationName, owner, declarationName.text);
      } else {
        // `local function f` writes a local; `function f()` writes whatever
        // `f` resolves to at that point — a forward-declared local or a global.
        const exported =
          declarationNode.type === 'function_definition_statement' &&
          !facts.localIdentifierStarts.has(declarationName.startIndex);
        grouped['@declaration.is-exported'] = syntheticCapture(
          '@declaration.is-exported',
          declarationName,
          String(exported),
        );
      }
    }
    out.push(grouped);
  }

  out.push(...collectLuaCallableBindingCaptures(tree.rootNode));

  // Imports are collected structurally instead of through the generic query:
  // the AST lists preserve positional local/RHS pairing and support all Lua
  // string-call forms without producing a cross-product of captures.
  out.push(...collectLuaImportCaptures(tree.rootNode));
  out.push(...collectLuaAssignedFunctionCaptures(tree.rootNode, facts));
  // Method-call class factories (`X = ISPanel:derive("X")`, `Base:extend()`,
  // `Base:subclass("X")`): the bound name is the class, as for middleclass.
  for (const { statement, name, isLocal } of facts.factoryClasses) {
    out.push({
      '@declaration.class': nodeToCapture('@declaration.class', statement),
      '@declaration.name': nodeToCapture('@declaration.name', name),
      '@declaration.is-exported': syntheticCapture('@declaration.is-exported', name, String(!isLocal)),
    });
  }
  // `self` inside `function X:m()` is an `X` (anchored on the body so the
  // binding lives in the method's own scope, not the enclosing one).
  for (const [body, className] of facts.selfTypes) {
    out.push({
      '@type-binding.self': syntheticCapture('@type-binding.self', body, 'self'),
      '@type-binding.name': syntheticCapture('@type-binding.name', body, 'self'),
      '@type-binding.type': syntheticCapture('@type-binding.type', body, className),
    });
  }
  out.push(...synthesizeCallableFlowCaptures(tree.rootNode, LUA_CALLABLE_CAPTURE_OPTIONS));

  // Heritage pairs (middleclass EXTENDS + HAS_METHOD) — collected here in the
  // worker where the AST is live, snapshotted onto ParsedFile.captureSideChannel
  // by `collectLuaCaptureSideChannel`, consumed by `emitLuaHeritageEdges`.
  const extendsPairs: LuaExtendsPair[] = [];
  for (const m of getHeritageQuery().matches(tree.rootNode)) {
    const caps: Record<string, Parser.SyntaxNode> = {};
    for (const c of m.captures) caps[c.name] = c.node;
    const child = stripQuotes(caps['child.name']?.text ?? '');
    const parent =
      caps['parent.name']?.text ??
      (caps['parent.module'] !== undefined && caps['parent.field'] !== undefined
        ? `${caps['parent.module'].text}.${caps['parent.field'].text}`
        : undefined);
    if (child.length > 0 && parent !== undefined) {
      extendsPairs.push({ child, parent });
    }
  }
  for (const { name, parentText, parentKeys } of facts.factoryClasses) {
    if (parentText.length > 0) extendsPairs.push({ child: name.text, parent: parentText, parentKeys });
  }
  const methodOwners: LuaMethodOwnerPair[] = [];
  for (const m of getMethodOwnerQuery().matches(tree.rootNode)) {
    const caps: Record<string, Parser.SyntaxNode> = {};
    for (const c of m.captures) caps[c.name] = c.node;
    const owner = caps['method.owner']?.text;
    const method = caps['method.name']?.text;
    const defNode = caps['method.def'];
    if (owner === undefined || method === undefined || defNode === undefined) continue;
    if (isNestedInLuaFunction(defNode)) continue;
    methodOwners.push({
      owner,
      method: stripQuotes(method),
      defRow: defNode.startPosition.row,
      defEndRow: defNode.endPosition.row,
    });
  }
  const classNames = new Set(
    out
      .filter((match) => match['@declaration.class'] !== undefined)
      .map((match) => match['@declaration.name']?.text)
      .filter((name): name is string => name !== undefined),
  );
  const returnedNames = collectLuaReturnedNames(tree.rootNode).filter((name) =>
    classNames.has(name),
  );
  const returnedFields = collectLuaReturnedFields(tree.rootNode);
  const { localOnlyCallees, defKeys, classKeys, returnKeys } = facts;
  const returnFieldKeys = facts.returnFields;
  if (
    extendsPairs.length > 0 ||
    methodOwners.length > 0 ||
    returnedNames.length > 0 ||
    returnedFields.length > 0 ||
    localOnlyCallees.length > 0 ||
    defKeys.length > 0 ||
    classKeys.length > 0 ||
    returnKeys.length > 0 ||
    Object.keys(returnFieldKeys).length > 0
  ) {
    setLuaHeritageFacts(filePath, {
      kind: 'lua',
      extendsPairs,
      methodOwners,
      returnedNames,
      returnedFields,
      localOnlyCallees,
      defKeys,
      classKeys,
      returnKeys,
      returnFieldKeys,
    });
  } else {
    // Re-capture produced no heritage — drop any prior facts for this file so
    // reanalysis of a file that lost its middleclass class does not emit stale
    // EXTENDS / HAS_METHOD edges from the previous pass.
    clearLuaHeritageFactsForFile(filePath);
  }

  return out;
}
