import type { Clock } from '../core/clock.js';

export type ProposalAnswer = 'yes' | 'no' | 'timeout';

interface Pending {
  id: number;
  text: string;
  resolve: (a: ProposalAnswer) => void;
  timer: { cancel(): void };
}

/**
 * Propositions de la bande « propose » : le bot annonce « je peux faire X ? » et attend.
 * Un oui → il agit (et c'est une approbation). Un non → il renonce. Le silence jusqu'au délai vaut
 * accord tacite : il agit, sans le bonus d'une approbation.
 */
export class ProposalBroker {
  private pending: Pending | null = null;
  private nextId = 1;

  constructor(
    private readonly clock: Clock,
    private readonly timeoutMs = 20_000,
  ) {}

  get open(): { id: number; text: string } | null {
    return this.pending ? { id: this.pending.id, text: this.pending.text } : null;
  }

  /** Ouvre une proposition (une seule à la fois : la précédente expire). */
  ask(text: string): Promise<ProposalAnswer> {
    this.settle('timeout');
    return new Promise((resolve) => {
      const id = this.nextId++;
      const timer = this.clock.setTimeout(() => {
        if (this.pending?.id === id) this.settle('timeout');
      }, this.timeoutMs);
      this.pending = { id, text, resolve, timer };
    });
  }

  /** Réponse du joueur (appelée par le module des retours). Renvoie vrai si une proposition attendait. */
  answer(a: 'yes' | 'no'): boolean {
    if (!this.pending) return false;
    this.settle(a);
    return true;
  }

  private settle(a: ProposalAnswer): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    p.timer.cancel();
    p.resolve(a);
  }
}
