import { describe, expect, it } from 'vitest';
import { isBuildingBlock } from '../src/bot/placedBlocks.js';
import { clarifyingQuestion } from '../src/feedback/clarify.js';
import { answerInventoryQuestion } from '../src/feedback/questions.js';
import { expandBlockNames, SKILLS } from '../src/skills/library.js';
import { facing, planStep } from '../src/skills/staircase.js';
import { askForTool, hasTool, toolFor, toolPlan } from '../src/skills/tools.js';

describe("outils : se refaire une hache cassée (question du joueur, 2026-10-05)", () => {
  it("choisit l'outil selon le bloc", () => {
    expect(toolFor('oak_log')).toBe('axe');
    expect(toolFor('deepslate_iron_ore')).toBe('pickaxe');
    expect(toolFor('stone')).toBe('pickaxe');
    expect(toolFor('dirt')).toBe('shovel');
    expect(toolFor('white_wool')).toBeNull();
  });

  it("repère qu'il n'a plus d'outil", () => {
    expect(hasTool([{ name: 'stone_axe' }], 'axe')).toBe(true);
    expect(hasTool([{ name: 'stone_pickaxe' }], 'axe')).toBe(false);
  });
});

describe("pioche adaptée au minerai (demande du joueur, 2026-10-05)", () => {
  const ironOre = ['stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'];
  const diamondOre = ['iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'];

  it("une pioche en bois ne suffit pas pour le fer : il fabrique une pioche en pierre avec ses pavés", () => {
    expect(toolPlan({ wooden_pickaxe: 1, cobblestone: 8, oak_planks: 2 }, 'pickaxe', ironOre, true)).toEqual({ craft: 'stone_pickaxe' });
  });

  it("garde l'outil qu'il a quand il convient", () => {
    expect(toolPlan({ iron_pickaxe: 1 }, 'pickaxe', diamondOre, true)).toEqual({ have: 'iron_pickaxe' });
  });

  it("diamant sans fer : il dit au joueur ce qui lui manque", () => {
    const plan = toolPlan({ cobblestone: 64, oak_log: 10 }, 'pickaxe', diamondOre, true);
    expect(plan).toEqual({ missing: 'une pioche en fer ou 3 lingots de fer' });
    expect(askForTool('diamond_ore', 'une pioche en fer ou 3 lingots de fer')).toBe(
      "Pour récolter du diamant, il me faut une pioche en fer ou 3 lingots de fer. Je n'en ai pas, ni dans les coffres à côté : tu peux m'en donner ?",
    );
  });

  it("pierre avec 3 bûches et rien d'autre : pioche en bois (établi compris)", () => {
    expect(toolPlan({ oak_log: 3 }, 'pickaxe', null, false)).toEqual({ craft: 'wooden_pickaxe' });
  });
});

describe("ordre vague : le bot demande quoi avant d'obéir", () => {
  it.each([
    ['Alex, va miner', 'Je mine quoi'],
    ['va récolter', 'Je récolte quoi'],
  ])("« %s » → « %s… »", (order, start) => {
    expect(clarifyingQuestion(order)).toMatch(new RegExp(`^${start}`));
  });

  it.each(['va miner du fer', 'mine tous les minerais', "creuse en escalier jusqu'en y=-10", 'récolte du bois', 'coupe 30 bûches'])("« %s » est assez précis", (order) => {
    expect(clarifyingQuestion(order)).toBeNull();
  });
});

describe("récolte : familles de blocs (manque réel : « récolte tous les minerais »)", () => {
  const known = ['iron_ore', 'deepslate_iron_ore', 'coal_ore', 'oak_log', 'birch_log', 'stone'];
  it("« minerais » → tous les minerais, « bois » → toutes les bûches, nom exact inchangé", () => {
    expect(expandBlockNames(known, ['minerais']).sort()).toEqual(['coal_ore', 'deepslate_iron_ore', 'iron_ore']);
    expect(expandBlockNames(known, ['bois']).sort()).toEqual(['birch_log', 'oak_log']);
    expect(expandBlockNames(known, ['stone'])).toEqual(['stone']);
  });
});

describe("escalier jusqu'à une hauteur (demande de JuicyBerries1993)", () => {
  const world = (cells: Record<string, string>) => (dx: number, dy: number, dz: number) => {
    const name = cells[`${dx},${dy},${dz}`] ?? 'stone';
    return { name, boundingBox: name === 'air' || name === 'lava' || name === 'water' ? 'empty' : 'block' };
  };

  it("creuse tête, pieds et marche devant, vers le nord", () => {
    expect(planStep(world({}), 'north')).toEqual({ dig: [[0, 1, -1], [0, 0, -1], [0, -1, -1]] });
  });

  it("s'arrête devant la lave, l'eau ou le vide", () => {
    expect(planStep(world({ '1,-1,-1': 'lava' }), 'north')).toEqual({ stop: "lave près de l'escalier" });
    expect(planStep(world({ '0,2,-1': 'water' }), 'north')).toEqual({ stop: "eau près de l'escalier" });
    expect(planStep(world({ '0,-2,-1': 'air' }), 'north')).toEqual({ stop: 'vide sous la prochaine marche' });
  });

  it("direction par défaut : celle du regard", () => {
    expect(facing(0)).toBe('north');
    expect(facing(Math.PI)).toBe('south');
    expect(facing(Math.PI / 2)).toBe('west');
    expect(facing(-Math.PI / 2)).toBe('east');
  });
});

it("« alex t'as combien de buches » sans point d'interrogation est une question", () => {
  expect(answerInventoryQuestion("alex t'as combien de buches", { oak_log: 4 })).toBe("J'ai 4 bûches.");
});

it("les vitres et le verre sont des blocs de construction protégés", () => {
  for (const n of ['glass', 'glass_pane', 'white_stained_glass_pane', 'tinted_glass']) expect(isBuildingBlock(n), n).toBe(true);
});

it("« t'as une pioche ? » / « t'as une hache ? » : il dit lesquelles (manques réels)", () => {
  const inv = { stone_pickaxe: 1, wooden_pickaxe: 1, oak_log: 3 };
  expect(answerInventoryQuestion('ALEX T’as une pioche ?', inv)).toBe("Oui, j'ai une pioche en pierre et une pioche en bois.");
  expect(answerInventoryQuestion("alex t'as une hache ?", inv)).toBe("Non, je n'ai pas de hache.");
});

describe("poser un objet à un endroit (manque réel : « pose le four à côté de la table de craft », 3×)", () => {
  it("« t'as un four ? » / « t'as un établi ? » sont des questions d'inventaire", () => {
    expect(answerInventoryQuestion('Léa t\'as un four ?', { furnace: 1 })).toBe("J'ai 1 four.");
    expect(answerInventoryQuestion("alex t'as un établi", {})).toBe("Je n'ai pas d'établi.");
  });

  it("pose le four sur une case libre à côté de l'établi", async () => {
    type V = { x: number; y: number; z: number; offset(a: number, b: number, c: number): V; minus(o: V): V; floored(): V; distanceTo(): number };
    const vec = (x: number, y: number, z: number): V => ({ x, y, z, offset: (a, b, c) => vec(x + a, y + b, z + c), minus: (o) => vec(x - o.x, y - o.y, z - o.z), floored: () => vec(x, y, z), distanceTo: () => 1 });
    const table = { name: 'crafting_table', position: vec(10, 64, 10), boundingBox: 'block' };
    const placed: string[] = [];
    const bot = {
      registry: { blocksByName: { crafting_table: { id: 1 } } },
      inventory: { items: () => [{ name: 'furnace', count: 1, type: 5 }] },
      entity: { position: vec(0, 64, 0) },
      findBlock: () => table,
      blockAt: (p: V) => (p.y === 63 ? { name: 'stone', boundingBox: 'block', position: p } : p.x === 10 && p.z === 10 ? table : { name: 'air', boundingBox: 'empty', position: p }),
      pathfinder: { goto: async () => {}, setGoal: () => {} },
      equip: async () => {},
      placeBlock: async (ground: { position: V }) => void placed.push(`${ground.position.x},${ground.position.z}`),
    };
    const r = await SKILLS.place!.run({ bot: bot as never, followPlayer: 'B' }, { item: 'furnace', near: 'crafting_table' }, new AbortController().signal);
    expect(r.status).toBe('success');
    expect(placed).toEqual(['11,10']);
  });
});
