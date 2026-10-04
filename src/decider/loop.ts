import { graded, type Autonomy } from '../autonomy/autonomy.js';
import type { ProposalBroker } from '../autonomy/proposals.js';
import type { GapRecorder } from '../gaps/gaps.js';
import type { Clock } from '../core/clock.js';
import type { Logger } from '../core/logger.js';
import type { Domain } from '../core/types.js';
import { evaluateOutcome, judged, type Outcome, type StateSnapshot } from '../outcome/outcome.js';
import type { ActionController, ActionResult } from '../skills/actionController.js';
import { SkillParamsError, toAction, type SkillContext } from '../skills/library.js';
import { FEEDBACK, type BehaviorTree } from '../tree/tree.js';
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
  /** Scores d'autonomie : cadence des initiatives, délais, et retour des résultats. */
  autonomy?: Autonomy;
  /** Propositions de la bande « propose » (réponses fournies par les retours du joueur). */
  proposals?: ProposalBroker;
  /** Repère les ordres que le bot n'a pas su traduire en action. */
  gaps?: GapRecorder;
}

const normOrder = (t: string) =>
  t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ').trim();

const RECALL = /\b(arrete|stop|stoppe|halte|attends|viens|reviens|rejoins moi|suis moi|ici)\b/;
/** Verbes d'action : « viens m'aider à couper du bois » n'est pas un simple rappel. */
const ACTION = /\b(construi\w*|bati\w*|pose\w*|min\w*|creus\w*|coup\w*|recolt\w*|ramass\w*|attaqu\w*|tue\w*|fabriqu\w*|craft\w*|mang\w*|explor\w*|donn\w*|equip\w*|apport\w*|ramen\w*|aid\w*|cherch\w*|plant\w*|cuis\w*|rang\w*|dor\w*)\b/;

/**
 * Ordre de rappel (« arrête-toi », « viens ici », « arrête de creuser, suis-moi ») : le code
 * l'exécute directement (arrêt puis suivi), sans appel au modèle. « arrête de <verbe> » ne compte
 * pas comme une demande d'action.
 */
export function isRecallOrder(text: string): boolean {
  const t = normOrder(text);
  if (!RECALL.test(t)) return false;
  return !ACTION.test(t.replace(/\b(arrete|stop|stoppe) (de |du |d')?\w+/g, ' '));
}

/**
 * Boucle Décideur → Compétences → Monde → Résultat → Arbre.
 * Déclenchée par des événements (épisode du joueur, fin d'action, ordre, correction) ou par
 * l'inactivité ; jamais par tick. Entre deux décisions, le bot suit le joueur sans appel LLM.
 */
export class DecisionLoop {
  private inFlight = false;
  private pending: { trigger: string; force: boolean; order?: string } | null = null;
  private lastDecisionAt = -Infinity;
  private lastOutcome: string | null = null;
  private stopped = false;
  /** Dernier rappel du joueur : une décision lancée avant est abandonnée. */
  private recalledAt = -Infinity;

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
  request(trigger: string, force = false, order?: string): void {
    if (this.stopped) return;
    const now = this.deps.clock.now();
    if (!force && now - this.lastDecisionAt < (this.deps.minIntervalMs ?? 5000)) return;
    if (this.inFlight) {
      if (!this.pending || force) this.pending = { trigger, force, ...(order ? { order } : {}) };
      // un ordre coupe toute action en cours ; une autre demande ne coupe que le suivi
      if (order || this.deps.actions.current?.name === 'follow') this.deps.actions.abort(`nouvelle décision : ${trigger}`);
      return;
    }
    void this.run(trigger, order);
  }

  /** Ordre explicite du joueur : immédiat, prioritaire sur l'action en cours. */
  order(text: string): void {
    this.deps.actions.abort('ordre du joueur');
    if (isRecallOrder(text)) {
      this.pending = null;
      this.recalledAt = this.deps.clock.now();
      this.lastDecisionAt = this.deps.clock.now();
      this.deps.logger.info({ order: text }, 'ordre de rappel : arrêt et suivi');
      void this.execute(null, 'follow', { distance: 2, seconds: 20 });
      return;
    }
    this.request('ordre du joueur', true, text);
  }

  /** Appelé quand le contrôleur est libre : décision si l'inactivité dure, sinon suivi sans LLM. */
  onIdle(): void {
    if (this.stopped || this.inFlight || this.deps.actions.isBusy || this.deps.actions.blockReason) return;
    // sous la bande « propose », pas d'initiative : le bot imite quand le joueur agit (épisodes)
    const interval = this.deps.autonomy ? graded.initiativeIntervalMs(this.deps.autonomy.max()) : (this.deps.idleDecideMs ?? 20_000);
    if (interval !== null && this.deps.clock.now() - this.lastDecisionAt >= interval) this.request('initiative');
    else void this.execute(null, 'follow', { distance: 3, seconds: 5 });
  }

  private async run(trigger: string, order?: string): Promise<void> {
    this.inFlight = true;
    try {
      const world = this.deps.world();
      if (!world) return;
      const startedAt = this.deps.clock.now();
      const record = await this.deps.decider.decide(trigger, world, this.lastOutcome, order);
      this.lastDecisionAt = this.deps.clock.now();
      const d = record.decision;
      this.deps.logger.info({ trigger, source: record.source, skill: d.skill, domain: d.domain, basedOn: d.basedOn, model: record.model }, `décision : ${d.intent}`);
      if (this.stopped || this.recalledAt >= startedAt) return;
      // un ordre qui finit en simple suivi : le bot ne sait pas encore faire ce qu'on lui demande
      if (order && (d.skill === 'follow' || record.source === 'fallback')) this.deps.gaps?.unfulfilledOrder(order);
      if (d.needsApproval) {
        if (!(await this.propose(record))) return;
      } else if (d.say) {
        this.say(d.say);
      }
      await this.execute(record, d.skill, d.params, order);
    } catch (err) {
      this.deps.logger.error({ err }, 'boucle de décision en erreur');
    } finally {
      this.inFlight = false;
      const next = this.pending;
      this.pending = null;
      if (next && !this.stopped) this.request(next.trigger, next.force, next.order);
    }
  }

  private async execute(record: DecisionRecord | null, skill: string, params: Record<string, unknown>, order?: string): Promise<void> {
    let action;
    try {
      action = toAction(this.deps.skillContext, skill, params);
    } catch (err) {
      if (!(err instanceof SkillParamsError)) throw err;
      this.deps.logger.warn({ err: err.message }, 'action refusée, repli sur le suivi');
      action = toAction(this.deps.skillContext, 'follow', { seconds: 5 });
    }
    // le suivi dure par construction : son délai ne se réduit pas (il expirerait avant la fin)
    if (record && this.deps.autonomy && action.name !== 'follow' && action.name !== 'say') {
      // prudence graduée : moins de confiance, délai plus court
      action = { ...action, timeoutMs: Math.max(10_000, Math.round(action.timeoutMs * graded.timeoutFactor(this.deps.autonomy.get(action.domain).score))) };
    }
    const before = this.deps.snapshot();
    const result = await this.deps.actions.run(action);
    const outcome = evaluateOutcome(result, before, this.deps.snapshot());
    if (!record) return;

    this.deps.tree.store.db
      .prepare('INSERT INTO outcomes(decision_id, status, details_json, at) VALUES (?, ?, ?, ?)')
      .run(record.id, outcome.status, JSON.stringify({ ...outcome, reason: result.reason, detail: result.detail }), this.deps.clock.now());
    this.lastOutcome = outcome.summary;
    // un ordre exécuté mais raté : souvent une compétence à compléter (la raison réelle est gardée)
    if (order && outcome.status === 'failure' && !outcome.precondition) this.deps.gaps?.failedOrder(order, action.name, result.reason ?? outcome.summary);
    if (judged(outcome)) {
      const success = outcome.status === 'success';
      for (const id of record.decision.basedOn) this.deps.tree.recordOutcome(id, success, record.id);
      if (record.decision.basedOn.length > 0) this.deps.router.recordOutcome(record.situationHash, success);
      if (this.deps.autonomy && record.decision.skill !== 'follow' && record.decision.skill !== 'say') {
        this.deps.autonomy.apply(record.decision.domain, success ? 'success' : outcome.status === 'death' ? 'death' : 'failure', record.id);
      }
    }
    this.deps.logger.info({ status: outcome.status, decision: record.id }, outcome.summary);
    this.deps.onExecuted?.({ record, result, outcome });
  }

  /**
   * Bande « propose » : annonce, puis attend. Oui → approbation (arbre + autonomie) et action ;
   * non → renoncement (léger recul) ; silence → accord tacite, action sans bonus.
   */
  private async propose(record: DecisionRecord): Promise<boolean> {
    const d = record.decision;
    const text = d.say ?? `Je peux ${d.intent.charAt(0).toLowerCase()}${d.intent.slice(1)} ?`;
    this.say(text);
    if (!this.deps.proposals) return false;
    const answer = await this.deps.proposals.ask(text);
    this.deps.logger.info({ answer, decision: record.id }, 'réponse à la proposition');
    if (answer === 'yes') {
      for (const id of d.basedOn) this.deps.tree.approve(id, { decisionId: record.id });
      this.deps.autonomy?.apply(d.domain, 'approval', record.id);
      return true;
    }
    if (answer === 'no') {
      for (const id of d.basedOn) this.deps.tree.adjust(id, FEEDBACK.failure, 'refusal', { decisionId: record.id });
      this.deps.autonomy?.apply(d.domain, 'refusal', record.id);
      return false;
    }
    return !this.stopped;
  }

  private say(text: string): void {
    const ctx = this.deps.skillContext;
    if (ctx.speak) ctx.speak(text);
    else ctx.bot.chat(text);
  }

  /** Instant de la dernière décision (pour rattacher un retour du joueur à cette décision). */
  get lastDecisionTime(): number {
    return this.lastDecisionAt;
  }

  /** Domaines concernés par la dernière décision (pour les retours du joueur). */
  lastDomain(): Domain | null {
    return this.deps.decider.lastDecision?.decision.domain ?? null;
  }
}
