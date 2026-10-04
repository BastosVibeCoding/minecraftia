import { describe, expect, it } from 'vitest';
import { Autonomy } from '../src/autonomy/autonomy.js';
import { ProposalBroker } from '../src/autonomy/proposals.js';
import { ManualClock } from '../src/core/clock.js';
import { Budget } from '../src/decider/budget.js';
import { DecisionCache } from '../src/decider/cache.js';
import type { DecisionRecord } from '../src/decider/decider.js';
import type { DecisionLoop } from '../src/decider/loop.js';
import type { LlmClient } from '../src/decider/llm.js';
import { classifyByRules, isAddressed, UtteranceClassifier } from '../src/feedback/classifier.js';
import { answerInventoryQuestion } from '../src/feedback/questions.js';
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

  it.each([
    ['Alex coupe du bois.', 'order'],
    ['alex coupe du bois', 'order'],
    ['Hé Alex, construit un mur', 'order'],
    ['coupe du bois, Alex !', 'order'],
    ['Alex, non, pas comme ça', 'correction'],
    ['Alex, regarde', 'teaching'],
    ['Salut Alex !', 'chatter'],
  ])('interpellation du personnage : « %s » → %s', (text, expected) => expect(label(text)).toBe(expected));

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
      id: 1, source: 'llm', model: 'fast', situationHash: 'h', situationText: 'x', branches: [], trigger: 'épisode du joueur',
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

  it("reproche d'une initiative : le domaine passe « sur demande seulement » ; reproche d'un ordre : non", async () => {
    const a = await setup();
    await a.handler.handle('Bastien', "c'est nul ce que tu as fait", 'voice');
    expect(a.autonomy.get('build').onRequestOnly).toBe(true);

    const b = await setup();
    b.setLast({ id: 2, source: 'llm', model: 'fast', situationHash: 'h', situationText: 'x', branches: [], trigger: 'ordre du joueur', decision: { skill: 'build', params: {}, domain: 'build', intent: 'mur', basedOn: [b.ing.mechanismId], needsApproval: false, rationale: '' } });
    await b.handler.handle('Bastien', "c'est nul ce que tu as fait", 'voice');
    expect(b.autonomy.get('build').onRequestOnly).toBeUndefined();
  });

  it("ordre vague : le bot demande quoi, puis la réponse complète l'ordre", async () => {
    const { handler, loopCalls, said } = await setup();
    await handler.handle('Bastien', 'va miner', 'voice');
    expect(loopCalls).toEqual([]);
    expect(said.at(-1)).toMatch(/^Je mine quoi/);
    await handler.handle('Bastien', 'du fer', 'voice');
    expect(loopCalls).toEqual(['order:va miner : du fer']);
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

describe("ordres oraux réels (2026-10-04) mal compris", () => {
  it.each([
    ['alex fait 3 echelles', 'Alex'],
    ["Là tu peux couper du bois aussi s'il te plaît.", 'Lea'],
    ['Là, donne-moi ton bois, s\'il te plaît.', 'Lea'],
    ["Ok, tu vas ramasser 5 bûches encore et tu vas me les donner.", 'Lea'],
    ['Allez, récupère du bois', 'Alex'],
    ['bon, plutot coupe du bois', 'Alex'],
  ])("« %s » est un ordre", (text, bot) => {
    expect(classifyByRules(text, bot)).toMatchObject({ label: 'order', ambiguous: false });
  });

  it("repère qu'une phrase interpelle le bot par son nom", () => {
    expect(isAddressed('Alex, 5-3-HEL.', 'Alex')).toBe(true);
    expect(isAddressed('Léa suis-moi', 'Lea')).toBe(true);
    expect(isAddressed('on va miner', 'Alex')).toBe(false);
  });
});

it("« non, plutôt coupe du bois » : correction accompagnée d'un ordre", () => {
  expect(classifyByRules('non, plutot coupe du bois', 'Alex')).toMatchObject({ label: 'correction', also: 'order' });
});

describe("reproches réels d'Alex (2026-10-05)", () => {
  it.each([
    "Alex, c'est nul ce que tu as fait, il ne faut pas faire ça, si je ne te demande pas à construire, construis pas.",
    "Alex, non, fais pas ça, je t'ai pas amené de construire.",
  ])("« %s » est une correction, pas un ordre de construire", (text) => {
    const c = classifyByRules(text, 'Alex');
    expect(c.label).toBe('correction');
    expect(c.also).toBeUndefined();
  });

  it("« construis pas » n'est pas un ordre, « construis un mur » si", () => {
    expect(classifyByRules('construis pas', 'Alex').label).not.toBe('order');
    expect(classifyByRules('construis un mur', 'Alex').label).toBe('order');
  });
});

it("« Alex, trouve de la laine » est un ordre (manque réel du 2026-10-05)", () => {
  expect(classifyByRules('Alex, trouve de la laine.', 'Alex')).toMatchObject({ label: 'order', ambiguous: false });
});

describe("questions sur l'inventaire (manques réels : « Alex, t'as du bois ou pas ? »)", () => {
  const inv = { oak_log: 12, birch_log: 3, cobblestone: 20, iron_ingot: 2 };
  it.each([
    ["Alex, t'as du bois ou pas ?", "J'ai 15 bûches."],
    ['tu as eu tes trente bûches ?', "J'ai 15 bûches."],
    ['combien de fer tu as', "J'ai 2 fer."],
    ['est-ce que tu as des diamants ?', "Je n'ai pas de diamants."],
  ])("« %s » → %s", (q, a) => {
    expect(answerInventoryQuestion(q, inv)).toBe(a);
  });

  it("un ordre n'est pas une question", () => {
    expect(answerInventoryQuestion('donne-moi tes bûches', inv)).toBeNull();
    expect(answerInventoryQuestion('ça va ?', inv)).toBeNull();
  });
});
