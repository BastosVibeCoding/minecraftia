import { describe, expect, it } from 'vitest';
import { Autonomy } from '../src/autonomy/autonomy.js';
import { ProposalBroker } from '../src/autonomy/proposals.js';
import { ManualClock } from '../src/core/clock.js';
import { Budget } from '../src/decider/budget.js';
import { DecisionCache } from '../src/decider/cache.js';
import type { DecisionRecord } from '../src/decider/decider.js';
import type { DecisionLoop } from '../src/decider/loop.js';
import type { LlmClient } from '../src/decider/llm.js';
import { classifyByRules, UtteranceClassifier } from '../src/feedback/classifier.js';
import { FeedbackHandler } from '../src/feedback/feedback.js';
import { Observer } from '../src/observer/observer.js';
import type { Episode } from '../src/observer/types.js';
import { ActionController } from '../src/skills/actionController.js';
import { untilAborted } from '../src/core/abort.js';
import { HashingEmbedder } from '../src/store/embedder.js';
import { Store } from '../src/store/store.js';
import { BehaviorTree } from '../src/tree/tree.js';
import { silentLogger } from './helpers.js';

describe('classification par règles', () => {
  const label = (t: string) => classifyByRules(t).label;
  it.each([
    ['non, pas comme ça', 'correction'],
    ['Arrête !', 'correction'],
    ["c'est pas ça du tout", 'correction'],
    ['bien joué', 'approval'],
    ['parfait, merci', 'approval'],
    ['oui vas-y', 'approval'],
    ['regarde, je fais comme ça', 'teaching'],
    ['je te montre', 'teaching'],
    ['construis un mur en pierre', 'order'],
    ['tu peux couper du bois ?', 'order'],
    ['il fait beau aujourd’hui', 'chatter'],
  ])('« %s » → %s', (text, expected) => expect(label(text)).toBe(expected));

  it('« non, construis plutôt en bois » : correction + ordre, sans ambiguïté', () => {
    const c = classifyByRules('non, construis plutôt en bois');
    expect(c).toMatchObject({ label: 'correction', also: 'order', domain: 'build', ambiguous: false });
  });

  it('une phrase de jeu sans motif reconnu est ambiguë', () => {
    expect(classifyByRules('le mur de la maison me semble trop haut').ambiguous).toBe(true);
  });
});

describe('classifieur à deux étages', () => {
  async function budget() {
    const clock = new ManualClock(Date.UTC(2026, 9, 4, 12));
    const s = await Store.open(':memory:', new HashingEmbedder(), clock);
    return new Budget(s.db, clock, 1);
  }
  function fakeLlm(answer: string) {
    const calls: string[] = [];
    const llm: LlmClient = { complete: async (req) => (calls.push(req.user), { text: answer, model: req.model, promptTokens: 120, completionTokens: 20, costUsd: null, latencyMs: 1 }) };
    return { llm, calls };
  }

  it('n\'appelle pas le LLM quand les règles suffisent', async () => {
    const { llm, calls } = fakeLlm('{}');
    const c = await new UtteranceClassifier(llm, await budget(), 'fast').classify('non, pas comme ça');
    expect(c).toMatchObject({ label: 'correction', classifier: 'rules' });
    expect(calls).toHaveLength(0);
  });

  it('fait trancher le LLM en cas d\'ambiguïté, et consigne le coût', async () => {
    const { llm, calls } = fakeLlm('{"label":"correction","also":null,"domain":"build","confidence":0.8}');
    const b = await budget();
    const c = await new UtteranceClassifier(llm, b, 'fast').classify('le mur de la maison me semble trop haut');
    expect(c).toMatchObject({ label: 'correction', domain: 'build', classifier: 'llm' });
    expect(calls).toHaveLength(1);
    expect(b.today().calls).toBe(1);
  });

  it('sans LLM ou sans budget, garde l\'hypothèse des règles', async () => {
    expect((await new UtteranceClassifier(null, null, 'fast').classify('le mur de la maison me semble trop haut')).classifier).toBe('rules');
  });
});

describe('effets des retours', () => {
  async function setup() {
    const clock = new ManualClock(Date.UTC(2026, 9, 4, 12));
    const store = await Store.open(':memory:', new HashingEmbedder(), clock);
    const tree = new BehaviorTree(store, { playTime: () => 0 });
    const autonomy = new Autonomy(store);
    for (let i = 0; i < 20; i++) autonomy.apply('build', 'success');
    const cache = new DecisionCache(store.db, clock);
    const proposals = new ProposalBroker(clock);
    const observer = new Observer('Bastien', () => {});
    const actions = new ActionController(clock, () => {});
    const loopCalls: string[] = [];
    const loop = { order: (t: string) => loopCalls.push(`order:${t}`), request: (t: string, f?: boolean) => loopCalls.push(`request:${t}:${f}`) } as unknown as DecisionLoop;
    const said: string[] = [];
    const ep: Episode = { player: 'Bastien', domain: 'build', kind: 'wall', summary: 'mur', situation: { text: 'construire un mur' }, mechanism: { skill: 'build', shape: 'wall', material: 'stone_bricks' }, params: {}, source: 'observed', startedAt: 0, endedAt: 1 };
    const ing = await tree.ingest(ep);
    let last: DecisionRecord | null = {
      id: 1, source: 'llm', model: 'fast', situationHash: 'h', situationText: 'x', branches: [],
      decision: { skill: 'build', params: {}, domain: 'build', intent: 'construire un mur', basedOn: [ing.mechanismId], needsApproval: false, rationale: '' },
    };
    const handler = new FeedbackHandler({
      classifier: new UtteranceClassifier(null, null, 'fast'), tree, autonomy, cache, proposals, observer, store, clock, logger: silentLogger,
      loop: () => loop, actions: () => actions, lastDecision: () => last, lastDecisionAt: () => clock.now() - 5000, say: (t) => said.push(t),
    });
    return { clock, store, tree, autonomy, cache, proposals, observer, actions, loopCalls, said, handler, ing, setLast: (d: DecisionRecord | null) => (last = d) };
  }

  it('correction : action coupée, mécanisme pénalisé, autonomie en baisse, cache vidé, nouvelle décision forcée', async () => {
    const { handler, actions, store, autonomy, cache, loopCalls, ing, said } = await setup();
    const running = actions.run({ name: 'build', domain: 'build', timeoutMs: 60_000, run: (s) => untilAborted(s) });
    cache.set('h', 'build', { skill: 'build', params: {}, domain: 'build', intent: 'x', basedOn: [], needsApproval: false, rationale: '' });
    const before = autonomy.get('build').score;
    await handler.handle('Bastien', 'non, pas comme ça', 'chat');
    expect((await running).status).toBe('preempted');
    expect(store.getNode(ing.mechanismId)!.weight).toBeLessThan(0);
    expect(autonomy.get('build').score).toBeLessThan(before * 0.85);
    expect(cache.get('h')).toBeNull();
    expect(loopCalls).toEqual(['request:correction du joueur:true']);
    expect(said).toContain('D\'accord, j\'arrête.');
    const u = store.db.prepare('SELECT label, channel FROM utterances').get() as { label: string; channel: string };
    expect(u).toEqual({ label: 'correction', channel: 'chat' });
  });

  it('correction avec alternative : la consigne devient un ordre', async () => {
    const { handler, loopCalls } = await setup();
    await handler.handle('Bastien', 'non, construis plutôt en bois', 'voice');
    expect(loopCalls).toEqual(['order:non, construis plutôt en bois']);
  });

  it('approbation : renforce le mécanisme utilisé et la confiance', async () => {
    const { handler, store, autonomy, ing } = await setup();
    const before = autonomy.get('build').score;
    await handler.handle('Bastien', 'bien joué !', 'chat');
    expect(store.getNode(ing.mechanismId)!.weight).toBe(3);
    expect(autonomy.get('build').score).toBeGreaterThan(before);
  });

  it('enseignement : ouvre la fenêtre, les épisodes suivants comptent triple', async () => {
    const { handler, observer, clock, said } = await setup();
    await handler.handle('Bastien', 'regarde, je fais comme ça', 'chat');
    expect(said).toContain('Je regarde !');
    const episodes: Episode[] = [];
    (observer as unknown as { onEpisode: (e: Episode) => void }).onEpisode = (e) => episodes.push(e);
    for (let i = 0; i < 6; i++) observer.push({ t: clock.now() + i * 300, type: 'block_placed', player: 'Bastien', pos: { x: i, y: 64, z: 0 }, block: 'oak_planks' });
    observer.flush();
    expect(episodes[0]!.source).toBe('taught');
  });

  it('une proposition ouverte reçoit la réponse oui / non', async () => {
    const { handler, proposals } = await setup();
    const p = proposals.ask('Je peux construire ?');
    await handler.handle('Bastien', 'ouais vas-y', 'chat');
    expect(await p).toBe('yes');
  });

  it('ordre : transmis à la boucle', async () => {
    const { handler, loopCalls } = await setup();
    await handler.handle('Bastien', 'coupe du bois', 'chat');
    expect(loopCalls).toEqual(['order:coupe du bois']);
  });
});
