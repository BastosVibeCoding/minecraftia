import { describe, expect, it } from 'vitest';
import { expandBlockNames } from '../src/skills/library.js';
import { facing, planStep } from '../src/skills/staircase.js';
import { craftableTier, hasTool, toolFor } from '../src/skills/tools.js';
import { answerInventoryQuestion } from '../src/feedback/questions.js';

describe("outils : se refaire une hache cassée (question du joueur, 2026-10-05)", () => {
  it("choisit l'outil selon le bloc", () => {
    expect(toolFor('oak_log')).toBe('axe');
    expect(toolFor('deepslate_iron_ore')).toBe('pickaxe');
    expect(toolFor('stone')).toBe('pickaxe');
    expect(toolFor('dirt')).toBeNull();
  });

  it("repère qu'il n'a plus d'outil, et le meilleur qu'il peut fabriquer", () => {
    expect(hasTool([{ name: 'stone_axe' }], 'axe')).toBe(true);
    expect(hasTool([{ name: 'stone_pickaxe' }], 'axe')).toBe(false);
    expect(craftableTier({ cobblestone: 5, oak_planks: 4 }, 'pickaxe')).toBe('stone_pickaxe');
    expect(craftableTier({ oak_log: 2 }, 'axe')).toBe('wooden_axe');
    expect(craftableTier({ dirt: 64 }, 'axe')).toBeNull();
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
