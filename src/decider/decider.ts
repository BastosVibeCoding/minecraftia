import type { Clock } from '../core/clock.js';
import type { Logger } from '../core/logger.js';
import type { Domain } from '../core/types.js';
import type { RoleStrategy } from '../strategy/strategy.js';
import type { Branch, BehaviorTree } from '../tree/tree.js';
import type { Budget } from './budget.js';
import type { DecisionCache } from './cache.js';
import { LlmError, type LlmClient } from './llm.js';
import { systemPrompt, userPrompt, type Band, type DecisionContext, type Persona } from './prompt.js';
import type { ModelRouter } from './router.js';
import { parseDecision, type Decision } from './schema.js';
import { describeSituation, situationHash, type WorldState } from './world.js';
import { actionKey } from '../tree/merge.js';

export interface DecisionRecord {
  id: number;
  decision: Decision;
  /** `llm` : décidé par le modèle ; `cache` : situation quasi identique ; `fallback` : repli sûr sans LLM. */
  source: 'llm' | 'cache' | 'fallback';
  model: string | null;
  situationHash: string;
  situationText: string;
  branches: Branch[];
  /** Ce qui a déclenché la décision (« ordre du joueur », « épisode du joueur », « initiative »…). */
  trigger: string;
}

export interface DeciderDeps {
  tree: BehaviorTree;
  llm: LlmClient | null;
  budget: Budget;
  cache: DecisionCache;
  router: ModelRouter;
  strategy: RoleStrategy;
  /** Bandes d'autonomie par domaine (phase 6 : calculées ; jusque-là, « imitate » partout). */
  autonomy: () => Record<Domain, { band: Band; score: number }>;
  clock: Clock;
  logger: Logger;
  maxTokens?: number;
  /** Nom et genre du personnage (par défaut : Alex, au féminin). */
  persona?: Persona;
}

export function fallbackDecision(reason: string): Decision {
  return { skill: 'follow', params: { distance: 3, seconds: 10 }, domain: 'explore', intent: 'suivre le joueur', basedOn: [], needsApproval: false, rationale: reason };
}

/**
 * Règles appliquées par le code, quoi qu'en dise le LLM (partagées avec le banc d'essai des modèles) :
 * - un ordre explicite du joueur s'exécute sans demander ;
 * - jamais un mécanisme corrigé, même si le LLM ne le cite pas ;
 * - la bande d'autonomie du domaine décide : « observe » interdit d'agir, « propose » exige une validation ;
 * - pas de construction sans le matériau dans l'inventaire ;
 * - seuls les identifiants de mécanismes réellement proposés sont conservés.
 */
export function applyGuards(
  d: Decision,
  branches: Branch[],
  autonomy: Record<Domain, { band: Band; score: number }>,
  ordered = false,
  inventory: Record<string, number> = {},
): Decision {
  const known = new Set(branches.flatMap((b) => b.mechanisms.map((m) => m.id)));
  const basedOn = d.basedOn.filter((id) => known.has(id));
  if (d.skill === 'build' && typeof d.params.material === 'string' && (inventory[d.params.material] ?? 0) < 4) {
    return fallbackDecision(`pas assez de ${d.params.material} dans l'inventaire pour construire`);
  }
  if (ordered || d.skill === 'none' || d.skill === 'follow' || d.skill === 'say') return { ...d, basedOn, needsApproval: false };
  const key = actionKey(d.skill, d.params);
  const avoided = branches.flatMap((b) => b.avoid).some((a) => a.mechanism && actionKey(String(a.mechanism.skill), a.mechanism) === key);
  const endorsed = branches.flatMap((b) => b.mechanisms).some((m) => m.mechanism && actionKey(String(m.mechanism.skill), m.mechanism) === key);
  if (avoided && !endorsed) return fallbackDecision(`reproduirait un mécanisme corrigé par le joueur (${key})`);
  const band = autonomy[d.domain]?.band ?? 'observe';
  if (band === 'observe') return fallbackDecision(`domaine ${d.domain} encore en observation`);
  return { ...d, basedOn, needsApproval: band === 'propose' };
}

/**
 * Décideur : état du monde + branches pertinentes + autonomie → décision JSON validée.
 * Jamais d'appel par tick ; un appel seulement si des branches existent, si le cache ne répond pas
 * et si le budget le permet. Sortie invalide : une nouvelle tentative, puis repli sûr.
 */
export class Decider {
  private budgetWarned = false;
  private last: DecisionRecord | null = null;

  constructor(private readonly deps: DeciderDeps) {
    this.last = this.restoreLast();
  }

  /** Dernière décision enregistrée (pour `!pourquoi` après un redémarrage). */
  private restoreLast(): DecisionRecord | null {
    const row = this.deps.tree.store.db
      .prepare('SELECT id, trigger, situation_hash, model, decision_json FROM decisions ORDER BY id DESC LIMIT 1')
      .get() as { id: number; trigger: string; situation_hash: string; model: string | null; decision_json: string } | undefined;
    if (!row) return null;
    try {
      const saved = JSON.parse(row.decision_json) as Decision & { source?: DecisionRecord['source']; situation?: string };
      const { source, situation, ...decision } = saved;
      return { id: row.id, decision, source: source ?? 'llm', model: row.model, situationHash: row.situation_hash, situationText: situation ?? '', branches: [], trigger: row.trigger };
    } catch {
      return null;
    }
  }

  get lastDecision(): DecisionRecord | null {
    return this.last;
  }

  /** Vrai quand le budget du jour est épuisé (le bot retombe sur suivi + réflexes). */
  get budgetExhausted(): boolean {
    return this.deps.budget.exhausted();
  }

  async decide(trigger: string, world: WorldState, lastOutcome: string | null = null, order?: string): Promise<DecisionRecord> {
    const { tree, cache, router, budget, strategy, logger } = this.deps;
    const situationText = describeSituation(world, order);
    const autonomy = this.deps.autonomy();
    const bands = Object.fromEntries(Object.entries(autonomy).map(([d, a]) => [d, a.band]));

    const branches = strategy.transform(await tree.search(situationText, { k: 6 })).filter((b) => b.mechanisms.length > 0 || b.avoid.length > 0);
    const hash = situationHash(world, branches.map((b) => b.situationId), bands) + (order ? `:${order}` : '');

    const usable = branches.filter((b) => autonomy[b.domain]?.band !== 'observe' && b.mechanisms.length > 0);
    // un ordre du joueur passe toujours par le LLM (il peut viser une compétence sans branche apprise)
    if (usable.length === 0 && !order) {
      const reason =
        branches.length === 0
          ? "rien d'appris pour cette situation"
          : branches.every((b) => b.mechanisms.length === 0)
            ? 'seuls des mécanismes corrigés par le joueur : rien à reproduire'
            : 'domaines encore en observation';
      return this.save(trigger, fallbackDecision(reason), 'fallback', null, hash, situationText, branches);
    }

    if (budget.exhausted()) {
      if (!this.budgetWarned) logger.warn({ spent: budget.spentToday(), daily: budget.dailyUsd }, 'budget quotidien atteint : décideur coupé, suivi + réflexes');
      this.budgetWarned = true;
      return this.save(trigger, fallbackDecision('budget quotidien atteint'), 'fallback', null, hash, situationText, branches);
    }
    this.budgetWarned = false;

    const cached = order ? null : cache.get(hash);
    if (cached) return this.save(trigger, cached, 'cache', null, hash, situationText, branches);
    if (!this.deps.llm) return this.save(trigger, fallbackDecision('aucun LLM configuré'), 'fallback', null, hash, situationText, branches);

    const ctx: DecisionContext = { trigger, world, autonomy, branches, lastOutcome, ...(order ? { order } : {}) };
    const { model } = router.pick('decide', hash);
    let error: string | undefined;
    // modèle qui a réellement répondu (une chaîne de fournisseurs peut remplacer le modèle demandé)
    let answeredBy = model;
    for (let attempt = 0; attempt < 2; attempt++) {
      let text: string;
      try {
        const res = await this.deps.llm.complete({ purpose: 'decide', model, system: systemPrompt(this.deps.persona), user: userPrompt(ctx, error), maxTokens: this.deps.maxTokens ?? 400 });
        budget.record({ purpose: 'decide', model: res.model, promptTokens: res.promptTokens, completionTokens: res.completionTokens, costUsd: res.costUsd, latencyMs: res.latencyMs, ok: true });
        text = res.text;
        answeredBy = res.model;
      } catch (err) {
        const e = err instanceof LlmError ? err : new LlmError(String(err));
        budget.record({ purpose: 'decide', model, promptTokens: 0, completionTokens: 0, costUsd: 0, latencyMs: 0, ok: false, error: e.message });
        logger.warn({ err: e.message, status: e.status }, 'appel LLM en échec');
        if (!e.retryable || attempt === 1) return this.save(trigger, fallbackDecision(`LLM indisponible : ${e.message}`), 'fallback', model, hash, situationText, branches);
        continue;
      }
      const parsed = parseDecision(text);
      if (parsed.ok) {
        const decision = applyGuards(parsed.decision, branches, autonomy, Boolean(order), world.bot.inventory);
        if (decision.skill !== 'none' && decision.skill !== 'follow') cache.set(hash, decision.domain, decision);
        return this.save(trigger, decision, 'llm', answeredBy, hash, situationText, branches);
      }
      error = parsed.error;
      logger.warn({ error, attempt }, 'décision LLM invalide');
    }
    return this.save(trigger, fallbackDecision(`sortie LLM invalide : ${error}`), 'fallback', answeredBy, hash, situationText, branches);
  }

  private save(trigger: string, decision: Decision, source: DecisionRecord['source'], model: string | null, hash: string, situationText: string, branches: Branch[]): DecisionRecord {
    const d = decision.skill === 'none' ? fallbackDecision(decision.rationale || 'aucune action utile') : decision;
    const r = this.deps.tree.store.db
      .prepare('INSERT INTO decisions(trigger, situation_hash, model, cached, node_ids_json, decision_json, rationale, autonomy_json, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(trigger, hash, model, source === 'cache' ? 1 : 0, JSON.stringify(d.basedOn), JSON.stringify({ ...d, source, situation: situationText }), d.rationale, JSON.stringify(this.deps.autonomy()), this.deps.clock.now());
    this.last = { id: Number(r.lastInsertRowid), decision: d, source, model, situationHash: hash, situationText, branches, trigger };
    return this.last;
  }
}
