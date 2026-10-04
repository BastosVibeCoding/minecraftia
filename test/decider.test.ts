import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/core/clock.js';
import { DOMAINS, type Domain } from '../src/core/types.js';
import { Budget } from '../src/decider/budget.js';
import { DecisionCache } from '../src/decider/cache.js';
import { applyGuards, Decider } from '../src/decider/decider.js';
import { LlmError, OpenRouterClient, type LlmClient } from '../src/decider/llm.js';
import type { Band } from '../src/decider/prompt.js';
import { ModelRouter } from '../src/decider/router.js';
import { parseDecision } from '../src/decider/schema.js';
import type { Episode } from '../src/observer/types.js';
import { RationalStubLlm } from '../src/sim/stubLlm.js';
import { HashingEmbedder } from '../src/store/embedder.js';
import { Store } from '../src/store/store.js';
import { MirrorStrategy, createStrategy } from '../src/strategy/strategy.js';
import { BehaviorTree } from '../src/tree/tree.js';
import { silentLogger, world } from './helpers.js';

const FAST = 'anthropic/claude-haiku-4.5';
const STRONG = 'anthropic/claude-sonnet-5.5';


function wallEpisode(over: Partial<Episode> = {}): Episode {
  return {
    player: 'Bastien',
    domain: 'build',
    kind: 'wall',
    summary: 'a construit un mur 7×4 en stone bricks',
    situation: { text: 'construire un mur' },
    mechanism: { skill: 'build', shape: 'wall', dims: { width: 7, height: 4, depth: 1 }, material: 'stone_bricks' },
    params: {},
    source: 'observed',
    startedAt: 0,
    endedAt: 1,
    ...over,
  };
}

const bands = (band: Band) => () => Object.fromEntries(DOMAINS.map((d) => [d, { band, score: 0.4 }])) as Record<Domain, { band: Band; score: number }>;

async function setup(opts: { llm?: LlmClient | null; daily?: number; band?: Band } = {}) {
  const clock = new ManualClock(Date.UTC(2026, 9, 4, 12));
  const store = await Store.open(':memory:', new HashingEmbedder(), clock);
  const tree = new BehaviorTree(store, { playTime: () => 0 });
  const stub = new RationalStubLlm();
  const llm = opts.llm === undefined ? stub : opts.llm;
  const budget = new Budget(store.db, clock, opts.daily ?? 1);
  const cache = new DecisionCache(store.db, clock);
  const router = new ModelRouter(FAST, STRONG);
  const decider = new Decider({ tree, llm, budget, cache, router, strategy: new MirrorStrategy(), autonomy: bands(opts.band ?? 'imitate'), clock, logger: silentLogger });
  return { clock, store, tree, stub, budget, cache, router, decider };
}

describe('décideur', () => {
  it('sans branche apprise : suivi, aucun appel LLM', async () => {
    const { decider, stub } = await setup();
    const r = await decider.decide('test', world());
    expect(r.source).toBe('fallback');
    expect(r.decision.skill).toBe('follow');
    expect(stub.calls).toHaveLength(0);
  });

  it('imite le mécanisme appris avec ses paramètres (petit modèle)', async () => {
    const { decider, tree, stub } = await setup();
    const ing = await tree.ingest(wallEpisode());
    const r = await decider.decide('épisode', world());
    expect(r.source).toBe('llm');
    expect(r.model).toBe(FAST);
    expect(r.decision).toMatchObject({ skill: 'build', domain: 'build', params: { shape: 'wall', material: 'stone_bricks', width: 7, height: 4 } });
    expect(r.decision.basedOn).toEqual([ing.mechanismId]);
    expect(stub.calls).toHaveLength(1);
  });

  it('situation quasi identique : décision servie par le cache, sans appel', async () => {
    const { decider, tree, stub } = await setup();
    await tree.ingest(wallEpisode());
    await decider.decide('a', world());
    const again = await decider.decide('b', world({ bot: { ...world().bot, health: 19, position: { x: 3, y: 64, z: 1 } } }));
    expect(again.source).toBe('cache');
    expect(stub.calls).toHaveLength(1);
  });

  it('sortie invalide : une nouvelle tentative, avec l\'erreur, puis succès', async () => {
    const { decider, tree, stub } = await setup();
    await tree.ingest(wallEpisode());
    stub.scripted.push('pas du json du tout');
    const r = await decider.decide('a', world());
    expect(r.source).toBe('llm');
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[1]!.user).toContain('invalide');
  });

  it('deux sorties invalides : repli sûr (suivi)', async () => {
    const { decider, tree, stub } = await setup();
    await tree.ingest(wallEpisode());
    stub.scripted.push('{"skill":"voler"}', '{"skill":"build","params":{"shape":"wall"},"domain":"build","intent":"x"}');
    const r = await decider.decide('a', world());
    expect(r.source).toBe('fallback');
    expect(r.decision.skill).toBe('follow');
    expect(r.decision.rationale).toContain('invalide');
  });

  it('budget épuisé : arrêt propre, suivi + réflexes, aucun appel', async () => {
    const { decider, tree, stub, budget } = await setup({ daily: 0.001 });
    await tree.ingest(wallEpisode());
    budget.record({ purpose: 'decide', model: FAST, promptTokens: 0, completionTokens: 0, costUsd: 0.002, latencyMs: 1, ok: true });
    const r = await decider.decide('a', world());
    expect(r.source).toBe('fallback');
    expect(r.decision.rationale).toContain('budget');
    expect(stub.calls).toHaveLength(0);
  });

  it('LLM en panne non récupérable : repli immédiat ; récupérable : une seconde chance', async () => {
    let calls = 0;
    const failing: LlmClient = {
      complete: async () => {
        calls++;
        throw new LlmError('HTTP 401', 401, false);
      },
    };
    const a = await setup({ llm: failing });
    await a.tree.ingest(wallEpisode());
    expect((await a.decider.decide('x', world())).source).toBe('fallback');
    expect(calls).toBe(1);

    const stub = new RationalStubLlm();
    let first = true;
    const flaky: LlmClient = {
      complete: async (req) => {
        if (first) {
          first = false;
          throw new LlmError('HTTP 503', 503, true);
        }
        return stub.complete(req);
      },
    };
    const b = await setup({ llm: flaky });
    await b.tree.ingest(wallEpisode());
    expect((await b.decider.decide('x', world())).source).toBe('llm');
  });

  it('chaque appel est consigné (tokens et coût)', async () => {
    const { decider, tree, budget } = await setup();
    await tree.ingest(wallEpisode());
    await decider.decide('a', world());
    const t = budget.today();
    expect(t.calls).toBe(1);
    expect(t.promptTokens).toBeGreaterThan(100);
    expect(t.costUsd).toBeGreaterThan(0);
    expect(t.costUsd).toBeLessThan(0.01);
  });

  it('la décision et sa justification sont conservées (pour !pourquoi)', async () => {
    const { decider, tree, store } = await setup();
    await tree.ingest(wallEpisode());
    const r = await decider.decide('épisode', world());
    const row = store.db.prepare('SELECT rationale, node_ids_json FROM decisions WHERE id = ?').get(r.id) as { rationale: string; node_ids_json: string };
    expect(row.rationale.length).toBeGreaterThan(5);
    expect(JSON.parse(row.node_ids_json)).toEqual(r.decision.basedOn);
  });

  it("la bande d'autonomie fixe la validation, quoi qu'en dise le LLM", async () => {
    const imit = await setup({ band: 'imitate' });
    await imit.tree.ingest(wallEpisode());
    imit.stub.scripted.push(JSON.stringify({ skill: 'build', params: { shape: 'wall', material: 'stone_bricks' }, domain: 'build', intent: 'x', needsApproval: true }));
    expect((await imit.decider.decide('a', world())).decision.needsApproval).toBe(false);

    const prop = await setup({ band: 'propose' });
    await prop.tree.ingest(wallEpisode());
    prop.stub.scripted.push(JSON.stringify({ skill: 'build', params: { shape: 'wall', material: 'stone_bricks' }, domain: 'build', intent: 'x', needsApproval: false }));
    expect((await prop.decider.decide('a', world())).decision.needsApproval).toBe(true);
  });

  it('bande « observe » partout : suivi sans appel', async () => {
    const { decider, tree, stub } = await setup({ band: 'observe' });
    await tree.ingest(wallEpisode());
    expect((await decider.decide('a', world())).decision.skill).toBe('follow');
    expect(stub.calls).toHaveLength(0);
  });
});

describe('correction', () => {
  it('une correction modifie le comportement dès la décision suivante', async () => {
    const { decider, tree, cache, stub } = await setup();
    const wall = await tree.ingest(wallEpisode());
    await tree.ingest(wallEpisode());
    await tree.ingest(wallEpisode({ kind: 'pillar', mechanism: { skill: 'build', shape: 'pillar', dims: { width: 1, height: 5, depth: 1 }, material: 'stone_bricks' } }));

    const before = await decider.decide('a', world());
    expect(before.decision.params.shape).toBe('wall');

    // « non, pas comme ça » : pénalité forte + cache du domaine invalidé
    tree.correct(wall.mechanismId);
    cache.invalidateDomain('build');

    const after = await decider.decide('correction', world());
    expect(after.source).toBe('llm');
    expect(after.decision.params.shape).toBe('pillar');
    expect(after.decision.basedOn).not.toContain(wall.mechanismId);
    // le mécanisme corrigé est présenté au LLM comme « à éviter »
    expect(stub.calls.at(-1)!.user).toContain(`"avoid":[{"id":${wall.mechanismId}`);
  });
});

describe("correction d'une habitude très renforcée (cas réel)", () => {
  it("même un mécanisme de poids 30 n'est plus reproduit après une correction, même si le LLM insiste", async () => {
    const { decider, tree, cache, stub } = await setup();
    let wall = await tree.ingest(wallEpisode({ source: 'taught' }));
    for (let i = 0; i < 9; i++) wall = await tree.ingest(wallEpisode({ source: 'taught' })); // poids 30
    tree.correct(wall.mechanismId);
    cache.invalidateDomain('build');
    expect(tree.store.getNode(wall.mechanismId)!.weight).toBeLessThan(0);
    // un LLM qui ignorerait la consigne et reconstruirait le même mur sans citer l'identifiant
    stub.scripted.push(JSON.stringify({ skill: 'build', params: { shape: 'wall', material: 'stone_bricks', width: 7, height: 4 }, domain: 'build', intent: 'refaire le mur', basedOn: [] }));
    const r = await decider.decide('correction', world());
    expect(r.decision.skill).toBe('follow');
    expect(r.decision.rationale).toContain('corrigé');
  });
});

describe("garde-fou contre un mécanisme corrigé", () => {
  it("refuse une décision qui reproduit un mécanisme à éviter, même quand le LLM est appelé", async () => {
    const { decider, tree, cache, stub } = await setup();
    let wall = await tree.ingest(wallEpisode({ source: 'taught' }));
    for (let i = 0; i < 9; i++) wall = await tree.ingest(wallEpisode({ source: 'taught' }));
    await tree.ingest(wallEpisode({ kind: 'pillar', mechanism: { skill: 'build', shape: 'pillar', material: 'stone_bricks' } }));
    tree.correct(wall.mechanismId);
    cache.invalidateDomain('build');
    stub.scripted.push(JSON.stringify({ skill: 'build', params: { shape: 'wall', material: 'stone_bricks' }, domain: 'build', intent: 'refaire le mur', basedOn: [] }));
    const r = await decider.decide('correction', world());
    expect(stub.calls).toHaveLength(1);
    expect(r.decision.skill).toBe('follow');
    expect(r.decision.rationale).toContain('corrigé');
  });
});

describe('garde-fou matériaux', () => {
  it("ne lance pas une construction sans le matériau dans l'inventaire (cas vu au banc)", async () => {
    const { decider, tree, stub } = await setup();
    await tree.ingest(wallEpisode());
    stub.scripted.push(JSON.stringify({ skill: 'build', params: { shape: 'wall', material: 'stone_bricks' }, domain: 'build', intent: 'mur' }));
    const r = await decider.decide('a', world({ bot: { ...world().bot, inventory: { dirt: 3 } } }));
    expect(r.decision.skill).toBe('follow');
    expect(r.decision.rationale).toContain('inventaire');
  });
});

describe('routage des modèles', () => {
  it('petit modèle par défaut, gros après 3 échecs dans la même situation, gros pour composer', () => {
    const r = new ModelRouter(FAST, STRONG);
    expect(r.pick('decide', 'h').model).toBe(FAST);
    r.recordOutcome('h', false);
    r.recordOutcome('h', false);
    expect(r.pick('decide', 'h').model).toBe(FAST);
    r.recordOutcome('h', false);
    expect(r.pick('decide', 'h').model).toBe(STRONG);
    expect(r.pick('decide', 'autre').model).toBe(FAST);
    r.recordOutcome('h', true);
    expect(r.pick('decide', 'h').model).toBe(FAST);
    expect(r.pick('compose').model).toBe(STRONG);
    expect(r.pick('classify').model).toBe(FAST);
  });

  it('le décideur escalade réellement vers le gros modèle', async () => {
    const { decider, tree, router, stub } = await setup();
    await tree.ingest(wallEpisode());
    const first = await decider.decide('a', world());
    for (let i = 0; i < 3; i++) router.recordOutcome(first.situationHash, false);
    decider['deps'].cache.clear();
    const second = await decider.decide('b', world());
    expect(second.model).toBe(STRONG);
    expect(stub.calls.at(-1)!.model).toBe(STRONG);
  });
});

describe('validation des décisions', () => {
  it('refuse une compétence inconnue et des paramètres hors bornes', () => {
    expect(parseDecision('{"skill":"teleport","params":{},"domain":"build","intent":"x"}').ok).toBe(false);
    const r = parseDecision('{"skill":"build","params":{"shape":"wall","material":"stone","width":500},"domain":"build","intent":"x"}');
    expect(r.ok).toBe(false);
  });

  it('tolère les écarts constatés au banc : dimensions décimales ou en texte, champ facultatif à null', () => {
    const r = parseDecision('{"skill":"build","params":{"shape":"wall","material":"stone_bricks","width":7.29,"height":"3","depth":1},"domain":"build","intent":"mur","say":null,"rationale":null}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.decision.params).toMatchObject({ width: 7, height: 3, depth: 1 });
    // les bornes restent appliquées après arrondi
    expect(parseDecision('{"skill":"build","params":{"shape":"wall","material":"stone","width":99.6},"domain":"build","intent":"x"}').ok).toBe(false);
  });

  it('accepte du texte autour du JSON', () => {
    const r = parseDecision('Voici : {"skill":"follow","params":{},"domain":"explore","intent":"suivre"} fin');
    expect(r.ok).toBe(true);
  });
});

describe('personnage', () => {
  it("Alex parle d'elle au féminin ; le nom et le genre sont configurables", async () => {
    const { systemPrompt } = await import('../src/decider/prompt.js');
    const alex = systemPrompt({ name: 'Alex', gender: 'feminine' });
    expect(alex).toContain('Tu es Alex, une compagne');
    expect(alex).toContain('au féminin');
    expect(systemPrompt({ name: 'Steve', gender: 'masculine' })).toContain('Tu es Steve, un compagnon');
  });
});

describe('stratégie', () => {
  it('mirror par défaut, complement refusé explicitement', () => {
    expect(createStrategy('mirror').name).toBe('mirror');
    expect(() => createStrategy('complement')).toThrow(/non implémentée/);
  });
});

describe('client OpenRouter', () => {
  it('lit le contenu, les tokens et le coût réel', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ model: FAST, choices: [{ message: { content: '{"a":1}' } }], usage: { prompt_tokens: 1200, completion_tokens: 80, cost: 0.0016 } }), { status: 200 })) as typeof fetch;
    const c = new OpenRouterClient({ apiKey: 'sk-or-v1-secret-cle-de-test', baseUrl: 'https://x', fetchImpl: fakeFetch });
    const r = await c.complete({ purpose: 'decide', model: FAST, system: 's', user: 'u', maxTokens: 100 });
    expect(r).toMatchObject({ text: '{"a":1}', promptTokens: 1200, completionTokens: 80, costUsd: 0.0016 });
  });

  it('erreur HTTP : message sans la clé, 429 et 5xx récupérables', async () => {
    const key = 'sk-or-v1-secret-cle-de-test';
    const fakeFetch = (async () => new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 })) as typeof fetch;
    const c = new OpenRouterClient({ apiKey: key, baseUrl: 'https://x', fetchImpl: fakeFetch });
    const err = await c.complete({ purpose: 'decide', model: FAST, system: 's', user: 'u', maxTokens: 10 }).catch((e: unknown) => e as LlmError);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).retryable).toBe(true);
    expect((err as LlmError).message).not.toContain(key);
  });
});

describe("construction d'initiative (demande du joueur, 2026-10-05)", () => {
  const imitate = Object.fromEntries(DOMAINS.map((d) => [d, { band: 'act' as Band, score: 0.9 }])) as Record<Domain, { band: Band; score: number }>;
  const floor = { skill: 'build', params: { shape: 'floor', material: 'oak_planks' }, domain: 'build' as Domain, intent: 'faire un sol comme toi', basedOn: [], needsApproval: false, say: 'Je vais faire un sol comme toi', rationale: '' };

  it("désactivée : même en autonomie maximale, pas de construction sans ordre", () => {
    expect(applyGuards(floor, [], imitate, false, { oak_planks: 64 }, false).skill).toBe('follow');
  });

  it("sur ordre, elle construit toujours", () => {
    expect(applyGuards(floor, [], imitate, true, { oak_planks: 64 }, false).skill).toBe('build');
  });
});
