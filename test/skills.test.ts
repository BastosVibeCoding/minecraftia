import { describe, expect, it } from 'vitest';
import type { Bot } from 'mineflayer';
import { evaluateOutcome, judged } from '../src/outcome/outcome.js';
import { blueprint } from '../src/skills/blueprint.js';
import { SkillParamsError, SKILLS, toAction } from '../src/skills/library.js';
import type { ActionResult } from '../src/skills/actionController.js';
import { matchingItems } from '../src/skills/extra.js';

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

describe('récolte interrompue par le pathfinder (cas réel)', () => {
  function fakeBot(gainOnCollect: number) {
    let logs = 2;
    return {
      registry: { blocksByName: { oak_log: { id: 7 } } },
      findBlocks: () => [{ x: 1, y: 64, z: 1 }],
      blockAt: (p: unknown) => ({ position: p }),
      inventory: { items: () => [{ name: 'oak_log', count: logs }] },
      collectBlock: {
        collect: async () => {
          logs += gainOnCollect;
          throw new Error('Took to long to decide path to goal!');
        },
        cancelTask: async () => {},
      },
    } as unknown as Bot;
  }
  const run = (bot: Bot) => SKILLS.collect!.run({ bot, followPlayer: 'B' }, { blocks: ['oak_log'], count: 8 }, new AbortController().signal);

  it("ce qui est arrivé dans l'inventaire compte, même si le trajet a été abandonné", async () => {
    expect(await run(fakeBot(6))).toMatchObject({ status: 'success', detail: { gained: 6, partial: 'Took to long to decide path to goal!' } });
  });

  it("sans rien récolté, c'est un échec avec la vraie raison", async () => {
    expect(await run(fakeBot(0))).toMatchObject({ status: 'failure', detail: { reason: 'Took to long to decide path to goal!' } });
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
