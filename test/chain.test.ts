import { describe, expect, it } from 'vitest';
import { buildChain, FallbackChainClient, RELAY_TIMEOUT_MS, SLOW_RELAY_TIMEOUT_MS, type ChainEntry } from '../src/decider/chain.js';
import { LlmError, type LlmClient, type LlmRequest } from '../src/decider/llm.js';
import { silentLogger } from './helpers.js';

const req: LlmRequest = { purpose: 'decide', model: 'ignoré', system: 's', user: 'u', maxTokens: 400 };

function fake(behaviour: () => string | LlmError): LlmClient & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  return {
    calls,
    async complete(r) {
      calls.push(r);
      const out = behaviour();
      if (out instanceof LlmError) throw out;
      return { text: out, model: r.model, promptTokens: 1200, completionTokens: 100, costUsd: 0.002, latencyMs: 5 };
    },
  };
}

function entry(name: string, client: LlmClient, free = true): ChainEntry {
  return { name, client, model: name.split(':').slice(1).join(':'), free, maxTokens: 600 };
}

describe('chaîne de fournisseurs', () => {
  it('le premier disponible répond ; le modèle et le plafond viennent de la chaîne ; gratuit = 0 $', async () => {
    const a = fake(() => '{"ok":1}');
    const chain = new FallbackChainClient([entry('gemini:flash', a), entry('groq:oss', fake(() => 'x'))], silentLogger);
    const r = await chain.complete(req);
    expect(r).toMatchObject({ model: 'gemini:flash', costUsd: 0 });
    expect(a.calls[0]).toMatchObject({ model: 'flash', maxTokens: 600 });
    expect(chain.lastServedBy).toBe('gemini:flash');
  });

  it('saturation : relais immédiat au suivant, puis le saturé reste en pause', async () => {
    let now = 0;
    const a = fake(() => new LlmError('HTTP 429 : Rate limit reached', 429, true));
    const b = fake(() => '{"ok":2}');
    const chain = new FallbackChainClient([entry('gemini:flash', a), entry('groq:oss', b)], silentLogger, () => now);
    expect((await chain.complete(req)).model).toBe('groq:oss');
    await chain.complete(req);
    expect(a.calls).toHaveLength(1); // en pause : pas réessayé tout de suite
    now += 61_000;
    await chain.complete(req);
    expect(a.calls).toHaveLength(2); // la pause est finie
  });

  it('quota du jour épuisé : pause longue', async () => {
    let now = 0;
    const a = fake(() => new LlmError('HTTP 429 : Rate limit reached on tokens per day (TPD)', 429, true));
    const chain = new FallbackChainClient([entry('groq:oss', a), entry('ollama:local', fake(() => 'ok'))], silentLogger, () => now);
    await chain.complete(req);
    now += 10 * 60_000;
    await chain.complete(req);
    expect(a.calls).toHaveLength(1);
    expect(chain.status()[0]!.pausedS).toBeGreaterThan(40 * 60);
  });

  it('réponse vide ou erreur serveur : on passe au suivant', async () => {
    const chain = new FallbackChainClient(
      [entry('a:1', fake(() => new LlmError('réponse sans contenu', 200))), entry('b:2', fake(() => new LlmError('HTTP 503 : surchargé', 503, true))), entry('c:3', fake(() => 'ok'))],
      silentLogger,
    );
    expect((await chain.complete(req)).model).toBe('c:3');
  });

  it('tous indisponibles : erreur non récupérable (le décideur se replie sur le suivi)', async () => {
    const chain = new FallbackChainClient([entry('a:1', fake(() => new LlmError('HTTP 503', 503, true)))], silentLogger);
    const err = (await chain.complete(req).then(
      () => null,
      (e: unknown) => e,
    )) as LlmError;
    expect(err).toBeInstanceOf(LlmError);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('aucun fournisseur disponible');
  });

  it('un fournisseur payant garde son coût réel', async () => {
    const chain = new FallbackChainClient([entry('openrouter:anthropic/claude-haiku-4.5', fake(() => 'ok'), false)], silentLogger);
    expect((await chain.complete(req)).costUsd).toBe(0.002);
  });
});

describe('construction de la chaîne', () => {
  it('lit « fournisseur:modèle », ignore les fournisseurs sans clé', () => {
    const chain = buildChain(
      'gemini:gemini-3.5-flash-lite, groq:openai/gpt-oss-120b, openrouter:nvidia/nemotron-3-super-120b-a12b:free, ollama:qwen2.5:7b-instruct, inconnu:x',
      { GEMINI_API_KEY: 'k', OPENROUTER_API_KEY: 'k' },
      silentLogger,
    )!;
    expect(chain.entries.map((e) => e.name)).toEqual(['gemini:gemini-3.5-flash-lite', 'openrouter:nvidia/nemotron-3-super-120b-a12b:free', 'ollama:qwen2.5:7b-instruct']);
    expect(chain.entries.map((e) => e.model)).toEqual(['gemini-3.5-flash-lite', 'nvidia/nemotron-3-super-120b-a12b:free', 'qwen2.5:7b-instruct']);
    expect(chain.entries.every((e) => e.free)).toBe(true);
  });

  it('aucun fournisseur utilisable : pas de chaîne', () => {
    expect(buildChain('groq:openai/gpt-oss-20b', {}, silentLogger)).toBeNull();
  });
});

it("un fournisseur lent passe la main après 4,5 s ; le dernier de la chaîne garde son délai (cas réel : Gemini à 7-20 s)", () => {
  const chain = buildChain('gemini:gemini-3.5-flash-lite,gemini:gemini-flash-lite-latest,groq:openai/gpt-oss-120b', { GEMINI_API_KEY: 'k', GROQ_API_KEY: 'k' }, silentLogger)!;
  const timeouts = chain.entries.map((e) => (e.client as unknown as { opts: { timeoutMs: number } }).opts.timeoutMs);
  expect(timeouts).toEqual([RELAY_TIMEOUT_MS, RELAY_TIMEOUT_MS, 20_000]);
});

it("sans Groq derrière (chaîne de Léa), Gemini a 8 s avant le relais vers le secours lent (cas réel : Nemotron 7-11 s)", () => {
  const chain = buildChain('gemini:gemini-3.5-flash-lite,gemini:gemini-flash-lite-latest,openrouter:nvidia/nemotron-3-super-120b-a12b:free', { GEMINI_API_KEY: 'k', OPENROUTER_API_KEY: 'k' }, silentLogger)!;
  const timeouts = chain.entries.map((e) => (e.client as unknown as { opts: { timeoutMs: number } }).opts.timeoutMs);
  expect(timeouts).toEqual([SLOW_RELAY_TIMEOUT_MS, SLOW_RELAY_TIMEOUT_MS, 30_000]);
});
