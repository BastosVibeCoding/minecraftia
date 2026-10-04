import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/core/clock.js';
import type { Episode } from '../src/observer/types.js';
import { HashingEmbedder } from '../src/store/embedder.js';
import { Store } from '../src/store/store.js';
import { PlayClock } from '../src/tree/playClock.js';
import { BehaviorTree } from '../src/tree/tree.js';

const HOUR = 3_600_000;

function episode(over: Partial<Episode> = {}): Episode {
  return {
    player: 'Bastien',
    domain: 'build',
    kind: 'wall',
    summary: 'a construit un mur en stone bricks',
    situation: { text: 'construire un mur' },
    mechanism: { skill: 'build', shape: 'wall', material: 'stone_bricks' },
    params: {},
    source: 'observed',
    startedAt: 0,
    endedAt: 1,
    ...over,
  };
}

async function setup() {
  const clock = new ManualClock(0);
  const store = await Store.open(':memory:', new HashingEmbedder(), clock);
  let play = 0;
  const tree = new BehaviorTree(store, { playTime: () => play, halfLifeMs: 6 * HOUR });
  return { store, tree, clock, advancePlay: (ms: number) => (play += ms) };
}

describe('décroissance', () => {
  it('le poids est divisé par deux après une demi-vie de jeu actif', async () => {
    const { store, tree, advancePlay } = await setup();
    const r = await tree.ingest(episode({ source: 'taught' })); // poids 3
    advancePlay(6 * HOUR);
    expect(tree.effectiveWeight(store.getNode(r.mechanismId)!)).toBeCloseTo(1.5, 5);
    advancePlay(6 * HOUR);
    expect(tree.effectiveWeight(store.getNode(r.mechanismId)!)).toBeCloseTo(0.75, 5);
  });

  it('un renforcement part du poids décru, pas du poids brut', async () => {
    const { store, tree, advancePlay } = await setup();
    const r = await tree.ingest(episode({ source: 'taught' })); // 3
    advancePlay(6 * HOUR); // → 1,5
    await tree.ingest(episode()); // + 1
    expect(tree.effectiveWeight(store.getNode(r.mechanismId)!)).toBeCloseTo(2.5, 5);
  });

  it('l\'horloge de jeu n\'avance pas hors ligne et persiste', async () => {
    const clock = new ManualClock(0);
    const store = await Store.open(':memory:', new HashingEmbedder(), clock);
    const play = new PlayClock(store.db, clock);
    play.setActive(true);
    clock.advance(HOUR);
    play.setActive(false);
    clock.advance(7 * 24 * HOUR); // une semaine sans jouer
    expect(play.now()).toBe(HOUR);
    const reopened = new PlayClock(store.db, clock);
    expect(reopened.now()).toBe(HOUR);
  });
});

describe('renforcement et correction', () => {
  it('approbation : +2 sur le mécanisme, +1 sur la situation', async () => {
    const { store, tree } = await setup();
    const r = await tree.ingest(episode());
    tree.approve(r.mechanismId);
    expect(store.getNode(r.mechanismId)!.weight).toBe(3);
    expect(store.getNode(r.situationId)!.weight).toBe(2);
  });

  it('réussite et échec modifient le poids et les compteurs', async () => {
    const { store, tree } = await setup();
    const r = await tree.ingest(episode());
    tree.recordOutcome(r.mechanismId, true);
    tree.recordOutcome(r.mechanismId, false);
    const n = store.getNode(r.mechanismId)!;
    expect(n.weight).toBeCloseTo(0.5, 5);
    expect(n).toMatchObject({ successes: 1, failures: 1, uses: 3 });
  });

  it('une correction pèse plus que tout : même un mécanisme très renforcé passe « à éviter »', async () => {
    const { tree } = await setup();
    let r = await tree.ingest(episode());
    for (let i = 0; i < 9; i++) r = await tree.ingest(episode()); // poids 10
    tree.correct(r.mechanismId);
    const branches = tree.searchVector((await tree.store.embedder.embed(['construire un mur']))[0]!);
    expect(branches[0]!.mechanisms.find((m) => m.id === r.mechanismId)).toBeUndefined();
    expect(branches[0]!.avoid.map((a) => a.id)).toContain(r.mechanismId);
  });

  it('après correction, le mécanisme alternatif montré par le joueur prend la tête', async () => {
    const { tree } = await setup();
    const wrong = await tree.ingest(episode());
    await tree.ingest(episode());
    tree.correct(wrong.mechanismId);
    await tree.ingest(episode({ source: 'corrected', mechanism: { skill: 'build', shape: 'wall_with_windows', material: 'stone_bricks' } }));
    const [branch] = await tree.search('construire un mur');
    expect(branch!.mechanisms[0]!.mechanism).toMatchObject({ shape: 'wall_with_windows' });
  });

  it('chaque variation laisse une preuve consultable', async () => {
    const { store, tree } = await setup();
    const r = await tree.ingest(episode());
    tree.approve(r.mechanismId);
    tree.correct(r.mechanismId);
    const kinds = (store.db.prepare('SELECT kind FROM node_evidence WHERE node_id = ? ORDER BY id').all(r.mechanismId) as { kind: string }[]).map((e) => e.kind);
    expect(kinds).toEqual(['observed', 'approval', 'correction']);
  });
});

describe('recherche', () => {
  it('renvoie les situations proches, classées par similarité et poids', async () => {
    const { tree } = await setup();
    await tree.ingest(episode());
    await tree.ingest(episode({ domain: 'combat', situation: { text: 'combattre un zombie la nuit' }, mechanism: { skill: 'attack', targets: ['zombie'] } }));
    const branches = await tree.search('combattre un zombie');
    expect(branches[0]!.domain).toBe('combat');
    expect(branches[0]!.mechanisms[0]!.mechanism).toMatchObject({ skill: 'attack' });
    expect(branches[0]!.mechanisms[0]!.mechanism).not.toHaveProperty('_stats');
  });

  it('filtre par domaine', async () => {
    const { tree } = await setup();
    await tree.ingest(episode());
    expect(await tree.search('construire un mur', { domain: 'combat' })).toEqual([]);
  });
});

describe('oubli', () => {
  it('!oublie retire les nœuds proches, de façon réversible', async () => {
    const { tree } = await setup();
    await tree.ingest(episode());
    await tree.ingest(episode({ domain: 'combat', situation: { text: 'combattre un zombie' }, mechanism: { skill: 'attack', targets: ['zombie'] } }));
    const forgotten = await tree.forget('construire un mur');
    expect(forgotten.length).toBeGreaterThan(0);
    expect(await tree.search('construire un mur', { domain: 'build' })).toEqual([]);
    expect(await tree.search('combattre un zombie')).not.toEqual([]);
    tree.restore(forgotten.map((n) => n.id));
    expect(await tree.search('construire un mur', { domain: 'build' })).not.toEqual([]);
  });
});
