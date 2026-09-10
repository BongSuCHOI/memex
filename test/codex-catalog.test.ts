import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  catalogPathFromConfig,
  codexHome,
  findCatalogModel,
  listableModels,
  readCodexCatalog,
  reasoningEffortsForModel,
} from '../src/codex-catalog.js';

/**
 * The catalog reader is the ONLY thing that can answer "which reasoning levels
 * does this model take" before a call is made, and it runs on hosts where
 * neither file exists. So the contract is: correct precedence, and it never
 * throws — a garbled catalog degrades to free-text input, never to an error.
 */

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-codex-catalog-'));
  process.env.CODEX_HOME = home;
});

afterEach(() => {
  delete process.env.CODEX_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

const ENTRY = {
  slug: 'gpt-6-astra',
  display_name: 'GPT-6-Astra',
  description: 'frontier',
  default_reasoning_level: 'low',
  supported_reasoning_levels: [
    { effort: 'low', description: 'fast' },
    { effort: 'medium' },
    { effort: 'high' },
    { effort: 'xhigh' },
    { effort: 'max' },
    { effort: 'ultra' },
  ],
  visibility: 'list',
  supported_in_api: true,
  priority: 1,
};

function writeCache(body: unknown): void {
  fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify(body));
}

function writeUserCatalog(file: string, body: unknown): void {
  fs.writeFileSync(path.join(home, 'config.toml'), `model = "x"\nmodel_catalog_json = "${file}"\n`);
  fs.writeFileSync(file, JSON.stringify(body));
}

describe('source precedence', () => {
  it('prefers model_catalog_json over models_cache.json', () => {
    writeCache({ fetched_at: '2026-09-01T00:00:00Z', models: [{ ...ENTRY, slug: 'from-cache' }] });
    const userFile = path.join(home, 'opencodex-catalog.json');
    writeUserCatalog(userFile, [{ ...ENTRY, slug: 'from-user-catalog' }]);

    const catalog = readCodexCatalog();
    expect(catalog.source).toBe('model_catalog_json');
    expect(catalog.path).toBe(userFile);
    expect(catalog.models.map((m) => m.slug)).toEqual(['from-user-catalog']);
  });

  it('falls back to models_cache.json and keeps its fetched_at', () => {
    writeCache({ fetched_at: '2026-09-01T00:00:00Z', models: [ENTRY] });
    const catalog = readCodexCatalog();
    expect(catalog.source).toBe('models_cache');
    expect(catalog.fetchedAt).toBe('2026-09-01T00:00:00Z');
    expect(catalog.models[0].reasoningEfforts).toEqual([
      'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
    ]);
    expect(catalog.models[0].defaultReasoning).toBe('low');
  });

  it('reports source "none" when this installation has neither file', () => {
    const catalog = readCodexCatalog();
    expect(catalog).toEqual({ source: 'none', path: null, fetchedAt: null, models: [] });
  });
});

describe('never throws', () => {
  it('degrades to the next source on unparseable TOML and on corrupt JSON', () => {
    fs.writeFileSync(path.join(home, 'config.toml'), 'this is not = = toml\n');
    writeCache({ models: [ENTRY] });
    expect(readCodexCatalog().source).toBe('models_cache');

    fs.writeFileSync(path.join(home, 'models_cache.json'), '{ broken');
    expect(readCodexCatalog().source).toBe('none');
  });

  it('falls through when the configured catalog path does not exist', () => {
    fs.writeFileSync(
      path.join(home, 'config.toml'),
      `model_catalog_json = "${path.join(home, 'missing.json')}"\n`,
    );
    writeCache({ models: [ENTRY] });
    expect(readCodexCatalog().source).toBe('models_cache');
  });

  it('ignores entries with no slug and an empty catalog document', () => {
    writeCache({ models: [{ display_name: 'nameless' }, ENTRY] });
    expect(readCodexCatalog().models.map((m) => m.slug)).toEqual(['gpt-6-astra']);

    writeCache({ models: [] });
    expect(readCodexCatalog().source).toBe('none');
  });
});

describe('visibility', () => {
  it('hides non-list entries from the picker but keeps them selectable by id', () => {
    writeCache({
      models: [
        ENTRY,
        { ...ENTRY, slug: 'gpt-reserve', visibility: 'hide', priority: 2 },
      ],
    });
    const catalog = readCodexCatalog();
    expect(listableModels(catalog).map((m) => m.slug)).toEqual(['gpt-6-astra']);
    expect(findCatalogModel(catalog, 'gpt-reserve')?.visible).toBe(false);
    expect(reasoningEffortsForModel('gpt-reserve', catalog)).toContain('max');
  });

  it('orders by catalog priority then slug', () => {
    writeCache({
      models: [
        { ...ENTRY, slug: 'third', priority: 9 },
        { ...ENTRY, slug: 'first', priority: 1 },
        { ...ENTRY, slug: 'second', priority: 5 },
      ],
    });
    expect(readCodexCatalog().models.map((m) => m.slug)).toEqual(['first', 'second', 'third']);
  });
});

describe('reasoning level lookup', () => {
  it('returns null for an unknown model so a stale catalog cannot refuse a write', () => {
    writeCache({ models: [ENTRY] });
    const catalog = readCodexCatalog();
    expect(reasoningEffortsForModel('not-in-catalog', catalog)).toBeNull();
  });

  it('returns null for a catalog entry that declares no levels', () => {
    writeCache({ models: [{ slug: 'bare' }] });
    expect(reasoningEffortsForModel('bare', readCodexCatalog())).toBeNull();
  });
});

it('resolves CODEX_HOME, defaulting to ~/.codex', () => {
  expect(codexHome()).toBe(path.resolve(home));
  expect(catalogPathFromConfig()).toBeNull();
  delete process.env.CODEX_HOME;
  expect(codexHome()).toBe(path.join(os.homedir(), '.codex'));
});
