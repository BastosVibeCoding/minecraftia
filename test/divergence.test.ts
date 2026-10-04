import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/core/clock.js';
import { DOMAINS, type Domain } from '../src/core/types.js';
import { Observer } from '../src/observer/observer.js';
import type { Episode, RawEvent } from '../src/observer/types.js';
import { builderLog, fighterLog } from '../src/sim/players.js';
import { HashingEmbedder } from '../src/store/embedder.js';
import { Store } from '../src/store/store.js';
import { BehaviorTree } from '../src/tree/tree.js';
import { Budget } from '../src/decider/budget.js';
import { DecisionCache } from '../src/decider/cache.js';
import { Decider } from '../src/decider/decider.js';
import { ModelRouter } from '../src/decider/router.js';
import type { WorldState } from '../src/decider/world.js';
import { RationalStubLlm } from '../src/sim/stubLlm.js';
import { MirrorStrategy } from '../src/strategy/strategy.js';
import { silentLogger } from './helpers.js';

/** Base vierge nourrie avec un journal d'événements simulé : renvoie l'arbre appris. */
export async function learnFrom(log: RawEvent[], player: string): Promise<BehaviorTree> {
  const store = await Store.open(':memory:', new HashingEmbedder(), new ManualClock(0));
  const tree = new BehaviorTree(store, { playTime: () => 0 });
  const episodes: Episode[] = [];
  const obs = new Observer(player, (e) => episodes.push(e));
  for (const e of log) obs.push(e);
  obs.flush();
  for (const ep of episodes) await tree.ingest(ep);
  return tree;
}

function dominant(profile: Record<Domain, number>): Domain {
  return DOMAINS.reduce((a, b) => (profile[b] > profile[a] ? b : a));
}

function cosineProfiles(a: Record<Domain, number>, b: Record<Domain, number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const d of DOMAINS) {
    dot += a[d] * b[d];
    na += a[d] ** 2;
    nb += b[d] ** 2;
  }
  return dot / Math.sqrt(na * nb);
}

describe('test de divergence (arbres)', () => {
  it('un bâtisseur et un combattant produisent deux arbres nettement différents', async () => {
    const builder = await learnFrom(builderLog(60), 'Batisseur');
    const fighter = await learnFrom(fighterLog(60), 'Combattant');
    const pb = builder.profile();
    const pf = fighter.profile();

    // la spécialité émerge sans avoir été choisie
    expect(dominant(pb)).toBe('build');
    expect(dominant(pf)).toBe('combat');
    // le bâtisseur n'a rien appris du combat, le combattant rien de la construction
    expect(pb.combat).toBe(0);
    expect(pf.build).toBe(0);
    // profils presque orthogonaux
    expect(cosineProfiles(pb, pf)).toBeLessThan(0.3);

    // meilleur mécanisme de chacun sur son domaine dominant (l'embedder de test est lexical : requêtes au vocabulaire partagé)
    const [bTop] = await builder.search('construire près de la base', { domain: 'build' });
    const [fTop] = await fighter.search('combattre un monstre', { domain: 'combat' });
    expect(bTop!.mechanisms[0]!.mechanism).toMatchObject({ skill: 'build' });
    expect(fTop!.mechanisms[0]!.mechanism).toMatchObject({ skill: 'attack', weapon: 'iron_sword' });
  });

  it('les préférences apprises reflètent le joueur (matériau, arme, bouclier)', async () => {
    const builder = await learnFrom(builderLog(60), 'Batisseur');
    const fighter = await learnFrom(fighterLog(60), 'Combattant');
    const walls = await builder.search('construire un mur', { domain: 'build' });
    const wallMech = walls.flatMap((b) => b.mechanisms).find((m) => m.mechanism?.shape === 'wall');
    expect(wallMech?.mechanism).toMatchObject({ material: 'stone_bricks', order: 'bottom_up' });
    const fights = await fighter.search('combattre zombie', { domain: 'combat' });
    const fightMech = fights[0]!.mechanisms[0]!.mechanism!;
    expect(fightMech.useShield).toBe(true);
    expect(fightMech.engageDistance as number).toBeLessThan(3.5);
  });
});

describe('test de divergence (comportements)', () => {
  async function decideWith(tree: BehaviorTree, w: WorldState) {
    const clock = new ManualClock(0);
    const decider = new Decider({
      tree,
      llm: new RationalStubLlm(),
      budget: new Budget(tree.store.db, clock, 5),
      cache: new DecisionCache(tree.store.db, clock),
      router: new ModelRouter('fast', 'strong'),
      strategy: new MirrorStrategy(),
      autonomy: () => Object.fromEntries(DOMAINS.map((d) => [d, { band: 'imitate' as const, score: 0.4 }])) as never,
      clock,
      logger: silentLogger,
    });
    return (await decider.decide('test', w)).decision;
  }

  const base: WorldState = {
    bot: { health: 20, food: 20, position: { x: 0, y: 64, z: 0 }, dimension: 'overworld', heldItem: null, inventory: { stone_bricks: 64, iron_sword: 1, shield: 1 } },
    player: { name: 'P', online: true, distance: 3, heldItem: null, activity: [], recent: [] },
    threats: [],
    time: 'jour',
    biome: 'plains',
  };

  it("mêmes stimuli, deux bots : l'un construit, l'autre combat", async () => {
    const builder = await learnFrom(builderLog(60), 'Batisseur');
    const fighter = await learnFrom(fighterLog(60), 'Combattant');

    // stimulus 1 : un zombie approche
    const zombie: WorldState = { ...base, threats: [{ name: 'zombie', distance: 6 }] };
    const fz = await decideWith(fighter, zombie);
    const bz = await decideWith(builder, zombie);
    expect(fz).toMatchObject({ skill: 'attack', params: { targets: expect.arrayContaining(['zombie']), useShield: true } });
    expect(bz.skill).not.toBe('attack');

    // stimulus 2 : le joueur se met à construire un mur
    const building: WorldState = { ...base, player: { ...base.player, activity: ['build'], recent: ['a construit un mur en stone bricks'] } };
    const bb = await decideWith(builder, building);
    const fb = await decideWith(fighter, building);
    expect(bb).toMatchObject({ skill: 'build', params: { material: 'stone_bricks' } });
    expect(fb.skill).not.toBe('build');
  });
});
