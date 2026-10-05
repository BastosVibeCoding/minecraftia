import type { Bot } from 'mineflayer';
import { describe, expect, it } from 'vitest';
import { ResourceMemory } from '../src/bot/resources.js';
import { ManualClock } from '../src/core/clock.js';
import { SKILLS } from '../src/skills/library.js';
import { notFoundMessage, SEARCH_MAX_DISTANCE, searchFor } from '../src/skills/search.js';
import { openDatabase } from '../src/store/db.js';
import { vec } from './helpers.js';

describe("mémoire des ressources (demande du joueur : retenir où on a vu ou récolté)", () => {
  it("retient un gisement une seule fois, rend le plus proche, oublie un gisement épuisé", () => {
    const m = new ResourceMemory(openDatabase(':memory:').db, new ManualClock(0));
    m.remember('sand', { x: 100, y: 63, z: 0 }, 'récolté');
    m.remember('sand', { x: 102, y: 63, z: 1 }, 'récolté'); // même gisement
    m.remember('sand', { x: 40, y: 63, z: 0 }, 'vu');
    expect(m.nearest(['sand'], { x: 0, y: 64, z: 0 }, 300)).toEqual([{ x: 40, y: 63, z: 0 }, { x: 100, y: 63, z: 0 }]);
    m.forget('sand', { x: 40, y: 63, z: 0 });
    expect(m.nearest(['sand'], { x: 0, y: 64, z: 0 }, 300)).toEqual([{ x: 100, y: 63, z: 0 }]);
    expect(m.nearest(['gravel'], { x: 0, y: 64, z: 0 }, 300)).toEqual([]);
  });
});

describe("recherche quand rien n'est en vue", () => {
  function walker(foundAt: (p: { x: number; z: number }) => boolean) {
    let pos = vec(0, 64, 0);
    const trips: string[] = [];
    const bot = {
      entity: {
        get position() {
          return pos;
        },
      },
      players: { B: { entity: { position: vec(2, 64, 2) } } },
      pathfinder: {
        goto: async (g: { x: number; z: number; y?: number }) => {
          trips.push(`${g.x},${g.z}`);
          pos = vec(g.x, 64, g.z);
        },
        setGoal: () => {},
      },
    } as unknown as Bot;
    return { bot, trips, found: () => foundAt(pos) };
  }

  it("va d'abord à l'endroit mémorisé", async () => {
    const memory = new ResourceMemory(openDatabase(':memory:').db, new ManualClock(0));
    memory.remember('sand', { x: 120, y: 63, z: 0 }, 'récolté');
    const w = walker((p) => p.x === 120);
    expect(await searchFor({ bot: w.bot, found: w.found, names: ['sand'], memory, followPlayer: 'B' }, new AbortController().signal)).toBe(true);
    expect(w.trips).toEqual(['120,0']);
  });

  it("sinon cherche par étapes de 30 blocs, et s'arrête dès qu'il trouve", async () => {
    const w = walker((p) => p.x === -30 && p.z === 0);
    expect(await searchFor({ bot: w.bot, found: w.found, names: ['sand'], followPlayer: 'B' }, new AbortController().signal)).toBe(true);
    expect(w.trips).toEqual(['30,0', '0,30', '-30,0']);
  });

  it("rien nulle part : au plus ~150 blocs parcourus, puis retour vers le joueur", async () => {
    const w = walker(() => false);
    expect(await searchFor({ bot: w.bot, found: w.found, names: ['sand'], followPlayer: 'B' }, new AbortController().signal)).toBe(false);
    expect(w.trips.at(-1)).toBe('2,2');
    const legs = w.trips.slice(0, -1).map((t) => t.split(',').map(Number) as [number, number]);
    let walked = 0;
    let from: [number, number] = [0, 0];
    for (const l of legs) {
      walked += Math.hypot(l[0] - from[0], l[1] - from[1]);
      from = l;
    }
    expect(walked).toBeLessThanOrEqual(SEARCH_MAX_DISTANCE);
  });

  it("la récolte le dit au joueur quand elle ne trouve vraiment rien", async () => {
    const said: string[] = [];
    const w = walker(() => false);
    const bot = Object.assign(w.bot, {
      registry: { blocksByName: { sand: { id: 3 } } },
      findBlocks: () => [],
      blockAt: () => null,
      inventory: { items: () => [] },
    });
    const r = await SKILLS.collect!.run({ bot: bot as Bot, followPlayer: 'B', speak: (t) => void said.push(t) }, { blocks: ['sand'], count: 4 }, new AbortController().signal);
    expect(r).toMatchObject({ status: 'failure', detail: { precondition: true } });
    expect(said).toEqual([notFoundMessage(['sand'])]);
    expect(said[0]).toBe("Je n'ai pas trouvé de sable dans le coin, tu peux me montrer où ?");
  });
});
