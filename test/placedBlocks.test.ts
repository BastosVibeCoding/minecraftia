import type { Bot } from 'mineflayer';
import { describe, expect, it } from 'vitest';
import { isBuildingBlock, PlacedBlocks } from '../src/bot/placedBlocks.js';
import { ManualClock } from '../src/core/clock.js';
import { SKILLS } from '../src/skills/library.js';
import { openDatabase } from '../src/store/db.js';

describe('blocs posés par les joueurs (cas réel : le bot cassait la maison pour aller aux bûches)', () => {
  it("une bûche posée par un joueur est protégée, celle d'un arbre ne l'est pas", () => {
    const placed = new PlacedBlocks(openDatabase(':memory:').db, new ManualClock(0));
    placed.placed({ x: 10.4, y: 64, z: -3.2 }, 'oak_log', 'Bilboquet86');
    expect(placed.isProtected({ name: 'oak_log', position: { x: 10, y: 64, z: -4 } })).toBe(true);
    expect(placed.isProtected({ name: 'oak_log', position: { x: 11, y: 64, z: -4 } })).toBe(false);
  });

  it('le registre survit au redémarrage, et un bloc cassé en sort', () => {
    const { db } = openDatabase(':memory:');
    const clock = new ManualClock(0);
    const a = new PlacedBlocks(db, clock);
    a.placed({ x: 1, y: 2, z: 3 }, 'dirt', 'JuicyBerries1993');
    a.placed({ x: 4, y: 5, z: 6 }, 'stone', 'Lea');
    a.broken({ x: 4, y: 5, z: 6 });
    const b = new PlacedBlocks(db, clock);
    expect(b.has({ x: 1, y: 2, z: 3 })).toBe(true);
    expect(b.has({ x: 4, y: 5, z: 6 })).toBe(false);
    expect(b.size).toBe(1);
  });

  it('les blocs de construction sont protégés partout, pas les blocs naturels', () => {
    for (const n of ['oak_planks', 'stone_bricks', 'glass', 'white_wool', 'oak_door', 'cobblestone', 'spruce_stairs', 'stripped_oak_log', 'chest']) expect(isBuildingBlock(n), n).toBe(true);
    for (const n of ['oak_log', 'dirt', 'stone', 'grass_block', 'oak_leaves', 'sand', 'iron_ore', 'terracotta']) expect(isBuildingBlock(n), n).toBe(false);
  });

  it('la récolte ignore les bûches posées et remet les réglages de déplacement', async () => {
    const placed = new PlacedBlocks(openDatabase(':memory:').db, new ManualClock(0));
    placed.placed({ x: 1, y: 64, z: 1 }, 'oak_log', 'Bilboquet86');
    let collected: unknown[] = [];
    let restored = 0;
    const bot = {
      registry: { blocksByName: { oak_log: { id: 7 } } },
      findBlocks: () => [{ x: 1, y: 64, z: 1 }, { x: 5, y: 64, z: 5 }],
      blockAt: (p: { x: number; y: number; z: number }) => ({ name: 'oak_log', position: p }),
      inventory: { items: () => [] },
      collectBlock: { collect: async (t: unknown[]) => void (collected = t), cancelTask: async () => {} },
    } as unknown as Bot;
    const ctx = { bot, followPlayer: 'B', isProtected: (b: { name: string; position: { x: number; y: number; z: number } }) => placed.isProtected(b), restoreMovements: () => void restored++ };
    await SKILLS.collect!.run(ctx, { blocks: ['oak_log'], count: 2 }, new AbortController().signal);
    expect((collected as { position: { x: number } }[]).map((b) => b.position.x)).toEqual([5]);
    expect(restored).toBe(1);
  });

  it("seulement des bûches posées à portée : la récolte n'y touche pas", async () => {
    const bot = {
      registry: { blocksByName: { oak_log: { id: 7 } } },
      findBlocks: () => [{ x: 1, y: 64, z: 1 }],
      blockAt: (p: unknown) => ({ name: 'oak_log', position: p }),
      inventory: { items: () => [] },
      collectBlock: { collect: async () => { throw new Error('ne doit pas être appelé'); } },
    } as unknown as Bot;
    const r = await SKILLS.collect!.run({ bot, followPlayer: 'B', isProtected: () => true }, { blocks: ['oak_log'], count: 2 }, new AbortController().signal);
    expect(r).toMatchObject({ status: 'failure' });
  });
});
