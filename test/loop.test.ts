import type { Bot } from 'mineflayer';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/core/clock.js';
import { DOMAINS } from '../src/core/types.js';
import { Budget } from '../src/decider/budget.js';
import { DecisionCache } from '../src/decider/cache.js';
import { Decider } from '../src/decider/decider.js';
import { DecisionLoop } from '../src/decider/loop.js';
import { ModelRouter } from '../src/decider/router.js';
import type { Episode } from '../src/observer/types.js';
import { RationalStubLlm } from '../src/sim/stubLlm.js';
import { ActionController } from '../src/skills/actionController.js';
import { HashingEmbedder } from '../src/store/embedder.js';
import { Store } from '../src/store/store.js';
import { MirrorStrategy } from '../src/strategy/strategy.js';
import { BehaviorTree } from '../src/tree/tree.js';
import { silentLogger, world } from './helpers.js';

const wall: Episode = {
  player: 'Bastien',
  domain: 'build',
  kind: 'wall',
  summary: 'a construit un mur en stone bricks',
  situation: { text: 'construire un mur' },
  mechanism: { skill: 'build', shape: 'wall', material: 'stone_bricks' },
  params: {},
  source: 'observed',
  startedAt: 0,
  endedAt: 1,
};

async function setup() {
  const clock = new ManualClock(Date.UTC(2026, 9, 4, 12));
  const store = await Store.open(':memory:', new HashingEmbedder(), clock);
  const tree = new BehaviorTree(store, { playTime: () => 0 });
  const stub = new RationalStubLlm();
  const router = new ModelRouter('fast', 'strong');
  const decider = new Decider({
    tree,
    llm: stub,
    budget: new Budget(store.db, clock, 1),
    cache: new DecisionCache(store.db, clock),
    router,
    strategy: new MirrorStrategy(),
    autonomy: () => Object.fromEntries(DOMAINS.map((d) => [d, { band: 'imitate' as const, score: 0.4 }])) as never,
    clock,
    logger: silentLogger,
  });
  const said: string[] = [];
  const bot = { chat: (t: string) => said.push(t), inventory: { items: () => [] }, players: {} } as unknown as Bot;
  const actions = new ActionController(clock, () => {});
  const executed: string[] = [];
  const loop = new DecisionLoop({
    decider,
    actions,
    tree,
    router,
    skillContext: { bot, followPlayer: 'Bastien' },
    world: () => world(),
    snapshot: () => ({ health: 20, food: 20, inventory: {}, deaths: 0 }),
    clock,
    logger: silentLogger,
    onExecuted: (e) => executed.push(`${e.record.decision.skill}:${e.outcome.status}`),
  });
  return { clock, store, tree, stub, loop, said, executed };
}

const flush = () => new Promise((r) => setTimeout(r, 30));

describe('boucle de décision', () => {
  it("décide, exécute, puis renvoie le résultat dans l'arbre", async () => {
    const { tree, stub, loop, said, executed, store } = await setup();
    const ing = await tree.ingest(wall);
    stub.scripted.push(JSON.stringify({ skill: 'say', params: { text: 'Je t’aide pour le mur !' }, domain: 'build', intent: 'encourager', basedOn: [ing.mechanismId], rationale: 'test' }));
    loop.request('épisode du joueur');
    await flush();
    expect(said).toEqual(['Je t’aide pour le mur !']);
    expect(executed).toEqual(['say:success']);
    expect(store.getNode(ing.mechanismId)!.successes).toBe(1);
    expect((store.db.prepare('SELECT status FROM outcomes').get() as { status: string }).status).toBe('success');
  });

  it("respecte l'intervalle minimal entre deux décisions, sauf correction ou ordre", async () => {
    const { tree, stub, loop, clock } = await setup();
    await tree.ingest(wall);
    stub.scripted.push(JSON.stringify({ skill: 'say', params: { text: 'a' }, domain: 'build', intent: 'x' }));
    loop.request('a');
    await flush();
    const n = stub.calls.length;
    loop.request('b'); // trop tôt : ignorée
    await flush();
    expect(stub.calls.length).toBe(n);
    clock.advance(1000);
    stub.scripted.push(JSON.stringify({ skill: 'say', params: { text: 'b' }, domain: 'explore', intent: 'y' }));
    // une correction invalide aussi le cache : la situation identique repasse par le LLM
    (loop as unknown as { deps: { decider: Decider } }).deps.decider['deps'].cache.clear();
    loop.request('correction', true); // forcée
    await flush();
    expect(stub.calls.length).toBe(n + 1);
  });
});
