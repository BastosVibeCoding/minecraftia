import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/core/clock.js';
import { GapRecorder } from '../src/gaps/gaps.js';
import { openDatabase } from '../src/store/db.js';

describe('compétences manquantes', () => {
  const setup = () => new GapRecorder(openDatabase(':memory:').db, new ManualClock(0));

  it('compte les ordres non exécutés, sans tenir compte du prénom ni de la ponctuation', () => {
    const g = setup();
    g.unfulfilledOrder('Alex, va pêcher !');
    g.unfulfilledOrder('va pêcher');
    expect(g.top()).toEqual([expect.objectContaining({ kind: 'ordre', count: 2, label: expect.stringContaining('va pêcher') })]);
  });

  it('repère les outils et les blocs que les compétences ne couvrent pas, et ignore le reste', () => {
    const g = setup();
    g.observe({ t: 0, type: 'equip', player: 'B', slot: 'hand', item: 'fishing_rod' });
    g.observe({ t: 0, type: 'equip', player: 'B', slot: 'hand', item: 'iron_sword' });
    g.observe({ t: 0, type: 'block_placed', player: 'B', pos: { x: 0, y: 64, z: 0 }, block: 'redstone_wire' });
    g.observe({ t: 0, type: 'block_placed', player: 'B', pos: { x: 1, y: 64, z: 0 }, block: 'stone_bricks' });
    // coffre et four : couverts par store/retrieve/smelt
    g.observe({ t: 0, type: 'block_placed', player: 'B', pos: { x: 2, y: 64, z: 0 }, block: 'chest' });
    g.observe({ t: 0, type: 'block_placed', player: 'B', pos: { x: 3, y: 64, z: 0 }, block: 'furnace' });
    expect(g.top().map((x) => x.key).sort()).toEqual(['outil:fishing_rod', 'pose:redstone_wire']);
  });
});

describe("manques relevés en jeu (2026-10-04)", () => {
  it("phrase adressée au bot mais incomprise, et ordre exécuté qui échoue", () => {
    const g = new GapRecorder(openDatabase(':memory:').db, new ManualClock(0));
    g.misunderstood('Alex, 5-3-HEL.');
    g.failedOrder('alex fait 3 echelles', 'craft', 'recette introuvable');
    g.failedOrder('alex fait 3 echelles', 'craft', 'recette introuvable');
    const top = g.top();
    expect(top[0]).toMatchObject({ kind: 'ordre', count: 2, example: 'alex fait 3 echelles → recette introuvable' });
    expect(top[0]!.label).toContain('ordre échoué (craft)');
    expect(top[1]!.label).toContain('phrase non comprise');
  });
});
