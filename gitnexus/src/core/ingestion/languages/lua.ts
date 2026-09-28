/**
 * Lua language provider.
 *
 * Phase A (legacy DAG): emits Function/Method/Class DEFINITION nodes from
 * LUA_QUERIES — `function foo()`, `local function foo()`, `function Obj:m()`
 * / `function Obj.m()`, single-target `f = function` / `T.f = function`, and
 * middleclass / `Base:derive("X")`-style classes.
 *
 * Phase B1 (scope resolution): `emitScopeCaptures` (lua/captures.ts) runs the
 * scope query (lua/query.ts) and the central ScopeExtractor builds the scope
 * tree + declarations + imports + reference sites. `interpretImport` turns
 * require()'s `@import.source` into a `namespace` ParsedImport when a local
 * binding is captured (`local X = require(...)`) so `X.foo()` resolves across
 * files, or `wildcard` for bare side-effect requires. `interpretTypeBinding`
 * types `self` in a colon method of a class declared in the same file.
 *
 * Lua visibility and module tables are computed in the worker by
 * lua/path-env.ts (block-scoped locals, global table paths such as
 * `MyMod.Client.Tx.create`, local aliases, registrations `C.Tx = P`) and
 * resolved workspace-wide by lua/path-index.ts through the ScopeResolver.
 *
 * `collectCaptureSideChannel` snapshots those facts plus class heritage pairs
 * (`class("Name", Parent)`, `Parent:derive("Name")`, `function Obj:m()`) onto
 * `ParsedFile.captureSideChannel`, so the resolver hooks and
 * `emitLuaHeritageEdges` work on the main thread without re-reading or
 * re-parsing (#1983).
 */
import { SupportedLanguages } from 'gitnexus-shared';
import { defineLanguage } from '../language-provider.js';
import { LUA_QUERIES } from '../tree-sitter-queries.js';
import { typeConfig as luaTypeConfig } from '../type-extractors/lua.js';
import { luaExportChecker } from '../export-detection.js';
import { createImportResolver } from '../import-resolvers/resolver-factory.js';
import { luaImportConfig } from '../import-resolvers/configs/lua.js';
import { createCallExtractor } from '../call-extractors/generic.js';
import { luaCallConfig } from '../call-extractors/configs/lua.js';
import { assertCloneable } from '../workers/clone-safety.js';
import { collectLuaCaptureSideChannel } from './lua/capture-side-channel.js';
import { emitLuaScopeCaptures, interpretLuaImport, interpretLuaTypeBinding } from './lua/index.js';

export const luaProvider = defineLanguage({
  id: SupportedLanguages.Lua,
  extensions: ['.lua'],
  treeSitterQueries: LUA_QUERIES,
  typeConfig: luaTypeConfig,
  exportChecker: luaExportChecker,
  importResolver: createImportResolver(luaImportConfig),
  callExtractor: createCallExtractor(luaCallConfig),
  emitScopeCaptures: emitLuaScopeCaptures,
  collectCaptureSideChannel: (filePath) => assertCloneable(collectLuaCaptureSideChannel(filePath)),
  interpretImport: interpretLuaImport,
  interpretTypeBinding: interpretLuaTypeBinding,
});
