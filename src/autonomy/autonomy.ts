import { DOMAINS, type Domain } from '../core/types.js';
import type { Band } from '../decider/prompt.js';
import type { EpisodeSource, Store } from '../store/store.js';

/** Seuils entre bandes : observer → imiter → proposer → agir seul. */
export const THRESHOLDS: { band: Band; from: number }[] = [
  { band: 'observe', from: 0 },
  { band: 'imitate', from: 0.25 },
  { band: 'propose', from: 0.5 },
  { band: 'act', from: 0.75 },
];

/** Gains (vers 1) et pertes (vers 0), proportionnels à la distance restante (voir PLAN.md §2 [4]). */
export const CHANGES = {
  success: { gain: 0.04 },
  approval: { gain: 0.08 },
  failure: { loss: 0.06 },
  refusal: { loss: 0.06 },
  correction: { loss: 0.2 },
  death: { loss: 0.3 },
} as const;

/** Regarder le joueur fait passer d'observer à imiter, jamais au-delà : il faut ensuite réussir. */
export const OBSERVATION = { observed: 0.02, taught: 0.06, corrected: 0.03, legacy: 0.02, cap: 0.35 } as const;

export type AutonomyEvent = keyof typeof CHANGES;

export interface DomainAutonomy {
  score: number;
  band: Band;
}

const HYSTERESIS = 0.03;

function rawBand(score: number): Band {
  let band: Band = 'observe';
  for (const t of THRESHOLDS) if (score >= t.from) band = t.band;
  return band;
}

/** Bande avec hystérésis : il faut dépasser un seuil de `h` pour monter, passer `h` sous lui pour descendre. */
export function bandWithHysteresis(score: number, previous: Band, h = HYSTERESIS): Band {
  const idx = (b: Band) => THRESHOLDS.findIndex((t) => t.band === b);
  let current = idx(previous);
  while (current < THRESHOLDS.length - 1 && score >= THRESHOLDS[current + 1]!.from + h) current++;
  while (current > 0 && score < THRESHOLDS[current]!.from - h) current--;
  // garde-fou : jamais plus d'une bande d'écart avec la bande brute
  const raw = idx(rawBand(score));
  return THRESHOLDS[Math.max(raw - 1, Math.min(raw + 1, current))]!.band;
}

/**
 * Niveau d'autonomie : un score continu par domaine, persisté (table `autonomy`, historique dans
 * `autonomy_events`). Le bot peut agir seul en construction et n'être qu'observateur en combat.
 */
export class Autonomy {
  private state = new Map<Domain, DomainAutonomy>();

  constructor(private readonly store: Store) {
    const saved = store.getAutonomy();
    for (const d of DOMAINS) {
      const s = saved[d];
      const score = s?.score ?? 0;
      const band = (s?.band as Band | undefined) && THRESHOLDS.some((t) => t.band === s?.band) ? (s!.band as Band) : rawBand(score);
      this.state.set(d, { score, band });
    }
  }

  get(domain: Domain): DomainAutonomy {
    return { ...this.state.get(domain)! };
  }

  all(): Record<Domain, DomainAutonomy> {
    return Object.fromEntries(DOMAINS.map((d) => [d, this.get(d)])) as Record<Domain, DomainAutonomy>;
  }

  /** Score le plus élevé, tous domaines confondus (cadence des initiatives). */
  max(): number {
    return Math.max(...DOMAINS.map((d) => this.state.get(d)!.score));
  }

  apply(domain: Domain, event: AutonomyEvent, refId?: number): DomainAutonomy {
    const cur = this.state.get(domain)!;
    const c = CHANGES[event];
    const next = 'gain' in c ? cur.score + c.gain * (1 - cur.score) : cur.score - c.loss * cur.score;
    return this.set(domain, next, event, refId);
  }

  /** Observation passive ou enseignement dans un domaine (plafonnée). */
  observe(domain: Domain, source: EpisodeSource, refId?: number): DomainAutonomy {
    const cur = this.state.get(domain)!;
    if (cur.score >= OBSERVATION.cap) return this.get(domain);
    return this.set(domain, Math.min(OBSERVATION.cap, cur.score + OBSERVATION[source]), `observation (${source})`, refId);
  }

  private set(domain: Domain, score: number, reason: string, refId?: number): DomainAutonomy {
    const cur = this.state.get(domain)!;
    const clamped = Math.max(0, Math.min(1, score));
    const band = bandWithHysteresis(clamped, cur.band);
    const next = { score: Math.round(clamped * 10000) / 10000, band };
    this.state.set(domain, next);
    this.store.setAutonomy(domain, next.score, band, reason, next.score - cur.score, refId);
    return { ...next };
  }
}

/**
 * Comportement gradué (pas de paliers rigides) : à partir du score, la cadence des initiatives et le
 * délai maximal d'une action varient continûment.
 */
export const graded = {
  /** Intervalle entre deux initiatives spontanées ; `null` = pas d'initiative (sous la bande « propose »). */
  initiativeIntervalMs(score: number): number | null {
    if (score < 0.5) return null;
    const t = (Math.min(1, score) - 0.5) / 0.5; // 0 → 1
    return Math.round(90_000 - t * 70_000); // 90 s à 0,5 → 20 s à 1
  },
  /** Facteur appliqué au délai maximal d'une action : prudence quand la confiance est faible. */
  timeoutFactor(score: number): number {
    return 0.5 + 0.5 * Math.min(1, Math.max(0, score));
  },
};
