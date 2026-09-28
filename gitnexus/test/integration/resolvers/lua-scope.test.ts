/**
 * Lua scope-resolution integration tests.
 *
 * Validates the cross-file member-call contract: `local X = require("mod")`
 * binds X as a namespace receiver so `X.foo()` resolves to `foo` in the
 * target file via collectNamespaceTargets (Case 1 of receiver-bound-calls).
 *
 * Mirrors `ruby-scope.test.ts` (require_relative) and the cross-file-binding
 * standard: a 2-file fixture indexed via runPipelineFromRepo with CALLS /
 * IMPORTS edge assertions at the graph level, not just registration/ABI.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'node:fs';
import os from 'node:os';
import {
  getRelationships,
  getNodesByLabel,
  getNodesByLabelFull,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';
import { SupportedLanguages, type BindingRef, type ScopeId } from 'gitnexus-shared';
import { emitLuaScopeCaptures } from '../../../src/core/ingestion/languages/lua/index.js';
import { collectLuaCaptureSideChannel } from '../../../src/core/ingestion/languages/lua/capture-side-channel.js';
import { luaScopeResolver } from '../../../src/core/ingestion/languages/lua/scope-resolver.js';
import { interpretLuaImport } from '../../../src/core/ingestion/languages/lua/interpret.js';

function writeFixtureRepo(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
}

/** Index `files` in a throwaway repo and hand the pipeline result to `check`. */
async function withLuaFixture(
  files: Record<string, string>,
  check: (result: PipelineResult) => void,
): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-fixture-'));
  try {
    writeFixtureRepo(tmpDir, files);
    check(await runPipelineFromRepo(tmpDir, () => {}));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** CALLS edges as `caller -> callee@file`, for readable failure output. */
function callsBetween(result: PipelineResult, source: string, target: string): string[] {
  return getRelationships(result, 'CALLS')
    .filter((edge) => edge.source === source && edge.target === target)
    .map((edge) => `${edge.source} -> ${edge.target}@${path.basename(edge.targetFilePath)}`);
}

describe('Lua scope resolver binding merge', () => {
  it('retains imported bindings when layering them onto existing bindings', () => {
    const local = {
      def: {
        nodeId: 'local',
        filePath: 'main.lua',
        type: 'Variable',
        qualifiedName: 'local',
      },
      origin: 'local',
    } satisfies BindingRef;
    const imported = {
      def: {
        nodeId: 'imported',
        filePath: 'lib.lua',
        type: 'Variable',
        qualifiedName: 'imported',
      },
      origin: 'import',
    } satisfies BindingRef;

    expect(luaScopeResolver.mergeBindings([local], [imported], 'scope:main' as ScopeId)).toEqual([
      local,
      imported,
    ]);
    expect(luaScopeResolver.language).toBe(SupportedLanguages.Lua);
  });

  it('keeps table members out of the bare-name bucket', () => {
    const member = {
      def: {
        nodeId: 'member',
        filePath: 'picker.lua',
        type: 'Method',
        qualifiedName: 'Picker.getText',
      },
      origin: 'local',
    } satisfies BindingRef;
    const global = {
      def: {
        nodeId: 'global',
        filePath: 'picker.lua',
        type: 'Function',
        qualifiedName: 'getText',
      },
      origin: 'local',
    } satisfies BindingRef;

    expect(luaScopeResolver.mergeBindings([], [member, global], 'scope:picker' as ScopeId)).toEqual(
      [global],
    );
  });
});

describe('Lua scope resolver import extensions', () => {
  it('prefers the Lua module when another language has the same module stem', () => {
    const files = new Set(['main.lua', 'foo.ts', 'foo.lua']);
    expect(luaScopeResolver.resolveImportTarget('foo', 'main.lua', files)).toBe('foo.lua');
  });

  it('does not bind an extensionless collision ahead of the Lua module', () => {
    const files = new Set(['main.lua', 'foo', 'foo.lua']);
    expect(luaScopeResolver.resolveImportTarget('foo', 'main.lua', files)).toBe('foo.lua');
  });

  it('unwraps quoted and long-bracket require sources', () => {
    const sources = ['"lib.util"', "'lib.util'", '[[lib.util]]', '[=[lib.util]=]'];
    for (const source of sources) {
      expect(
        interpretLuaImport({
          '@import.source': { text: source },
        } as never),
      ).toEqual({ kind: 'wildcard', targetRaw: 'lib.util' });
    }
  });
});

describe('Lua scope resolver arity compatibility', () => {
  it('does not narrow calls by positional arity', () => {
    const def = {
      nodeId: 'fixed',
      filePath: 'x.lua',
      type: 'Function',
      qualifiedName: 'fixed',
      parameterCount: 2,
      requiredParameterCount: 2,
      parameterTypes: [],
    } as const;
    expect(luaScopeResolver.arityCompatibility({ arity: 0 }, def)).toBe('unknown');
    expect(luaScopeResolver.arityCompatibility({ arity: 2 }, def)).toBe('unknown');
    expect(luaScopeResolver.arityCompatibility({ arity: 5 }, def)).toBe('unknown');
  });
});

describe('Lua scope resolver require syntax and positional bindings', () => {
  it('pairs multi-assignment requires by position without cross-binding', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-multi-require-'));
    try {
      writeFixtureRepo(tmpDir, {
        'x.lua': 'return {}\n',
        'y.lua': 'return {}\n',
        'main.lua': 'local a, b = require("x"), require("y")\n',
      });
      const result = await runPipelineFromRepo(tmpDir, () => {});
      const imports = getRelationships(result, 'IMPORTS').filter((e) =>
        e.sourceFilePath?.endsWith('main.lua'),
      );
      expect(imports.map((e) => e.targetFilePath).sort()).toEqual(['x.lua', 'y.lua']);
      expect(imports).toHaveLength(2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);

  it('recognizes parenthesis-free short and long-bracket requires', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-require-forms-'));
    try {
      writeFixtureRepo(tmpDir, {
        'short.lua': 'return {}\n',
        'long.lua': 'return {}\n',
        'main.lua': 'local short = require "short"\nrequire [[long]]\n',
      });
      const result = await runPipelineFromRepo(tmpDir, () => {});
      const imports = getRelationships(result, 'IMPORTS').filter((e) =>
        e.sourceFilePath?.endsWith('main.lua'),
      );
      expect(imports.map((e) => e.targetFilePath).sort()).toEqual(['long.lua', 'short.lua']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);

  it('finds requires nested in local initializers without duplicating direct bindings', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-nested-require-'));
    try {
      writeFixtureRepo(tmpDir, {
        'direct.lua': 'return {}\n',
        'function.lua': 'return {}\n',
        'wrapped.lua': 'return {}\n',
        'main.lua': `local direct = require("direct")
local loader = function() require("function") end
local value = wrap(require("wrapped"))
`,
      });
      const result = await runPipelineFromRepo(tmpDir, () => {});
      const imports = getRelationships(result, 'IMPORTS').filter((e) =>
        e.sourceFilePath?.endsWith('main.lua'),
      );
      expect(imports.map((e) => e.targetFilePath).sort()).toEqual([
        'direct.lua',
        'function.lua',
        'wrapped.lua',
      ]);
      expect(imports).toHaveLength(3);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);
});

describe('Lua module export visibility', () => {
  it('exports local functions only when the module return value exposes them', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-exports-'));
    try {
      writeFixtureRepo(tmpDir, {
        'module.lua': `local function exposed() end
local function hidden() end
local Private = {}
function Private.answer() end
function global() end
return { exposed = exposed }
`,
      });
      const result = await runPipelineFromRepo(tmpDir, () => {});
      const functions = getNodesByLabelFull(result, 'Function').filter((node) =>
        node.properties.filePath?.endsWith('module.lua'),
      );
      const privateMethods = getNodesByLabelFull(result, 'Method').filter((node) =>
        node.properties.filePath?.endsWith('module.lua'),
      );
      expect(privateMethods).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'answer',
            properties: expect.objectContaining({ isExported: false }),
          }),
        ]),
      );
      expect(functions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'exposed',
            properties: expect.objectContaining({ isExported: true }),
          }),
          expect.objectContaining({
            name: 'hidden',
            properties: expect.objectContaining({ isExported: false }),
          }),
          expect.objectContaining({
            name: 'global',
            properties: expect.objectContaining({ isExported: true }),
          }),
        ]),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);
});

describe('Lua local callable declarations', () => {
  it('declares local aliases and closure bindings for callable-flow resolution', () => {
    const captures = emitLuaScopeCaptures(
      `function target() end
function entry()
  local alias = target
  local value, callback = 1, function() end
  callback()
end
`,
      'main.lua',
    );
    expect(
      captures.some(
        (match) =>
          match['@declaration.variable']?.text === 'local alias = target' &&
          match['@declaration.name']?.text === 'alias',
      ),
    ).toBe(true);
    // The closure's def sits on its own function value (the node that is also
    // its `@scope.function`), so calls inside it are attributed to `callback`.
    expect(
      captures.some(
        (match) =>
          match['@declaration.function']?.text === 'function() end' &&
          match['@declaration.name']?.text === 'callback',
      ),
    ).toBe(true);
    expect(
      captures.some(
        (match) =>
          match['@declaration.function'] !== undefined &&
          match['@declaration.name']?.text === 'value',
      ),
    ).toBe(false);
    expect(
      captures.some(
        (match) =>
          match['@callable-flow.seed']?.text === 'local alias = target' &&
          match['@callable-flow.destination']?.text === 'alias',
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// require("lib.util") + member call util.answer() across files
// ---------------------------------------------------------------------------

describe('Lua scope: require + cross-file member call', () => {
  let result: PipelineResult;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-imports-'));
    writeFixtureRepo(tmpDir, {
      'lib/util.lua': `local M = {}
function M.answer()
  return 42
end
return M
`,
      'main.lua': `local util = require("lib.util")
local function run()
  return util.answer()
end
run()
`,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits IMPORTS edge from main.lua to lib/util.lua', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const utilImports = imports.filter(
      (e) => e.sourceFilePath?.includes('main.lua') && e.targetFilePath?.includes('util.lua'),
    );
    expect(utilImports).toHaveLength(1);
  });

  it('resolves run -> util.answer() as CALLS edge to util.lua', () => {
    const calls = getRelationships(result, 'CALLS');
    const answerCall = calls.find(
      (c) => c.target === 'answer' && c.source === 'run' && c.targetFilePath?.includes('util.lua'),
    );
    expect(answerCall).toBeDefined();
  });

  it('detects answer as a Method node and run as a Function node', () => {
    expect(getNodesByLabel(result, 'Method')).toContain('answer');
    expect(getNodesByLabel(result, 'Function')).toContain('run');
  });

  it('resolves a local alias of a statically known callable value', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-callable-alias-'));
    try {
      writeFixtureRepo(tmpDir, {
        'lib/util.lua': `local M = {}
function M.answer()
  return 42
end
return M
`,
        'main.lua': `local util = require("lib.util")
local answer = util.answer
answer()
`,
      });
      const result = await runPipelineFromRepo(tmpDir, () => {});
      // Exactly one edge — the require-rooted path `~util.answer` is resolved
      // once, by the table-path pass, not again by a name guess.
      expect(
        getRelationships(result, 'CALLS')
          .filter((edge) => edge.sourceFilePath?.endsWith('main.lua') && edge.target === 'answer')
          .map((edge) => `${path.basename(edge.targetFilePath)} ${edge.rel.reason}`),
      ).toEqual(['util.lua lua-table-path']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);
});

describe('Lua scope: bare require import', () => {
  it('emits one IMPORTS edge for an unbound side-effect require', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-bare-import-'));
    try {
      writeFixtureRepo(tmpDir, {
        'lib/util.lua': 'return {}\n',
        'main.lua': 'require("lib.util")\n',
      });
      const result = await runPipelineFromRepo(tmpDir, () => {});
      const imports = getRelationships(result, 'IMPORTS').filter(
        (e) => e.sourceFilePath?.includes('main.lua') && e.targetFilePath?.includes('util.lua'),
      );
      expect(imports).toHaveLength(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);

  it('resolves a long-bracket require source in the graph', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-long-require-'));
    try {
      writeFixtureRepo(tmpDir, {
        'lib/util.lua': 'return {}\n',
        'main.lua': 'require([[lib.util]])\n',
      });
      const result = await runPipelineFromRepo(tmpDir, () => {});
      const imports = getRelationships(result, 'IMPORTS').filter(
        (e) => e.sourceFilePath?.includes('main.lua') && e.targetFilePath?.includes('util.lua'),
      );
      expect(imports).toHaveLength(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);

  it('leaves computed module names unresolved', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-dynamic-require-'));
    try {
      writeFixtureRepo(tmpDir, {
        'lib/util.lua': 'return {}\n',
        'lib.lua': 'return {}\n',
        'main.lua': 'local name = "lib.util"\nrequire(name)\nrequire("lib." .. "util")\n',
      });
      const result = await runPipelineFromRepo(tmpDir, () => {});
      expect(getRelationships(result, 'IMPORTS')).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);
});

// ---------------------------------------------------------------------------
// middleclass: class("Name", Parent) → EXTENDS + HAS_METHOD across files
// ---------------------------------------------------------------------------

describe('Lua scope: middleclass EXTENDS + HAS_METHOD', () => {
  let result: PipelineResult;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-heritage-'));
    writeFixtureRepo(tmpDir, {
      'base.lua': `local class = require("lib.class")
local Animal = class("Animal")
function Animal:speak()
  return "..."
end
return Animal
`,
      'dog.lua': `local class = require("lib.class")
local Animal = require("base")
local Dog = class("Dog", Animal)
function Dog:bark()
  return "woof"
end
return Dog
`,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits EXTENDS from Dog to Animal across files', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    const dogExtendsAnimal = extends_.find((e) => e.source === 'Dog' && e.target === 'Animal');
    expect(dogExtendsAnimal).toBeDefined();
  });

  it('emits HAS_METHOD from each class to its methods', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    expect(hasMethod.find((e) => e.source === 'Animal' && e.target === 'speak')).toBeDefined();
    expect(hasMethod.find((e) => e.source === 'Dog' && e.target === 'bark')).toBeDefined();
  });

  it('detects Dog and Animal as Class nodes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('Dog');
    expect(classes).toContain('Animal');
  });
});

// ---------------------------------------------------------------------------
// middleclass heritage: duplicate class names must follow imports or decline
// ---------------------------------------------------------------------------

describe('Lua scope: middleclass heritage name collisions', () => {
  it('resolves an imported duplicate parent to the imported file', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-heritage-collision-'));
    try {
      writeFixtureRepo(tmpDir, {
        'lib/a.lua': `local class = require("lib.class")
local Animal = class("Animal")
return Animal
`,
        'lib/b.lua': `local class = require("lib.class")
local Animal = class("Animal")
return Animal
`,
        'dog.lua': `local class = require("lib.class")
local Animal = require("lib.a")
local Dog = class("Dog", Animal)
return Dog
`,
      });

      const result = await runPipelineFromRepo(tmpDir, () => {});
      const dogExtendsAnimal = getRelationships(result, 'EXTENDS').find(
        (edge) => edge.source === 'Dog' && edge.target === 'Animal',
      );
      expect(dogExtendsAnimal).toBeDefined();
      expect(dogExtendsAnimal?.targetFilePath?.replaceAll('\\', '/')).toContain('lib/a.lua');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);

  it('resolves an aliased imported parent to the returned class', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-heritage-alias-'));
    try {
      writeFixtureRepo(tmpDir, {
        'base.lua': `local Animal = class("Animal")
return Animal
`,
        'dog.lua': `local Base = require("base")
local Dog = class("Dog", Base)
return Dog
`,
      });

      const result = await runPipelineFromRepo(tmpDir, () => {});
      const edge = getRelationships(result, 'EXTENDS').find(
        (candidate) => candidate.source === 'Dog' && candidate.target === 'Animal',
      );
      expect(edge).toBeDefined();
      expect(edge?.targetFilePath).toContain('base.lua');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);

  it('resolves an aliased parent when the imported module defines multiple classes', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-heritage-multi-class-'));
    try {
      writeFixtureRepo(tmpDir, {
        'base.lua': `local Animal = class("Animal")
local Cat = class("Cat")
return Animal
`,
        'dog.lua': `local Base = require("base")
local Dog = class("Dog", Base)
return Dog
`,
      });

      const result = await runPipelineFromRepo(tmpDir, () => {});
      const edge = getRelationships(result, 'EXTENDS').find(
        (candidate) => candidate.source === 'Dog' && candidate.target === 'Animal',
      );
      expect(edge).toBeDefined();
      expect(edge?.targetFilePath).toContain('base.lua');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);

  it('does not guess when duplicate parents are not disambiguated by imports', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-heritage-ambiguous-'));
    try {
      writeFixtureRepo(tmpDir, {
        'lib/a.lua': `local class = require("lib.class")
local Animal = class("Animal")
return Animal
`,
        'lib/b.lua': `local class = require("lib.class")
local Animal = class("Animal")
return Animal
`,
        'dog.lua': `local class = require("lib.class")
local Dog = class("Dog", Animal)
return Dog
`,
      });

      const result = await runPipelineFromRepo(tmpDir, () => {});
      expect(
        getRelationships(result, 'EXTENDS').some(
          (edge) => edge.source === 'Dog' && edge.target === 'Animal',
        ),
      ).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);
});

describe('Lua scope: middleclass method ownership boundaries', () => {
  it('captures assignment-form methods when the owner is a known class', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-assignment-method-'));
    try {
      writeFixtureRepo(tmpDir, {
        'dog.lua': `local Dog = class("Dog")
local ignored = nil
ignored, Dog.bark = nil, function(self)
  return "woof"
end
return Dog
`,
      });

      const result = await runPipelineFromRepo(tmpDir, () => {});
      expect(
        getRelationships(result, 'HAS_METHOD').some(
          (edge) => edge.source === 'Dog' && edge.target === 'bark',
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);

  it('captures static string-key assignment-form methods', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-string-method-'));
    try {
      writeFixtureRepo(tmpDir, {
        'dog.lua': `local Dog = class("Dog")
Dog["bark"] = function(self)
  return "woof"
end
return Dog
`,
      });

      const result = await runPipelineFromRepo(tmpDir, () => {});
      expect(
        getRelationships(result, 'HAS_METHOD').some(
          (edge) => edge.source === 'Dog' && edge.target === 'bark',
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);

  it('recognizes the canonical middleclass constructor name', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-class-alias-'));
    try {
      writeFixtureRepo(tmpDir, {
        'dog.lua': `local Dog = middleclass("Dog")
return Dog
`,
      });

      const result = await runPipelineFromRepo(tmpDir, () => {});
      expect(getNodesByLabel(result, 'Class')).toContain('Dog');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);

  it('does not attach a nested function method to a middleclass owner', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-nested-method-'));
    try {
      writeFixtureRepo(tmpDir, {
        'dog.lua': `local Dog = class("Dog")
local function factory()
  function Dog:helper()
    return true
  end
end
return Dog
`,
      });

      const result = await runPipelineFromRepo(tmpDir, () => {});
      expect(
        getRelationships(result, 'HAS_METHOD').some(
          (edge) => edge.source === 'Dog' && edge.target === 'helper',
        ),
      ).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);
});

describe('Lua scope: explicit table exports', () => {
  it('selects the imported parent from a named table export', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-table-export-'));
    try {
      writeFixtureRepo(tmpDir, {
        'base.lua': `local Animal = class("Animal")
local Cat = class("Cat")
return { Animal = Animal, Cat = Cat }
`,
        'dog.lua': `local Base = require("base")
local Dog = class("Dog", Base.Animal)
return Dog
`,
      });

      const result = await runPipelineFromRepo(tmpDir, () => {});
      const edge = getRelationships(result, 'EXTENDS').find(
        (candidate) => candidate.source === 'Dog' && candidate.target === 'Animal',
      );
      expect(edge).toBeDefined();
      expect(edge?.targetFilePath).toContain('base.lua');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);

  it('selects an imported parent from a static string-key table export', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-string-table-export-'));
    try {
      writeFixtureRepo(tmpDir, {
        'base.lua': `local Animal = class("Animal")
return { ["Animal"] = Animal }
`,
        'dog.lua': `local Base = require("base")
local Dog = class("Dog", Base.Animal)
return Dog
`,
      });

      const result = await runPipelineFromRepo(tmpDir, () => {});
      expect(
        getRelationships(result, 'EXTENDS').some(
          (edge) => edge.source === 'Dog' && edge.target === 'Animal',
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);

  it('does not treat a nested function return as a module export', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-nested-export-'));
    try {
      writeFixtureRepo(tmpDir, {
        'base.lua': `local Animal = class("Animal")
local Cat = class("Cat")
local function make()
  return Animal
end
return { Cat = Cat }
`,
        'dog.lua': `local Base = require("base")
local Dog = class("Dog", Base.Animal)
return Dog
`,
      });
      const result = await runPipelineFromRepo(tmpDir, () => {});
      expect(
        getRelationships(result, 'EXTENDS').some(
          (edge) => edge.source === 'Dog' && edge.target === 'Animal',
        ),
      ).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);

  it('does not fall back to the only class when a dotted export is missing', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-missing-table-export-'));
    try {
      writeFixtureRepo(tmpDir, {
        'base.lua': `local Animal = class("Animal")
return { Cat = Animal }
`,
        'dog.lua': `local Base = require("base")
local Dog = class("Dog", Base.Animal)
return Dog
`,
      });

      const result = await runPipelineFromRepo(tmpDir, () => {});
      expect(
        getRelationships(result, 'EXTENDS').some(
          (edge) => edge.source === 'Dog' && edge.target === 'Animal',
        ),
      ).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);
});

describe('Lua scope: middleclass inherited dispatch', () => {
  it('resolves a call on a child class to an inherited parent method', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-mro-'));
    try {
      writeFixtureRepo(tmpDir, {
        'base.lua': `local Animal = class("Animal")
function Animal:speak()
  return "..."
end
return Animal
`,
        'dog.lua': `local Base = require("base")
local Dog = class("Dog", Base)
Dog.speak()
return Dog
`,
        'main.lua': 'local Dog = require("dog")\n',
      });

      const result = await runPipelineFromRepo(tmpDir, () => {});
      expect(
        getRelationships(result, 'CALLS').some(
          (edge) => edge.sourceFilePath?.endsWith('dog.lua') && edge.target === 'speak',
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);

  it('resolves middleclass __base calls to the immediate parent method', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-base-call-'));
    try {
      writeFixtureRepo(tmpDir, {
        'base.lua': `local Animal = class("Animal")
function Animal:speak()
  return "animal"
end
return Animal
`,
        'dog.lua': `local Base = require("base")
local Dog = class("Dog", Base)
function Dog:speak()
  return Dog.__base.speak(self)
end
Dog.speak()
return Dog
`,
      });
      const result = await runPipelineFromRepo(tmpDir, () => {});
      const calls = getRelationships(result, 'CALLS');
      expect(
        calls.some(
          (edge) =>
            edge.source === 'speak' &&
            edge.sourceFilePath?.endsWith('dog.lua') &&
            edge.target === 'speak' &&
            edge.targetFilePath?.endsWith('base.lua'),
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);

  it('resolves a bounded module-level callable alias chain', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-callable-alias-'));
    try {
      writeFixtureRepo(tmpDir, {
        'util.lua': `function answer()
  return 42
end
return { answer = answer }
`,
        'main.lua': `local util = require("util")
local ignored, first = nil, util.answer
local second = first
second()
`,
      });
      const result = await runPipelineFromRepo(tmpDir, () => {});
      expect(
        getRelationships(result, 'CALLS')
          .filter((edge) => edge.sourceFilePath?.endsWith('main.lua') && edge.target === 'answer')
          .map((edge) => `${path.basename(edge.targetFilePath)} ${edge.rel.reason}`),
      ).toEqual(['util.lua lua-table-path']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);

  it('fails closed for callable alias cycles, dynamic keys, and factory results', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-callable-alias-negative-'));
    try {
      writeFixtureRepo(tmpDir, {
        'util.lua': `function answer()
  return 42
end
return { answer = answer }
`,
        'main.lua': `local util = require("util")
local a = b
local b = a
a()
local key = "answer"
local dynamic = util[key]
dynamic()
local made = factory()
made()
`,
      });
      const result = await runPipelineFromRepo(tmpDir, () => {});
      const calls = getRelationships(result, 'CALLS');
      expect(
        calls.some(
          (edge) =>
            edge.sourceFilePath?.endsWith('main.lua') &&
            edge.target === 'answer' &&
            edge.targetFilePath?.endsWith('util.lua'),
        ),
      ).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);

  it('does not synthesize partial classes for constructor aliases or 30log-style calls', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-class-alias-negative-'));
    try {
      writeFixtureRepo(tmpDir, {
        'middleclass.lua': 'return function(name, parent) return {} end\n',
        '30log.lua': 'return function(name, parent) return {} end\n',
        'main.lua': `local mc = require("middleclass")
local log = require("30log")
local Dog = mc("Dog")
local Cat = log("Cat")
`,
      });
      const result = await runPipelineFromRepo(tmpDir, () => {});
      const classes = getNodesByLabel(result, 'Class');
      expect(classes.some((name) => name === 'Dog' || name === 'Cat')).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);

  it('keeps direct middleclass aliases aligned with the local class identity', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-middleclass-alias-'));
    try {
      writeFixtureRepo(tmpDir, {
        'main.lua': 'local Foo = middleclass("Bar")\nreturn Foo\n',
      });
      const result = await runPipelineFromRepo(tmpDir, () => {});
      const classes = getNodesByLabel(result, 'Class');
      expect(classes).toContain('Foo');
      expect(classes).not.toContain('Bar');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);

  it('does not assign nested anonymous method values to a middleclass owner', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-scope-nested-method-owner-'));
    try {
      writeFixtureRepo(tmpDir, {
        'main.lua': `local M = class("M")
function outer()
  M.helper = function()
    return 1
  end
end
return M
`,
      });
      const result = await runPipelineFromRepo(tmpDir, () => {});
      expect(
        getRelationships(result, 'HAS_METHOD').some(
          (edge) => edge.source === 'M' && edge.target === 'helper',
        ),
      ).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);
});

// ---------------------------------------------------------------------------
// heritage lifecycle: re-capture with no middleclass must not retain stale
// EXTENDS / HAS_METHOD facts from a prior pass (reanalysis regression)
// ---------------------------------------------------------------------------

describe('Lua scope: heritage lifecycle (no stale facts on reanalysis)', () => {
  // The capture side channel is a module-level map populated by
  // `emitLuaScopeCaptures` (worker) and snapshotted by
  // `collectLuaCaptureSideChannel`. Calling both here in the test process
  // exercises the same module instance, so a re-capture that produces no
  // heritage must drop the prior facts — otherwise reanalysis of a file that
  // lost its middleclass class would emit stale EXTENDS / HAS_METHOD edges.
  const heritageSrc = `local class = require("lib.class")
local Animal = class("Animal")
function Animal:speak() return "..." end
local Dog = class("Dog", Animal)
function Dog:bark() return "woof" end
return Dog
`;
  const noHeritageSrc = `local x = 1
return x
`;

  it('populates facts on a middleclass capture', () => {
    emitLuaScopeCaptures(heritageSrc, 'lifecycle.lua');
    const facts = collectLuaCaptureSideChannel('lifecycle.lua');
    expect(facts).toBeDefined();
    expect(facts?.extendsPairs.length).toBeGreaterThan(0);
    expect(facts?.methodOwners.length).toBeGreaterThan(0);
  });

  it('clears facts on a subsequent no-heritage capture (no stale state)', () => {
    // First capture establishes heritage facts for the file.
    emitLuaScopeCaptures(heritageSrc, 'lifecycle.lua');
    expect(collectLuaCaptureSideChannel('lifecycle.lua')).toBeDefined();
    // Re-capture with no middleclass — the prior facts must be dropped, not
    // retained for collectLuaCaptureSideChannel to snapshot as stale edges.
    emitLuaScopeCaptures(noHeritageSrc, 'lifecycle.lua');
    expect(collectLuaCaptureSideChannel('lifecycle.lua')).toBeUndefined();
  });

  it('drops a stale local-only callee fact when the local disappears', () => {
    emitLuaScopeCaptures('local function f() end\nf()\n', 'lifecycle.lua');
    expect(collectLuaCaptureSideChannel('lifecycle.lua')?.localOnlyCallees).toEqual(['f']);
    emitLuaScopeCaptures(noHeritageSrc, 'lifecycle.lua');
    expect(collectLuaCaptureSideChannel('lifecycle.lua')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Lua visibility: a bare name reaches the innermost `local`, else a global.
// Table members (`T.f`, `T:f`) and `local` functions are never reachable by a
// bare name from another scope/file. Regressions from the PZ corpus.
// ---------------------------------------------------------------------------

describe('Lua scope: bare-name visibility (no false edges)', () => {
  it('never binds a bare engine-global call to a same-named table method', async () => {
    await withLuaFixture(
      {
        'm/media/lua/client/mod/picker.lua': `local P = {}
local Picker = {}
Picker.__index = Picker
local function tr(key) return getText("UI_" .. key) end
function Picker:getText() return self.ac:getText() end
function P.new() return setmetatable({}, Picker) end
return P
`,
        'm/media/lua/client/mod/panel.lua': `require "mod/picker"
function render() return getText("UI_Title") end
`,
      },
      (result) => {
        expect(getNodesByLabel(result, 'Method')).toContain('getText');
        expect(
          getRelationships(result, 'CALLS')
            .filter((edge) => edge.target === 'getText')
            .map((edge) => `${edge.source} -> getText`),
        ).toEqual([]);
      },
    );
  }, 60000);

  it('routes a local alias call to the aliased table member, not a same-named one', async () => {
    await withLuaFixture(
      {
        'm/media/lua/shared/core.lua': `MyMod = MyMod or {}
MyMod.Client = MyMod.Client or {}
local C = MyMod.Client
function C.itemLabel(t) return t end
`,
        'm/media/lua/client/widgets.lua': `local U = {}
MyMod.Client.UI = U
function U.itemName(t) return t end
return U
`,
        'm/media/lua/client/panel.lua': `local C = MyMod.Client
local itemName = C.itemLabel
function draw(e) return itemName(e) end
`,
      },
      (result) => {
        expect(callsBetween(result, 'draw', 'itemName')).toEqual([]);
        expect(callsBetween(result, 'draw', 'itemLabel')).toEqual(['draw -> itemLabel@core.lua']);
      },
    );
  }, 60000);

  it("keeps a file's own local function callable but invisible to other files", async () => {
    await withLuaFixture(
      {
        'm/media/lua/shared/dyn.lua': `MDADDynamics = MDADDynamics or {}
local D = MDADDynamics
function D.finite(n) return n == n end
`,
        'm/media/lua/shared/profile.lua': `local function isFinite(n) return n == n end
function profileOk(x) return isFinite(x) end
`,
        'm/media/lua/shared/follower.lua': `local isFinite = MDADDynamics.finite
function laneOk(x) return isFinite(x) end
`,
      },
      (result) => {
        expect(callsBetween(result, 'profileOk', 'isFinite')).toEqual([
          'profileOk -> isFinite@profile.lua',
        ]);
        expect(callsBetween(result, 'laneOk', 'isFinite')).toEqual([]);
        expect(callsBetween(result, 'laneOk', 'finite')).toEqual(['laneOk -> finite@dyn.lua']);
      },
    );
  }, 60000);

  it('binds a forward-declared local to its later assignment, not to another file', async () => {
    await withLuaFixture(
      {
        'm/media/lua/client/mm.lua': `local getBoolOption
local function refresh() return getBoolOption("A", true) end
getBoolOption = function(id, d) return d end
`,
        'm/media/lua/client/poi.lua': `local function getBoolOption(id, d) return d end
function poiRefresh() return getBoolOption("B", false) end
`,
      },
      (result) => {
        expect(callsBetween(result, 'refresh', 'getBoolOption')).toEqual([
          'refresh -> getBoolOption@mm.lua',
        ]);
        expect(callsBetween(result, 'poiRefresh', 'getBoolOption')).toEqual([
          'poiRefresh -> getBoolOption@poi.lua',
        ]);
      },
    );
  }, 60000);

  it("lets a unique true global win over another file's local of the same name", async () => {
    await withLuaFixture(
      {
        'a.lua': 'local function helper() end\n',
        'b.lua': 'function helper() end\n',
        'c.lua': 'function run() helper() end\n',
      },
      (result) => {
        expect(callsBetween(result, 'run', 'helper')).toEqual(['run -> helper@b.lua']);
      },
    );
  }, 60000);

  it("never reaches another file's local function when no global exists", async () => {
    await withLuaFixture(
      {
        'a.lua': 'local function helper() end\n',
        'c.lua': 'function run() helper() end\n',
      },
      (result) => {
        expect(callsBetween(result, 'run', 'helper')).toEqual([]);
      },
    );
  }, 60000);

  it('does not guess a global for a call through a parameter of the same name', async () => {
    await withLuaFixture(
      {
        'lib.lua': 'function cb() end\n',
        'main.lua': 'function use(cb) cb() end\n',
      },
      (result) => {
        expect(callsBetween(result, 'use', 'cb')).toEqual([]);
      },
    );
  }, 60000);
});

// ---------------------------------------------------------------------------
// Global module tables: `MyMod = MyMod or {}`, local aliases (`local C =
// MyMod.Client`) and local tables registered under a global path
// (`C.Tx = P`) resolve member calls across files with no `require` binding.
// ---------------------------------------------------------------------------

describe('Lua scope: global table paths', () => {
  it('resolves a direct global-table member call across files', async () => {
    await withLuaFixture(
      {
        'm/media/lua/shared/f.lua': `MDADFollower = MDADFollower or {}
function MDADFollower.laneBiasAt(p) return p end
`,
        'm/media/lua/shared/d.lua': 'function drive(p) return MDADFollower.laneBiasAt(p) end\n',
      },
      (result) => {
        expect(callsBetween(result, 'drive', 'laneBiasAt')).toEqual(['drive -> laneBiasAt@f.lua']);
      },
    );
  }, 60000);

  it('follows local alias chains and a local table registered under a global path', async () => {
    await withLuaFixture(
      {
        'm/media/lua/shared/core.lua': `MinidoracatEconomy = MinidoracatEconomy or {}
local EC = MinidoracatEconomy
function EC.sortSafe(l) return l end
`,
        'm/media/lua/client/client.lua': `local EC = MinidoracatEconomy
EC.Client = EC.Client or {}
`,
        'm/media/lua/client/tx.lua': `local EC = MinidoracatEconomy
local C = EC.Client
local P = {}
C.AdminTransactions = P
function P.create(o) return o end
return P
`,
        'm/media/lua/client/admin.lua': `local EC = MinidoracatEconomy
local C = EC.Client
local Transactions = C.AdminTransactions
local Panel = {}
function Panel:build()
  EC.sortSafe({})
  return Transactions.create(self)
end
`,
      },
      (result) => {
        expect(callsBetween(result, 'build', 'create')).toEqual(['build -> create@tx.lua']);
        expect(callsBetween(result, 'build', 'sortSafe')).toEqual(['build -> sortSafe@core.lua']);
      },
    );
  }, 60000);

  it('resolves calls on an unregistered local table and through self in its methods', async () => {
    await withLuaFixture(
      {
        'm.lua': `local P = {}
function P.a() end
function P.b() P.a() end
function P:c() self:b() end
return P
`,
      },
      (result) => {
        expect(callsBetween(result, 'b', 'a')).toEqual(['b -> a@m.lua']);
        expect(callsBetween(result, 'c', 'b')).toEqual(['c -> b@m.lua']);
      },
    );
  }, 60000);

  it('refuses a path that two files define', async () => {
    await withLuaFixture(
      {
        'a.lua': 'M = M or {}\nfunction M.f() end\n',
        'b.lua': 'M = M or {}\nfunction M.f() end\n',
        'c.lua': 'function g() M.f() end\n',
      },
      (result) => {
        expect(callsBetween(result, 'g', 'f')).toEqual([]);
      },
    );
  }, 60000);

  it('refuses a reassigned alias, a parameter shadowing the table, and a computed key', async () => {
    await withLuaFixture(
      {
        'lib.lua': 'Lib = Lib or {}\nfunction Lib.a() end\nfunction Lib.b() end\n',
        'main.lua': `local f = Lib.a
f = Lib.b
function u1() f() end
function u2(Lib) Lib.a() end
function u3(k) Lib[k]() end
`,
      },
      (result) => {
        for (const caller of ['u1', 'u2', 'u3']) {
          expect(callsBetween(result, caller, 'a')).toEqual([]);
          expect(callsBetween(result, caller, 'b')).toEqual([]);
        }
      },
    );
  }, 60000);

  it('does not turn a monkey-patch wrapper into a self-call', async () => {
    await withLuaFixture(
      {
        'p.lua': `local orig = ISFoo.bar
function ISFoo.bar(self, ...) return orig(self, ...) end
`,
        'q.lua': 'function use() ISFoo.bar(1) end\n',
      },
      (result) => {
        expect(callsBetween(result, 'bar', 'bar')).toEqual([]);
        expect(callsBetween(result, 'use', 'bar')).toEqual(['use -> bar@p.lua']);
      },
    );
  }, 60000);

  it('does not index a member defined only when a function runs', async () => {
    await withLuaFixture(
      {
        'm.lua': 'M = M or {}\nfunction init() M.late = function() end end\n',
        'n.lua': 'function g() M.late() end\n',
      },
      (result) => {
        expect(callsBetween(result, 'g', 'late')).toEqual([]);
      },
    );
  }, 60000);
});

// ---------------------------------------------------------------------------
// Method-call class factories: `X = Base:derive("X")` (Project Zomboid's
// ISBaseObject), `Base:extend()`, `Base:subclass("X")` — Class + EXTENDS +
// HAS_METHOD, `self` typed as the class, super calls `Parent.m(self)`.
// ---------------------------------------------------------------------------

describe('Lua scope: class factories', () => {
  it('derives classes in one file with methods, self calls and super calls', async () => {
    await withLuaFixture(
      {
        'm/media/lua/client/hud.lua': `Tip = ISButton:derive("Tip")
function Tip:new(x) local o = ISButton.new(self, x, 0, 1, 1); return o end
function Tip:updateTooltip() end
function Tip:prerender() self:updateTooltip() end
Cap = Tip:derive("Cap")
function Cap:render() Tip.prerender(self) end
function Cap:draw() self:updateTooltip() end
`,
      },
      (result) => {
        expect(getNodesByLabel(result, 'Class')).toEqual(expect.arrayContaining(['Tip', 'Cap']));
        expect(
          getRelationships(result, 'EXTENDS').map((edge) => `${edge.source} -> ${edge.target}`),
        ).toEqual(['Cap -> Tip']);
        expect(
          getRelationships(result, 'HAS_METHOD')
            .map((edge) => `${edge.source}.${edge.target}`)
            .sort(),
        ).toEqual(['Cap.draw', 'Cap.render', 'Tip.new', 'Tip.prerender', 'Tip.updateTooltip']);
        expect(callsBetween(result, 'prerender', 'updateTooltip')).toEqual([
          'prerender -> updateTooltip@hud.lua',
        ]);
        // Inherited through Cap -> Tip.
        expect(callsBetween(result, 'draw', 'updateTooltip')).toEqual([
          'draw -> updateTooltip@hud.lua',
        ]);
        expect(callsBetween(result, 'render', 'prerender')).toEqual(['render -> prerender@hud.lua']);
        // `ISButton.new(self, …)` is the engine's constructor, not Tip:new.
        expect(callsBetween(result, 'new', 'new')).toEqual([]);
      },
    );
  }, 60000);

  it('extends a local class registered under a global path in another file', async () => {
    await withLuaFixture(
      {
        'm/media/lua/client/w.lua': `local U = {}
MyUI = U
local Button = ISButton:derive("MyButton")
function Button:onClick() end
U.Button = Button
return U
`,
        'm/media/lua/client/p.lua': `local Btn = MyUI.Button
local Fancy = Btn:derive("Fancy")
function Fancy:onPress() Btn.onClick(self) end
`,
      },
      (result) => {
        const classes = getNodesByLabel(result, 'Class');
        expect(classes).toEqual(expect.arrayContaining(['Button', 'Fancy']));
        expect(classes).not.toContain('MyButton');
        expect(
          getRelationships(result, 'EXTENDS').map(
            (edge) =>
              `${edge.source}@${path.basename(edge.sourceFilePath)} -> ${edge.target}@${path.basename(edge.targetFilePath)}`,
          ),
        ).toEqual(['Fancy@p.lua -> Button@w.lua']);
        expect(callsBetween(result, 'onPress', 'onClick')).toEqual(['onPress -> onClick@w.lua']);
      },
    );
  }, 60000);

  it('owns a method defined on a global class from another file', async () => {
    await withLuaFixture(
      {
        'm/media/lua/client/h.lua': 'Panel = ISPanel:derive("Panel")\nfunction Panel:base() end\n',
        'm/media/lua/client/ext.lua': 'function Panel:extra() self:base() end\n',
      },
      (result) => {
        expect(
          getRelationships(result, 'HAS_METHOD')
            .map((edge) => `${edge.source}.${edge.target}@${path.basename(edge.targetFilePath)}`)
            .sort(),
        ).toEqual(['Panel.base@h.lua', 'Panel.extra@ext.lua']);
        expect(callsBetween(result, 'extra', 'base')).toEqual(['extra -> base@h.lua']);
      },
    );
  }, 60000);

  it('leaves an engine parent and an engine super call unresolved', async () => {
    await withLuaFixture(
      {
        'x.lua': 'P = ISPanel:derive("P")\nfunction P:render() ISPanel.render(self) end\n',
      },
      (result) => {
        expect(getNodesByLabel(result, 'Class')).toContain('P');
        expect(getRelationships(result, 'EXTENDS')).toEqual([]);
        expect(callsBetween(result, 'render', 'render')).toEqual([]);
      },
    );
  }, 60000);

  it('does not mint a class from a multi-assignment', async () => {
    await withLuaFixture(
      {
        'x.lua': 'local A, B = ISPanel:derive("A"), 1\nfunction A:render() end\n',
      },
      (result) => {
        expect(getNodesByLabel(result, 'Class')).not.toContain('A');
      },
    );
  }, 60000);
});
