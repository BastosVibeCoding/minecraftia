import type { Classification } from './classifier.js';

const norm = (t: string) =>
  t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export interface VoicePipelineDeps {
  /** Traite une phrase ; `final: false` laisse une phrase adressée mais incomprise en suspens (`unclear`). */
  handle: (text: string, final: boolean) => Promise<Classification>;
  /** Retranscription précise de la phrase (modèle plus gros), si le service la garde encore. */
  refine?: (id: number) => Promise<string | null>;
  /** Correction de la phrase par le modèle de langage, d'après le contexte du jeu. */
  correct?: (text: string) => Promise<string | null>;
}

export type VoiceRoute = 'directe' | 'retranscription' | 'correction' | 'incomprise';

/**
 * Comprendre une phrase dite à voix haute, en trois temps (le reste du temps, aucun délai) :
 * 1. la transcription rapide ; si elle est comprise, c'est fini ;
 * 2. sinon, si elle s'adressait au bot, une retranscription précise du même son ;
 * 3. sinon, une correction par le modèle de langage ; enfin, la dernière version est traitée pour de bon
 *    (manque noté, réponse de conversation).
 */
export async function understandVoice(text: string, id: number | undefined, d: VoicePipelineDeps): Promise<{ result: Classification; text: string; route: VoiceRoute }> {
  let result = await d.handle(text, false);
  if (!result.unclear) return { result, text, route: 'directe' };
  let latest = text;
  if (id !== undefined && d.refine) {
    const refined = await d.refine(id);
    if (refined && norm(refined) !== norm(text)) {
      latest = refined;
      result = await d.handle(refined, false);
      if (!result.unclear) return { result, text: refined, route: 'retranscription' };
    }
  }
  if (d.correct) {
    const corrected = await d.correct(latest);
    if (corrected && norm(corrected) !== norm(latest)) {
      result = await d.handle(corrected, false);
      if (!result.unclear) return { result, text: corrected, route: 'correction' };
    }
  }
  result = await d.handle(latest, true);
  return { result, text: latest, route: 'incomprise' };
}
