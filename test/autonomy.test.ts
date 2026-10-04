import type { Bot } from 'mineflayer';
import { describe, expect, it } from 'vitest';
import { Autonomy, bandWithHysteresis, graded, OBSERVATION, ON_REQUEST_MS } from '../src/autonomy/autonomy.js';
import { ProposalBroker } from '../src/autonomy/proposals.js';
import { ManualClock } from '../src/core/clock.js';
import { Budget } from '../src/decider/budget.js';
import { DecisionCache } from '../src/decider/cache.js';
import { Decider } from '../src/decider/decider.js';
import { DecisionLoop } from '../src/decider/loop.js';
import { ModelRouter } from '../src/decider/router.js';
import { RationalStubLlm } from '../src/sim/stubLlm.js';
import { ActionController } from '../src/skills/actionController.js';
import { HashingEmbedder } from '../src/store/embedder.js';
import { Store } from '../src/store/store.js';
import { MirrorStrategy } from '../src/strategy/strategy.js';
import { BehaviorTree } from '../src/tree/tree.js';
import { silentLogger, world } from './helpers.js';

async function store() {
  return Store.open(':memory:', new HashingEmbedder(), new ManualClock(0));
}

describe('score d\'autonomie', () => {
  it('part de zéro partout : le bot commence par observer', async () => {
    const a = new Autonomy(await store());
    expect(Object.values(a.all()).every((d) => d.score === 0 && d.band === 'observe')).toBe(true);
  });

  it('monte avec les réussites et les approbations, baisse avec échecs, corrections et mort', async () => {
    const a = new Autonomy(await store());
    for (let i = 0; i < 10; i++) a.apply('build', 'success');
    const afterSuccess = a.get('build').score;
    expect(afterSuccess).toBeGreaterThan(0.3);
    a.apply('build', 'approval');
    expect(a.get('build').score).toBeGreaterThan(afterSuccess);
    const beforeFail = a.get('build').score;
    a.apply('build', 'failure');
    expect(a.get('build').score).toBeLessThan(beforeFail);
    const beforeCorrection = a.get('build').score;
    a.apply('build', 'correction');
    expect(beforeCorrection - a.get('build').score).toBeGreaterThan(beforeFail - beforeCorrection);
  });

  it('les domaines sont indépendants : autonome en construction, observateur en combat', async () => {
    const a = new Autonomy(await store());
    for (let i = 0; i < 40; i++) a.apply('build', 'success');
    expect(a.get('build').band).toBe('act');
    expect(a.get('combat')).toEqual({ score: 0, band: 'observe' });
  });

  it('l\'observation seule mène à l\'imitation, jamais au-delà', async () => {
    const a = new Autonomy(await store());
    for (let i = 0; i < 200; i++) a.observe('mine', 'observed');
    expect(a.get('mine').score).toBe(OBSERVATION.cap);
    expect(a.get('mine').band).toBe('imitate');
  });

  it('l\'enseignement fait progresser plus vite que l\'observation passive', async () => {
    const a = new Autonomy(await store());
    a.observe('build', 'observed');
    a.observe('craft', 'taught');
    expect(a.get('craft').score).toBeGreaterThan(a.get('build').score * 2);
  });

  it('persiste et se recharge', async () => {
    const s = await store();
    const a = new Autonomy(s);
    for (let i = 0; i < 15; i++) a.apply('combat', 'success');
    const b = new Autonomy(s);
    expect(b.get('combat')).toEqual(a.get('combat'));
    const events = s.db.prepare("SELECT COUNT(*) AS n FROM autonomy_events WHERE domain = 'combat'").get() as { n: number };
    expect(events.n).toBe(15);
  });
});

describe('bandes avec hystérésis', () => {
  it('il faut dépasser nettement un seuil pour monter, et passer nettement dessous pour descendre', () => {
    expect(bandWithHysteresis(0.26, 'observe')).toBe('observe');
    expect(bandWithHysteresis(0.29, 'observe')).toBe('imitate');
    expect(bandWithHysteresis(0.24, 'imitate')).toBe('imitate');
    expect(bandWithHysteresis(0.21, 'imitate')).toBe('observe');
  });
});

describe('comportement gradué', () => {
  it('pas d\'initiative sous « propose », puis des initiatives de plus en plus fréquentes', () => {
    expect(graded.initiativeIntervalMs(0.3)).toBeNull();
    const a = graded.initiativeIntervalMs(0.55)!;
    const b = graded.initiativeIntervalMs(0.8)!;
    const c = graded.initiativeIntervalMs(1)!;
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
    expect(c).toBe(20_000);
  });

  it('le délai maximal d\'une action grandit avec la confiance', () => {
    expect(graded.timeoutFactor(0)).toBe(0.5);
    expect(graded.timeoutFactor(1)).toBe(1);
  });
});

describe('propositions', () => {
  it('oui, non, ou silence (accord tacite au délai)', async () => {
    const clock = new ManualClock(0);
    const broker = new ProposalBroker(clock, 20_000);
    const yes = broker.ask('Je peux construire un mur ?');
    expect(broker.open?.text).toContain('mur');
    broker.answer('yes');
    expect(await yes).toBe('yes');
    const no = broker.ask('Je peux miner ?');
    broker.answer('no');
    expect(await no).toBe('no');
    const silent = broker.ask('Je peux explorer ?');
    clock.advance(20_001);
    expect(await silent).toBe('timeout');
    expect(broker.answer('yes')).toBe(false);
  });
});

describe('autonomie dans la boucle', () => {
  async function setup(score: number) {
    const clock = new ManualClock(Date.UTC(2026, 9, 4, 12));
    const s = await Store.open(':memory:', new HashingEmbedder(), clock);
    const tree = new BehaviorTree(s, { playTime: () => 0 });
    const autonomy = new Autonomy(s);
    // amène la construction au score voulu par des réussites
    while (autonomy.get('build').score < score) autonomy.apply('build', 'success');
    const stub = new RationalStubLlm();
    const router = new ModelRouter('fast', 'strong');
    const decider = new Decider({ tree, llm: stub, budget: new Budget(s.db, clock, 1), cache: new DecisionCache(s.db, clock), router, strategy: new MirrorStrategy(), autonomy: () => autonomy.all(), clock, logger: silentLogger });
    const said: string[] = [];
    const bot = { chat: (t: string) => said.push(t), inventory: { items: () => [] }, players: {} } as unknown as Bot;
    const proposals = new ProposalBroker(clock, 20_000);
    const executed: string[] = [];
    const loop = new DecisionLoop({
      decider, actions: new ActionController(clock, () => {}), tree, router, skillContext: { bot, followPlayer: 'Bastien' },
      world: () => world(), snapshot: () => ({ health: 20, food: 20, inventory: {}, deaths: 0 }), clock, logger: silentLogger,
      autonomy, proposals, onExecuted: (e) => executed.push(e.record.decision.skill),
    });
    const ing = await tree.ingest({
      player: 'Bastien', domain: 'build', kind: 'wall', summary: 'mur', situation: { text: 'construire un mur' },
      mechanism: { skill: 'build', shape: 'wall', material: 'stone_bricks' }, params: {}, source: 'observed', startedAt: 0, endedAt: 1,
    });
    return { s, tree, autonomy, said, proposals, executed, loop, ing, stub };
  }
  const flush = () => new Promise((r) => setTimeout(r, 30));

  it('bande « propose » : le bot demande ; un oui est une approbation qui fait monter la confiance', async () => {
    const { autonomy, said, proposals, loop, ing, s } = await setup(0.55);
    expect(autonomy.get('build').band).toBe('propose');
    const before = autonomy.get('build').score;
    loop.request('épisode du joueur');
    await flush();
    expect(said[0]).toMatch(/\?$/);
    expect(proposals.open).not.toBeNull();
    proposals.answer('yes');
    await flush();
    expect(autonomy.get('build').score).toBeGreaterThan(before);
    expect(s.getNode(ing.mechanismId)!.weight).toBeGreaterThan(1);
  });

  it('un refus fait renoncer et reculer la confiance', async () => {
    const { autonomy, proposals, loop, executed } = await setup(0.55);
    const before = autonomy.get('build').score;
    loop.request('épisode du joueur');
    await flush();
    proposals.answer('no');
    await flush();
    expect(executed).toEqual([]);
    expect(autonomy.get('build').score).toBeLessThan(before);
  });

  it('le suivi décidé en repli va à son terme (pas de délai réduit)', async () => {
    const { loop, executed } = await setup(0);
    loop.request('épisode du joueur');
    await flush();
    // pas de joueur visible dans ce faux bot : le suivi échoue proprement, sans expirer
    expect(executed).toEqual(['follow']);
  });

  it('bande « observe » : aucune décision LLM, même quand le joueur agit', async () => {
    const { loop, stub } = await setup(0);
    loop.request('épisode du joueur');
    await flush();
    expect(stub.calls).toHaveLength(0);
  });
});

describe("« sur demande seulement » (cas réel : Alex construisait sans qu'on le lui demande)", () => {
  it("après un reproche : bande « observe » le temps de la règle, puis retour à la normale", async () => {
    const clock = new ManualClock(0);
    const s = await Store.open(':memory:', new HashingEmbedder(), clock);
    const a = new Autonomy(s);
    for (let i = 0; i < 8; i++) a.observe('build', 'taught');
    expect(a.get('build').band).toBe('imitate');
    a.restrictToRequests('build');
    expect(a.get('build')).toMatchObject({ band: 'observe', onRequestOnly: true });
    expect(new Autonomy(s).get('build').onRequestOnly).toBe(true); // persiste
    expect(a.get('craft').onRequestOnly).toBeUndefined();
    clock.advance(ON_REQUEST_MS + 1);
    expect(a.get('build')).toMatchObject({ band: 'imitate' });
  });
});
