import type { Clock } from '../core/clock.js';
import type { Db } from '../store/db.js';
import type { LlmPurpose } from './llm.js';

/** Prix en dollars par million de tokens (entrée, sortie). Relevés sur OpenRouter le 2026-10-04. */
export const DEFAULT_PRICES: Record<string, { input: number; output: number }> = {
  'anthropic/claude-haiku-4.5': { input: 1, output: 5 },
  'anthropic/claude-sonnet-5.5': { input: 2, output: 10 },
  'anthropic/claude-opus-5.5': { input: 4, output: 20 },
};

export interface CallRecord {
  purpose: LlmPurpose;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number | null;
  latencyMs: number;
  ok: boolean;
  error?: string;
}

/**
 * Budget quotidien (journée locale). Chaque appel est consigné dans `llm_calls` avec tokens et coût ;
 * au-delà du plafond, `exhausted()` devient vrai et le décideur se coupe.
 */
export class Budget {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    readonly dailyUsd: number,
    private readonly prices: Record<string, { input: number; output: number }> = DEFAULT_PRICES,
  ) {}

  /** Coût estimé à partir des tokens (utilisé quand le fournisseur ne donne pas le coût). */
  estimate(model: string, promptTokens: number, completionTokens: number): number {
    const p = this.prices[model] ?? this.prices[model.replace(/:.*$/, '')] ?? { input: 5, output: 25 };
    return (promptTokens * p.input + completionTokens * p.output) / 1_000_000;
  }

  private dayStart(): number {
    const d = new Date(this.clock.now());
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  spentToday(): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM llm_calls WHERE at >= ?').get(this.dayStart()) as { s: number };
    return row.s;
  }

  remaining(): number {
    return Math.max(0, this.dailyUsd - this.spentToday());
  }

  exhausted(): boolean {
    return this.spentToday() >= this.dailyUsd;
  }

  record(c: CallRecord): number {
    const cost = c.costUsd ?? this.estimate(c.model, c.promptTokens, c.completionTokens);
    this.db
      .prepare('INSERT INTO llm_calls(purpose, model, prompt_tokens, completion_tokens, cost_usd, latency_ms, ok, error, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(c.purpose, c.model, c.promptTokens, c.completionTokens, cost, c.latencyMs, c.ok ? 1 : 0, c.error ?? null, this.clock.now());
    return cost;
  }

  /** Résumé du jour pour les commandes d'inspection. */
  today(): { calls: number; costUsd: number; promptTokens: number; completionTokens: number } {
    const r = this.db
      .prepare('SELECT COUNT(*) AS calls, COALESCE(SUM(cost_usd),0) AS cost, COALESCE(SUM(prompt_tokens),0) AS pt, COALESCE(SUM(completion_tokens),0) AS ct FROM llm_calls WHERE at >= ?')
      .get(this.dayStart()) as { calls: number; cost: number; pt: number; ct: number };
    return { calls: r.calls, costUsd: r.cost, promptTokens: r.pt, completionTokens: r.ct };
  }
}
