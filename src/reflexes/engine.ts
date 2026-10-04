import type { Clock } from '../core/clock.js';
import type { Logger } from '../core/logger.js';
import type { ActionController } from '../skills/actionController.js';
import { evaluateReflexes } from './rules.js';
import type { ReflexDecision, ReflexKind, ReflexThresholds, SurvivalSnapshot } from './types.js';

/** Ce dont le moteur a besoin du monde : un instantané et un battement par tick physique. */
export interface ReflexHost {
  snapshot(): SurvivalSnapshot | null;
  onTick(cb: () => void): () => void;
}

/** Exécute physiquement un réflexe ; doit s'arrêter dès que `signal` est annulé. */
export interface ReflexExecutor {
  execute(decision: ReflexDecision, signal: AbortSignal): Promise<void>;
  stop(): void;
}

export interface ReflexEvent {
  kind: ReflexKind;
  reason: string;
  preemptedAction: string | null;
  at: number;
}

/**
 * Vérifie les réflexes à chaque tick physique (20 Hz). En cas de danger :
 * préemption synchrone de l'action en cours, verrou sur le contrôleur, exécution du réflexe.
 */
export class ReflexEngine {
  private active: { decision: ReflexDecision; controller: AbortController } | null = null;
  private lastEnd = new Map<ReflexKind, number>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly host: ReflexHost,
    private readonly actions: ActionController,
    private readonly executor: ReflexExecutor,
    private readonly thresholds: ReflexThresholds,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly onReflex: (e: ReflexEvent) => void = () => {},
    private readonly maxReflexMs = 8000,
    private readonly cooldownMs = 500,
  ) {}

  /** Certains réflexes demandent plus de temps : nager jusqu'à la rive, semer des poursuivants. */
  private limitFor(kind: ReflexKind): number {
    const extra: Partial<Record<ReflexKind, number>> = { surface: 2.5, flee: 2 };
    return Math.round(this.maxReflexMs * (extra[kind] ?? 1));
  }

  start(): void {
    this.stop();
    this.unsubscribe = this.host.onTick(() => this.tick());
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.active) this.active.controller.abort('arrêt du moteur de réflexes');
  }

  get activeReflex(): ReflexKind | null {
    return this.active?.decision.kind ?? null;
  }

  /** Public pour les tests ; appelé à chaque tick par l'hôte. */
  tick(): void {
    let snap: SurvivalSnapshot | null;
    try {
      snap = this.host.snapshot();
    } catch (err) {
      this.logger.warn({ err }, 'instantané de survie impossible');
      return;
    }
    if (!snap) return;
    // état du contrôleur, pas une valeur apprise : un combat en cours change le seuil de fuite
    const decision = evaluateReflexes({ ...snap, fighting: this.actions.current?.name === 'attack' }, this.thresholds);
    if (!decision) return;
    if (this.active && this.active.decision.priority >= decision.priority) return;
    const last = this.lastEnd.get(decision.kind);
    if (!this.active && last !== undefined && this.clock.now() - last < this.cooldownMs) return;
    this.trigger(decision);
  }

  private trigger(decision: ReflexDecision): void {
    const preempted = this.actions.current?.name ?? null;
    if (this.active) this.active.controller.abort('remplacé par un réflexe plus urgent');
    this.actions.block(`réflexe ${decision.kind}`);
    this.actions.abort(`réflexe : ${decision.reason}`);

    const controller = new AbortController();
    this.active = { decision, controller };
    const event: ReflexEvent = { kind: decision.kind, reason: decision.reason, preemptedAction: preempted, at: this.clock.now() };
    this.logger.info(event, 'réflexe déclenché');
    this.onReflex(event);

    const timer = this.clock.setTimeout(() => controller.abort('délai du réflexe dépassé'), this.limitFor(decision.kind));
    const finish = () => {
      timer.cancel();
      if (this.active?.controller === controller) {
        this.active = null;
        this.actions.unblock();
        this.lastEnd.set(decision.kind, this.clock.now());
      }
      try {
        this.executor.stop();
      } catch (err) {
        this.logger.warn({ err }, 'arrêt du réflexe en erreur');
      }
    };
    controller.signal.addEventListener('abort', finish, { once: true });
    this.executor.execute(decision, controller.signal).then(
      () => {
        if (!controller.signal.aborted) controller.abort('réflexe terminé');
      },
      (err: unknown) => {
        this.logger.warn({ err, kind: decision.kind }, 'réflexe en échec');
        if (!controller.signal.aborted) controller.abort('réflexe en échec');
      },
    );
  }
}
