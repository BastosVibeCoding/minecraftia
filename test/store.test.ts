import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/core/clock.js';
import { getMeta, openDatabase, schemaVersion } from '../src/store/db.js';
import { HashingEmbedder, type Embedder } from '../src/store/embedder.js';
import { contentHash, importJson } from '../src/store/legacyImport.js';
import { MIGRATIONS } from '../src/store/migrations.js';
import { Store } from '../src/store/store.js';
import { MemoryVectorIndex, SqliteVecIndex, cosine } from '../src/store/vectorIndex.js';

function randomVector(seed: number, dims = 384): Float32Array {
  let s = seed;
  const v = new Float32Array(dims);
  for (let i = 0; i < dims; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    v[i] = s / 2147483648 - 0.5;
  }
  return v;
}

describe('base SQLite', () => {
  it('applique les migrations et charge sqlite-vec', () => {
    const { db, vecAvailable } = openDatabase(':memory:');
    expect(vecAvailable).toBe(true);
    expect(schemaVersion(db)).toBe(MIGRATIONS.at(-1)!.version);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    for (const t of ['episodes', 'nodes', 'node_embeddings', 'node_evidence', 'autonomy', 'utterances', 'decisions', 'outcomes', 'decision_cache', 'llm_calls', 'legacy_import']) {
      expect(tables).toContain(t);
    }
  });

  it('le repli fonctionne quand sqlite-vec est désactivé', () => {
    const { vecAvailable } = openDatabase(':memory:', { vector: 'off' });
    expect(vecAvailable).toBe(false);
  });
});

describe('index vectoriel', () => {
  it('sqlite-vec et le repli mémoire renvoient les mêmes voisins', () => {
    const a = openDatabase(':memory:').db;
    const b = openDatabase(':memory:', { vector: 'off' }).db;
    // les vecteurs référencent des nœuds (clé étrangère) : on crée des nœuds factices
    for (const db of [a, b]) {
      const ins = db.prepare("INSERT INTO nodes(id, level, domain, label, decayed_at, created_at) VALUES (?, 'situation', 'build', 'n', 0, 0)");
      for (let i = 1; i <= 50; i++) ins.run(i);
    }
    const vec = new SqliteVecIndex(a, 384);
    const mem = new MemoryVectorIndex(b, 384);
    for (let i = 1; i <= 50; i++) {
      vec.upsert(i, randomVector(i));
      mem.upsert(i, randomVector(i));
    }
    for (const q of [3, 17, 999]) {
      const query = randomVector(q);
      const r1 = vec.search(query, 5);
      const r2 = mem.search(query, 5);
      expect(r1.map((h) => h.id)).toEqual(r2.map((h) => h.id));
      r1.forEach((h, i) => expect(h.similarity).toBeCloseTo(r2[i]!.similarity, 4));
    }
    expect(vec.search(randomVector(17), 1)[0]).toMatchObject({ id: 17 });
    vec.remove(17);
    expect(vec.search(randomVector(17), 1)[0]!.id).not.toBe(17);
    expect(vec.size()).toBe(49);
  });

  it('le repli mémoire recharge les vecteurs persistés', () => {
    const { db } = openDatabase(':memory:', { vector: 'off' });
    db.prepare("INSERT INTO nodes(id, level, domain, label, decayed_at, created_at) VALUES (1, 'situation', 'build', 'n', 0, 0)").run();
    new MemoryVectorIndex(db, 384).upsert(1, randomVector(1));
    const reloaded = new MemoryVectorIndex(db, 384);
    expect(reloaded.size()).toBe(1);
    expect(cosine(reloaded.get(1)!, randomVector(1))).toBeCloseTo(1, 5);
  });

  it('refuse un vecteur de mauvaise dimension', () => {
    const { db } = openDatabase(':memory:');
    expect(() => new SqliteVecIndex(db, 384).search(new Float32Array(10), 3)).toThrow(/dimension/);
  });
});

describe('embedder déterministe', () => {
  it('rapproche les textes qui partagent des mots', async () => {
    const e = new HashingEmbedder();
    const [a, b, c] = await e.embed(['mur en pierre taillée symétrique', 'grand mur en pierre taillée', 'combat au corps à corps contre un zombie']);
    expect(cosine(a!, b!)).toBeGreaterThan(cosine(a!, c!));
    expect(a!.length).toBe(384);
    const [again] = await e.embed(['mur en pierre taillée symétrique']);
    expect(Array.from(again!)).toEqual(Array.from(a!));
  });
});

describe('Store', () => {
  it('reconstruit l\'index quand l\'embedder change', async () => {
    const clock = new ManualClock(1000);
    const path = ':memory:';
    const store = await Store.open(path, new HashingEmbedder(), clock);
    const root = store.domainRoot('build');
    const id = await store.insertNode({ parentId: root, level: 'situation', domain: 'build', label: 'mur de pierre' });
    expect(getMeta(store.db, 'embedder')).toBe('hashing-v1');
    const other: Embedder = { name: 'autre', dims: 384, embed: async (t) => t.map(() => randomVector(42)) };
    const swapped = Object.assign(Object.create(Object.getPrototypeOf(store)), store, { embedder: other }) as Store;
    expect(await swapped.reindexIfEmbedderChanged()).toBe(true);
    expect(cosine(store.index.get(id)!, randomVector(42))).toBeCloseTo(1, 5);
    expect(await swapped.reindexIfEmbedderChanged()).toBe(false);
  });

  it('la racine d\'un domaine est unique et commence à poids nul', async () => {
    const store = await Store.open(':memory:', new HashingEmbedder(), new ManualClock());
    const a = store.domainRoot('combat');
    expect(store.domainRoot('combat')).toBe(a);
    expect(store.getNode(a)).toMatchObject({ level: 'domain', weight: 0 });
  });
});

describe('migration JSON', () => {
  const exportJson = JSON.stringify({
    format: 'minecraftia-export',
    version: 1,
    episodes: [
      { player: 'Bastien', domain: 'build', kind: 'wall', summary: 'mur 7x4 en pierre taillée', params: { w: 7, h: 4 }, startedAt: 1, endedAt: 2 },
      { player: 'Bastien', domain: 'nimporte', kind: 'x', summary: 'domaine invalide', startedAt: 1, endedAt: 2 },
    ],
    nodes: [{ domain: 'build', situation: 'construire un mur', mechanism: { skill: 'build', material: 'stone_bricks' }, weight: 3 }],
    autonomy: { build: 0.4, cuisine: 0.9 },
    champInconnu: { garde: 'moi' },
  });

  it('mappe ce qui est reconnu et conserve tout le reste brut', async () => {
    const store = await Store.open(':memory:', new HashingEmbedder(), new ManualClock());
    const report = await importJson(store, 'ancien.json', exportJson);
    expect(report).toMatchObject({ skipped: false, episodes: 1, nodes: 1, autonomy: 1 });
    expect(report.unmapped).toEqual(['$.episodes[1]', '$.autonomy.cuisine']);
    expect(store.listEpisodes()[0]).toMatchObject({ kind: 'wall', source: 'legacy', params: { w: 7, h: 4 } });
    expect(store.getAutonomy().build?.score).toBe(0.4);
    const situation = store.listNodes({ level: 'situation' })[0]!;
    expect(situation).toMatchObject({ label: 'construire un mur', weight: 3 });
    expect(store.listNodes({ level: 'mechanism', parentId: situation.id })[0]!.mechanism).toEqual({ skill: 'build', material: 'stone_bricks' });
    expect(store.index.size()).toBe(2);
  });

  it('aller-retour sans perte : le contenu brut stocké reproduit exactement le fichier', async () => {
    const store = await Store.open(':memory:', new HashingEmbedder(), new ManualClock());
    await importJson(store, 'ancien.json', exportJson);
    const raw = store.listLegacy('ancien.json').find((r) => r.jsonPath === '$')!;
    expect(raw.rawJson).toBe(exportJson);
    expect(raw.contentHash).toBe(contentHash(exportJson));
    expect(JSON.parse(raw.rawJson).champInconnu).toEqual({ garde: 'moi' });
    // chaque élément invalide garde aussi sa copie individuelle
    const bad = store.listLegacy('ancien.json').find((r) => r.jsonPath === '$.episodes[1]')!;
    expect(bad.mappedTo).toBeNull();
    expect(JSON.parse(bad.rawJson).summary).toBe('domaine invalide');
  });

  it('est idempotente', async () => {
    const store = await Store.open(':memory:', new HashingEmbedder(), new ManualClock());
    await importJson(store, 'a.json', exportJson);
    const again = await importJson(store, 'a.json', exportJson);
    expect(again.skipped).toBe(true);
    expect(store.listEpisodes()).toHaveLength(1);
  });

  it('conserve un JSON de format inconnu ou invalide', async () => {
    const store = await Store.open(':memory:', new HashingEmbedder(), new ManualClock());
    const r1 = await importJson(store, 'etat.json', '{"lieux":{"base":[1,2,3]}}');
    const r2 = await importJson(store, 'casse.json', '{pas du json');
    expect(r1.unmapped).toHaveLength(1);
    expect(r2.unmapped[0]).toContain('invalide');
    expect(JSON.parse(store.listLegacy('etat.json')[0]!.rawJson)).toEqual({ lieux: { base: [1, 2, 3] } });
    expect(JSON.parse(store.listLegacy('casse.json')[0]!.rawJson)).toBe('{pas du json');
  });
});
