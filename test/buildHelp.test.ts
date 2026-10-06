import type { Bot } from 'mineflayer';
import { describe, expect, it } from 'vitest';
import { blueprintOfRecent, detectWall, placeBlockAt, wallExtension, type Placement } from '../src/skills/buildHelp.js';
import { SKILLS } from '../src/skills/library.js';
import { vec } from './helpers.js';

const p = (x: number, y: number, z: number, block = 'stone_bricks', at = 0): Placement => ({ x, y, z, block, at });

describe("aide à la construction (évolution 4)", () => {
  it("repère le mur qu'on vient de construire : axe, étendue, hauteur", () => {
    // mur en x de 10 à 13, 2 de haut, le dernier bloc posé en x=13
    const wall = [p(13, 65, 5, 'stone_bricks', 9), p(13, 64, 5, 'stone_bricks', 8), p(12, 65, 5), p(12, 64, 5), p(11, 64, 5), p(10, 64, 5), p(30, 64, 30, 'dirt')];
    expect(detectWall(wall)).toMatchObject({ block: 'stone_bricks', axis: 'x', fixed: 5, from: 10, to: 13, minY: 64, maxY: 65 });
    expect(detectWall([p(1, 64, 1)])).toBeNull();
  });

  it("prolonge depuis le bout où l'on a fini, de bas en haut", () => {
    const wall = detectWall([p(13, 64, 5, 'stone_bricks', 9), p(12, 64, 5), p(11, 64, 5)])!;
    expect(wallExtension(wall, 3)).toEqual([{ x: 14, y: 64, z: 5 }, { x: 15, y: 64, z: 5 }, { x: 16, y: 64, z: 5 }]);
    const backwards = detectWall([p(11, 64, 5, 'stone_bricks', 9), p(12, 64, 5), p(13, 64, 5)])!;
    expect(wallExtension(backwards, 1)).toEqual([{ x: 10, y: 64, z: 5 }]);
  });

  it("relève ce qu'on vient de construire en coordonnées relatives, du bas vers le haut", () => {
    const plan = blueprintOfRecent([p(5, 65, 5, 'oak_planks', 3), p(5, 64, 5, 'oak_log', 2), p(6, 64, 5, 'oak_log', 1)])!;
    expect(plan.origin).toEqual({ x: 5, y: 64, z: 5 });
    expect(plan.size).toEqual({ x: 2, y: 2, z: 1 });
    expect(plan.cells).toEqual([
      { x: 0, y: 0, z: 0, block: 'oak_log' },
      { x: 1, y: 0, z: 0, block: 'oak_log' },
      { x: 0, y: 1, z: 0, block: 'oak_planks' },
    ]);
  });

  it("pose un bloc contre une face latérale quand il n'y a rien dessous", async () => {
    const placed: { ref: string; face: string }[] = [];
    const solid = new Set(['4,64,0']); // un bloc à côté (x+1), rien dessous
    const bot = {
      entity: { position: vec(3, 64, 2) },
      blockAt: (q: { x: number; y: number; z: number }) => ({ name: solid.has(`${q.x},${q.y},${q.z}`) ? 'stone' : 'air', boundingBox: solid.has(`${q.x},${q.y},${q.z}`) ? 'block' : 'empty', position: vec(q.x, q.y, q.z) }),
      inventory: { items: () => [{ name: 'stone_bricks', count: 5, type: 1 }] },
      pathfinder: { goto: async () => {}, setGoal: () => {} },
      equip: async () => {},
      placeBlock: async (ref: { position: { x: number; y: number; z: number } }, face: { x: number; y: number; z: number }) => void placed.push({ ref: `${ref.position.x},${ref.position.y},${ref.position.z}`, face: `${face.x},${face.y},${face.z}` }),
    } as unknown as Bot;
    expect(await placeBlockAt({ bot, followPlayer: 'B' }, vec(3, 64, 0) as never, 'stone_bricks', new AbortController().signal)).toBe(true);
    expect(placed).toEqual([{ ref: '4,64,0', face: '-1,0,0' }]);
  });

  it("« apporte-moi des planches » : prises dans le coffre puis données", async () => {
    const inv: { name: string; count: number; type: number }[] = [];
    const chest = [{ name: 'oak_planks', count: 64, type: 7 }];
    const tossed: number[] = [];
    const pos = vec(0, 64, 0);
    const bot = {
      entity: { position: pos },
      registry: { blocksByName: { chest: { id: 54 } } },
      inventory: { items: () => inv.filter((i) => i.count > 0) },
      findBlocks: () => [vec(2, 64, 0)],
      blockAt: (q: unknown) => ({ name: 'chest', position: q }),
      players: { B: { entity: { position: vec(1, 64, 1) } } },
      pathfinder: { goto: async () => {}, setGoal: () => {} },
      openContainer: async () => ({
        containerItems: () => chest.filter((i) => i.count > 0),
        count: (type: number) => inv.filter((i) => i.type === type).reduce((s, i) => s + i.count, 0),
        withdraw: async (_t: number, _m: null, n: number) => {
          chest[0]!.count -= n;
          inv.push({ name: 'oak_planks', count: n, type: 7 });
        },
        close: () => {},
      }),
      lookAt: async () => {},
      toss: async (_t: number, _m: null, n: number) => void tossed.push(n),
    } as unknown as Bot;
    const r = await SKILLS.bring!.run({ bot, followPlayer: 'B' }, { item: 'oak_planks', count: 32 }, new AbortController().signal);
    expect(r).toMatchObject({ status: 'success' });
    expect(tossed).toEqual([32]);
    expect(chest[0]!.count).toBe(32);
  });
});

it("prolonger un mur en planches sans planches : il en fabrique d'abord (cas réel : bouleau)", async () => {
  const inv: { name: string; count: number; type: number }[] = [];
  const crafted: string[] = [];
  const bot = {
    entity: { position: vec(0, 64, 0) },
    registry: { blocksByName: { chest: { id: 54 } } },
    inventory: { items: () => inv },
    findBlocks: () => [],
    blockAt: (q: { x: number; y: number; z: number }) => ({ name: q.y === 63 ? 'stone' : 'air', boundingBox: q.y === 63 ? 'block' : 'empty', position: vec(q.x, q.y, q.z) }),
    pathfinder: { goto: async () => {}, setGoal: () => {} },
    equip: async () => {},
    placeBlock: async () => {},
  } as unknown as Bot;
  const wall = [{ x: 3, y: 64, z: 0, block: 'birch_planks', at: 2 }, { x: 2, y: 64, z: 0, block: 'birch_planks', at: 1 }];
  const r = await SKILLS.extend_wall!.run(
    {
      bot,
      followPlayer: 'B',
      recentPlacements: () => wall,
      craft: async (item, count) => {
        crafted.push(`${item}x${count}`);
        inv.push({ name: item, count, type: 9 });
      },
    },
    { length: 2, toPlayer: false },
    new AbortController().signal,
  );
  expect(crafted).toEqual(['birch_planksx2']);
  expect(r).toMatchObject({ status: 'success', detail: { placed: 2 } });
});
