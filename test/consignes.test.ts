import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/commands/commands.js';
import { ManualClock } from '../src/core/clock.js';
import { userPrompt } from '../src/decider/prompt.js';
import { ConsignesStore, isStandingInstruction } from '../src/feedback/consignes.js';
import { openDatabase } from '../src/store/db.js';
import { world } from './helpers.js';

describe("mémoire des consignes du joueur (évolution 6)", () => {
  it("reconnaît une consigne durable, pas un ordre ponctuel ni une question", () => {
    for (const t of [
      'Alex, retiens que le fer va dans le coffre de droite',
      "à l'avenir, range toujours le bois près de la porte",
      "je n'aime pas que tu casses les fleurs",
      'ne coupe plus jamais les arbres du jardin',
      'mets toujours les torches dans le coffre divers',
      'désormais, reste près de moi la nuit',
    ]) expect(isStandingInstruction(t), t).toBe(true);
    for (const t of ['coupe du bois', 'range tes affaires', "tu te souviens de quoi ?", 'trie les coffres']) expect(isStandingInstruction(t), t).toBe(false);
  });

  it("garde les consignes en base, sans doublon, et en retire une", () => {
    const { db } = openDatabase(':memory:');
    const s = new ConsignesStore(db, new ManualClock(0));
    s.add('le fer va dans le coffre de droite');
    s.add('Le fer va dans le coffre de droite');
    s.add('ne casse pas les fleurs');
    expect(new ConsignesStore(db, new ManualClock(0)).texts()).toEqual(['Le fer va dans le coffre de droite', 'ne casse pas les fleurs']);
    expect(s.remove(1)).toBe('Le fer va dans le coffre de droite');
    expect(s.texts()).toEqual(['ne casse pas les fleurs']);
  });

  it("les consignes partent au modèle avec chaque décision", () => {
    const prompt = userPrompt({ trigger: 'ordre du joueur', world: world(), autonomy: {}, branches: [], lastOutcome: null, consignes: ['ne casse pas les fleurs'] });
    expect(prompt).toContain('"consignes":["ne casse pas les fleurs"]');
  });

  it("!consignes les liste, !oublie consigne 1 en retire une", async () => {
    const { db } = openDatabase(':memory:');
    const consignes = new ConsignesStore(db, new ManualClock(0));
    consignes.add('reste près de moi la nuit');
    let cleared = 0;
    const deps = { consignes, cache: { clear: () => void cleared++ } } as never;
    expect(await runCommand('!consignes', deps)).toBe('Tes consignes :\n1. reste près de moi la nuit');
    expect(await runCommand('!oublie consigne 1', deps)).toBe("J'oublie la consigne : « reste près de moi la nuit ».");
    expect(cleared).toBe(1);
  });
});
