import type { Clock } from '../core/clock.js';
import type { Domain } from '../core/types.js';
import type { Db } from '../store/db.js';
import type { Decision } from './schema.js';

/**
 * Cache des décisions pour situations quasi identiques (même signature quantifiée).
 * Invalidé par domaine dès qu'une correction touche ce domaine.
 */
export class DecisionCache {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly ttlMs = 120_000,
  ) {}

  get(hash: string): Decision | null {
    const row = this.db.prepare('SELECT decision_json, expires_at FROM decision_cache WHERE situation_hash = ?').get(hash) as
      | { decision_json: string; expires_at: number }
      | undefined;
    if (!row) return null;
    if (row.expires_at <= this.clock.now()) {
      this.db.prepare('DELETE FROM decision_cache WHERE situation_hash = ?').run(hash);
      return null;
    }
    this.db.prepare('UPDATE decision_cache SET hits = hits + 1 WHERE situation_hash = ?').run(hash);
    return JSON.parse(row.decision_json) as Decision;
  }

  set(hash: string, domain: Domain, decision: Decision): void {
    this.db
      .prepare(
        `INSERT INTO decision_cache(situation_hash, domain, decision_json, hits, expires_at) VALUES (?, ?, ?, 0, ?)
         ON CONFLICT(situation_hash) DO UPDATE SET domain = excluded.domain, decision_json = excluded.decision_json, hits = 0, expires_at = excluded.expires_at`,
      )
      .run(hash, domain, JSON.stringify(decision), this.clock.now() + this.ttlMs);
  }

  invalidateDomain(domain: Domain): number {
    return this.db.prepare('DELETE FROM decision_cache WHERE domain = ?').run(domain).changes;
  }

  clear(): void {
    this.db.exec('DELETE FROM decision_cache');
  }
}
