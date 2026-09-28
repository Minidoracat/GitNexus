/**
 * Workspace index of Lua table-path keys (main thread).
 *
 * The worker (`path-env.ts`) records, per file, the path keys each table
 * member / global function def (`defKeys`) and each factory class
 * (`classKeys`) is reachable under, and the key each call site names
 * (`@reference.qualified-name`). This index joins them across the workspace:
 *
 *   `A.B.c`    global path            → every def any file keyed `A.B.c`
 *   `#3.c`     caller-file local table → that file's defs keyed `#3.c`
 *   `~util.c`  require root            → the import edge bound to `util`, then
 *                                        the target file's `return` keys
 *   `@12:4`    local function value    → the caller file's def at 12:4
 *
 * Resolution returns every candidate; callers act only on exactly one, so a
 * path defined twice (two files, two conditional branches) stays unresolved.
 */
import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { definitionIdPosition } from '../../scope-resolution/utils/definition-id.js';
import type { LuaCaptureSideChannel } from './capture-side-channel.js';
import type { LuaDefKeys } from './path-env.js';

interface LuaKeyTable {
  /** Workspace-wide keys (global paths). */
  readonly global: ReadonlyMap<string, readonly SymbolDefinition[]>;
  /** File-local keys (`#…`), per file. */
  readonly local: ReadonlyMap<string, ReadonlyMap<string, readonly SymbolDefinition[]>>;
}

interface LuaFilePathIndex {
  readonly parsed: ParsedFile;
  readonly defsByPosition: ReadonlyMap<string, SymbolDefinition>;
  readonly returnKeys: readonly string[];
  readonly returnFieldKeys: Readonly<Record<string, readonly string[]>>;
}

export interface LuaPathIndex {
  /** Callable defs (table members, global functions) by key. */
  readonly callables: LuaKeyTable;
  /** Factory classes (`X = Base:derive("X")`) by key. */
  readonly classes: LuaKeyTable;
  readonly files: ReadonlyMap<string, LuaFilePathIndex>;
}

/** Bound on require-root hops (`~a.b` → a file returning `~c` → …). */
const MAX_REQUIRE_HOPS = 8;

function addKeys(
  facts: readonly LuaDefKeys[],
  parsed: ParsedFile,
  defsByPosition: ReadonlyMap<string, SymbolDefinition>,
  global: Map<string, SymbolDefinition[]>,
  local: Map<string, Map<string, SymbolDefinition[]>>,
): void {
  for (const { line, col, keys } of facts) {
    const def = defsByPosition.get(`${line}:${col}`);
    if (def === undefined) continue;
    for (const key of keys) {
      let bucket: Map<string, SymbolDefinition[]> = global;
      if (key.startsWith('#')) {
        bucket = local.get(parsed.filePath) ?? new Map();
        local.set(parsed.filePath, bucket);
      }
      const defs = bucket.get(key) ?? [];
      if (!defs.includes(def)) defs.push(def);
      bucket.set(key, defs);
    }
  }
}

export function buildLuaPathIndex(parsedFiles: readonly ParsedFile[]): LuaPathIndex {
  const callables = { global: new Map(), local: new Map() };
  const classes = { global: new Map(), local: new Map() };
  const files = new Map<string, LuaFilePathIndex>();
  for (const parsed of parsedFiles) {
    const defsByPosition = new Map<string, SymbolDefinition>();
    for (const def of parsed.localDefs) {
      const at = definitionIdPosition(def.nodeId, parsed.filePath);
      if (at === undefined) continue;
      const key = `${at.line}:${at.column}`;
      // Several defs can share an anchor (`local a, b = x, y`); only a callable
      // or class-like def is ever a path target.
      if (!defsByPosition.has(key) || def.type !== 'Variable') defsByPosition.set(key, def);
    }
    const channel = parsed.captureSideChannel as LuaCaptureSideChannel | undefined;
    const lua = channel?.kind === 'lua' ? channel : undefined;
    addKeys(lua?.defKeys ?? [], parsed, defsByPosition, callables.global, callables.local);
    addKeys(lua?.classKeys ?? [], parsed, defsByPosition, classes.global, classes.local);
    files.set(parsed.filePath, {
      parsed,
      defsByPosition,
      returnKeys: lua?.returnKeys ?? [],
      returnFieldKeys: lua?.returnFieldKeys ?? {},
    });
  }
  return { callables, classes, files };
}

/** Every def `key` names in `table`, from `filePath`'s point of view (deduplicated). */
export function resolveLuaPathKey(
  index: LuaPathIndex,
  table: LuaKeyTable,
  filePath: string,
  key: string,
  scopes: ScopeResolutionIndexes,
  hops = 0,
): readonly SymbolDefinition[] {
  const file = index.files.get(filePath);
  if (file === undefined) return [];
  if (key.startsWith('@')) {
    const def = file.defsByPosition.get(key.slice(1));
    return def === undefined ? [] : [def];
  }
  if (key.startsWith('#')) return table.local.get(filePath)?.get(key) ?? [];
  if (!key.startsWith('~')) return table.global.get(key) ?? [];

  // `~util.f`: the file bound to `local util = require …`, then what it returns.
  if (hops >= MAX_REQUIRE_HOPS) return [];
  const [root, ...fields] = key.slice(1).split('.');
  const edges = (scopes.imports.get(file.parsed.moduleScope) ?? []).filter(
    (edge) => edge.localName === root && edge.targetFile !== null,
  );
  const targetFile = edges.length === 1 ? edges[0]?.targetFile : undefined;
  const target = targetFile == null ? undefined : index.files.get(targetFile);
  if (target === undefined) return [];
  const suffix = fields.map((field) => `.${field}`).join('');
  const [field, ...rest] = fields;
  const restSuffix = rest.map((part) => `.${part}`).join('');
  const candidates = [
    ...target.returnKeys.map((returned) => returned + suffix),
    ...(field === undefined ? [] : (target.returnFieldKeys[field] ?? [])).map(
      (fieldKey) => fieldKey + restSuffix,
    ),
  ].flatMap((candidate) =>
    resolveLuaPathKey(index, table, target.parsed.filePath, candidate, scopes, hops + 1),
  );
  return [...new Set(candidates)];
}

/**
 * Give each table-member Method whose owner table is a factory class declared
 * in ANOTHER file (or reached through an alias) its `ownerId`, so the method
 * registers under the class and class-receiver dispatch finds it. A member
 * whose owner keys name no class, or several, is left alone.
 */
export function assignLuaWorkspaceOwners(index: LuaPathIndex): void {
  for (const [filePath, file] of index.files) {
    const channel = file.parsed.captureSideChannel as LuaCaptureSideChannel | undefined;
    if (channel?.kind !== 'lua') continue;
    for (const { line, col, keys } of channel.defKeys ?? []) {
      const def = file.defsByPosition.get(`${line}:${col}`);
      if (def === undefined || def.type !== 'Method' || def.ownerId !== undefined) continue;
      const owners = new Set(
        keys.flatMap((key) => {
          const ownerKey = key.slice(0, Math.max(0, key.lastIndexOf('.')));
          if (ownerKey.length === 0) return [];
          const table = ownerKey.startsWith('#')
            ? index.classes.local.get(filePath)
            : index.classes.global;
          return table?.get(ownerKey) ?? [];
        }),
      );
      const [owner] = owners;
      if (owners.size === 1 && owner !== undefined) def.ownerId = owner.nodeId;
    }
  }
}
