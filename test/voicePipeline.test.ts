import { describe, expect, it } from 'vitest';
import type { Classification } from '../src/feedback/classifier.js';
import { understandVoice } from '../src/feedback/voicePipeline.js';

const understood: Classification = { label: 'order', confidence: 0.9, classifier: 'rules' };
const unclear: Classification = { label: 'chatter', confidence: 0.8, classifier: 'rules', unclear: true };

describe("voix : transcription rapide, puis précise, puis corrigée (combinaison 1 + 2)", () => {
  it("phrase comprise du premier coup : aucune retranscription ni correction", async () => {
    let refined = 0;
    const r = await understandVoice('Alex, coupe du bois', 1, { handle: async () => understood, refine: async () => (refined++, null) });
    expect(r.route).toBe('directe');
    expect(refined).toBe(0);
  });

  it("incomprise : la retranscription précise est essayée et retenue si elle est comprise", async () => {
    const seen: [string, boolean][] = [];
    const r = await understandVoice('Alex, mettez Jean-Bière', 7, {
      handle: async (t, final) => (seen.push([t, final]), t.includes('jambières') ? understood : unclear),
      refine: async (id) => (id === 7 ? 'Alex, mets tes jambières' : null),
      correct: async () => 'jamais appelé',
    });
    expect(r).toMatchObject({ route: 'retranscription', text: 'Alex, mets tes jambières' });
    expect(seen).toEqual([['Alex, mettez Jean-Bière', false], ['Alex, mets tes jambières', false]]);
  });

  it("toujours incomprise : correction par le modèle de langage", async () => {
    const r = await understandVoice('Léa, récolte du boulot', 3, {
      handle: async (t) => (t.includes('bouleau') ? understood : unclear),
      refine: async () => 'Léa, récolte du boulot',
      correct: async () => 'Léa, récolte du bouleau',
    });
    expect(r).toMatchObject({ route: 'correction', text: 'Léa, récolte du bouleau' });
  });

  it("rien n'y fait : la dernière version est traitée pour de bon (manque noté, réponse)", async () => {
    const finals: string[] = [];
    const r = await understandVoice('Alex, 5-3-HEL', 4, {
      handle: async (t, final) => (final && finals.push(t), unclear),
      refine: async () => 'Alex, cinq trois elle',
      correct: async () => null,
    });
    expect(r.route).toBe('incomprise');
    expect(finals).toEqual(['Alex, cinq trois elle']);
  });
});
