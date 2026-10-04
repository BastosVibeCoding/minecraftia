import type { LlmPurpose } from './llm.js';

/**
 * Routage des modèles : le petit modèle pour les décisions fréquentes ; le gros uniquement après des
 * échecs répétés dans la même situation, ou pour composer une nouvelle compétence (enchaînement).
 */
export class ModelRouter {
  private failures = new Map<string, number>();

  constructor(
    readonly fast: string,
    readonly strong: string,
    readonly escalateAfter = 3,
  ) {}

  pick(purpose: LlmPurpose, situationHash?: string): { model: string; reason: string } {
    if (purpose === 'compose') return { model: this.strong, reason: 'composition d\'une nouvelle compétence' };
    const n = situationHash ? (this.failures.get(situationHash) ?? 0) : 0;
    if (purpose === 'decide' && n >= this.escalateAfter) return { model: this.strong, reason: `${n} échecs consécutifs dans cette situation` };
    return { model: this.fast, reason: 'décision courante' };
  }

  recordOutcome(situationHash: string, success: boolean): void {
    if (success) this.failures.delete(situationHash);
    else this.failures.set(situationHash, (this.failures.get(situationHash) ?? 0) + 1);
  }

  consecutiveFailures(situationHash: string): number {
    return this.failures.get(situationHash) ?? 0;
  }
}
