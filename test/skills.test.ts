import { describe, expect, it } from 'vitest';
import type { Bot } from 'mineflayer';
import { evaluateOutcome, judged } from '../src/outcome/outcome.js';
import { blueprint } from '../src/skills/blueprint.js';
import { SkillParamsError, SKILLS, toAction } from '../src/skills/library.js';
import type { ActionResult } from '../src/skills/actionController.js';

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
      const params = s.params.parse(s.name === 'build' ? { shape: 'wall', material: 'stone' } : s.name === 'collect' ? { blocks: ['oak_log'] } : s.name === 'attack' ? { targets: ['zombie'] } : s.name === 'craft' || s.name === 'equip' ? { item: 'stick' } : s.name === 'say' ? { text: 'salut' } : {});
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
