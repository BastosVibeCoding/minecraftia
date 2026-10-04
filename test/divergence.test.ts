import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/core/clock.js';
import { DOMAINS, type Domain } from '../src/core/types.js';
import { Observer } from '../src/observer/observer.js';
import type { Episode, RawEvent } from '../src/observer/types.js';
import { builderLog, fighterLog } from '../src/sim/players.js';
import { HashingEmbedder } from '../src/store/embedder.js';
import { Store } from '../src/store/store.js';
import { BehaviorTree } from '../src/tree/tree.js';

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
