import type { Clock } from '../core/clock.js';
import type { Logger } from '../core/logger.js';
import type { Domain } from '../core/types.js';
import { evaluateOutcome, judged, type Outcome, type StateSnapshot } from '../outcome/outcome.js';
import type { ActionController, ActionResult } from '../skills/actionController.js';
import { SkillParamsError, toAction, type SkillContext } from '../skills/library.js';
import type { BehaviorTree } from '../tree/tree.js';
import type { Decider, DecisionRecord } from './decider.js';
import type { ModelRouter } from './router.js';
import type { WorldState } from './world.js';

export interface LoopDeps {
  decider: Decider;
  actions: ActionController;
  tree: BehaviorTree;
  router: ModelRouter;
  skillContext: SkillContext;
  world: () => WorldState | null;
  snapshot: () => StateSnapshot;
  clock: Clock;
  logger: Logger;
  /** Intervalle minimal entre deux décisions (hors corrections et ordres). */
  minIntervalMs?: number;
  /** Inactivité au bout de laquelle le bot redemande une décision. */
  idleDecideMs?: number;
  onExecuted?: (e: { record: DecisionRecord; result: ActionResult; outcome: Outcome }) => void;
  /** Proposition à faire valider par le joueur (bande « propose ») : renvoie vrai si acceptée. */
  propose?: (record: DecisionRecord) => Promise<boolean>;
}

/**
 * Boucle Décideur → Compétences → Monde → Résultat → Arbre.
 * Déclenchée par des événements (épisode du joueur, fin d'action, ordre, correction) ou par
 * l'inactivité ; jamais par tick. Entre deux décisions, le bot suit le joueur sans appel LLM.
 */
export class DecisionLoop {
  private inFlight = false;
  private pending: { trigger: string; force: boolean } | null = null;
  private lastDecisionAt = -Infinity;
  private lastOutcome: string | null = null;
  private stopped = false;

  constructor(private readonly deps: LoopDeps) {}

  stop(): void {
    this.stopped = true;
  }

  get busy(): boolean {
    return this.inFlight;
  }

  /**
   * Demande une décision. `force` ignore l'intervalle minimal (correction, ordre du joueur).
   * Une action de suivi en cours est interrompue ; toute autre action termine d'abord.
   */
  request(trigger: string, force = false): void {
    if (this.stopped) return;
    const now = this.deps.clock.now();
    if (!force && now - this.lastDecisionAt < (this.deps.minIntervalMs ?? 5000)) return;
    if (this.inFlight) {
      if (!this.pending || force) this.pending = { trigger, force };
      if (this.deps.actions.current?.name === 'follow') this.deps.actions.abort(`nouvelle décision : ${trigger}`);
      return;
    }
    void this.run(trigger);
  }

  /** Appelé quand le contrôleur est libre : décision si l'inactivité dure, sinon suivi sans LLM. */
  onIdle(): void {
    if (this.stopped || this.inFlight || this.deps.actions.isBusy || this.deps.actions.blockReason) return;
    if (this.deps.clock.now() - this.lastDecisionAt >= (this.deps.idleDecideMs ?? 20_000)) this.request('inactivité');
    else void this.execute(null, 'follow', { distance: 3, seconds: 5 });
  }

  private async run(trigger: string): Promise<void> {
    this.inFlight = true;
    try {
      const world = this.deps.world();
      if (!world) return;
      const record = await this.deps.decider.decide(trigger, world, this.lastOutcome);
      this.lastDecisionAt = this.deps.clock.now();
      const d = record.decision;
      this.deps.logger.info({ trigger, source: record.source, skill: d.skill, domain: d.domain, basedOn: d.basedOn, model: record.model }, `décision : ${d.intent}`);
      if (this.stopped) return;
      if (d.needsApproval) {
        const accepted = this.deps.propose ? await this.deps.propose(record) : false;
        if (!accepted) return;
      } else if (d.say) {
        this.deps.skillContext.bot.chat(d.say);
      }
      await this.execute(record, d.skill, d.params);
    } catch (err) {
      this.deps.logger.error({ err }, 'boucle de décision en erreur');
    } finally {
      this.inFlight = false;
      const next = this.pending;
      this.pending = null;
      if (next && !this.stopped) this.request(next.trigger, next.force);
    }
  }

  private async execute(record: DecisionRecord | null, skill: string, params: Record<string, unknown>): Promise<void> {
    let action;
    try {
      action = toAction(this.deps.skillContext, skill, params);
    } catch (err) {
      if (!(err instanceof SkillParamsError)) throw err;
      this.deps.logger.warn({ err: err.message }, 'action refusée, repli sur le suivi');
      action = toAction(this.deps.skillContext, 'follow', { seconds: 5 });
    }
    const before = this.deps.snapshot();
    const result = await this.deps.actions.run(action);
    const outcome = evaluateOutcome(result, before, this.deps.snapshot());
    if (!record) return;

    this.deps.tree.store.db
      .prepare('INSERT INTO outcomes(decision_id, status, details_json, at) VALUES (?, ?, ?, ?)')
      .run(record.id, outcome.status, JSON.stringify({ ...outcome, reason: result.reason, detail: result.detail }), this.deps.clock.now());
    this.lastOutcome = outcome.summary;
    if (judged(outcome) && record.decision.basedOn.length > 0) {
      const success = outcome.status === 'success';
      for (const id of record.decision.basedOn) this.deps.tree.recordOutcome(id, success, record.id);
      this.deps.router.recordOutcome(record.situationHash, success);
    }
    this.deps.logger.info({ status: outcome.status, decision: record.id }, outcome.summary);
    this.deps.onExecuted?.({ record, result, outcome });
  }

  /** Domaines concernés par la dernière décision (pour les retours du joueur). */
  lastDomain(): Domain | null {
    return this.deps.decider.lastDecision?.decision.domain ?? null;
  }
}
