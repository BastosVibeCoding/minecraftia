import type { Bot } from 'mineflayer';
import { describe, expect, it } from 'vitest';
import { classifyByRules } from '../src/feedback/classifier.js';
import type { ChestSurvey } from '../src/skills/extra.js';
import { SKILLS } from '../src/skills/library.js';
import { assignRoles, DIVERS, planMoves, signFamily, sortFamily } from '../src/skills/sortChests.js';
import { vec } from './helpers.js';

const fam = (n: string) => sortFamily(n, n === 'bread');

describe("trier les coffres : panneaux d'abord, sinon le contenu dominant (demande du joueur)", () => {
  it("lit les panneaux", () => {
    expect(signFamily('Minerais')).toBe('minerais');
    expect(signFamily('BOIS\nplanches')).toBe('bois');
    expect(signFamily('Bouffe')).toBe('nourriture');
    expect(signFamily('Divers')).toBe(DIVERS);
    expect(signFamily('Bilboquet86')).toBeNull();
  });

  it("le panneau l'emporte ; sans panneau, la famille dominante ; vide = divers", () => {
    const chests: ChestSurvey[] = [
      { contents: { oak_log: 40, cobblestone: 2 }, free: 10 },
      { contents: { oak_log: 5, raw_iron: 3 }, free: 20 },
      { contents: {}, free: 27 },
    ];
    expect(assignRoles(chests, [null, 'minerais', null], fam)).toEqual(['bois', 'minerais', DIVERS]);
  });

  it("chaque objet va au coffre de sa famille, sinon au divers ; ce qui est à sa place ne bouge pas", () => {
    const chests: ChestSurvey[] = [
      { contents: { oak_log: 40, raw_iron: 4, white_wool: 3 }, free: 10 },
      { contents: { coal: 10, birch_log: 6 }, free: 20 },
      { contents: {}, free: 27 },
    ];
    const roles = ['bois', 'minerais', DIVERS];
    expect(planMoves(chests, roles, fam)).toEqual([
      { from: 0, to: 1, item: 'raw_iron', count: 4 },
      { from: 0, to: 2, item: 'white_wool', count: 3 },
      { from: 1, to: 0, item: 'birch_log', count: 6 },
    ]);
  });

  it("« trie les coffres » est un ordre", () => {
    expect(classifyByRules('Léa, trie les coffres', 'Lea').label).toBe('order');
  });

  it("tri complet : le fer passe dans le coffre marqué « minerais », le bois revient au coffre du bois", async () => {
    type It = { name: string; count: number; type: number };
    const ids: Record<string, number> = { oak_log: 1, raw_iron: 2, coal: 3, birch_log: 4 };
    const chests: Record<number, It[]> = {
      1: [{ name: 'oak_log', count: 40, type: 1 }, { name: 'raw_iron', count: 4, type: 2 }],
      2: [{ name: 'coal', count: 10, type: 3 }, { name: 'birch_log', count: 6, type: 4 }],
    };
    const inv: It[] = [];
    const bot = {
      entity: { position: vec(0, 64, 0) },
      registry: { blocksByName: { chest: { id: 54 } }, foodsByName: {}, itemsByName: Object.fromEntries(Object.entries(ids).map(([n, id]) => [n, { id }])) },
      findBlocks: () => [vec(1, 64, 0), vec(2, 64, 0)],
      blockAt: (p: { x: number; y: number; z: number; offset?: unknown }) => {
        if (p.x === 2 && p.y === 65) return { name: 'oak_wall_sign', position: p, getSignText: () => ['Minerais', ''] };
        if (p.y === 64 && (p.x === 1 || p.x === 2)) return { name: 'chest', position: vec(p.x, p.y, p.z), getProperties: () => ({ type: 'single' }) };
        return { name: 'air', position: p };
      },
      inventory: { items: () => inv, emptySlotCount: () => 30 },
      pathfinder: { goto: async () => {}, setGoal: () => {} },
      openContainer: async (b: { position: { x: number } }) => {
        const c = chests[b.position.x]!;
        return {
          inventoryStart: 27,
          containerItems: () => c.filter((i) => i.count > 0),
          count: (type: number) => inv.filter((i) => i.type === type).reduce((s, i) => s + i.count, 0),
          withdraw: async (type: number, _m: null, n: number) => {
            const it = c.find((i) => i.type === type)!;
            it.count -= n;
            inv.push({ ...it, count: n });
          },
          deposit: async (type: number, _m: null, n: number) => {
            const k = inv.findIndex((i) => i.type === type);
            const it = inv.splice(k, 1)[0]!;
            c.push({ ...it, count: n });
          },
          close: () => {},
        };
      },
    } as unknown as Bot;
    const r = await SKILLS.sort_chests!.run({ bot, followPlayer: 'B' }, {}, new AbortController().signal);
    expect(r).toMatchObject({ status: 'success', detail: { moved: 10, roles: ['bois', 'minerais'] } });
    const names = (x: number) => chests[x]!.filter((i) => i.count > 0).map((i) => i.name).sort();
    expect(names(1)).toEqual(['birch_log', 'oak_log']);
    expect(names(2)).toEqual(['coal', 'raw_iron']);
  });
});

describe("tri : corrections après l'essai en jeu", () => {
  it("un rôle donné lors d'un tri précédent est gardé ; un panneau l'emporte toujours", () => {
    const chests: ChestSurvey[] = [{ contents: { raw_iron: 50 }, free: 10 }, { contents: { cobblestone: 5 }, free: 20 }];
    expect(assignRoles(chests, [null, null], fam, ['bois', 'divers'])).toEqual(['bois', 'divers']);
    expect(assignRoles(chests, ['minerais', null], fam, ['bois', null])).toEqual(['minerais', 'terre et pierre']);
  });

  it("les rôles sont retenus en base d'un tri à l'autre", async () => {
    const { openDatabase } = await import('../src/store/db.js');
    const { ChestRoles } = await import('../src/bot/chestRoles.js');
    const { db } = openDatabase(':memory:');
    new ChestRoles(db).setMany([[{ x: 1, y: 64, z: 0 }, 'bois']]);
    expect(new ChestRoles(db).get({ x: 1.4, y: 64, z: 0 })).toBe('bois');
    expect(new ChestRoles(db).get({ x: 2, y: 64, z: 0 })).toBeNull();
  });

  it("un retrait raté ne fait jamais déposer les affaires du bot (cas réel : sa pioche partie dans un coffre)", async () => {
    type It = { name: string; count: number; type: number };
    const inv: It[] = [{ name: 'stone_pickaxe', count: 1, type: 9 }];
    const deposited: string[] = [];
    const chests: Record<number, It[]> = { 1: [{ name: 'oak_log', count: 30, type: 1 }, { name: 'stone_pickaxe', count: 1, type: 9 }], 2: [{ name: 'iron_pickaxe', count: 1, type: 8 }] };
    const bot = {
      entity: { position: vec(0, 64, 0) },
      registry: { blocksByName: { chest: { id: 54 } }, foodsByName: {}, itemsByName: { stone_pickaxe: { id: 9 }, oak_log: { id: 1 }, iron_pickaxe: { id: 8 } } },
      findBlocks: () => [vec(1, 64, 0), vec(2, 64, 0)],
      blockAt: (p: { x: number; y: number; z: number }) => (p.y === 64 && p.x >= 1 && p.x <= 2 ? { name: 'chest', position: vec(p.x, p.y, p.z), getProperties: () => ({ type: 'single' }) } : { name: 'air', position: p }),
      inventory: { items: () => inv.filter((i) => i.count > 0), emptySlotCount: () => 30 },
      pathfinder: { goto: async () => {}, setGoal: () => {} },
      openContainer: async (b: { position: { x: number } }) => ({
        inventoryStart: 27,
        containerItems: () => chests[b.position.x]!,
        count: (type: number) => inv.filter((i) => i.type === type).reduce((s, i) => s + i.count, 0),
        withdraw: async () => {
          throw new Error('retrait refusé');
        },
        deposit: async (type: number) => void deposited.push(String(type)),
        close: () => {},
      }),
    } as unknown as Bot;
    await SKILLS.sort_chests!.run({ bot, followPlayer: 'B' }, {}, new AbortController().signal);
    expect(deposited).toEqual([]);
    expect(inv[0]!.count).toBe(1);
  });
});

it("dépôt impossible : l'erreur est notée et les objets retournent dans leur coffre (cas réel : 71 steaks gardés sur lui)", async () => {
  type It = { name: string; count: number; type: number };
  const chests: Record<number, It[]> = { 1: [{ name: 'oak_log', count: 40, type: 1 }, { name: 'cooked_beef', count: 10, type: 5 }], 2: [{ name: 'bread', count: 3, type: 6 }] };
  const inv: It[] = [];
  const bot = {
    entity: { position: vec(0, 64, 0) },
    registry: { blocksByName: { chest: { id: 54 } }, foodsByName: { cooked_beef: {}, bread: {} }, itemsByName: { oak_log: { id: 1 }, cooked_beef: { id: 5 }, bread: { id: 6 } } },
    findBlocks: () => [vec(1, 64, 0), vec(2, 64, 0)],
    blockAt: (p: { x: number; y: number; z: number }) => (p.y === 64 && p.x >= 1 && p.x <= 2 ? { name: 'chest', position: vec(p.x, p.y, p.z), getProperties: () => ({ type: 'single' }) } : { name: 'air', position: p }),
    inventory: { items: () => inv.filter((i) => i.count > 0), emptySlotCount: () => 30 },
    pathfinder: { goto: async () => {}, setGoal: () => {} },
    openContainer: async (b: { position: { x: number } }) => {
      const x = b.position.x;
      const c = chests[x]!;
      return {
        inventoryStart: 27,
        containerItems: () => c.filter((i) => i.count > 0),
        count: (type: number) => inv.filter((i) => i.type === type).reduce((s, i) => s + i.count, 0),
        withdraw: async (type: number, _m: null, n: number) => {
          const it = c.find((i) => i.type === type)!;
          it.count -= n;
          inv.push({ ...it, count: n });
        },
        deposit: async (type: number, _m: null, n: number) => {
          if (x === 2) throw new Error('destination full');
          const k = inv.findIndex((i) => i.type === type);
          inv.splice(k, 1);
          c.push({ name: type === 5 ? 'cooked_beef' : 'oak_log', count: n, type });
        },
        close: () => {},
      };
    },
  } as unknown as Bot;
  const r = await SKILLS.sort_chests!.run({ bot, followPlayer: 'B' }, {}, new AbortController().signal);
  expect(r).toMatchObject({ status: 'failure', detail: { reason: 'dépôt de cooked_beef dans le coffre 2 : destination full' } });
  expect(inv).toEqual([]); // rien gardé sur lui
  expect(chests[1]!.filter((i) => i.name === 'cooked_beef').reduce((s, i) => s + i.count, 0)).toBe(10);
});

describe("le coffre à panneau passe avant le coffre deviné (cas réel : steaks hors du coffre « nourriture »)", () => {
  const foodFam = (n: string) => sortFamily(n, ['cooked_beef', 'bread', 'apple', 'rotten_flesh'].includes(n));

  it("un coffre deviné « nourriture » cède la place au coffre marqué « nourriture »", () => {
    const chests: ChestSurvey[] = [
      { contents: { oak_log: 30 }, free: 10 },
      { contents: { cooked_beef: 60, cobblestone: 20 }, free: 5 }, // deviné nourriture, retenu comme tel
      { contents: { bread: 2 }, free: 25 }, // panneau « nourriture »
    ];
    const roles = assignRoles(chests, [null, null, 'nourriture'], foodFam, ['bois', 'nourriture', null]);
    expect(roles).toEqual(['bois', 'terre et pierre', 'nourriture']);
    expect(planMoves(chests, roles, foodFam)).toEqual([{ from: 1, to: 2, item: 'cooked_beef', count: 60 }]);
  });

  it("chair putréfiée : avec le butin, pas avec la nourriture", () => {
    expect(foodFam('rotten_flesh')).toBe('butin');
    expect(foodFam('cooked_beef')).toBe('nourriture');
  });
});

it("coffre à panneau sans coffre « divers » : ce qui n'est pas de sa famille part au coffre sans panneau le plus libre (cas réel)", () => {
  const chests: ChestSurvey[] = [
    { contents: { oak_log: 30 }, free: 4 },
    { contents: { cobblestone: 20 }, free: 18 },
    { contents: { cooked_beef: 40, glass: 8, white_wool: 3 }, free: 10 }, // panneau « nourriture »
  ];
  const beefIsFood = (n: string) => sortFamily(n, n === 'cooked_beef');
  const roles = assignRoles(chests, [null, null, 'nourriture'], beefIsFood);
  expect(planMoves(chests, roles, beefIsFood, [null, null, 'nourriture'])).toEqual([
    { from: 2, to: 1, item: 'glass', count: 8 },
    { from: 2, to: 1, item: 'white_wool', count: 3 },
  ]);
});
