/**
 * Lua lexical-environment and static table-path walk (worker side, runs on
 * the live AST, one pass per file).
 *
 * Lua resolves a bare identifier to the innermost visible `local` (block
 * scoped, visible only AFTER its declaration statement) and otherwise to the
 * global table. Modules are plain tables: `MyMod = MyMod or {}` declares one,
 * `local C = MyMod.Client` aliases a sub-table, `local P = {}; C.Tx = P`
 * registers a file-local table under a global path, and `function P.create()`
 * defines `MyMod.Client.Tx.create`. The scope model the central extractor
 * builds has neither block scopes, declaration order nor table paths, so every
 * fact that depends on them is computed here and handed to the capture
 * emitter and the capture side channel:
 *
 *   - `localIdentifierStarts` — byte offsets of identifiers (bare callees,
 *     bare `function name()` statement names, simple assignment targets) that
 *     resolve to a lexical local. Drives `@declaration.is-exported`.
 *   - `localOnlyCallees` — names whose EVERY bare call in the file resolves to
 *     a local; a workspace-wide name guess for them is impossible.
 *   - `defKeys` — the path keys each table-member / global function def is
 *     reachable under (all aliases of its owner table).
 *   - `callKeys` — the path key a call site names, carried to resolution as
 *     `@reference.qualified-name`.
 *   - `returnKeys` / `returnFields` — what the chunk's `return` exposes, for
 *     `local M = require "…"` roots resolved on the main thread.
 *
 * ## Path keys (Lua-private encoding)
 *
 *   `A.B.c`      a path rooted at the global `A`
 *   `#3.c`       a path rooted at this file's 3rd table constructor (`local P = {}`)
 *   `~util.f`    a path rooted at the table `local util = require …` returns
 *   `@12:4`      the local function value defined at line 12, column 4
 *
 * Values are flow-insensitive per local declaration: every assignment to a
 * local joins its value set, and a local whose values disagree (or include
 * anything that is not a static path) resolves to nothing. Everything this
 * walk cannot prove — dynamic keys, call results, parameters, cycles — yields
 * no key, so resolution fails closed.
 */
import type Parser from 'tree-sitter';

type SyntaxNode = Parser.SyntaxNode;

/** One per `local` declaration, so shadowing never merges two locals. */
interface Decl {
  /** 1-based line of the declaration statement. */
  readonly line: number;
  readonly values: Sym[];
}

type Sym =
  | { readonly kind: 'global'; readonly name: string; readonly fields: readonly string[] }
  | { readonly kind: 'local'; readonly decl: Decl; readonly fields: readonly string[] }
  | { readonly kind: 'table'; readonly id: number; readonly fields: readonly string[] }
  | { readonly kind: 'require'; readonly local: string; readonly fields: readonly string[] }
  | { readonly kind: 'def'; readonly line: number; readonly col: number }
  | { readonly kind: 'unset' }
  | { readonly kind: 'opaque' };

type Resolved = Exclude<Sym, { kind: 'local' } | { kind: 'unset' } | { kind: 'opaque' }>;

const OPAQUE: Sym = { kind: 'opaque' };
const UNSET: Sym = { kind: 'unset' };

export interface LuaDefKeys {
  /** Def anchor: 1-based line, 0-based column (the def id's coordinates). */
  readonly line: number;
  readonly col: number;
  readonly keys: readonly string[];
}

export interface LuaLexicalFacts {
  readonly localIdentifierStarts: ReadonlySet<number>;
  readonly localOnlyCallees: readonly string[];
}

/**
 * A class minted by a method-call factory — `X = Base:derive("X")`
 * (Project Zomboid's ISBaseObject), `Base:extend()` (rxi/classic),
 * `Base:subclass("X")` (middleclass) — bound to a single simple name.
 */
export interface LuaFactoryClass {
  /** The declaration statement — the Class def and graph node anchor. */
  readonly statement: SyntaxNode;
  /** The bound name, which is the class identity (as for `local X = class("X")`). */
  readonly name: SyntaxNode;
  readonly isLocal: boolean;
  /** The factory's receiver as written (`ISPanel`, `U.Button`). */
  readonly parentText: string;
  /** Path keys of the receiver; empty when it is not a static path. */
  readonly parentKeys: readonly string[];
}

export interface LuaPathFacts extends LuaLexicalFacts {
  readonly defKeys: readonly LuaDefKeys[];
  /** Path keys of every factory class, by its statement anchor. */
  readonly classKeys: readonly LuaDefKeys[];
  readonly factoryClasses: readonly LuaFactoryClass[];
  /** Colon-method bodies whose `self` is a class declared in this file: body → class name. */
  readonly selfTypes: ReadonlyMap<SyntaxNode, string>;
  /** Call node `startIndex:endIndex` → the path key the callee names. */
  readonly callKeys: ReadonlyMap<string, string>;
  readonly returnKeys: readonly string[];
  readonly returnFields: Readonly<Record<string, readonly string[]>>;
}

/** Receiver methods that mint a subclass table (see {@link LuaFactoryClass}). */
const CLASS_FACTORY_METHODS: Readonly<Record<string, true>> = {
  derive: true,
  extend: true,
  subclass: true,
};

/** `Base:derive(...)` / `:extend` / `:subclass` → the `Base` expression, else undefined. */
function classFactoryReceiver(node: SyntaxNode | undefined): SyntaxNode | undefined {
  if (node?.type !== 'call') return undefined;
  const callee = node.childForFieldName('function');
  const method = callee?.type === 'variable' ? callee.childForFieldName('method') : null;
  if (method === null || method === undefined || CLASS_FACTORY_METHODS[method.text] !== true) {
    return undefined;
  }
  return callee?.childForFieldName('table') ?? undefined;
}

class Env {
  readonly decls = new Map<string, Decl>();
  constructor(readonly parent: Env | null) {}

  lookup(name: string): Decl | undefined {
    for (let env: Env | null = this; env !== null; env = env.parent) {
      const decl = env.decls.get(name);
      if (decl !== undefined) return decl;
    }
    return undefined;
  }
}

/** `(variable name: (identifier))` with no table/field/method → the identifier. */
export function simpleVariableName(node: SyntaxNode | null | undefined): SyntaxNode | undefined {
  if (node === null || node === undefined) return undefined;
  if (node.type === 'identifier') return node;
  if (node.type !== 'variable') return undefined;
  if (node.childForFieldName('table') !== null) return undefined;
  const name = node.childForFieldName('name');
  return name?.type === 'identifier' ? name : undefined;
}

function childOfType(node: SyntaxNode, type: string): SyntaxNode | undefined {
  return node.namedChildren.find((child) => child.type === type);
}

/** `require "m"` / `require("m")` / `require [[m]]`. */
export function isLuaRequireCall(node: SyntaxNode): boolean {
  return (
    node.type === 'call' && simpleVariableName(node.childForFieldName('function'))?.text === 'require'
  );
}

function position(node: SyntaxNode): { line: number; col: number } {
  return { line: node.startPosition.row + 1, col: node.startPosition.column };
}

/** Static field name of `T.f` / `T["f"]`; undefined for a computed key. */
function fieldName(field: SyntaxNode | null): string | undefined {
  if (field?.type === 'identifier') return field.text;
  if (field?.type === 'string') return field.text.replace(/^(["'])([\s\S]*)\1$/, '$2');
  return undefined;
}

/** Inside a function body — only runs when that function is called. */
export function isNestedInLuaFunction(node: SyntaxNode): boolean {
  for (let enclosing = node.parent; enclosing !== null; enclosing = enclosing.parent) {
    if (
      enclosing.type === 'function_definition_statement' ||
      enclosing.type === 'local_function_definition_statement' ||
      enclosing.type === 'function_definition'
    ) {
      return true;
    }
  }
  return false;
}

interface MemberDefFact {
  readonly anchor: SyntaxNode;
  readonly owner: Sym;
  readonly member: string;
}

type CallFact =
  | { readonly kind: 'member'; readonly owner: Sym; readonly member: string }
  | { readonly kind: 'bare'; readonly name: string; readonly decl: Decl | undefined };

export function collectLuaPathFacts(root: SyntaxNode): LuaPathFacts {
  const localIdentifierStarts = new Set<number>();
  const bareCalls = new Map<string, { local: number; global: number }>();
  const tableIds = new Map<number, number>();
  const memberDefs: MemberDefFact[] = [];
  const globalDefs: { anchor: SyntaxNode; name: string }[] = [];
  const registrations: { target: Sym; value: Sym }[] = [];
  const calls = new Map<string, CallFact>();
  let returnSym: Sym | undefined;
  const returnFieldSyms = new Map<string, Sym>();
  const factoryParents = new Map<number, { readonly parent: Sym; readonly text: string }>();
  const factoryDecls: {
    readonly statement: SyntaxNode;
    readonly name: SyntaxNode;
    readonly isLocal: boolean;
    readonly tableId: number;
  }[] = [];
  const colonMethods: { readonly body: SyntaxNode; readonly owner: SyntaxNode; readonly sym: Sym }[] =
    [];

  const tableIdAt = (node: SyntaxNode): number => {
    let id = tableIds.get(node.startIndex);
    if (id === undefined) {
      id = tableIds.size + 1;
      tableIds.set(node.startIndex, id);
    }
    return id;
  };

  const withField = (sym: Sym, field: string | undefined): Sym => {
    if (field === undefined) return OPAQUE;
    switch (sym.kind) {
      case 'global':
      case 'local':
      case 'table':
      case 'require':
        return { ...sym, fields: [...sym.fields, field] };
      default:
        return OPAQUE;
    }
  };

  const symOf = (node: SyntaxNode | null | undefined, env: Env): Sym => {
    if (node === null || node === undefined) return OPAQUE;
    const name = simpleVariableName(node);
    if (name !== undefined) {
      const decl = env.lookup(name.text);
      return decl !== undefined
        ? { kind: 'local', decl, fields: [] }
        : { kind: 'global', name: name.text, fields: [] };
    }
    switch (node.type) {
      case 'variable': {
        const table = node.childForFieldName('table');
        if (table === null || node.childForFieldName('method') !== null) return OPAQUE;
        return withField(symOf(table, env), fieldName(node.childForFieldName('field')));
      }
      case 'parenthesized_expression':
        return symOf(node.namedChildren[0], env);
      case 'binary_expression':
        // `X = X or {}` — the namespace idiom names the left operand.
        return node.childForFieldName('operator')?.type === 'or' &&
          node.childForFieldName('right')?.type === 'table'
          ? symOf(node.childForFieldName('left'), env)
          : OPAQUE;
      case 'table':
        return { kind: 'table', id: tableIdAt(node), fields: [] };
      case 'call': {
        // `Base:derive("X")` mints a new class table whose parent is `Base`.
        const receiver = classFactoryReceiver(node);
        if (receiver === undefined) return OPAQUE;
        const id = tableIdAt(node);
        if (!factoryParents.has(id)) {
          factoryParents.set(id, { parent: symOf(receiver, env), text: receiver.text });
        }
        return { kind: 'table', id, fields: [] };
      }
      case 'function_definition':
        return { kind: 'def', ...position(node) };
      default:
        return OPAQUE;
    }
  };

  /** Values of `lhs1, lhs2 = e1, e2` by position; a missing value is `nil`
   *  unless the last expression is a call/vararg (multiple returns). */
  const valuesFor = (count: number, expressions: readonly SyntaxNode[], env: Env): Sym[] => {
    const last = expressions[expressions.length - 1];
    const spread = last?.type === 'call' || last?.type === 'vararg_expression';
    return Array.from({ length: count }, (_, index) =>
      index < expressions.length ? symOf(expressions[index], env) : spread ? OPAQUE : UNSET,
    );
  };

  const visitChildren = (node: SyntaxNode, env: Env): void => {
    for (const child of node.namedChildren) visit(child, env);
  };

  const declare = (env: Env, name: string, line: number, value: Sym): Decl => {
    const decl: Decl = { line, values: [value] };
    env.decls.set(name, decl);
    return decl;
  };

  const visitFunction = (fn: SyntaxNode, env: Env, self: Sym | undefined): void => {
    const inner = new Env(env);
    const line = fn.startPosition.row + 1;
    if (self !== undefined) declare(inner, 'self', line, self);
    for (const param of fn.childForFieldName('parameters')?.namedChildren ?? []) {
      if (param.type === 'identifier') declare(inner, param.text, line, OPAQUE);
    }
    const body = fn.childForFieldName('body');
    if (body !== null) visit(body, inner);
  };

  const visit = (node: SyntaxNode, env: Env): void => {
    switch (node.type) {
      case 'local_variable_declaration': {
        // RHS is evaluated before the names exist: `local C = C` reads the outer C.
        const expressions = childOfType(node, 'expression_list')?.namedChildren ?? [];
        const names = (childOfType(node, 'variable_list')?.namedChildren ?? []).map((variable) =>
          simpleVariableName(variable),
        );
        const values = valuesFor(names.length, expressions, env).map((value, index) =>
          expressions[index] !== undefined && isLuaRequireCall(expressions[index]) && names[index]
            ? ({ kind: 'require', local: names[index].text, fields: [] } as const)
            : value,
        );
        for (const expression of expressions) visit(expression, env);
        const line = node.startPosition.row + 1;
        names.forEach((name, index) => {
          if (name !== undefined) declare(env, name.text, line, values[index] ?? UNSET);
        });
        const [single] = values;
        if (
          names.length === 1 &&
          expressions.length === 1 &&
          names[0] !== undefined &&
          single?.kind === 'table' &&
          factoryParents.has(single.id)
        ) {
          factoryDecls.push({ statement: node, name: names[0], isLocal: true, tableId: single.id });
        }
        return;
      }
      case 'local_function_definition_statement': {
        // The name is in scope inside its own body (recursion).
        const name = node.childForFieldName('name');
        if (name !== null) {
          declare(env, name.text, node.startPosition.row + 1, { kind: 'def', ...position(node) });
        }
        visitFunction(node, env, undefined);
        return;
      }
      case 'function_definition_statement': {
        const name = node.childForFieldName('name');
        let self: Sym | undefined;
        if (name?.type === 'identifier') {
          const decl = env.lookup(name.text);
          if (decl !== undefined) {
            localIdentifierStarts.add(name.startIndex);
            decl.values.push({ kind: 'def', ...position(node) });
          } else if (!isNestedInLuaFunction(node)) {
            globalDefs.push({ anchor: node, name: name.text });
          }
        } else if (name !== null) {
          const owner = symOf(name.childForFieldName('table'), env);
          const member =
            name.childForFieldName('method')?.text ?? fieldName(name.childForFieldName('field'));
          if (member !== undefined && !isNestedInLuaFunction(node)) {
            memberDefs.push({ anchor: node, owner, member });
          }
          const tableNode = name.childForFieldName('table');
          if (name.childForFieldName('method') !== null) {
            self = owner;
            const body = node.childForFieldName('body');
            if (body !== null && tableNode?.type === 'identifier') {
              colonMethods.push({ body, owner: tableNode, sym: owner });
            }
          }
          visit(name, env);
        }
        visitFunction(node, env, self);
        return;
      }
      case 'function_definition':
        visitFunction(node, env, undefined);
        return;
      case 'variable_assignment': {
        const expressions = childOfType(node, 'expression_list')?.namedChildren ?? [];
        const targets = childOfType(node, 'variable_list')?.namedChildren ?? [];
        const values = valuesFor(targets.length, expressions, env);
        for (const expression of expressions) visit(expression, env);
        const topLevel = !isNestedInLuaFunction(node);
        targets.forEach((target, index) => {
          const value = values[index] ?? UNSET;
          const valueNode = expressions[index];
          const isFunctionValue = valueNode?.type === 'function_definition';
          const name = simpleVariableName(target);
          if (name !== undefined) {
            const decl = env.lookup(name.text);
            if (
              targets.length === 1 &&
              expressions.length === 1 &&
              value.kind === 'table' &&
              factoryParents.has(value.id)
            ) {
              factoryDecls.push({
                statement: node,
                name,
                isLocal: decl !== undefined,
                tableId: value.id,
              });
            }
            if (decl !== undefined) {
              localIdentifierStarts.add(name.startIndex);
              decl.values.push(value);
              return;
            }
            if (isFunctionValue && topLevel) globalDefs.push({ anchor: valueNode, name: name.text });
            registrations.push({ target: symOf(target, env), value });
            return;
          }
          const table = target.childForFieldName('table');
          const member = fieldName(target.childForFieldName('field'));
          if (table !== null && member !== undefined && isFunctionValue && topLevel) {
            memberDefs.push({ anchor: valueNode, owner: symOf(table, env), member });
          }
          registrations.push({ target: symOf(target, env), value });
          visit(target, env);
        });
        return;
      }
      case 'for_numeric_statement': {
        for (const field of ['start', 'end', 'step']) {
          const expr = node.childForFieldName(field);
          if (expr !== null) visit(expr, env);
        }
        const inner = new Env(env);
        const name = node.childForFieldName('name');
        if (name !== null) declare(inner, name.text, node.startPosition.row + 1, OPAQUE);
        const body = node.childForFieldName('body');
        if (body !== null) visit(body, inner);
        return;
      }
      case 'for_generic_statement': {
        const right = node.childForFieldName('right');
        if (right !== null) visit(right, env);
        const inner = new Env(env);
        for (const variable of node.childForFieldName('left')?.namedChildren ?? []) {
          const name = simpleVariableName(variable);
          if (name !== undefined) declare(inner, name.text, node.startPosition.row + 1, OPAQUE);
        }
        const body = node.childForFieldName('body');
        if (body !== null) visit(body, inner);
        return;
      }
      case 'repeat_statement': {
        // `until` sees the body's locals.
        const inner = new Env(env);
        const body = node.childForFieldName('body');
        if (body !== null) visitChildren(body, inner);
        const condition = node.childForFieldName('condition');
        if (condition !== null) visit(condition, inner);
        return;
      }
      case 'block':
        visitChildren(node, new Env(env));
        return;
      case 'call': {
        const callee = node.childForFieldName('function');
        const bare = simpleVariableName(callee);
        const callKey = `${node.startIndex}:${node.endIndex}`;
        if (bare !== undefined) {
          const decl = env.lookup(bare.text);
          if (decl !== undefined) localIdentifierStarts.add(bare.startIndex);
          const stats = bareCalls.get(bare.text) ?? { local: 0, global: 0 };
          if (decl !== undefined) stats.local++;
          else stats.global++;
          bareCalls.set(bare.text, stats);
          calls.set(callKey, { kind: 'bare', name: bare.text, decl });
        } else if (callee?.type === 'variable') {
          const table = callee.childForFieldName('table');
          const member =
            callee.childForFieldName('method')?.text ??
            fieldName(callee.childForFieldName('field'));
          if (table !== null && member !== undefined) {
            calls.set(callKey, { kind: 'member', owner: symOf(table, env), member });
          }
        }
        visitChildren(node, env);
        return;
      }
      case 'return_statement': {
        if (node.parent?.type === 'chunk') {
          const value = childOfType(node, 'expression_list')?.namedChildren[0];
          if (value?.type === 'table') {
            for (const field of childOfType(value, 'field_list')?.namedChildren ?? []) {
              const key = fieldName(field.childForFieldName('key'));
              if (field.type === 'field' && key !== undefined) {
                returnFieldSyms.set(key, symOf(field.childForFieldName('value'), env));
              }
            }
          } else if (value !== undefined) {
            returnSym = symOf(value, env);
          }
        }
        visitChildren(node, env);
        return;
      }
      default:
        visitChildren(node, env);
    }
  };

  visitChildren(root, new Env(null));

  // ── Flow-insensitive resolution ──────────────────────────────────────────
  const declMemo = new Map<Decl, Resolved | null>();
  const resolveDecl = (decl: Decl): Resolved | null => {
    const memo = declMemo.get(decl);
    if (memo !== undefined) return memo;
    declMemo.set(decl, null); // cycle guard: a self-referential local resolves to nothing
    let result: Resolved | null = null;
    let identity: string | undefined;
    for (const value of decl.values) {
      if (value.kind === 'unset') continue;
      const resolved = resolve(value);
      const valueIdentity = resolved === null ? undefined : identityOf(resolved);
      if (resolved === null || (identity !== undefined && identity !== valueIdentity)) {
        result = null;
        identity = '';
        break;
      }
      result = resolved;
      identity = valueIdentity;
    }
    declMemo.set(decl, result);
    return result;
  };

  const resolve = (sym: Sym): Resolved | null => {
    switch (sym.kind) {
      case 'local': {
        const base = resolveDecl(sym.decl);
        if (base === null) return null;
        if (sym.fields.length === 0) return base;
        return base.kind === 'def' ? null : { ...base, fields: [...base.fields, ...sym.fields] };
      }
      case 'unset':
      case 'opaque':
        return null;
      default:
        return sym;
    }
  };

  // Table id → every path it was stored under (`C.Tx = P`, `MyMod = P`).
  const aliasesByTable = new Map<number, Sym[]>();
  for (const { target, value } of registrations) {
    const resolved = resolve(value);
    if (resolved?.kind !== 'table' || resolved.fields.length > 0) continue;
    const aliases = aliasesByTable.get(resolved.id) ?? [];
    aliases.push(target);
    aliasesByTable.set(resolved.id, aliases);
  }

  const tableKeyMemo = new Map<number, readonly string[]>();
  const tableKeys = (id: number): readonly string[] => {
    const memo = tableKeyMemo.get(id);
    if (memo !== undefined) return memo;
    tableKeyMemo.set(id, [`#${id}`]); // cycle guard
    const keys = new Set([`#${id}`]);
    for (const target of aliasesByTable.get(id) ?? []) {
      const resolved = resolve(target);
      if (resolved !== null) for (const key of keysOf(resolved)) keys.add(key);
    }
    const result = [...keys].sort();
    tableKeyMemo.set(id, result);
    return result;
  };

  const keysOf = (resolved: Resolved): readonly string[] => {
    switch (resolved.kind) {
      case 'global':
        return [[resolved.name, ...resolved.fields].join('.')];
      case 'require':
        return [`~${[resolved.local, ...resolved.fields].join('.')}`];
      case 'def':
        return [`@${resolved.line}:${resolved.col}`];
      case 'table': {
        const suffix = resolved.fields.map((field) => `.${field}`).join('');
        return tableKeys(resolved.id).map((key) => key + suffix);
      }
    }
  };

  const symKeys = (sym: Sym, member?: string): readonly string[] => {
    const resolved = resolve(sym);
    if (resolved === null) return [];
    if (member === undefined) return keysOf(resolved);
    return resolved.kind === 'def' ? [] : keysOf(resolved).map((key) => `${key}.${member}`);
  };

  const defKeys: LuaDefKeys[] = [];
  const definedAt = new Map<string, number[]>();
  const addDef = (anchor: SyntaxNode, keys: readonly string[]): void => {
    if (keys.length === 0) return;
    const at = position(anchor);
    defKeys.push({ ...at, keys });
    for (const key of keys) definedAt.set(key, [...(definedAt.get(key) ?? []), at.line]);
  };
  for (const { anchor, owner, member } of memberDefs) addDef(anchor, symKeys(owner, member));
  for (const { anchor, name } of globalDefs) addDef(anchor, [name]);

  const classKeys: LuaDefKeys[] = [];
  const factoryClasses: LuaFactoryClass[] = [];
  const classNameByKey = new Map<string, string>();
  for (const { statement, name, isLocal, tableId } of factoryDecls) {
    const parent = factoryParents.get(tableId);
    const keys = tableKeys(tableId);
    classKeys.push({ ...position(statement), keys });
    for (const key of keys) classNameByKey.set(key, name.text);
    factoryClasses.push({
      statement,
      name,
      isLocal,
      parentText: parent?.text ?? '',
      parentKeys: parent === undefined ? [] : symKeys(parent.parent),
    });
  }
  // `self` in `function X:m()` is typed as class `X` only when `X` is the very
  // name a class of this file is bound to — the name the scope model resolves.
  const selfTypes = new Map<SyntaxNode, string>();
  for (const { body, owner, sym } of colonMethods) {
    if (symKeys(sym).some((key) => classNameByKey.get(key) === owner.text)) {
      selfTypes.set(body, owner.text);
    }
  }

  const callKeys = new Map<string, string>();
  for (const [callKey, fact] of calls) {
    const keys =
      fact.kind === 'member'
        ? symKeys(fact.owner, fact.member)
        : fact.decl === undefined
          ? [fact.name]
          : symKeys({ kind: 'local', decl: fact.decl, fields: [] });
    const key = preferredKey(keys);
    if (key === undefined) continue;
    // Monkey-patch wrapper: `local orig = X.f` captured the value X.f held
    // BEFORE this file (re)defined it, so the alias never names this file's
    // later definition — resolving it there would mint a self-call.
    const aliasLine = fact.kind === 'bare' ? fact.decl?.line : undefined;
    if (aliasLine !== undefined && (definedAt.get(key) ?? []).some((line) => line >= aliasLine)) {
      continue;
    }
    callKeys.set(callKey, key);
  }

  const returnResolved = returnSym === undefined ? null : resolve(returnSym);
  const returnFields: Record<string, readonly string[]> = {};
  for (const [field, sym] of returnFieldSyms) {
    const keys = symKeys(sym);
    if (keys.length > 0) returnFields[field] = keys;
  }

  const localOnlyCallees = [...bareCalls]
    .filter(([, stats]) => stats.global === 0)
    .map(([name]) => name)
    .sort();
  return {
    localIdentifierStarts,
    localOnlyCallees,
    defKeys,
    classKeys,
    factoryClasses,
    selfTypes,
    callKeys,
    returnKeys: returnResolved === null ? [] : keysOf(returnResolved),
    returnFields,
  };
}

/** Structural identity of a resolved value (two assignments agree iff equal). */
function identityOf(resolved: Resolved): string {
  switch (resolved.kind) {
    case 'global':
      return `g:${[resolved.name, ...resolved.fields].join('.')}`;
    case 'require':
      return `r:${[resolved.local, ...resolved.fields].join('.')}`;
    case 'table':
      return `t:${[resolved.id, ...resolved.fields].join('.')}`;
    case 'def':
      return `d:${resolved.line}:${resolved.col}`;
  }
}

/**
 * The one key a call site carries. Every key of a table names the same
 * definitions, so any works where the definition lives; a global path also
 * works from every other file, so it wins, then a require root, then the
 * file-local forms.
 */
function preferredKey(keys: readonly string[]): string | undefined {
  const rank = (key: string): number =>
    key.startsWith('@') ? 3 : key.startsWith('#') ? 2 : key.startsWith('~') ? 1 : 0;
  return [...keys].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0];
}
