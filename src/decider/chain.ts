import type { Logger } from '../core/logger.js';
import { LlmError, OpenRouterClient, type LlmClient, type LlmRequest, type LlmResponse } from './llm.js';

/** Fournisseurs connus (tous au format « chat completions »). */
export const PROVIDERS = {
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', extras: true, timeoutMs: 30_000 },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyEnv: 'GEMINI_API_KEY', extras: false, timeoutMs: 20_000 },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY', extras: false, timeoutMs: 20_000 },
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1', keyEnv: '', extras: false, timeoutMs: 180_000 },
} as const;

export type ProviderName = keyof typeof PROVIDERS;

export interface ChainEntry {
  /** Nom affiché dans les journaux, ex. « gemini:gemini-3.5-flash-lite ». */
  name: string;
  client: LlmClient;
  model: string;
  /** Gratuit : compté 0 $ dans le budget. */
  free: boolean;
  /** Plafond de tokens en sortie (les modèles qui « réfléchissent » en consomment avant de répondre). */
  maxTokens: number;
}

/** Délai maximal d'un fournisseur avant de passer au suivant (le dernier de la chaîne n'est pas concerné). */
export const RELAY_TIMEOUT_MS = 4500;

/** Durées de mise en pause d'un fournisseur selon l'échec. */
const PAUSE = {
  rateLimit: 60_000, // saturation passagère
  daily: 60 * 60_000, // quota du jour épuisé : on réessaie dans une heure
  server: 2 * 60_000, // erreur 5xx, délai dépassé, réseau
  empty: 30_000, // réponse vide
  refused: 15 * 60_000, // 400/401/403/404 : configuration ou modèle indisponible
} as const;

/**
 * Chaîne de fournisseurs : chaque requête part au premier fournisseur disponible ; en cas de
 * saturation, de quota épuisé, d'erreur ou de réponse vide, il est mis en pause et le suivant prend
 * le relais immédiatement. Le modèle demandé par l'appelant est ignoré : c'est la chaîne qui choisit.
 */
export class FallbackChainClient implements LlmClient {
  private pausedUntil = new Map<string, number>();
  /** Dernier fournisseur ayant répondu (pour `!budget` et les journaux). */
  lastServedBy: string | null = null;

  constructor(
    readonly entries: ChainEntry[],
    private readonly logger: Logger,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (entries.length === 0) throw new Error('chaîne de fournisseurs vide');
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const errors: string[] = [];
    const available = this.entries.filter((e) => (this.pausedUntil.get(e.name) ?? 0) <= this.now());
    // tous en pause : on retente quand même le premier plutôt que d'abandonner
    for (const entry of available.length ? available : this.entries.slice(0, 1)) {
      try {
        const res = await entry.client.complete({ ...req, model: entry.model, maxTokens: Math.max(req.maxTokens, entry.maxTokens) });
        this.lastServedBy = entry.name;
        return { ...res, model: entry.name, costUsd: entry.free ? 0 : res.costUsd };
      } catch (err) {
        const e = err instanceof LlmError ? err : new LlmError(String(err));
        const pause = pauseFor(e);
        this.pausedUntil.set(entry.name, this.now() + pause);
        errors.push(`${entry.name} : ${e.message.slice(0, 80)}`);
        this.logger.warn({ provider: entry.name, status: e.status, pauseS: Math.round(pause / 1000) }, `fournisseur indisponible, relais au suivant : ${e.message.slice(0, 120)}`);
      }
    }
    throw new LlmError(`aucun fournisseur disponible (${errors.join(' | ')})`, undefined, false);
  }

  /** État de la chaîne : fournisseurs et secondes de pause restantes. */
  status(): { name: string; pausedS: number }[] {
    return this.entries.map((e) => ({ name: e.name, pausedS: Math.max(0, Math.round(((this.pausedUntil.get(e.name) ?? 0) - this.now()) / 1000)) }));
  }
}

function pauseFor(e: LlmError): number {
  const msg = e.message.toLowerCase();
  if (msg.includes('sans contenu')) return PAUSE.empty;
  if (e.status === 429) return /per day|daily|tpd|rpd|quota/.test(msg) ? PAUSE.daily : PAUSE.rateLimit;
  if (e.status !== undefined && e.status >= 400 && e.status < 500) return PAUSE.refused;
  return PAUSE.server;
}

/**
 * Construit la chaîne depuis une liste « fournisseur:modèle » séparée par des virgules, par exemple
 * `gemini:gemini-3.5-flash-lite,groq:openai/gpt-oss-120b,ollama:qwen2.5:7b-instruct`.
 * Les fournisseurs sans clé configurée sont ignorés (et signalés).
 */
export function buildChain(spec: string, env: Record<string, string | undefined>, logger: Logger): FallbackChainClient | null {
  const valid: { raw: string; provider: ProviderName; model: string; key: string }[] = [];
  for (const raw of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = raw.indexOf(':');
    const provider = raw.slice(0, i) as ProviderName;
    const model = raw.slice(i + 1);
    const def = PROVIDERS[provider];
    if (i < 0 || !def || !model) {
      logger.warn({ entry: raw }, 'entrée de chaîne invalide (attendu fournisseur:modèle), ignorée');
      continue;
    }
    const key = def.keyEnv ? env[def.keyEnv] : 'ollama';
    if (!key) {
      logger.warn({ entry: raw, variable: def.keyEnv }, 'clé absente : fournisseur ignoré');
      continue;
    }
    valid.push({ raw, provider, model, key });
  }
  const entries: ChainEntry[] = valid.map(({ raw, provider, model, key }, i) => {
    const def = PROVIDERS[provider];
    // un fournisseur lent (Gemini saturé : 7 à 20 s par réponse, cas réel) passe la main au suivant
    // après RELAY_TIMEOUT_MS ; seul le dernier de la chaîne garde son délai long, pour qu'une réponse arrive
    const timeoutMs = i < valid.length - 1 ? Math.min(def.timeoutMs, RELAY_TIMEOUT_MS) : def.timeoutMs;
    return {
      name: raw,
      model,
      free: provider !== 'openrouter' || model.endsWith(':free'),
      // les modèles qui raisonnent (gpt-oss, nemotron…) ont besoin de place avant de répondre
      maxTokens: provider === 'gemini' || provider === 'ollama' ? 600 : 1500,
      client: new OpenRouterClient({ apiKey: key, baseUrl: provider === 'ollama' ? (env.OLLAMA_URL ?? def.baseUrl) : def.baseUrl, timeoutMs, openRouterExtras: def.extras }),
    };
  });
  return entries.length ? new FallbackChainClient(entries, logger) : null;
}
