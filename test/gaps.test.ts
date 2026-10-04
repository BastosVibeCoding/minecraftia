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
    expect(g.top().map((x) => x.key).sort()).toEqual(['outil:fishing_rod', 'pose:redstone_wire']);
  });
});
