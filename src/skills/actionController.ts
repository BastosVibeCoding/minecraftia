import type { Clock } from '../core/clock.js';
import type { ActionStatus, Domain } from '../core/types.js';

export interface Action {
  name: string;
  domain: Domain;
  /** Délai maximal : au-delà, l'action est interrompue avec le statut `timeout`. */
  timeoutMs: number;
  params?: Record<string, unknown>;
  /** Doit s'arrêter rapidement quand `signal` est annulé. */
  run(signal: AbortSignal): Promise<ActionRunOutput | void>;
}

export interface ActionRunOutput {
  /** `failure` si l'action s'est terminée sans atteindre son but. Par défaut : `success`. */
  status?: 'success' | 'failure';
  detail?: Record<string, unknown>;
}

export interface ActionResult {
  action: string;
  domain: Domain;
  params?: Record<string, unknown>;
  status: ActionStatus;
  reason?: string;
  detail?: Record<string, unknown>;
  startedAt: number;
  endedAt: number;
}

interface Running {
  action: Action;
  controller: AbortController;
  startedAt: number;
  settle: (status: ActionStatus, reason?: string) => void;
}

/**
 * Exécute une action à la fois, avec délai maximal, et permet à tout moment de la préempter.
 * `stopAll` coupe les moteurs mineflayer (pathfinder, pvp, collectblock) lors d'une préemption.
 */
export class ActionController {
  private running: Running | null = null;
  private blockedBy: string | null = null;

  constructor(
    private readonly clock: Clock,
    private readonly stopAll: () => void,
    private readonly onResult: (r: ActionResult) => void = () => {},
  ) {}

  get current(): Action | null {
    return this.running?.action ?? null;
  }

  get isBusy(): boolean {
    return this.running !== null;
  }

  get blockReason(): string | null {
    return this.blockedBy;
  }

  /** Tant qu'un réflexe tient le verrou, aucune nouvelle action ne démarre. */
  block(reason: string): void {
    this.blockedBy = reason;
  }

  unblock(): void {
    this.blockedBy = null;
  }

  run(action: Action): Promise<ActionResult> {
    const startedAt = this.clock.now();
    if (this.blockedBy) {
      const r: ActionResult = {
        action: action.name,
        domain: action.domain,
        params: action.params,
        status: 'preempted',
        reason: `bloqué : ${this.blockedBy}`,
        startedAt,
        endedAt: startedAt,
      };
      this.onResult(r);
      return Promise.resolve(r);
    }
    if (this.running) this.abort('remplacée par une nouvelle action');

    return new Promise<ActionResult>((resolve) => {
      const controller = new AbortController();
      let done = false;
      const timer = this.clock.setTimeout(() => settle('timeout', `délai de ${action.timeoutMs} ms dépassé`), action.timeoutMs);

      const settle = (status: ActionStatus, reason?: string, detail?: Record<string, unknown>) => {
        if (done) return;
        done = true;
        timer.cancel();
        if (status !== 'success' && status !== 'failure' && !controller.signal.aborted) controller.abort(reason);
        if (this.running?.controller === controller) this.running = null;
        const result: ActionResult = {
          action: action.name,
          domain: action.domain,
          params: action.params,
          status,
          reason,
          detail,
          startedAt,
          endedAt: this.clock.now(),
        };
        this.onResult(result);
        resolve(result);
      };

      this.running = { action, controller, startedAt, settle };

      let promise: Promise<ActionRunOutput | void>;
      try {
        promise = action.run(controller.signal);
      } catch (err) {
        promise = Promise.reject(err);
      }
      promise.then(
        (out) => settle(out?.status ?? 'success', undefined, out?.detail),
        (err: unknown) => {
          if (controller.signal.aborted) return; // déjà réglé par abort/timeout
          settle('failure', err instanceof Error ? err.message : String(err));
        },
      );
    });
  }

  /**
   * Interrompt immédiatement l'action en cours (synchrone).
   * Renvoie vrai si une action a été interrompue.
   */
  abort(reason: string, status: ActionStatus = 'preempted'): boolean {
    const running = this.running;
    try {
      this.stopAll();
    } catch {
      // l'arrêt des moteurs ne doit jamais empêcher la préemption
    }
    if (!running) return false;
    running.settle(status, reason);
    return true;
  }
}
