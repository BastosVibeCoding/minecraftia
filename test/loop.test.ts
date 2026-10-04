import type { Bot } from 'mineflayer';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/core/clock.js';
import { DOMAINS } from '../src/core/types.js';
import { Budget } from '../src/decider/budget.js';
import { DecisionCache } from '../src/decider/cache.js';
import { Decider } from '../src/decider/decider.js';
import { DecisionLoop, isRecallOrder } from '../src/decider/loop.js';
import { splitOrder } from '../src/decider/orders.js';
import { ModelRouter } from '../src/decider/router.js';
import type { Episode } from '../src/observer/types.js';
import { RationalStubLlm } from '../src/sim/stubLlm.js';
import { ActionController } from '../src/skills/actionController.js';
import { HashingEmbedder } from '../src/store/embedder.js';
import { Store } from '../src/store/store.js';
import { MirrorStrategy } from '../src/strategy/strategy.js';
import { BehaviorTree } from '../src/tree/tree.js';
import { openWorld, silentLogger, vec, world } from './helpers.js';

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

describe("ordres de rappel (manques réels de Léa)", () => {
  it("reconnaît « arrête-toi » et « viens ici », pas les vrais ordres d'action", () => {
    expect(isRecallOrder("Ok arrête toi, c'est moitié fait.")).toBe(true);
    expect(isRecallOrder("Viens, arrête de creuser, essuie-moi.")).toBe(true);
    expect(isRecallOrder("Viens, arrête-toi et viens ici.")).toBe(true);
    expect(isRecallOrder("Léa arrête et suis-moi.")).toBe(true);
    expect(isRecallOrder("tu peux venir ici ?")).toBe(true);
    expect(isRecallOrder("Vas-y, on arrête du creuset, viens la surface.")).toBe(true);
    expect(isRecallOrder("Suis-moi, Yulia.")).toBe(true);
    expect(isRecallOrder("Léa reviens à la surface pour me suivre")).toBe(true);
    expect(isRecallOrder("Alex, donne ton bois.")).toBe(false);
    expect(isRecallOrder("viens m'aider à couper du bois")).toBe(false);
    expect(isRecallOrder("construis un mur")).toBe(false);
  });

  it("exécute le suivi sans appeler le modèle", async () => {
    const { stub, loop } = await setup();
    loop.order("Viens, arrête-toi et viens ici.");
    await flush();
    expect(stub.calls.length).toBe(0);
  });
});

describe("ordre coupé par un réflexe (cas réel : « défends-moi » puis fuite)", () => {
  it("reprend l'ordre une fois le danger passé, une seule fois", async () => {
    const { stub, loop } = await setup();
    const attack = JSON.stringify({ skill: 'attack', params: { targets: ['zombie'] }, domain: 'combat', intent: 'défendre', basedOn: [], rationale: 'ordre' });
    stub.scripted.push(attack, attack);
    const deps = (loop as unknown as { deps: { actions: import('../src/skills/actionController.js').ActionController; skillContext: { bot: Record<string, unknown> } } }).deps;
    const actions = deps.actions;
    // un zombie qui reste en vie : l'attaque dure jusqu'à ce qu'on la coupe
    const zombie = { name: 'zombie', isValid: true, position: vec(3, 64, 0) };
    Object.assign(deps.skillContext.bot, {
      entity: { position: vec(0, 64, 0) },
      world: openWorld,
      health: 20,
      nearestEntity: (f: (e: unknown) => boolean) => (f(zombie) ? zombie : null),
      pvp: { attack: async () => {}, stop: async () => {}, forceStop: () => {}, attackRange: 3 },
    });
    loop.order('défends-moi');
    await flush();
    actions.abort('réflexe : creeper à 2.0 blocs');
    await flush();
    loop.onIdle();
    await flush();
    expect(stub.calls.length).toBe(2);
    actions.abort('fin du test');
    await flush();
    loop.onIdle();
    await flush();
    expect(stub.calls.length).toBe(2);
  });
});

describe("ordres en plusieurs étapes (manque réel : « récolte le fer dans le four et mets-le dans le coffre »)", () => {
  it("découpe sur « et » / « puis » suivis d'un verbe d'action, pas ailleurs", () => {
    expect(splitOrder('alex recole le fer dans le four et met le dans le coffre le plus proche')).toEqual(['alex recole le fer dans le four', 'met le dans le coffre le plus proche']);
    expect(splitOrder('Alex, récupère le fer dans le four et mets-le dans le coffre juste à côté.')).toEqual(['Alex, récupère le fer dans le four', 'mets-le dans le coffre juste à côté.']);
    expect(splitOrder('coupe du bois puis donne-moi tes bûches')).toEqual(['coupe du bois', 'donne-moi tes bûches']);
    expect(splitOrder('récolte du fer et du charbon')).toEqual(['récolte du fer et du charbon']);
    expect(splitOrder('construis un mur en bois')).toEqual(['construis un mur en bois']);
  });

  it("exécute la deuxième étape après la réussite de la première, avec son résultat en contexte", async () => {
    const { stub, loop } = await setup();
    const say = (t: string) => JSON.stringify({ skill: 'say', params: { text: t }, domain: 'build', intent: t, basedOn: [], rationale: 'ordre' });
    stub.scripted.push(say('je récupère'), say('je range'));
    loop.order('récupère le fer dans le four et mets-le dans le coffre');
    await flush();
    await flush();
    expect(stub.calls.length).toBe(2);
    expect(stub.calls[1]!.user).toContain('mets-le dans le coffre');
    expect(stub.calls[1]!.user).toContain('étape précédente');
  });
});
