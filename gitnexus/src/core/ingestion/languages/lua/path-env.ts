/**
 * Lua lexical-environment walk (worker side, runs on the live AST).
 *
 * Lua resolves a bare identifier to the innermost visible `local` (block
 * scoped, visible only AFTER its declaration statement) and otherwise to the
 * global table. The scope model the central extractor builds has neither
 * block scopes nor declaration order, so the facts that depend on that rule
 * are computed here, in one pass, and handed to the capture emitter and the
 * capture side channel:
 *
 *   - `localIdentifierStarts` — byte offsets of identifiers (bare callees,
 *     bare `function name()` statement names, simple assignment targets) that
 *     resolve to a lexical local. Drives `@declaration.is-exported`: a
 *     `function f()` or `f = function` that writes a local is file-private.
 *   - `localOnlyCallees` — names whose EVERY bare call in the file resolves to
 *     a local. A workspace-wide name guess for such a call is impossible in
 *     Lua (the local shadows the global), which the resolver's
 *     `isGlobalNameFallbackPlausible` hook enforces.
 */
import type Parser from 'tree-sitter';

type SyntaxNode = Parser.SyntaxNode;

export interface LuaLexicalFacts {
  readonly localIdentifierStarts: ReadonlySet<number>;
  readonly localOnlyCallees: readonly string[];
}

class Env {
  readonly names = new Set<string>();
  constructor(readonly parent: Env | null) {}

  has(name: string): boolean {
    for (let env: Env | null = this; env !== null; env = env.parent) {
      if (env.names.has(name)) return true;
    }
    return false;
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

export function collectLuaLexicalFacts(root: SyntaxNode): LuaLexicalFacts {
  const localIdentifierStarts = new Set<number>();
  const bareCalls = new Map<string, { local: number; global: number }>();

  const recordBareCall = (identifier: SyntaxNode, env: Env): void => {
    const isLocal = env.has(identifier.text);
    if (isLocal) localIdentifierStarts.add(identifier.startIndex);
    const stats = bareCalls.get(identifier.text) ?? { local: 0, global: 0 };
    if (isLocal) stats.local++;
    else stats.global++;
    bareCalls.set(identifier.text, stats);
  };

  const visitChildren = (node: SyntaxNode, env: Env): void => {
    for (const child of node.namedChildren) visit(child, env);
  };

  const visitFunction = (fn: SyntaxNode, env: Env, implicitSelf: boolean): void => {
    const inner = new Env(env);
    if (implicitSelf) inner.names.add('self');
    for (const param of fn.childForFieldName('parameters')?.namedChildren ?? []) {
      if (param.type === 'identifier') inner.names.add(param.text);
    }
    const body = fn.childForFieldName('body');
    if (body !== null) visit(body, inner);
  };

  const visit = (node: SyntaxNode, env: Env): void => {
    switch (node.type) {
      case 'local_variable_declaration': {
        // RHS is evaluated before the names exist: `local C = C` reads the outer C.
        const values = childOfType(node, 'expression_list');
        if (values !== undefined) visit(values, env);
        for (const variable of childOfType(node, 'variable_list')?.namedChildren ?? []) {
          const name = simpleVariableName(variable);
          if (name !== undefined) env.names.add(name.text);
        }
        return;
      }
      case 'local_function_definition_statement': {
        // The name is in scope inside its own body (recursion).
        const name = node.childForFieldName('name');
        if (name !== null) env.names.add(name.text);
        visitFunction(node, env, false);
        return;
      }
      case 'function_definition_statement': {
        const name = node.childForFieldName('name');
        if (name?.type === 'identifier') {
          if (env.has(name.text)) localIdentifierStarts.add(name.startIndex);
        } else if (name !== null) visit(name, env);
        visitFunction(node, env, name?.childForFieldName('method') != null);
        return;
      }
      case 'function_definition':
        visitFunction(node, env, false);
        return;
      case 'variable_assignment': {
        const values = childOfType(node, 'expression_list');
        if (values !== undefined) visit(values, env);
        for (const target of childOfType(node, 'variable_list')?.namedChildren ?? []) {
          const name = simpleVariableName(target);
          if (name === undefined) visit(target, env);
          else if (env.has(name.text)) localIdentifierStarts.add(name.startIndex);
        }
        return;
      }
      case 'for_numeric_statement': {
        for (const field of ['start', 'end', 'step']) {
          const expr = node.childForFieldName(field);
          if (expr !== null) visit(expr, env);
        }
        const inner = new Env(env);
        const name = node.childForFieldName('name');
        if (name !== null) inner.names.add(name.text);
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
          if (name !== undefined) inner.names.add(name.text);
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
        const callee = simpleVariableName(node.childForFieldName('function'));
        if (callee !== undefined) recordBareCall(callee, env);
        visitChildren(node, env);
        return;
      }
      default:
        visitChildren(node, env);
    }
  };

  visitChildren(root, new Env(null));

  const localOnlyCallees = [...bareCalls]
    .filter(([, stats]) => stats.global === 0)
    .map(([name]) => name)
    .sort();
  return { localIdentifierStarts, localOnlyCallees };
}
