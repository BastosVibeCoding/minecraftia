import { z } from 'zod';

const intFromEnv = (def: number) => z.coerce.number().int().positive().default(def);
const numFromEnv = (def: number) => z.coerce.number().nonnegative().default(def);

export const ConfigSchema = z.object({
  minecraft: z.object({
    host: z.string().min(1).default('localhost'),
    port: intFromEnv(25565),
    username: z.string().min(1).max(16).default('Minecraftia'),
    version: z.string().default('1.21'),
  }),
  /** Pseudo du joueur que le bot suit et dont il apprend. */
  followPlayer: z.string().min(1),
  /** mirror : le bot devient comme le joueur. complement : point d'extension, non implémenté. */
  strategy: z.enum(['mirror', 'complement']).default('mirror'),
  openrouter: z.object({
    apiKey: z.string().optional(),
    baseUrl: z.string().url().default('https://openrouter.ai/api/v1'),
    modelFast: z.string().default('anthropic/claude-haiku-4.5'),
    modelStrong: z.string().default('anthropic/claude-sonnet-5.5'),
    dailyBudgetUsd: numFromEnv(1),
  }),
  reconnect: z.object({
    initialDelayMs: intFromEnv(2000),
    maxDelayMs: intFromEnv(60000),
  }),
  reflexes: z.object({
    lowHealth: numFromEnv(8),
    eatBelowFood: numFromEnv(6),
    drowningOxygen: numFromEnv(8),
    dangerousFall: numFromEnv(5),
    threatRadius: numFromEnv(8),
    maxHostiles: intFromEnv(3),
    creeperRadius: numFromEnv(4),
    maxReflexMs: intFromEnv(8000),
  }),
  actions: z.object({
    defaultTimeoutMs: intFromEnv(60000),
    followDistance: numFromEnv(3),
  }),
  log: z.object({
    level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    pretty: z.coerce.boolean().default(false),
  }),
  dataDir: z.string().default('data'),
});

export type Config = z.infer<typeof ConfigSchema>;
