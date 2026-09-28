/**
 * JVM internal-name strings → the in-repo classes and methods they name.
 *
 * Bytecode tooling (ASM transformers, agents, `MethodHandles` plumbing) names
 * classes by their JVM internal name — `"com/example/Outer$Inner"` — and
 * methods by a name literal written next to it:
 *
 *     private static final String HOOKS = "com/example/Hooks";
 *     new HeadCall("com/example/Watchdog", "tick", "()V");
 *     insn.owner.equals(HOOKS)
 *
 * None of these is a Java reference, so without this pass the named class
 * has no incoming edge at all and `impact()` reports it unused.
 *
 * Worker side ({@link captureJavaJvmNameFacts}) reads the syntax tree once and
 * records plain data: every string literal shaped like an internal name, and
 * every argument list that pairs a class name (a literal, an effectively-final
 * local `String` initialised by one, or a same-file `static final String`
 * constant) with a method-name literal. Resolution
 * ({@link emitJavaJvmNameEdges}) binds a name only to a class whose binary name
 * — declared package plus `$`-joined member-class nesting — is exactly equal
 * and unique in the workspace; anything else (JDK, the host application, a
 * plain path string, a bare package) produces nothing.
 *
 * Edges: `USES` from the enclosing callable (or class / file for initializers)
 * to the class — the same edge a Java type reference produces, and one the
 * default `impact()` traversal follows — and `CALLS` to a method only when its
 * name and, for overloads, the adjacent descriptor's parameter count pick
 * exactly one declared method. Both carry {@link JVM_INTERNAL_NAME_REASON} at
 * {@link JVM_INTERNAL_NAME_CONFIDENCE}, below a resolved direct call.
 *
 * Dotted binary names (`Class.forName("a.b.C")`) and names built at run time
 * (`"L" + cls + ";"`) are out of scope.
 */

import type { ParsedFile, Scope, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import {
  resolveCallerGraphId,
  resolveDefGraphId,
  simpleQualifiedName,
} from '../../scope-resolution/graph-bridge/ids.js';
import type { GraphNodeLookup } from '../../scope-resolution/graph-bridge/node-lookup.js';
import { isClassLike } from '../../scope-resolution/scope/walkers.js';
import { definitionIdPosition } from '../../scope-resolution/utils/definition-id.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { getJavaJvmNameFacts } from './capture-side-channel.js';
import { getJavaPackageFact } from './package-facts.js';

export const JVM_INTERNAL_NAME_REASON = 'jvm-internal-name';
export const JVM_INTERNAL_NAME_CONFIDENCE = 0.7;

/** A string literal whose value is shaped like a JVM internal class name. */
export interface JavaJvmNameRef {
  /** 1-based line / 0-based column of the literal. */
  readonly line: number;
  readonly col: number;
  readonly internalName: string;
}

/** A method-name literal in an argument list, with the descriptor right after it. */
export interface JavaJvmMethodName {
  readonly name: string;
  readonly descriptor?: string;
}

/** An argument list naming class(es) by internal name and method(s) by literal. */
export interface JavaJvmNameCall {
  /** 1-based line / 0-based column of the argument list. */
  readonly line: number;
  readonly col: number;
  readonly classNames: readonly string[];
  readonly methods: readonly JavaJvmMethodName[];
}

export interface JavaJvmNameFacts {
  readonly refs: readonly JavaJvmNameRef[];
  readonly calls: readonly JavaJvmNameCall[];
}

const JAVA_IDENTIFIER = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;
/** At least one `/`; every segment a Java identifier (`$` included, for nesting). */
const INTERNAL_NAME = /^(?:[\p{L}_$][\p{L}\p{N}_$]*\/)+[\p{L}_$][\p{L}\p{N}_$]*$/u;
const FIELD_DESCRIPTOR = /\[*(?:[BCDFIJSZ]|L[^;()[\]]+;)/y;
const MAX_INTERNAL_NAME_LENGTH = 1024;

export function isJvmInternalName(value: string): boolean {
  return value.length <= MAX_INTERNAL_NAME_LENGTH && INTERNAL_NAME.test(value);
}

/**
 * Parameter count of a JVM method descriptor (`(ILjava/lang/String;[J)V` → 3),
 * or `undefined` when `value` is not a well-formed method descriptor.
 */
export function jvmDescriptorParameterCount(value: string): number | undefined {
  if (!value.startsWith('(')) return undefined;
  const close = value.indexOf(')');
  if (close === -1) return undefined;
  let count = 0;
  FIELD_DESCRIPTOR.lastIndex = 1;
  while (FIELD_DESCRIPTOR.lastIndex < close) {
    const start = FIELD_DESCRIPTOR.lastIndex;
    if (FIELD_DESCRIPTOR.exec(value) === null || FIELD_DESCRIPTOR.lastIndex > close) {
      return undefined;
    }
    if (FIELD_DESCRIPTOR.lastIndex === start) return undefined;
    count++;
  }
  const ret = value.slice(close + 1);
  if (ret === 'V') return count;
  FIELD_DESCRIPTOR.lastIndex = 0;
  const match = FIELD_DESCRIPTOR.exec(ret);
  return match !== null && FIELD_DESCRIPTOR.lastIndex === ret.length ? count : undefined;
}

// ── Worker side ─────────────────────────────────────────────────────────────

/** Value of a plain (non text-block, escape-free) string literal. */
function stringLiteralValue(node: SyntaxNode | null | undefined): string | undefined {
  if (node === null || node === undefined || node.type !== 'string_literal') return undefined;
  const text = node.text;
  if (text.startsWith('"""') || text.length < 2 || text.includes('\\')) return undefined;
  return text.slice(1, -1);
}

const hasModifier = (declaration: SyntaxNode, keyword: string): boolean =>
  declaration.namedChildren.some(
    (child) =>
      child.type === 'modifiers' && child.children.some((token) => token.type === keyword),
  );

const isStringType = (type: SyntaxNode | null): boolean =>
  type !== null && (type.text === 'String' || type.text === 'java.lang.String');

/**
 * Same-file `static final String` constants initialised by a single literal.
 * Interface fields are implicitly static final. A name declared twice with
 * different values (two nested classes) is dropped rather than guessed.
 */
function collectStringConstants(root: SyntaxNode): Map<string, string> {
  const values = new Map<string, string>();
  const conflicting = new Set<string>();
  for (const declaration of root.descendantsOfType(['field_declaration', 'constant_declaration'])) {
    if (!isStringType(declaration.childForFieldName('type'))) continue;
    if (
      declaration.type === 'field_declaration' &&
      !(hasModifier(declaration, 'static') && hasModifier(declaration, 'final'))
    ) {
      continue;
    }
    for (const declarator of declaration.childrenForFieldName('declarator')) {
      const name = declarator.childForFieldName('name')?.text;
      const value = stringLiteralValue(declarator.childForFieldName('value'));
      if (name === undefined || value === undefined) continue;
      const prior = values.get(name);
      if (prior !== undefined && prior !== value) conflicting.add(name);
      values.set(name, value);
    }
  }
  for (const name of conflicting) values.delete(name);
  return values;
}

const isComment = (node: SyntaxNode): boolean =>
  node.type === 'line_comment' || node.type === 'block_comment';

const CALLABLE_TYPES = [
  'method_declaration',
  'constructor_declaration',
  'compact_constructor_declaration',
  'static_initializer',
];

function enclosingCallable(node: SyntaxNode): SyntaxNode | null {
  for (let cursor = node.parent; cursor !== null; cursor = cursor.parent) {
    if (CALLABLE_TYPES.includes(cursor.type)) return cursor;
  }
  return null;
}

/**
 * Names a callable binds locally → the literal an effectively-final local
 * `String` holds, or `null` when the name is a parameter, a non-literal or
 * reassigned local, or declared twice with different values. Any entry here
 * shadows a same-named field constant.
 */
function collectCallableLocals(callable: SyntaxNode): Map<string, string | null> {
  const locals = new Map<string, string | null>();
  const bind = (name: string | undefined, value: string | null): void => {
    if (name === undefined) return;
    const prior = locals.get(name);
    locals.set(name, prior === undefined || prior === value ? value : null);
  };
  for (const node of callable.descendantsOfType([
    'local_variable_declaration',
    'formal_parameter',
    'spread_parameter',
    'catch_formal_parameter',
    'enhanced_for_statement',
    'lambda_expression',
    'assignment_expression',
  ])) {
    switch (node.type) {
      case 'local_variable_declaration': {
        const isString = isStringType(node.childForFieldName('type'));
        for (const declarator of node.childrenForFieldName('declarator')) {
          const value = isString ? stringLiteralValue(declarator.childForFieldName('value')) : undefined;
          bind(declarator.childForFieldName('name')?.text, value ?? null);
        }
        break;
      }
      case 'lambda_expression': {
        const params = node.childForFieldName('parameters');
        if (params?.type === 'identifier') bind(params.text, null);
        else for (const param of params?.descendantsOfType('identifier') ?? []) bind(param.text, null);
        break;
      }
      case 'assignment_expression': {
        const left = node.childForFieldName('left');
        if (left?.type === 'identifier') bind(left.text, null);
        break;
      }
      case 'spread_parameter':
        for (const declarator of node.descendantsOfType('variable_declarator')) {
          bind(declarator.childForFieldName('name')?.text, null);
        }
        break;
      default:
        bind(node.childForFieldName('name')?.text, null);
    }
  }
  return locals;
}

/** Record internal-name literals and class+method argument lists for one file. */
export function captureJavaJvmNameFacts(root: SyntaxNode): JavaJvmNameFacts | undefined {
  const literals = root.descendantsOfType('string_literal');
  if (literals.length === 0) return undefined;

  const refs: JavaJvmNameRef[] = [];
  const argumentLists = new Map<number, SyntaxNode>();
  for (const literal of literals) {
    const value = stringLiteralValue(literal);
    if (value === undefined) continue;
    if (isJvmInternalName(value)) {
      refs.push({
        line: literal.startPosition.row + 1,
        col: literal.startPosition.column,
        internalName: value,
      });
    }
    const parent = literal.parent;
    if (parent !== null && parent.type === 'argument_list') argumentLists.set(parent.id, parent);
  }
  // A constant or local can only hold an internal name some literal in this
  // file spells, so a file without one has nothing to pair either.
  if (refs.length === 0) return undefined;

  const calls: JavaJvmNameCall[] = [];
  let constants: Map<string, string> | undefined;
  const localsByCallable = new Map<number, Map<string, string | null>>();
  /** A literal, or an identifier naming an effectively-final local / static final constant. */
  const valueOf = (node: SyntaxNode | undefined): string | undefined => {
    if (node === undefined) return undefined;
    if (node.type !== 'identifier') return stringLiteralValue(node);
    const callable = enclosingCallable(node);
    if (callable !== null) {
      let locals = localsByCallable.get(callable.id);
      if (locals === undefined) {
        locals = collectCallableLocals(callable);
        localsByCallable.set(callable.id, locals);
      }
      const local = locals.get(node.text);
      if (local !== undefined) return local ?? undefined;
    }
    constants ??= collectStringConstants(root);
    return constants.get(node.text);
  };
  for (const list of argumentLists.values()) {
    const args = list.namedChildren.filter((child) => !isComment(child));
    const classNames: string[] = [];
    const methods: JavaJvmMethodName[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      const value = valueOf(arg);
      if (value === undefined) continue;
      if (isJvmInternalName(value)) {
        classNames.push(value);
        continue;
      }
      if (arg.type !== 'string_literal' || !JAVA_IDENTIFIER.test(value)) continue;
      const next = valueOf(args[i + 1]);
      const descriptor =
        next !== undefined && jvmDescriptorParameterCount(next) !== undefined ? next : undefined;
      methods.push(descriptor === undefined ? { name: value } : { name: value, descriptor });
    }
    if (classNames.length === 0 || methods.length === 0) continue;
    calls.push({
      line: list.startPosition.row + 1,
      col: list.startPosition.column,
      classNames,
      methods,
    });
  }
  return { refs, calls };
}

// ── Resolution side ─────────────────────────────────────────────────────────

/** The class-like def a scope declares: owned by it and anchored at its start. */
function declaredClassOf(scope: Scope): SymbolDefinition | undefined {
  return scope.ownedDefs.find((def) => {
    if (!isClassLike(def.type)) return false;
    const at = definitionIdPosition(def.nodeId, def.filePath);
    return at !== undefined && at.line === scope.range.startLine && at.column === scope.range.startCol;
  });
}

/**
 * Binary name (`pkg/Outer$Inner`) → class, for every top-level and member class
 * in a file with a known package. Local and anonymous classes have no stable
 * binary name and are left out. A name declared by more than one file maps to
 * `null` (ambiguous).
 */
function buildBinaryNameIndex(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
): Map<string, SymbolDefinition | null> {
  const out = new Map<string, SymbolDefinition | null>();
  for (const parsed of parsedFiles) {
    const pkg = getJavaPackageFact(parsed.filePath);
    if (pkg === undefined || pkg.status !== 'known') continue;
    const prefix = pkg.packageName === '' ? '' : `${pkg.packageName.replace(/\./g, '/')}/`;
    for (const scope of parsed.scopes) {
      const def = declaredClassOf(scope);
      if (def === undefined) continue;
      const nesting: string[] = [];
      let cursor: Scope | undefined = scope;
      let addressable = true;
      while (cursor !== undefined && cursor.kind !== 'Module') {
        const declared = declaredClassOf(cursor);
        const name = declared === undefined ? undefined : simpleQualifiedName(declared);
        if (name === undefined || !JAVA_IDENTIFIER.test(name)) {
          addressable = false;
          break;
        }
        nesting.unshift(name);
        cursor = indexes.scopeTree.getParent(cursor.id);
      }
      if (!addressable || cursor === undefined) continue;
      const binaryName = prefix + nesting.join('$');
      out.set(binaryName, out.has(binaryName) ? null : def);
    }
  }
  return out;
}

const containsPoint = (scope: Scope, line: number, col: number): boolean =>
  (scope.range.startLine < line || (scope.range.startLine === line && scope.range.startCol <= col)) &&
  (scope.range.endLine > line || (scope.range.endLine === line && scope.range.endCol >= col));

/** Innermost scope of `parsed` enclosing the position. */
function innermostScopeAt(
  parsed: ParsedFile,
  indexes: ScopeResolutionIndexes,
  line: number,
  col: number,
): ScopeId {
  let current = parsed.moduleScope;
  for (;;) {
    let next: ScopeId | undefined;
    for (const childId of indexes.scopeTree.getChildren(current)) {
      const child = indexes.scopeTree.getScope(childId);
      if (child !== undefined && containsPoint(child, line, col)) {
        next = childId;
        break;
      }
    }
    if (next === undefined) return current;
    current = next;
  }
}

function methodsByOwnerIndex(parsedFiles: readonly ParsedFile[]): Map<string, SymbolDefinition[]> {
  const out = new Map<string, SymbolDefinition[]>();
  for (const parsed of parsedFiles) {
    for (const def of parsed.localDefs) {
      if (def.type !== 'Method' || def.ownerId === undefined) continue;
      const list = out.get(def.ownerId);
      if (list === undefined) out.set(def.ownerId, [def]);
      else list.push(def);
    }
  }
  return out;
}

/** The single method a name + optional descriptor selects, or `undefined`. */
function pickMethod(
  candidates: readonly SymbolDefinition[],
  descriptor: string | undefined,
): SymbolDefinition | undefined {
  if (descriptor === undefined) return candidates.length === 1 ? candidates[0] : undefined;
  const arity = jvmDescriptorParameterCount(descriptor);
  const matching = candidates.filter((def) => def.parameterCount === arity);
  return matching.length === 1 ? matching[0] : undefined;
}

/** Emit `USES` (class) and `CALLS` (method) edges for recorded internal names. */
export function emitJavaJvmNameEdges(
  graph: KnowledgeGraph,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
  indexes: ScopeResolutionIndexes,
): void {
  const withFacts = parsedFiles.filter((parsed) => getJavaJvmNameFacts(parsed.filePath) !== undefined);
  if (withFacts.length === 0) return;
  const classes = buildBinaryNameIndex(parsedFiles, indexes);
  if (classes.size === 0) return;
  let methodsByOwner: Map<string, SymbolDefinition[]> | undefined;

  const classOf = (internalName: string): SymbolDefinition | undefined =>
    classes.get(internalName) ?? undefined;
  const sourceAt = (parsed: ParsedFile, line: number, col: number): string | undefined =>
    resolveCallerGraphId(innermostScopeAt(parsed, indexes, line, col), indexes, nodeLookup, {
      startLine: line,
      startCol: col,
    });
  const addEdge = (type: 'USES' | 'CALLS', sourceId: string, targetId: string): void => {
    if (sourceId === targetId) return;
    // CALLS shares the collapsed `(caller, target)` key of the Java call
    // bridge, so a resolved direct call to the same method keeps its edge.
    const key =
      type === 'CALLS'
        ? `CALLS:${sourceId}->${targetId}`
        : `USES:${sourceId}->${targetId}:${JVM_INTERNAL_NAME_REASON}`;
    graph.addRelationship({
      id: `rel:${key}`,
      sourceId,
      targetId,
      type,
      confidence: JVM_INTERNAL_NAME_CONFIDENCE,
      reason: JVM_INTERNAL_NAME_REASON,
    });
  };

  for (const parsed of withFacts) {
    const facts = getJavaJvmNameFacts(parsed.filePath);
    if (facts === undefined) continue;
    for (const ref of facts.refs) {
      const target = classOf(ref.internalName);
      if (target === undefined) continue;
      const targetId = resolveDefGraphId(target.filePath, target, nodeLookup);
      const sourceId = sourceAt(parsed, ref.line, ref.col);
      if (targetId !== undefined && sourceId !== undefined) addEdge('USES', sourceId, targetId);
    }
    for (const call of facts.calls) {
      const owners = call.classNames
        .map(classOf)
        .filter((def): def is SymbolDefinition => def !== undefined);
      if (owners.length === 0) continue;
      methodsByOwner ??= methodsByOwnerIndex(parsedFiles);
      const targetIds: string[] = [];
      for (const method of call.methods) {
        const perOwner = owners
          .map((owner) =>
            (methodsByOwner?.get(owner.nodeId) ?? []).filter(
              (def) => simpleQualifiedName(def) === method.name,
            ),
          )
          .filter((defs) => defs.length > 0);
        // A name declared by two of the named classes cannot be attributed.
        if (perOwner.length !== 1) continue;
        const picked = pickMethod(perOwner[0], method.descriptor);
        const targetId =
          picked === undefined ? undefined : resolveDefGraphId(picked.filePath, picked, nodeLookup);
        if (targetId !== undefined) targetIds.push(targetId);
      }
      if (targetIds.length === 0) continue;
      const sourceId = sourceAt(parsed, call.line, call.col);
      if (sourceId === undefined) continue;
      for (const targetId of targetIds) addEdge('CALLS', sourceId, targetId);
    }
  }
}
