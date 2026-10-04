import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/core/clock.js';
import { Observer } from '../src/observer/observer.js';
import type { Episode } from '../src/observer/types.js';
import { builderLog } from '../src/sim/players.js';
import { HashingEmbedder } from '../src/store/embedder.js';
import { Store } from '../src/store/store.js';
import { mechanismSignature, mergeMechanism, publicMechanism } from '../src/tree/merge.js';
import { BehaviorTree } from '../src/tree/tree.js';

function episode(over: Partial<Episode> = {}): Episode {
  return {
    player: 'Bastien',
    domain: 'build',
    kind: 'wall',
    summary: 'a construit un mur 7×4 en stone bricks',
    situation: { text: 'construire un mur' },
    mechanism: { skill: 'build', shape: 'wall', dims: { width: 7, height: 4, depth: 1 }, material: 'stone_bricks', symmetric: true },
    params: {},
    source: 'observed',
    startedAt: 0,
    endedAt: 10,
    ...over,
  };
}

describe('fusion de mécanismes', () => {
  it('moyenne les nombres et garde la catégorie dominante', () => {
    let m = mergeMechanism(null, { skill: 'build', shape: 'wall', dims: { width: 7 }, material: 'stone_bricks' }, 1);
    m = mergeMechanism(m, { skill: 'build', shape: 'wall', dims: { width: 9 }, material: 'stone_bricks' }, 1);
    m = mergeMechanism(m, { skill: 'build', shape: 'wall', dims: { width: 5 }, material: 'cobblestone' }, 1);
    expect(publicMechanism(m)).toEqual({ skill: 'build', shape: 'wall', dims: { width: 7 }, material: 'stone_bricks' });
  });

  it('une observation lourde (enseignement) déplace davantage la préférence', () => {
    let m = mergeMechanism(null, { skill: 'build', shape: 'wall', material: 'stone_bricks' }, 1);
    m = mergeMechanism(m, { skill: 'build', shape: 'wall', material: 'stone_bricks' }, 1);
    m = mergeMechanism(m, { skill: 'build', shape: 'wall', material: 'deepslate_bricks' }, 3);
    expect(m.material).toBe('deepslate_bricks');
  });

  it('fusionne les listes par fréquence', () => {
    let m = mergeMechanism(null, { skill: 'attack', targets: ['zombie', 'spider'] }, 1);
    m = mergeMechanism(m, { skill: 'attack', targets: ['zombie'] }, 1);
    expect(m.targets).toEqual(['zombie', 'spider']);
  });

  it('distingue les mécanismes concurrents par leur signature', () => {
    expect(mechanismSignature({ skill: 'build', shape: 'wall' })).not.toBe(mechanismSignature({ skill: 'build', shape: 'house' }));
    expect(mechanismSignature({ skill: 'collect', targets: ['iron_ore'] })).toBe('collect:iron_ore');
  });
});

describe('ingestion des épisodes', () => {
  async function setup() {
    const store = await Store.open(':memory:', new HashingEmbedder(), new ManualClock(1000));
    return { store, tree: new BehaviorTree(store) };
  }

  it('crée situation et mécanisme, puis renforce au lieu de dupliquer', async () => {
    const { store, tree } = await setup();
    const a = await tree.ingest(episode());
    expect(a).toMatchObject({ createdSituation: true, createdMechanism: true });
    const b = await tree.ingest(episode({ mechanism: { skill: 'build', shape: 'wall', dims: { width: 9, height: 4, depth: 1 }, material: 'stone_bricks', symmetric: true } }));
    expect(b).toMatchObject({ createdSituation: false, createdMechanism: false, situationId: a.situationId, mechanismId: a.mechanismId });
    const mech = store.getNode(a.mechanismId)!;
    expect(mech.weight).toBe(2);
    expect(mech.uses).toBe(2);
    expect((mech.mechanism as { dims: { width: number } }).dims.width).toBe(8);
    expect(store.listEpisodes()).toHaveLength(2);
  });

  it('une autre forme crée un mécanisme concurrent sous la même situation', async () => {
    const { store, tree } = await setup();
    const a = await tree.ingest(episode());
    const b = await tree.ingest(episode({ mechanism: { skill: 'build', shape: 'pillar', material: 'stone_bricks' } }));
    expect(b.situationId).toBe(a.situationId);
    expect(b.mechanismId).not.toBe(a.mechanismId);
    expect(store.listNodes({ parentId: a.situationId, level: 'mechanism' })).toHaveLength(2);
  });

  it('l\'enseignement pèse trois fois une observation passive', async () => {
    const { store, tree } = await setup();
    const r = await tree.ingest(episode({ source: 'taught' }));
    expect(store.getNode(r.mechanismId)!.weight).toBe(3);
  });

  it('une situation d\'un autre domaine n\'est jamais fusionnée', async () => {
    const { tree } = await setup();
    const a = await tree.ingest(episode());
    const b = await tree.ingest(episode({ domain: 'combat', mechanism: { skill: 'attack', targets: ['zombie'] } }));
    expect(b.situationId).not.toBe(a.situationId);
  });

  it('un journal de bâtisseur donne un arbre compact (fusion effective)', async () => {
    const { store, tree } = await setup();
    const episodes: Episode[] = [];
    const obs = new Observer('Batisseur', (e) => episodes.push(e));
    for (const e of builderLog(40)) obs.push(e);
    obs.flush();
    for (const ep of episodes) await tree.ingest(ep);
    const situations = store.listNodes({ level: 'situation' });
    expect(situations.length).toBeLessThan(episodes.length / 2);
    expect(situations[0]!.domain).toBe('build');
  });
});
