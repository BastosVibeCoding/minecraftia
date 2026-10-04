import { readFileSync, existsSync } from 'node:fs';
import { z } from 'zod';
import { ConfigSchema, type Config } from './schema.js';

type Env = Record<string, string | undefined>;

function prune(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === '') continue;
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? prune(v as Record<string, unknown>) : v;
  }
  return out;
}

function deepMerge(base: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown> {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    const cur = out[k];
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object'
        ? deepMerge(cur as Record<string, unknown>, v as Record<string, unknown>)
        : v;
  }
  return out;
}

/** Variables d'environnement → structure de config. Les secrets ne viennent que d'ici (.env). */
export function fromEnv(env: Env): Record<string, unknown> {
  return prune({
    minecraft: { host: env.MC_HOST, port: env.MC_PORT, username: env.MC_USERNAME, version: env.MC_VERSION },
    followPlayer: env.FOLLOW_PLAYER,
    strategy: env.STRATEGY,
    gender: env.BOT_GENDER,
    openrouter: {
      apiKey: env.OPENROUTER_API_KEY,
      modelFast: env.OPENROUTER_MODEL_FAST,
      modelStrong: env.OPENROUTER_MODEL_STRONG,
      dailyBudgetUsd: env.DAILY_BUDGET_USD,
    },
    telemetry: { port: env.TELEMETRY_PORT, capturePath: env.TELEMETRY_CAPTURE },
    voice: { url: env.VOICE_URL, linkPort: env.VOICE_LINK_PORT },
    log: { level: env.LOG_LEVEL, pretty: env.LOG_PRETTY },
    dataDir: env.DATA_DIR,
  });
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/**
 * Charge la configuration : fichier JSON optionnel (réglages fins, jamais de secret),
 * puis variables d'environnement, qui priment.
 */
export function loadConfig(env: Env, configFile?: string): Config {
  let fileValues: Record<string, unknown> = {};
  if (configFile && existsSync(configFile)) {
    fileValues = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>;
    if (JSON.stringify(fileValues).match(/apiKey|api_key/i)) {
      throw new ConfigError(`${configFile} ne doit contenir aucune clé : utilisez .env`);
    }
  }
  const merged = deepMerge(
    { minecraft: {}, openrouter: {}, reconnect: {}, reflexes: {}, actions: {}, telemetry: {}, voice: {}, log: {} },
    deepMerge(fileValues, fromEnv(env)),
  );
  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) throw new ConfigError(`configuration invalide :\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
