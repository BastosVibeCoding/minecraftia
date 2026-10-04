import { Autonomy, graded } from '../autonomy/autonomy.js';
import { ManualClock } from '../core/clock.js';
import type { Logger } from '../core/logger.js';
import type { Domain } from '../core/types.js';
import { Budget } from '../decider/budget.js';
import { DecisionCache } from '../decider/cache.js';
import { Decider } from '../decider/decider.js';
import { ModelRouter } from '../decider/router.js';
import type { WorldState } from '../decider/world.js';
import { Observer } from '../observer/observer.js';
import type { Episode, RawEvent } from '../observer/types.js';
import { HashingEmbedder } from '../store/embedder.js';
import { Store } from '../store/store.js';
import { MirrorStrategy } from '../strategy/strategy.js';
import { BehaviorTree } from '../tree/tree.js';
import { Rng } from './players.js';
import { RationalStubLlm } from './stubLlm.js';

export interface HourReport {
  minutes: number;
  events: number;
  episodes: number;
  decisions: number;
  bySource: Record<'llm' | 'cache' | 'fallback', number>;
  llmCalls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  dailyBudgetUsd: number;
  autonomy: Record<Domain, { score: number; band: string }>;
}

export interface HourOptions {
  log: RawEvent[];
  player: string;
  dailyBudgetUsd?: number;
  model?: string;
  /** Probabilité de réussite d'une action simulée. */
  successRate?: number;
  /** Durée simulée d'une action (pendant laquelle seules les demandes d'épisode sont mises en attente). */
  actionMs?: number;
  seed?: number;
  logger: Logger;
}

const MIN_INTERVAL_MS = 5000; // mêmes règles que DecisionLoop
const TICK_MS = 1000;

/**
 * Simulation accélérée d'une session de jeu : les événements du joueur traversent l'observateur,
 * l'arbre, l'autonomie et le décideur réels (cache, budget, routage), avec un LLM simulé qui compte
 * les tokens des vrais prompts. L'ordonnancement reprend les règles de la boucle de décision :
 * déclenchement par épisode, intervalle minimal de 5 s, initiatives graduées selon l'autonomie.
 */
export async function simulateSession(o: HourOptions): Promise<HourReport> {
  const events = [...o.log].sort((a, b) => a.t - b.t);
  const t0 = events[0]?.t ?? 0;
  const tEnd = events.at(-1)?.t ?? t0;
  const clock = new ManualClock(t0);
  const store = await Store.open(':memory:', new HashingEmbedder(), clock);
  const tree = new BehaviorTree(store, { playTime: () => clock.now() - t0 });
  const autonomy = new Autonomy(store);
  const budget = new Budget(store.db, clock, o.dailyBudgetUsd ?? 1);
  const model = o.model ?? 'anthropic/claude-haiku-4.5';
  const decider = new Decider({
    tree,
    llm: new RationalStubLlm(),
    budget,
    cache: new DecisionCache(store.db, clock),
    router: new ModelRouter(model, 'anthropic/claude-sonnet-5.5'),
    strategy: new MirrorStrategy(),
    autonomy: () => autonomy.all(),
    clock,
    logger: o.logger,
  });
  const rng = new Rng(o.seed ?? 3);
  const recent: string[] = [];
  const pendingEpisodes: Episode[] = [];
  const observer = new Observer(o.player, (e) => pendingEpisodes.push(e));
  const report: HourReport = {
    minutes: Math.round((tEnd - t0) / 60000),
    events: events.length,
    episodes: 0,
    decisions: 0,
    bySource: { llm: 0, cache: 0, fallback: 0 },
    llmCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
    dailyBudgetUsd: budget.dailyUsd,
    autonomy: autonomy.all(),
  };

  let lastDecision = -Infinity;
  let busyUntil = -Infinity;
  let wantDecision: string | null = null;
  let lastThreatAt = -Infinity;

  const world = (): WorldState => ({
    bot: { health: 20, food: 18, position: { x: 0, y: 64, z: 0 }, dimension: 'overworld', heldItem: null, inventory: { stone_bricks: 64, oak_planks: 32, iron_sword: 1, shield: 1 } },
    player: { name: o.player, online: true, distance: 3, heldItem: null, activity: observer.activity(), recent: recent.slice(0, 3) },
    threats: clock.now() - lastThreatAt < 10_000 ? [{ name: 'zombie', distance: 6 }] : [],
    time: 'jour',
    biome: 'plains',
  });

  const decide = async (trigger: string) => {
    const r = await decider.decide(trigger, world());
    report.decisions++;
    report.bySource[r.source]++;
    lastDecision = clock.now();
    const d = r.decision;
    if (d.skill === 'follow') return;
    busyUntil = clock.now() + (o.actionMs ?? 15_000);
    const success = rng.next() < (o.successRate ?? 0.8);
    for (const id of d.basedOn) tree.recordOutcome(id, success, r.id);
    autonomy.apply(d.domain, success ? 'success' : 'failure', r.id);
  };

  let i = 0;
  for (let now = t0; now <= tEnd + 30_000; now += TICK_MS) {
    clock.advance(now - clock.now());
    while (i < events.length && events[i]!.t <= now) {
      const e = events[i++]!;
      if (e.type === 'attack' || e.type === 'damaged') lastThreatAt = e.t;
      observer.push(e);
    }
    observer.tick(now);
    while (pendingEpisodes.length) {
      const ep = pendingEpisodes.shift()!;
      const res = await tree.ingest(ep);
      autonomy.observe(ep.domain, ep.source, res.episodeId);
      recent.unshift(ep.summary);
      report.episodes++;
      wantDecision = 'épisode du joueur';
    }
    const free = now >= busyUntil;
    if (wantDecision && free && now - lastDecision >= MIN_INTERVAL_MS) {
      const trigger = wantDecision;
      wantDecision = null;
      await decide(trigger);
      continue;
    }
    const interval = graded.initiativeIntervalMs(autonomy.max());
    if (free && interval !== null && now - lastDecision >= interval) await decide('initiative');
  }
  observer.flush();

  const t = budget.today();
  report.llmCalls = t.calls;
  report.promptTokens = t.promptTokens;
  report.completionTokens = t.completionTokens;
  report.costUsd = Math.round(t.costUsd * 10000) / 10000;
  report.autonomy = autonomy.all();
  store.close();
  return report;
}
