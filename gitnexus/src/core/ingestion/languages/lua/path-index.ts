/**
 * Workspace index of Lua table-path keys (main thread).
 *
 * The worker (`path-env.ts`) records, per file, the path keys each table
 * member / global function def is reachable under (`defKeys`) and the key each
 * call site names (`@reference.qualified-name`). This index joins them across
 * the workspace:
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

interface LuaFilePathIndex {
  readonly parsed: ParsedFile;
  readonly defsByPosition: ReadonlyMap<string, SymbolDefinition>;
  readonly localKeys: ReadonlyMap<string, readonly SymbolDefinition[]>;
  readonly returnKeys: readonly string[];
  readonly returnFieldKeys: Readonly<Record<string, readonly string[]>>;
}

export interface LuaPathIndex {
  readonly globalKeys: ReadonlyMap<string, readonly SymbolDefinition[]>;
  readonly files: ReadonlyMap<string, LuaFilePathIndex>;
}

/** Bound on require-root hops (`~a.b` → a file returning `~c` → …). */
const MAX_REQUIRE_HOPS = 8;

export function buildLuaPathIndex(parsedFiles: readonly ParsedFile[]): LuaPathIndex {
  const globalKeys = new Map<string, SymbolDefinition[]>();
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
    const localKeys = new Map<string, SymbolDefinition[]>();
    for (const { line, col, keys } of channel?.kind === 'lua' ? (channel.defKeys ?? []) : []) {
      const def = defsByPosition.get(`${line}:${col}`);
      if (def === undefined) continue;
      for (const key of keys) {
        const bucket = key.startsWith('#') ? localKeys : globalKeys;
        const defs = bucket.get(key) ?? [];
        if (!defs.includes(def)) defs.push(def);
        bucket.set(key, defs);
      }
    }
    files.set(parsed.filePath, {
      parsed,
      defsByPosition,
      localKeys,
      returnKeys: channel?.kind === 'lua' ? (channel.returnKeys ?? []) : [],
      returnFieldKeys: channel?.kind === 'lua' ? (channel.returnFieldKeys ?? {}) : {},
    });
  }
  return { globalKeys, files };
}

/** Every def `key` names from `filePath`'s point of view (deduplicated). */
export function resolveLuaPathKey(
  index: LuaPathIndex,
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
  if (key.startsWith('#')) return file.localKeys.get(key) ?? [];
  if (!key.startsWith('~')) return index.globalKeys.get(key) ?? [];

  // `~util.f`: the file bound to `local util = require …`, then what it returns.
  if (hops >= MAX_REQUIRE_HOPS) return [];
  const [root, ...fields] = key.slice(1).split('.');
  if (fields.length === 0) return [];
  const edges = (scopes.imports.get(file.parsed.moduleScope) ?? []).filter(
    (edge) => edge.localName === root && edge.targetFile !== null,
  );
  const targetFile = edges.length === 1 ? edges[0]?.targetFile : undefined;
  const target = targetFile == null ? undefined : index.files.get(targetFile);
  if (target === undefined) return [];
  const suffix = `.${fields.join('.')}`;
  const [field, ...rest] = fields;
  const restSuffix = rest.map((part) => `.${part}`).join('');
  const candidates = [
    ...target.returnKeys.map((returned) => returned + suffix),
    ...(target.returnFieldKeys[field ?? ''] ?? []).map((fieldKey) => fieldKey + restSuffix),
  ].flatMap((candidate) => resolveLuaPathKey(index, target.parsed.filePath, candidate, scopes, hops + 1));
  return [...new Set(candidates)];
}
