import type { Bot } from 'mineflayer';
import { smeltFor } from '../src/skills/extra.js';
import { describe, expect, it } from 'vitest';
import { isBuildingBlock } from '../src/bot/placedBlocks.js';
import { clarifyingQuestion } from '../src/feedback/clarify.js';
import { classifyByRules } from '../src/feedback/classifier.js';
import { answerInventoryQuestion, answerProgressQuestion, answerStatusQuestion, answerWhereQuestion } from '../src/feedback/questions.js';
import { expandBlockNames, SKILLS } from '../src/skills/library.js';
import { facing, planStep } from '../src/skills/staircase.js';
import { askForTool, ensureHarvestTool, hasTool, toolFor, toolPlan } from '../src/skills/tools.js';
import { vec } from './helpers.js';

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

it("« Léa, t'as mangé ? », « ça va ? », « t'as combien de vie ? » : elle parle de son état (manque réel)", () => {
  expect(answerStatusQuestion("Léa, t'as mangé ?", { health: 20, food: 20 })).toBe("Non, je n'ai pas faim.");
  expect(answerStatusQuestion('tu as faim ?', { health: 20, food: 6 })).toBe("Oui, j'ai faim (6/20).");
  expect(answerStatusQuestion("t'as combien de vie", { health: 13.5, food: 20 })).toBe("J'ai 14/20 de vie.");
  expect(answerStatusQuestion('ça va Léa ?', { health: 20, food: 19 })).toBe('Ça va bien ! J’ai 20/20 de vie.'.replace('’', "'"));
  expect(answerStatusQuestion("t'as du bois ?", { health: 20, food: 20 })).toBeNull();
});

it("« Léa t'as le sable ? » et « Léa clique sur le lit » (manques réels)", () => {
  expect(answerInventoryQuestion("Léa t'as le sable ?", { sand: 23 })).toBe("J'ai 23 sable.");
  expect(answerInventoryQuestion("t'as du verre ?", { glass_pane: 4, glass: 2 })).toBe("J'ai 6 verre.");
  expect(classifyByRules('Léa clique sur le lit', 'Lea').label).toBe('order');
});

it("« Léa t'as fini ? » : action en cours, ou résultat de la dernière (manque réel, 2×)", () => {
  expect(answerProgressQuestion("Léa t'as fini ?", { current: 'collect', lastOutcome: null })).toBe('Pas encore, je récolte.');
  expect(answerProgressQuestion('tu as fini', { current: 'follow', lastOutcome: 'collect : réussi +23 sand' })).toBe("Oui, c'est fini : collect : réussi +23 sand.");
  expect(answerProgressQuestion('tu fais quoi ?', { current: null, lastOutcome: null })).toBe("Je n'ai rien en cours, je te suis.");
  expect(answerProgressQuestion("t'as du sable ?", { current: null, lastOutcome: null })).toBeNull();
});

it("hache : le moins cher d'abord, le fer accepté si c'est tout ce qu'il a (choix du joueur)", () => {
  // le joueur accepte le fer pour une hache (le coffre est fouillé avant, dans ensureHarvestTool)
  expect(toolPlan({ iron_ingot: 3, oak_planks: 2 }, 'axe', null, true)).toEqual({ craft: 'iron_axe' });
  expect(toolPlan({ iron_ingot: 3, cobblestone: 3, oak_planks: 2 }, 'axe', null, true)).toEqual({ craft: 'stone_axe' });
  // pour un minerai qui l'exige, le fer reste permis
  expect(toolPlan({ iron_ingot: 3, oak_planks: 2 }, 'pickaxe', ['iron_pickaxe', 'diamond_pickaxe'], true)).toEqual({ craft: 'iron_pickaxe' });
  expect(classifyByRules('Tape les mobs Léa', 'Lea').label).toBe('order');
});

it("outil tout fait dans le coffre : pris avant de fabriquer avec son fer (choix du joueur)", async () => {
  const mcData = (await import('minecraft-data')).default('1.21');
  const inv = [{ name: 'iron_ingot', count: 3, type: mcData.itemsByName.iron_ingot!.id }, { name: 'oak_planks', count: 4, type: mcData.itemsByName.oak_planks!.id }];
  const crafted: string[] = [];
  const axe = { name: 'iron_axe', count: 1, type: mcData.itemsByName.iron_axe!.id };
  const bot = {
    registry: mcData,
    inventory: { items: () => inv },
    findBlock: () => null,
    findBlocks: () => [vec(3, 64, 0)],
    blockAt: (p: unknown) => ({ name: 'chest', position: p }),
    pathfinder: { goto: async () => {}, setGoal: () => {} },
    openContainer: async () => ({ containerItems: () => [axe], withdraw: async () => void inv.push(axe), close: () => {} }),
    recipesFor: () => [{}],
    craft: async (_r: unknown) => void crafted.push('craft'),
  };
  expect(await ensureHarvestTool(bot as never, 'oak_log', new AbortController().signal)).toEqual({ ok: true });
  expect(inv.some((i) => i.name === 'iron_axe')).toBe(true);
  expect(crafted).toEqual([]);
});

describe("manques de la partie du 5 octobre (soir)", () => {
  it("« wooden_stairs » → tous les escaliers ; « t'as combien de cuivre » ; « t'as trouvé des trucs ? »", () => {
    expect(expandBlockNames(['oak_stairs', 'spruce_stairs', 'oak_log'], ['wooden_stairs']).sort()).toEqual(['oak_stairs', 'spruce_stairs']);
    expect(answerInventoryQuestion("alex t'as combien de cuivre", { raw_copper: 5 })).toBe("J'ai 5 cuivre.");
    expect(answerProgressQuestion("Léa t'as trouvé des trucs ?", { current: null, lastOutcome: 'collect : réussi +4 iron_ore' })).toBe("Oui, c'est fini : collect : réussi +4 iron_ore.");
  });

  it("« casse les escaliers en bois » : les escaliers protégés deviennent cassables, le reste non", async () => {
    const targets: string[] = [];
    const collect = { movements: 'nos réglages', collect: async (t: { name: string }) => void targets.push(t.name), cancelTask: async () => {} };
    const mcData = (await import('minecraft-data')).default('1.21');
    const bot = {
      registry: mcData,
      findBlocks: () => [vec(1, 64, 0)],
      blockAt: (p: { y: number }) => (p.y === 64 ? { name: 'oak_stairs', position: p } : { name: 'air', position: p }),
      inventory: { items: () => [] },
      collectBlock: collect,
      world: { getBlock: () => null },
      entities: {},
    } as unknown as Bot;
    await SKILLS.collect!.run({ bot, followPlayer: 'B', isProtected: () => true }, { blocks: ['wooden_stairs'], count: 1 }, new AbortController().signal).catch(() => null);
    expect(targets).toEqual(['oak_stairs']);
    expect(collect.movements).toBe('nos réglages'); // réglages remis après
  });
});

describe("fabriquer avec des ingrédients pris dans les coffres (manques réels : « fabrique des vitres »)", () => {
  function craftBot(chest: { name: string; count: number; type: number }[]) {
    const inv: { name: string; count: number; type: number }[] = [];
    const said: string[] = [];
    const items: Record<number, { name: string }> = { 20: { name: 'glass' }, 21: { name: 'glass_pane' } };
    const paneRecipe = { requiresTable: true, delta: [{ id: 20, count: -6 }, { id: 21, count: 16 }], result: { count: 16 } };
    const has = (n: string, c: number) => inv.filter((i) => i.name === n).reduce((s, i) => s + i.count, 0) >= c;
    const bot = {
      registry: { itemsByName: { glass_pane: { id: 21 }, glass: { id: 20 }, crafting_table: { id: 30 } }, blocksByName: { crafting_table: { id: 31 }, chest: { id: 54 } }, items },
      inventory: { items: () => inv.filter((i) => i.count > 0) },
      findBlock: () => ({ name: 'crafting_table', position: vec(2, 64, 0) }),
      findBlocks: () => (chest.length ? [vec(3, 64, 0)] : []),
      blockAt: (p: unknown) => ({ name: 'chest', position: p }),
      pathfinder: { goto: async () => {}, setGoal: () => {} },
      openContainer: async () => ({
        containerItems: () => chest.filter((i) => i.count > 0),
        count: (type: number) => inv.filter((i) => i.type === type).reduce((s, i) => s + i.count, 0),
        withdraw: async (type: number, _m: null, n: number) => {
          const it = chest.find((i) => i.type === type)!;
          it.count -= n;
          inv.push({ ...it, count: n });
        },
        close: () => {},
      }),
      recipesFor: () => (has('glass', 6) ? [paneRecipe] : []),
      recipesAll: () => [paneRecipe],
      craft: async () => {
        inv.find((i) => i.name === 'glass')!.count -= 6;
        inv.push({ name: 'glass_pane', count: 16, type: 21 });
      },
    } as unknown as Bot;
    return { bot, inv, said };
  }

  it("prend le verre dans le coffre puis fabrique les vitres", async () => {
    const chest = [{ name: 'glass', count: 8, type: 20 }];
    const { bot } = craftBot(chest);
    const r = await SKILLS.craft!.run({ bot, followPlayer: 'B' }, { item: 'glass_pane', count: 1 }, new AbortController().signal);
    expect(r).toMatchObject({ status: 'success', detail: { made: 16 } });
    expect(chest[0]!.count).toBe(2); // il n'a pris que les 6 blocs nécessaires
  });

  it("pas de verre nulle part : il dit ce qui manque", async () => {
    const said: string[] = [];
    const { bot } = craftBot([]);
    const r = await SKILLS.craft!.run({ bot, followPlayer: 'B', speak: (t) => void said.push(t) }, { item: 'glass_pane', count: 1 }, new AbortController().signal);
    expect(r).toMatchObject({ status: 'failure', detail: { precondition: true } });
    expect(said[0]).toBe("Pour fabriquer glass pane, il me manque 6 glass, ni sur moi ni dans les coffres. Tu peux m'en donner ?");
  });
});

it("« Léa, t'es où ? » : position, distance au joueur et à la maison", () => {
  expect(answerWhereQuestion("Léa t'es où ?", { x: -283.4, y: 64, z: 91.6, toPlayer: 37.2, toHome: 120 })).toBe('Je suis en -283 64 92, à 37 blocs de toi, à 120 blocs de la maison.');
  expect(answerWhereQuestion('tu es où', { x: 0, y: 64, z: 0, toPlayer: 2, toHome: 3 })).toBe('Je suis en 0 64 0, juste à côté de toi, à la maison.');
});

describe("fonte automatique (évolution 2)", () => {
  it("il faut des lingots de fer : il fait cuire le fer brut des coffres, puis s'arrête au nombre voulu", async () => {
    const mcData = (await import('minecraft-data')).default('1.21');
    const inv: { name: string; count: number; type: number }[] = [{ name: 'coal', count: 4, type: mcData.itemsByName.coal!.id }];
    const chest = [{ name: 'raw_iron', count: 5, type: mcData.itemsByName.raw_iron!.id }];
    const putInputs: number[] = [];
    const bot = {
      registry: mcData,
      inventory: { items: () => inv.filter((i) => i.count > 0) },
      entity: { position: vec(0, 64, 0) },
      findBlocks: () => [vec(3, 64, 0)],
      findBlock: () => ({ name: 'furnace', position: vec(2, 64, 0) }),
      blockAt: (p: unknown) => ({ name: 'chest', position: p }),
      pathfinder: { goto: async () => {}, setGoal: () => {} },
      openContainer: async () => ({
        containerItems: () => chest.filter((i) => i.count > 0),
        count: (type: number) => inv.filter((i) => i.type === type).reduce((s, i) => s + i.count, 0),
        withdraw: async (_t: number, _m: null, n: number) => {
          chest[0]!.count -= n;
          inv.push({ name: 'raw_iron', count: n, type: chest[0]!.type });
        },
        close: () => {},
      }),
      openFurnace: async () => {
        let cooked = 0;
        return {
          outputItem: () => (cooked > 0 ? { name: 'iron_ingot', count: cooked } : null),
          inputItem: () => null,
          fuelItem: () => null,
          takeOutput: async () => {
            const n = cooked;
            cooked = 0;
            inv.push({ name: 'iron_ingot', count: n, type: mcData.itemsByName.iron_ingot!.id });
            return { count: n };
          },
          putFuel: async () => {},
          putInput: async (_t: number, _m: null, n: number) => {
            putInputs.push(n);
            inv.find((i) => i.name === 'raw_iron')!.count -= n;
            cooked = n;
          },
          close: () => {},
        };
      },
    } as unknown as Bot;
    const got = await smeltFor({ bot, followPlayer: 'B' }, 'iron_ingot', 3, new AbortController().signal);
    expect(got).toBe(3);
    expect(putInputs).toEqual([3]);
    expect(chest[0]!.count).toBe(2);
  });
});

it("« récolte 5 diamant » : l'objet demandé donne ses minerais (cas réel : bloc « diamond » inconnu)", () => {
  const known = ['diamond_ore', 'deepslate_diamond_ore', 'diamond_block', 'iron_ore', 'deepslate_iron_ore', 'coal_ore', 'lapis_ore', 'redstone_ore', 'nether_quartz_ore'];
  expect(expandBlockNames(known, ['diamond']).sort()).toEqual(['deepslate_diamond_ore', 'diamond_ore']);
  expect(expandBlockNames(known, ['diamant']).sort()).toEqual(['deepslate_diamond_ore', 'diamond_ore']);
  expect(expandBlockNames(known, ['raw_iron']).sort()).toEqual(['deepslate_iron_ore', 'iron_ore']);
  expect(expandBlockNames(known, ['lapis_lazuli'])).toEqual(['lapis_ore']);
  expect(expandBlockNames(known, ['quartz'])).toEqual(['nether_quartz_ore']);
  expect(expandBlockNames(known, ['diamond_block'])).toEqual(['diamond_block']);
});
