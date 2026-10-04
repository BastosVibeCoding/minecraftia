import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EasyLlmMapper } from '../src/bot/easyLlmMapping.js';
import { Observer } from '../src/observer/observer.js';
import type { Episode, RawEvent } from '../src/observer/types.js';

/** Messages réels du mod Easy LLM, capturés sur le serveur pendant une session du joueur scripté. */
const capture = readFileSync(new URL('./fixtures/easyllm-capture.jsonl', import.meta.url), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Record<string, unknown>);

function mapAll(): RawEvent[] {
  const mapper = new EasyLlmMapper(() => 1_000_000);
  return capture.flatMap((m) => mapper.map(m));
}

describe('traduction Easy LLM (capture réelle)', () => {
  const events = mapAll();
  const of = <T extends RawEvent['type']>(type: T) => events.filter((e): e is Extract<RawEvent, { type: T }> => e.type === type);

  it('attribue les poses de pierre taillée au joueur qui a frappé à portée', () => {
    const placed = of('block_placed');
    expect(placed.length).toBeGreaterThanOrEqual(15);
    expect(placed.every((e) => e.player === 'Testeur' && e.block === 'stone_bricks')).toBe(true);
  });

  it('traduit les casses avec joueur et outil', () => {
    const broken = of('block_broken');
    expect(broken.length).toBeGreaterThan(0);
    expect(broken[0]).toMatchObject({ player: 'Testeur', tool: expect.any(String) });
  });

  it('traduit l\'artisanat exact', () => {
    expect(of('craft').map((c) => c.item)).toEqual(expect.arrayContaining(['oak_planks', 'crafting_table']));
    expect(of('craft').find((c) => c.item === 'oak_planks')).toMatchObject({ count: 4, consumed: { oak_log: 1 } });
  });

  it('suit l\'équipement et les déplacements avec le biome', () => {
    expect(of('equip').map((e) => e.item)).toEqual(expect.arrayContaining(['stone_bricks', 'iron_sword']));
    expect(of('move')[0]).toMatchObject({ player: 'Testeur', biome: 'plains' });
  });

  it('les temps sont croissants et dérivés des ticks', () => {
    const ts = events.map((e) => e.t);
    expect(ts.every((t, i) => i === 0 || t >= ts[i - 1]!)).toBe(true);
  });

  it('chaîne complète : capture réelle → observateur → épisode « mur en pierre taillée »', () => {
    const episodes: Episode[] = [];
    const obs = new Observer('Testeur', (e) => episodes.push(e));
    for (const e of events) obs.push(e);
    obs.flush();
    const wall = episodes.find((e) => e.domain === 'build');
    expect(wall).toBeDefined();
    expect(wall!.kind).toBe('wall');
    expect(wall!.mechanism).toMatchObject({ material: 'stone_bricks', order: 'bottom_up' });
    expect(episodes.some((e) => e.domain === 'craft')).toBe(true);
  });

  it('ignore une pose sans coup de bras récent', () => {
    const mapper = new EasyLlmMapper(() => 0);
    mapper.map({ type: 'players_tick', tick: 1, data: { players: { u: { name: 'A', visible: { position: [0, 64, 0], equipment: {} }, hidden: {} } } } });
    const out = mapper.map({ type: 'block_update', tick: 100, data: { pos: [1, 64, 0], old: { blockName: 'air' }, new: { blockName: 'stone' } } });
    expect(out).toEqual([]);
  });

  it('compte les types inconnus sans planter', () => {
    const mapper = new EasyLlmMapper(() => 0);
    expect(mapper.map({ type: 'nouveau_type', data: {} })).toEqual([]);
    expect(mapper.ignored.get('nouveau_type')).toBe(1);
  });
});
