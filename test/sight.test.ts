import type { Bot } from 'mineflayer';
import { describe, expect, it } from 'vitest';
import { blocksSight, canSee } from '../src/bot/sight.js';
import { vec } from './helpers.js';

describe("pas de vision à travers les murs (demande du joueur)", () => {
  /** Un mur en x = 5 (pierre ou verre selon le cas) ; le rayon s'arrête au premier bloc opaque. */
  function botWithWall(material: string | null) {
    return {
      entity: { position: vec(0, 64, 0) },
      world: {
        raycast: (from: { x: number }, dir: { x: number }, range: number, matcher: (b: { name: string; boundingBox: string }) => boolean) => {
          if (!material || dir.x <= 0 || 5 - from.x > range) return null;
          const wall = { name: material, boundingBox: 'block' };
          return matcher(wall) ? wall : null;
        },
      },
    } as unknown as Bot;
  }
  const zombie = { position: vec(8, 64, 0) as never, height: 1.95 };

  it("un zombie derrière un mur de pierre n'est pas vu", () => {
    expect(canSee(botWithWall('stone'), zombie)).toBe(false);
  });

  it("à travers le verre, les vitres, les feuilles : vu", () => {
    for (const m of ['glass', 'white_stained_glass_pane', 'oak_leaves', 'iron_bars', 'oak_fence']) expect(canSee(botWithWall(m), zombie), m).toBe(true);
  });

  it("sans mur : vu ; collé au bot : senti même derrière un bloc", () => {
    expect(canSee(botWithWall(null), zombie)).toBe(true);
    expect(canSee(botWithWall('stone'), { position: vec(1, 64, 0) as never, height: 0.5 })).toBe(true);
  });

  it("blocs qui arrêtent ou non le regard", () => {
    expect(blocksSight({ name: 'stone', boundingBox: 'block' })).toBe(true);
    expect(blocksSight({ name: 'glass', boundingBox: 'block' })).toBe(false);
    expect(blocksSight({ name: 'short_grass', boundingBox: 'empty' })).toBe(false);
  });
});
