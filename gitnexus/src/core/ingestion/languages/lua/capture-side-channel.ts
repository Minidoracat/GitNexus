/**
 * Lua capture-time side channel — heritage pairs collected in the parse worker
 * (where the tree-sitter AST is live) and snapshotted onto
 * `ParsedFile.captureSideChannel` so the main-thread `emitLuaHeritageEdges`
 * hook emits EXTENDS + HAS_METHOD edges WITHOUT re-reading or re-parsing the
 * file (the #1983 no-main-thread-re-parse contract).
 *
 * Mirrors `languages/java/capture-side-channel.ts` and the C/CPP equivalents:
 * `emitScopeCaptures` populates this map as a side effect, then
 * `LanguageProvider.collectCaptureSideChannel` snapshots it per file.
 */
import type { LuaDefKeys } from './path-env.js';

export interface LuaExtendsPair {
  /** Child class name (quotes stripped from `class("Name", ...)`; the bound
   *  name for a `Base:derive(...)` factory class). */
  readonly child: string;
  /** Parent as written (bare `Parent`, `mod.Parent`, or the factory receiver). */
  readonly parent: string;
  /** Table-path keys of a factory class's receiver, resolved against the
   *  workspace class index before any name-based lookup. */
  readonly parentKeys?: readonly string[];
}

export interface LuaMethodOwnerPair {
  /** Receiver/table identifier — the class that owns the method. */
  readonly owner: string;
  readonly method: string;
  /** 0-based row of the `function_definition_statement` (for Method node lookup). */
  readonly defRow: number;
  /** 0-based inclusive end row of the function definition (fallback node range). */
  readonly defEndRow: number;
}

export interface LuaReturnedField {
  readonly exportName: string;
  readonly localName: string;
}

export interface LuaCaptureSideChannel {
  readonly kind: 'lua';
  readonly extendsPairs: readonly LuaExtendsPair[];
  readonly methodOwners: readonly LuaMethodOwnerPair[];
  /** Bare class/value names returned directly by the module. */
  readonly returnedNames: readonly string[];
  /** Static fields returned from a table literal, e.g. `{ Animal = Animal }`. */
  readonly returnedFields: readonly LuaReturnedField[];
  /**
   * Table-path keys every table member / global function def is reachable
   * under (`MyMod.Client.Tx.create`, `#1.create`; encoding in `path-env.ts`),
   * by def anchor. The resolver indexes these workspace-wide.
   */
  readonly defKeys: readonly LuaDefKeys[];
  /** Table-path keys of every factory class, by its declaration anchor. */
  readonly classKeys: readonly LuaDefKeys[];
  /** Keys of the table the chunk's `return` exposes (`return P`). */
  readonly returnKeys: readonly string[];
  /** Keys per field when the chunk returns a table constructor (`return { f = f }`). */
  readonly returnFieldKeys: Readonly<Record<string, readonly string[]>>;
  /**
   * Names whose every bare call in this file resolves to a lexical `local`
   * (see `path-env.ts`). A workspace-wide name guess for such a call is
   * impossible — the local shadows any global — so the resolver refuses it.
   */
  readonly localOnlyCallees: readonly string[];
}

const _facts = new Map<string, LuaCaptureSideChannel>();

/** Populate from `emitLuaScopeCaptures` (worker). Overwrites per file per run. */
export function setLuaHeritageFacts(filePath: string, facts: LuaCaptureSideChannel): void {
  _facts.set(filePath, facts);
}

/** Snapshot hook for `LanguageProvider.collectCaptureSideChannel`. */
export function collectLuaCaptureSideChannel(filePath: string): LuaCaptureSideChannel | undefined {
  return _facts.get(filePath);
}

/** Clear facts retained by a prior workspace pass in a long-lived process. */
export function clearLuaHeritageFacts(): void {
  _facts.clear();
}

/** Drop this file's facts so a re-capture that produces no heritage (the file
 *  lost its middleclass class between passes) does not leave stale EXTENDS /
 *  HAS_METHOD facts for `collectLuaCaptureSideChannel` to snapshot. */
export function clearLuaHeritageFactsForFile(filePath: string): void {
  _facts.delete(filePath);
}
