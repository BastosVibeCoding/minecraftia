import { z } from 'zod';

const intFromEnv = (def: number) => z.coerce.number().int().positive().default(def);
const numFromEnv = (def: number) => z.coerce.number().nonnegative().default(def);

export const ConfigSchema = z.object({
  minecraft: z.object({
    host: z.string().min(1).default('localhost'),
    port: intFromEnv(25565),
    username: z.string().min(1).max(16).default('Alex'),
    version: z.string().default('1.21'),
  }),
  /** Pseudo du joueur que le bot suit et dont il apprend. */
  followPlayer: z.string().min(1),
  /** Noms des autres bots du serveur : une phrase qui leur est adressée ne concerne pas ce bot. */
  peers: z.array(z.string().min(1)).default([]),
  /** Genre grammatical du personnage (sa façon de parler d'elle ou de lui-même). Son nom est `minecraft.username`. */
  gender: z.enum(['feminine', 'masculine']).default('feminine'),
  /**
   * Construire de sa propre initiative. Non par défaut : un bot ne peut pas deviner où le joueur veut
   * ses blocs ; il construit seulement sur demande.
   */
  buildInitiative: z.boolean().default(false),
  /** Rayon de la zone protégée autour de la maison (le bot n'y casse rien), en blocs. */
  homeRadius: z.number().int().min(0).max(128).default(24),
  /** mirror : le bot devient comme le joueur. complement : point d'extension, non implémenté. */
  strategy: z.enum(['mirror', 'complement']).default('mirror'),
  /**
   * Chaîne de fournisseurs « fournisseur:modèle » séparés par des virgules (gemini, groq, openrouter,
   * ollama). Vide : OpenRouter seul avec `openrouter.modelFast` / `modelStrong`.
   */
  llmChain: z.string().optional(),
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
  telemetry: z.object({
    /** Port du serveur WebSocket auquel se connecte le mod Easy LLM. */
    port: intFromEnv(7891),
    /** Fichier JSONL où recopier les messages bruts (relevé du protocole) ; vide = désactivé. */
    capturePath: z.string().optional(),
  }),
  voice: z.object({
    /** Service vocal Python (transcription + synthèse) ; vide = pas de voix. */
    url: z.string().default('ws://voice:8800'),
    /** Port où se connecte le mod Easy LLM Voice pour faire parler le bot dans le jeu. */
    linkPort: intFromEnv(8765),
    /** Voix de synthèse propre au bot (ex. fr-FR-DeniseNeural) ; vide = voix par défaut du service. */
    ttsVoice: z.string().optional(),
  }),
  log: z.object({
    level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    pretty: z.coerce.boolean().default(false),
  }),
  dataDir: z.string().default('data'),
});

export type Config = z.infer<typeof ConfigSchema>;
