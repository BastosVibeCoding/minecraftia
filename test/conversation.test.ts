import { describe, expect, it } from 'vitest';
import { Autonomy } from '../src/autonomy/autonomy.js';
import { ProposalBroker } from '../src/autonomy/proposals.js';
import { ManualClock } from '../src/core/clock.js';
import { Budget } from '../src/decider/budget.js';
import { DecisionCache } from '../src/decider/cache.js';
import type { DecisionLoop } from '../src/decider/loop.js';
import type { LlmClient, LlmRequest } from '../src/decider/llm.js';
import { UtteranceClassifier } from '../src/feedback/classifier.js';
import { FeedbackHandler, isSmallTalk } from '../src/feedback/feedback.js';
import { Observer } from '../src/observer/observer.js';
import { ActionController } from '../src/skills/actionController.js';
import { HashingEmbedder } from '../src/store/embedder.js';
import { Store } from '../src/store/store.js';
import { BehaviorTree } from '../src/tree/tree.js';
import { silentLogger } from './helpers.js';

/** Léa accompagne Bilbo ; le modèle de conversation répond « réponse n », et on garde chaque requête. */
async function setup() {
  const clock = new ManualClock(Date.UTC(2026, 9, 10, 12));
  const store = await Store.open(':memory:', new HashingEmbedder(), clock);
  const chats: LlmRequest[] = [];
  const llm: LlmClient = {
    complete: async (req) => {
      if (req.purpose === 'chat') chats.push(req);
      const text = req.purpose === 'chat' ? `réponse ${chats.length}` : '{"label":"chatter","confidence":0.8}';
      return { text, model: req.model, promptTokens: 1, completionTokens: 1, costUsd: 0, latencyMs: 1 };
    },
  };
  const classifier = new UtteranceClassifier(llm, new Budget(store.db, clock, 1), 'fast', 'Lea', 'feminine');
  const orders: string[] = [];
  const said: string[] = [];
  const handler = new FeedbackHandler({
    classifier, tree: new BehaviorTree(store, { playTime: () => 0 }), autonomy: new Autonomy(store), cache: new DecisionCache(store.db, clock),
    proposals: new ProposalBroker(clock), observer: new Observer('Bilbo', () => {}), store, clock, logger: silentLogger,
    loop: () => ({ order: (t: string) => orders.push(t), request: () => {} }) as unknown as DecisionLoop,
    actions: () => new ActionController(clock, () => {}), lastDecision: () => null, lastDecisionAt: () => 0, say: (t) => said.push(t),
    botName: 'Lea', owner: 'Bilbo', status: () => ({ health: 18, food: 15 }), inventory: () => ({ oak_log: 12 }),
  });
  return { clock, chats, orders, said, handler };
}

describe("conversation plus naturelle (demande du joueur, 2026-10-10)", () => {
  it("« bonjour » sans son nom : elle répond quand même à son joueur", async () => {
    const s = await setup();
    await s.handler.handle('Bilbo', 'bonjour !', 'chat');
    expect(s.said).toEqual(['réponse 1']);
  });

  it("la question suivante, sans son nom, reçoit une réponse qui a le fil et la situation", async () => {
    const s = await setup();
    await s.handler.handle('Bilbo', "Léa, c'est quoi ton mob préféré ?", 'chat');
    s.clock.advance(5000);
    await s.handler.handle('Bilbo', 'et pourquoi ?', 'chat');
    expect(s.said).toEqual(['réponse 1', 'réponse 2']);
    const last = s.chats[1]!.user;
    expect(last).toContain("Bilbo : Léa, c'est quoi ton mob préféré ?");
    expect(last).toContain('Lea : réponse 1');
    expect(last).toContain('vie 18/20');
    expect(last).toContain('12 oak_log');
  });

  it("une phrase entre joueurs, longtemps après, n'est pas pour elle", async () => {
    const s = await setup();
    await s.handler.handle('Bilbo', 'Léa, tu aimes la pluie ?', 'chat');
    s.clock.advance(120_000);
    await s.handler.handle('Bilbo', 'on va à la mine après ?', 'chat');
    expect(s.said).toEqual(['réponse 1']);
  });

  it("une question à voix haute est répondue tout de suite, sans retranscription ni manque noté", async () => {
    const s = await setup();
    const c = await s.handler.handle('Bilbo', 'Léa, tu aimes les creepers ?', 'voice', { final: false });
    expect(c.unclear).toBeUndefined();
    expect(s.said).toEqual(['réponse 1']);
  });

  it("un autre joueur peut discuter avec elle, mais elle ne prend pas ses ordres", async () => {
    const s = await setup();
    await s.handler.handleGuest('Juicy', 'Léa, coupe du bois');
    expect(s.orders).toEqual([]);
    expect(s.said).toEqual(['réponse 1']);
    expect(s.chats[0]!.system).toContain("tu ne prends pas d'ordres");
    expect(s.chats[0]!.system).toContain('tu accompagnes Bilbo');
  });

  it("un autre joueur qui ne la nomme pas (et ne lui parlait pas) : elle se tait", async () => {
    const s = await setup();
    await s.handler.handleGuest('Juicy', 'salut tout le monde');
    expect(s.said).toEqual([]);
  });

  it("politesses reconnues", () => {
    expect(isSmallTalk('salut')).toBe(true);
    expect(isSmallTalk('bonne nuit tout le monde')).toBe(true);
    expect(isSmallTalk('coupe du bois')).toBe(false);
  });
});

describe("attaquer n'importe qui sur ordre de son joueur (demande du joueur, 2026-10-10)", () => {
  it("un autre bot ou un joueur par son pseudo, un villageois par « PNJ », jamais soi-même", async () => {
    const { isAttackTarget } = await import('../src/skills/library.js');
    const alex = { name: 'player', type: 'player', username: 'Alex' };
    const bilbo = { name: 'player', type: 'player', username: 'Bilbo' };
    const lea = { name: 'player', type: 'player', username: 'Lea' };
    expect(isAttackTarget(alex, ['alex'], 'Lea', 'Bilbo')).toBe(true);
    expect(isAttackTarget(lea, ['Léa'], 'Lea', 'Bilbo')).toBe(false);
    expect(isAttackTarget({ name: 'villager', type: 'mob' }, ['PNJ'], 'Lea', 'Bilbo')).toBe(true);
    // « attaque les joueurs » : tout le monde sauf son propre joueur, qui reste attaquable s'il est nommé
    expect(isAttackTarget(alex, ['joueurs'], 'Lea', 'Bilbo')).toBe(true);
    expect(isAttackTarget(bilbo, ['player'], 'Lea', 'Bilbo')).toBe(false);
    expect(isAttackTarget(bilbo, ['Bilbo'], 'Lea', 'Bilbo')).toBe(true);
    expect(isAttackTarget({ name: 'cow', type: 'animal' }, ['zombie'], 'Lea', 'Bilbo')).toBe(false);
  });
});

describe("trait de caractère propre au bot (Laure a un faible pour Plagyat, 2026-10-10)", () => {
  it("le trait est ajouté à la consigne de conversation, et absent sans réglage", async () => {
    const seen: string[] = [];
    const clock = new ManualClock(Date.UTC(2026, 9, 10, 12));
    const store = await Store.open(':memory:', new HashingEmbedder(), clock);
    const llm: LlmClient = {
      complete: async (req) => (seen.push(req.system), { text: 'ok', model: req.model, promptTokens: 1, completionTokens: 1, costUsd: 0, latencyMs: 1 }),
    };
    const budget = new Budget(store.db, clock, 1);
    await new UtteranceClassifier(llm, budget, 'fast', 'Laure', 'feminine', 'tu as un faible pour Plagyat').reply('salut', { player: 'Plagyat' });
    await new UtteranceClassifier(llm, budget, 'fast', 'Lea', 'feminine').reply('salut', { player: 'Juicy' });
    expect(seen[0]).toContain('Ton caractère : tu as un faible pour Plagyat');
    expect(seen[1]).not.toContain('Ton caractère');
  });
});
