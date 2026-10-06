import { describe, expect, it } from 'vitest';
import type { Bot } from 'mineflayer';
import { evaluateOutcome, judged } from '../src/outcome/outcome.js';
import { blueprint } from '../src/skills/blueprint.js';
import { SkillParamsError, SKILLS, toAction } from '../src/skills/library.js';
import type { ActionResult } from '../src/skills/actionController.js';
import { familyOf, matchingItems, planStorage, type ChestSurvey } from '../src/skills/extra.js';
import { openWorld, vec } from './helpers.js';
import { isAddressed } from '../src/feedback/classifier.js';

describe('plans de construction', () => {
  it('mur 7×4 : 28 blocs, posés couche par couche de bas en haut', () => {
    const cells = blueprint({ shape: 'wall', width: 7, height: 4, depth: 1 });
    expect(cells).toHaveLength(28);
    expect(cells.every((c, i) => i === 0 || c.y >= cells[i - 1]!.y)).toBe(true);
    expect(new Set(cells.map((c) => c.z))).toEqual(new Set([0]));
  });

  it('maison : murs avec ouverture de porte, puis toit plein', () => {
    const cells = blueprint({ shape: 'house', width: 5, height: 3, depth: 5 });
    const walls = 3 * 16 - 2; // contour 5×5 = 16 par couche, moins la porte (2 de haut)
    expect(cells).toHaveLength(walls + 25);
    expect(cells.some((c) => c.x === 2 && c.z === 0 && c.y < 2)).toBe(false);
    expect(cells.slice(-25).every((c) => c.y === 3)).toBe(true);
  });

  it('contour d\'abord quand c\'est la préférence apprise', () => {
    const cells = blueprint({ shape: 'floor', width: 4, height: 1, depth: 4, borderFirst: true });
    const firstInterior = cells.findIndex((c) => c.x > 0 && c.x < 3 && c.z > 0 && c.z < 3);
    expect(firstInterior).toBe(12); // les 12 cases du contour passent avant
  });

  it('dimensions bornées : jamais de chantier démesuré', () => {
    expect(blueprint({ shape: 'wall', width: 999, height: 999, depth: 1 })).toHaveLength(16 * 8);
  });
});

describe('bibliothèque de compétences', () => {
  const ctx = { bot: {} as Bot, followPlayer: 'Bastien' };

  it('chaque compétence a un délai maximal et un domaine', () => {
    for (const s of Object.values(SKILLS)) {
      const examples: Record<string, unknown> = {
        build: { shape: 'wall', material: 'stone' },
        collect: { blocks: ['oak_log'] },
        attack: { targets: ['zombie'] },
        craft: { item: 'stick' },
        equip: { item: 'stick' },
        say: { text: 'salut' },
        plant: { seed: 'wheat_seeds' },
        smelt: { item: 'raw_iron' },
        retrieve: { item: 'coal' },
        give: { item: 'log' },
        staircase: { targetY: -10 },
        place: { item: 'furnace' },
        furnace_take: {},
        pickup: {},
        go_home: {},
        sort_chests: {},
        harvest_crops: {},
        bring: { item: 'oak_planks' },
      };
      const params = s.params.parse(examples[s.name] ?? {});
      expect(s.timeoutMs(params)).toBeGreaterThan(0);
      expect(s.timeoutMs(params)).toBeLessThanOrEqual(300_000);
    }
  });

  it('valide les paramètres avant d\'exécuter', () => {
    expect(() => toAction(ctx, 'build', { shape: 'tour_eiffel', material: 'stone' })).toThrow(SkillParamsError);
    expect(() => toAction(ctx, 'teleport', {})).toThrow(SkillParamsError);
    const a = toAction(ctx, 'build', { shape: 'wall', material: 'stone_bricks' });
    expect(a).toMatchObject({ name: 'build', domain: 'build', params: { width: 5, height: 3 } });
  });
});

describe("récolte bloc par bloc (cas réel : 3 bûches rapportées sur 30 demandées)", () => {
  /** Chaque appel à collectblock rapporte `gains[i]` puis abandonne le trajet, comme en jeu. */
  function fakeBot(gains: number[], trees = 40) {
    let logs = 2;
    let call = 0;
    const targets: string[] = [];
    const cut = new Set<number>();
    const bot = {
      registry: { blocksByName: { oak_log: { id: 7 } } },
      findBlocks: () => Array.from({ length: trees }, (_, i) => vec(i, 64, 0)).filter((p) => !cut.has(p.x)),
      blockAt: (p: { x: number; y: number }) => ({ name: p.y === 64 ? 'oak_log' : 'air', position: p }),
      inventory: { items: () => [{ name: 'oak_log', count: logs }] },
      collectBlock: {
        collect: async (t: { position: { x: number } }) => {
          targets.push(String(t.position.x));
          const g = gains[call++] ?? 0;
          logs += g;
          if (g > 0) cut.add(t.position.x); // bloc coupé : il disparaît du monde
          throw new Error('Took to long to decide path to goal!');
        },
        cancelTask: async () => {},
      },
    } as unknown as Bot;
    return { bot, targets };
  }
  const run = (bot: Bot, count = 8) => SKILLS.collect!.run({ bot, followPlayer: 'B' }, { blocks: ['oak_log'], count }, new AbortController().signal);

  it("continue après un trajet abandonné jusqu'au nombre demandé", async () => {
    const { bot } = fakeBot(Array(30).fill(1));
    expect(await run(bot, 30)).toMatchObject({ status: 'success', detail: { gained: 30, requested: 30 } });
  });

  it("un bloc inaccessible est sauté, pas retenté en boucle", async () => {
    const { bot, targets } = fakeBot([0, 1, 1]);
    await run(bot, 2);
    expect(targets).toEqual(['0', '1', '2']);
  });

  it("4 échecs d'affilée : arrêt, avec ce qui a été récolté et la vraie raison", async () => {
    const { bot } = fakeBot([3, 0, 0, 0, 0, 5]);
    expect(await run(bot, 30)).toMatchObject({ status: 'success', detail: { gained: 3, requested: 30, partial: 'Took to long to decide path to goal!' } });
  });

  it("sans rien récolté, c'est un échec avec la vraie raison", async () => {
    expect(await run(fakeBot([]).bot)).toMatchObject({ status: 'failure', detail: { reason: 'Took to long to decide path to goal!' } });
  });
});

describe('résultat d\'une action', () => {
  const base: ActionResult = { action: 'collect', domain: 'gather', status: 'success', startedAt: 0, endedAt: 10 };
  const snap = (inv: Record<string, number>, health = 20, deaths = 0) => ({ health, food: 20, inventory: inv, deaths });

  it('réussite avec gains d\'inventaire', () => {
    const o = evaluateOutcome(base, snap({ oak_log: 2 }), snap({ oak_log: 8 }));
    expect(o).toMatchObject({ status: 'success', inventoryDelta: { oak_log: 6 } });
    expect(o.summary).toContain('+6 oak_log');
    expect(judged(o)).toBe(true);
  });

  it('la mort l\'emporte sur le statut de l\'action', () => {
    const o = evaluateOutcome({ ...base, status: 'preempted' }, snap({}), snap({}, 20, 1));
    expect(o.status).toBe('death');
    expect(judged(o)).toBe(true);
  });

  it('une précondition manquante ou une préemption ne juge pas la branche', () => {
    expect(judged(evaluateOutcome({ ...base, status: 'failure', detail: { precondition: true } }, snap({}), snap({})))).toBe(false);
    expect(judged(evaluateOutcome({ ...base, status: 'preempted' }, snap({}), snap({})))).toBe(false);
  });
});

describe("donner des objets (manque réel : « Alex, donne ton bois »)", () => {
  const inv = [{ name: 'oak_log', count: 5, type: 1 }, { name: 'birch_log', count: 3, type: 2 }, { name: 'oak_planks', count: 8, type: 3 }];

  it("trouve un objet par nom exact ou par famille", () => {
    expect(matchingItems(inv, 'oak_log').map((i) => i.name)).toEqual(['oak_log']);
    expect(matchingItems(inv, 'log').map((i) => i.name)).toEqual(['oak_log', 'birch_log']);
    expect(matchingItems(inv, 'oak').map((i) => i.name)).toEqual(['oak_log', 'oak_planks']);
    expect(matchingItems(inv, 'diamond')).toEqual([]);
  });

  it("lance au joueur la quantité demandée, puis s'arrête", async () => {
    const tossed: [number, number][] = [];
    const pos = { offset: () => pos, x: 0, y: 64, z: 0 };
    const bot = {
      inventory: { items: () => inv },
      players: { B: { entity: { position: pos } } },
      pathfinder: { goto: async () => {}, setGoal: () => {} },
      lookAt: async () => {},
      toss: async (type: number, _m: null, n: number) => void tossed.push([type, n]),
    } as unknown as Bot;
    const r = await SKILLS.give!.run({ bot, followPlayer: 'B' }, { item: 'log', count: 6 }, new AbortController().signal);
    expect(r).toMatchObject({ status: 'success', detail: { given: 6 } });
    expect(tossed).toEqual([[1, 5], [2, 1]]);
  });

  it("sans l'objet : précondition manquante, pas un échec de la branche", async () => {
    const bot = { inventory: { items: () => [] }, players: {} } as unknown as Bot;
    expect(await SKILLS.give!.run({ bot, followPlayer: 'B' }, { item: 'log' }, new AbortController().signal)).toMatchObject({ status: 'failure', detail: { precondition: true } });
  });
});

it("« donne » tout court (item « all ») : tout sauf l'équipement et la nourriture (manque réel)", async () => {
  const tossed: string[] = [];
  const pos = { offset: () => pos, x: 0, y: 64, z: 0 };
  const items = [{ name: 'raw_iron', count: 6, type: 1 }, { name: 'stone_pickaxe', count: 1, type: 2 }, { name: 'bread', count: 3, type: 3 }, { name: 'cobblestone', count: 12, type: 4 }];
  const bot = {
    registry: { foodsByName: { bread: {} } },
    inventory: { items: () => items },
    players: { B: { entity: { position: pos } } },
    pathfinder: { goto: async () => {}, setGoal: () => {} },
    lookAt: async () => {},
    toss: async (type: number, _m: null, n: number) => void tossed.push(`${type}x${n}`),
  } as unknown as Bot;
  const r = await SKILLS.give!.run({ bot, followPlayer: 'B' }, { item: 'all' }, new AbortController().signal);
  expect(r).toMatchObject({ status: 'success', detail: { given: 18 } });
  expect(tossed).toEqual(['1x6', '4x12']);
});

it("« récupère le fer dans les trois fours » : passe par tous les fours, pas seulement le plus proche (manque réel)", async () => {
  const outputs: Record<number, { name: string; count: number } | null> = { 1: null, 2: { name: 'iron_ingot', count: 4 }, 3: { name: 'iron_ingot', count: 2 } };
  const bot = {
    registry: { blocksByName: { furnace: { id: 9 } } },
    findBlocks: () => [{ x: 1, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }, { x: 3, y: 64, z: 0 }],
    blockAt: (p: { x: number }) => ({ name: 'furnace', position: p }),
    pathfinder: { goto: async () => {}, setGoal: () => {} },
    openFurnace: async (b: { position: { x: number } }) => ({
      outputItem: () => outputs[b.position.x],
      takeOutput: async () => outputs[b.position.x],
      close: () => {},
    }),
  } as unknown as Bot;
  const r = await SKILLS.furnace_take!.run({ bot, followPlayer: 'B' }, {}, new AbortController().signal);
  expect(r).toMatchObject({ status: 'success', detail: { taken: { iron_ingot: 6 }, furnaces: 3 } });
});

describe("four sans combustible (manque réel : « Léa va mettre le fer au four »)", () => {
  function furnaceBot(chestItems: { name: string; count: number; type: number }[]) {
    const inv = [{ name: 'raw_iron', count: 4, type: 1 }];
    const said: string[] = [];
    const bot = {
      registry: { itemsByName: { raw_iron: { id: 1 }, coal: { id: 2 } }, blocksByName: { chest: { id: 50 }, furnace: { id: 51 } } },
      inventory: { items: () => inv },
      findBlocks: () => (chestItems.length ? [{ x: 1, y: 64, z: 0 }] : []),
      blockAt: (p: unknown) => ({ name: 'chest', position: p }),
      pathfinder: { goto: async () => {}, setGoal: () => {} },
      openContainer: async () => ({
        containerItems: () => chestItems,
        count: (type: number) => inv.filter((i) => i.type === type).reduce((s, i) => s + i.count, 0),
        withdraw: async (type: number, _m: null, n: number) => void inv.push({ name: chestItems.find((i) => i.type === type)!.name, count: n, type }),
        close: () => {},
      }),
      findBlock: () => null,
    } as unknown as Bot;
    return { bot, said, inv };
  }

  it("prend du charbon dans un coffre proche", async () => {
    const { bot, inv } = furnaceBot([{ name: 'coal', count: 10, type: 2 }]);
    // la suite (four, cuisson) n'est pas simulée ici : seul compte le passage au coffre
    await SKILLS.smelt!.run({ bot, followPlayer: 'B' }, { item: 'raw_iron', count: 4 }, new AbortController().signal).catch(() => null);
    expect(inv.some((i) => i.name === 'coal')).toBe(true);
  });

  it("sans charbon nulle part : il le demande au joueur", async () => {
    const said: string[] = [];
    const { bot } = furnaceBot([]);
    const r = await SKILLS.smelt!.run({ bot, followPlayer: 'B', speak: (t) => void said.push(t) }, { item: 'raw_iron', count: 4 }, new AbortController().signal);
    expect(r).toMatchObject({ status: 'failure', detail: { reason: 'pas de combustible', precondition: true } });
    expect(said[0]).toContain('Il me faut du combustible');
  });
});

it("« Léa, donne ton fer » dit par le joueur d'Alex s'adresse à Léa, pas à Alex (cas réel)", () => {
  expect(isAddressed('lea donne ton fer', 'Lea')).toBe(true);
  expect(isAddressed('lea donne ton fer', 'Alex')).toBe(false);
  // « à Léa » en fin de phrase : le bot appelé par son propre nom l'emporte (règle de App.hear)
  const forAlex = (t: string) => isAddressed(t, 'Alex') || !isAddressed(t, 'Lea');
  expect(forAlex('Alex, donne ton fer à Léa')).toBe(true);
  expect(forAlex('lea donne ton fer')).toBe(false);
});

it("« reprends tes affaires au sol » : va sur chaque objet tombé, du plus proche au plus loin (manque réel)", async () => {
  const at = (x: number) => ({ x, y: 64, z: 0, distanceTo: (o: { x: number }) => Math.abs(o.x - x) });
  const me = at(0);
  const inv: { name: string; count: number }[] = [];
  const visited: number[] = [];
  const entities: Record<number, { id: number; name: string; position: ReturnType<typeof at> }> = {
    1: { id: 1, name: 'item', position: at(6) },
    2: { id: 2, name: 'item', position: at(2) },
    3: { id: 3, name: 'zombie', position: at(3) },
  };
  const bot = {
    entity: { position: me },
    entities,
    inventory: { items: () => inv },
    pathfinder: {
      goto: async (g: { x: number }) => {
        visited.push(g.x);
        const e = Object.values(entities).find((x) => x.name === 'item' && x.position.x === g.x);
        if (e) {
          delete entities[e.id];
          inv.push({ name: 'cobblestone', count: 8 });
        }
      },
      setGoal: () => {},
    },
  } as unknown as Bot;
  const r = await SKILLS.pickup!.run({ bot, followPlayer: 'B' }, { radius: 16 }, new AbortController().signal);
  expect(visited).toEqual([2, 6]);
  expect(r).toMatchObject({ status: 'success', detail: { gained: 16 } });
});

it("« tue les poules » : enchaîne les cibles à portée, puis s'arrête (manque réel)", async () => {
  const chickens = [1, 2].map((id) => ({ id, name: 'chicken', isValid: true, position: vec(20, 64, id) }));
  const bot = {
    entity: { position: vec(0, 64, 0) },
    world: openWorld,
    health: 20,
    inventory: { items: () => [] },
    nearestEntity: (f: (e: unknown) => boolean) => chickens.find((c) => c.isValid && f(c)) ?? null,
    pvp: {
      attack: async (t: { isValid: boolean }) => void setTimeout(() => (t.isValid = false), 10),
      forceStop: () => {},
      attackRange: 3,
    },
  } as unknown as Bot;
  const r = await SKILLS.attack!.run({ bot, followPlayer: 'B' }, { targets: ['chicken'], engageDistance: 3, retreatHp: 6, useShield: false }, new AbortController().signal);
  expect(r).toMatchObject({ status: 'success', detail: { killed: ['chicken', 'chicken'] } });
});

it("sable dans l'eau et à la surface : la surface d'abord (cas réel : le bot s'est noyé)", async () => {
  const targets: number[] = [];
  let sand = 0;
  const water = new Set(['0,65,0']); // le sable en x=0 est sous l'eau, celui en x=5 à l'air libre
  const bot = {
    registry: { blocksByName: { sand: { id: 3 } } },
    findBlocks: () => [vec(0, 64, 0), vec(5, 64, 0)],
    blockAt: (p: { x: number; y: number; z: number }) => ({ name: water.has(`${p.x},${p.y},${p.z}`) ? 'water' : p.y === 64 ? 'sand' : 'air', position: p }),
    inventory: { items: () => [{ name: 'sand', count: sand }] },
    collectBlock: { collect: async (t: { position: { x: number } }) => void (targets.push(t.position.x), sand++), cancelTask: async () => {} },
  } as unknown as Bot;
  await SKILLS.collect!.run({ bot, followPlayer: 'B' }, { blocks: ['sand'], count: 1 }, new AbortController().signal);
  expect(targets).toEqual([5]);
});

it("four occupé : vide la sortie et l'entrée étrangère avant de cuire le sable (cas réel : destination full)", async () => {
  const calls: string[] = [];
  const inv = [{ name: 'sand', count: 8, type: 10 }, { name: 'coal', count: 4, type: 2 }];
  const bot = {
    registry: { itemsByName: { sand: { id: 10 }, coal: { id: 2 } }, blocksByName: { furnace: { id: 51 } } },
    inventory: { items: () => inv },
    findBlock: () => ({ name: 'furnace', position: vec(1, 64, 0) }),
    pathfinder: { goto: async () => {}, setGoal: () => {} },
    openFurnace: async () => ({
      outputItem: () => (calls.includes('takeOutput') ? null : { name: 'glass', count: 8 }),
      inputItem: () => (calls.includes('takeInput') ? null : { type: 99, name: 'raw_iron' }),
      fuelItem: () => null,
      takeOutput: async () => void calls.push('takeOutput'),
      takeInput: async () => void calls.push('takeInput'),
      putFuel: async () => void calls.push('putFuel'),
      putInput: async () => {
        calls.push('putInput');
        throw new Error('fin du test');
      },
      close: () => {},
    }),
  } as unknown as Bot;
  await SKILLS.smelt!.run({ bot, followPlayer: 'B' }, { item: 'sand', count: 8 }, new AbortController().signal).catch(() => null);
  expect(calls).toEqual(['takeOutput', 'takeInput', 'putFuel', 'putInput']);
});

describe("ranger dans le bon coffre (cas réel : trois coffres à la maison, le bot ouvrait le mauvais)", () => {
  it("chaque objet va avec ses semblables, le reste dans le coffre le plus libre", () => {
    const chests: ChestSurvey[] = [
      { contents: { cobblestone: 64, dirt: 30 }, free: 20 },
      { contents: { oak_log: 40, birch_planks: 12 }, free: 10 },
      { contents: { raw_iron: 5, coal: 20 }, free: 24 },
    ];
    const plan = planStorage(['spruce_log', 'raw_iron', 'iron_ingot', 'cobblestone', 'white_wool'], chests);
    expect(plan.spruce_log![0]).toBe(1); // bois avec le bois
    expect(plan.raw_iron![0]).toBe(2); // même objet
    expect(plan.iron_ingot![0]).toBe(2); // même famille (minerais)
    expect(plan.cobblestone![0]).toBe(0);
    expect(plan.white_wool![0]).toBe(2); // rien de semblable : le plus de place
    expect(familyOf('deepslate_iron_ore')).toBe('minerais');
  });

  it("dépose dans le coffre du bois et dans celui des minerais, pas tout dans le plus proche", async () => {
    const chestAt = (x: number) => vec(x, 64, 0);
    const contents: Record<number, { name: string; count: number; type: number }[]> = {
      1: [{ name: 'cobblestone', count: 64, type: 1 }],
      2: [{ name: 'oak_log', count: 40, type: 2 }],
      3: [{ name: 'coal', count: 20, type: 3 }],
    };
    const inv = [{ name: 'birch_log', count: 6, type: 20 }, { name: 'raw_iron', count: 4, type: 21 }, { name: 'stone_pickaxe', count: 1, type: 22 }];
    const deposits: string[] = [];
    let opened = 0;
    const bot = {
      entity: { position: vec(0, 64, 0) },
      registry: { blocksByName: { chest: { id: 54 } }, foodsByName: {} },
      findBlocks: () => [chestAt(1), chestAt(2), chestAt(3)],
      blockAt: (p: { x: number }) => ({ name: 'chest', position: p }),
      inventory: { items: () => inv.filter((i) => i.count > 0) },
      pathfinder: { goto: async () => {}, setGoal: () => {} },
      openContainer: async (b: { position: { x: number } }) => {
        const x = b.position.x;
        opened++;
        return {
          inventoryStart: 27,
          containerItems: () => contents[x]!,
          deposit: async (type: number, _m: null, n: number) => {
            const it = inv.find((i) => i.type === type)!;
            deposits.push(`${it.name}→${x}`);
            it.count -= n;
          },
          close: () => {},
        };
      },
    } as unknown as Bot;
    const r = await SKILLS.store!.run({ bot, followPlayer: 'B' }, {}, new AbortController().signal);
    expect(r).toMatchObject({ status: 'success' });
    expect(deposits.sort()).toEqual(['birch_log→2', 'raw_iron→3']);
    expect(opened).toBe(5); // 3 coffres inspectés, 2 utilisés
  });
});

it("agriculture : récolte seulement le blé mûr et replante sur la terre labourée (évolution 3)", async () => {
  const field: Record<string, { name: string; age: number }> = { '1,64,0': { name: 'wheat', age: 7 }, '2,64,0': { name: 'wheat', age: 3 } };
  const inv = [{ name: 'wheat_seeds', count: 4, type: 1 }];
  const dug: string[] = [];
  const planted: string[] = [];
  const blockAt = (p: { x: number; y: number; z: number }) => {
    if (p.y === 63) return { name: 'farmland', position: vec(p.x, p.y, p.z) };
    const c = field[`${p.x},${p.y},${p.z}`];
    return c ? { name: c.name, position: vec(p.x, p.y, p.z), getProperties: () => ({ age: c.age }) } : { name: 'air', position: vec(p.x, p.y, p.z) };
  };
  const bot = {
    registry: { blocksByName: { wheat: { id: 10 }, carrots: { id: 11 }, potatoes: { id: 12 }, beetroots: { id: 13 } } },
    findBlocks: (o: { useExtraInfo: (b: unknown) => boolean }) => Object.keys(field).map((k) => k.split(',').map(Number) as [number, number, number]).map(([x, y, z]) => vec(x, y, z)).filter((p) => o.useExtraInfo(blockAt(p))),
    blockAt,
    inventory: { items: () => inv },
    pathfinder: { goto: async () => {}, setGoal: () => {} },
    dig: async (b: { position: { x: number } }) => {
      dug.push(String(b.position.x));
      delete field[`${b.position.x},64,0`];
    },
    equip: async () => {},
    placeBlock: async (soil: { position: { x: number } }) => void planted.push(String(soil.position.x)),
  } as unknown as Bot;
  const r = await SKILLS.harvest_crops!.run({ bot, followPlayer: 'B' }, { count: 10, replant: true }, new AbortController().signal);
  expect(r).toMatchObject({ status: 'success', detail: { harvested: 1, replanted: 1 } });
  expect(dug).toEqual(['1']);
  expect(planted).toEqual(['1']);
});
