/**
 * Banc d'essai des modèles pour le décideur d'Alex : mêmes prompts qu'en production, situations
 * représentatives, vérification du JSON et du choix. Sert à comparer des modèles gratuits à Haiku.
 * Usage (là où se trouve OPENROUTER_API_KEY) :
 *   node dist/scripts/eval-models.js <modèle> [<modèle> ...]
 * Préfixe « ollama: » (ex. ollama:qwen2.5:7b-instruct) : modèle local servi par Ollama (OLLAMA_URL).
 */
import 'dotenv/config';
import { join } from 'node:path';
import { ManualClock } from '../src/core/clock.js';
import { createLogger } from '../src/core/logger.js';
import { DOMAINS, type Domain } from '../src/core/types.js';
import { OpenRouterClient, type LlmError } from '../src/decider/llm.js';
import { systemPrompt, userPrompt, type Band, type DecisionContext } from '../src/decider/prompt.js';
import { parseDecision, type Decision } from '../src/decider/schema.js';
import { describeSituation, type WorldState } from '../src/decider/world.js';
import { Observer } from '../src/observer/observer.js';
import type { Episode, RawEvent } from '../src/observer/types.js';
import { builderLog, fighterLog } from '../src/sim/players.js';
import { createEmbedder, type Embedder } from '../src/store/embedder.js';
import { Store } from '../src/store/store.js';
import { BehaviorTree } from '../src/tree/tree.js';

const models = process.argv.slice(2);
/**
 * Fournisseurs (tous au format « chat completions ») : préfixe du nom de modèle → client.
 * Sans préfixe : OpenRouter. Les clés viennent de l'environnement, jamais des arguments.
 */
const PROVIDERS: Record<string, { baseUrl: string; key: string | undefined; timeoutMs: number; extras: boolean }> = {
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', key: process.env.OPENROUTER_API_KEY, timeoutMs: 90_000, extras: true },
  ollama: { baseUrl: process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434/v1', key: 'ollama', timeoutMs: 300_000, extras: false },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', key: process.env.GROQ_API_KEY, timeoutMs: 60_000, extras: false },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', key: process.env.GEMINI_API_KEY, timeoutMs: 60_000, extras: false },
};

function clientFor(model: string): { llm: OpenRouterClient; id: string; provider: string } {
  const prefix = model.split(':')[0]!;
  const provider = prefix in PROVIDERS && prefix !== 'openrouter' ? prefix : 'openrouter';
  const id = provider === 'openrouter' ? model : model.slice(provider.length + 1);
  const p = PROVIDERS[provider]!;
  if (!p.key) throw new Error(`clé manquante pour ${provider} (variable d'environnement)`);
  return { llm: new OpenRouterClient({ apiKey: p.key, baseUrl: p.baseUrl, timeoutMs: p.timeoutMs, openRouterExtras: p.extras }), id, provider };
}

if (models.length === 0) {
  console.error('usage : eval-models <modèle> [...]  (préfixes : ollama:, groq:, gemini: ; sinon OpenRouter)');
  process.exit(1);
}
const logger = createLogger({ level: 'silent' });
const persona = { name: 'Alex', gender: 'feminine' as const };

async function learn(embedder: Embedder, log: RawEvent[], player: string): Promise<BehaviorTree> {
  const store = await Store.open(':memory:', embedder, new ManualClock(0));
  const tree = new BehaviorTree(store, { playTime: () => 0 });
  const episodes: Episode[] = [];
  const obs = new Observer(player, (e) => episodes.push(e));
  for (const e of log) obs.push(e);
  obs.flush();
  for (const ep of episodes) await tree.ingest(ep);
  return tree;
}

const bands = (over: Partial<Record<Domain, Band>> = {}, base: Band = 'observe') =>
  Object.fromEntries(DOMAINS.map((d) => [d, { band: over[d] ?? base, score: over[d] === 'act' ? 0.8 : over[d] === 'propose' ? 0.6 : over[d] === 'imitate' ? 0.35 : 0.1 }])) as Record<Domain, { band: Band; score: number }>;

const world = (over: Partial<WorldState> = {}, player: Partial<WorldState['player']> = {}): WorldState => ({
  bot: { health: 20, food: 18, position: { x: 0, y: 64, z: 0 }, dimension: 'overworld', heldItem: null, inventory: { stone_bricks: 64, oak_planks: 32, iron_sword: 1, shield: 1 } },
  player: { name: 'Bilboquet86', online: true, distance: 3, heldItem: null, activity: [], recent: [], ...player },
  threats: [],
  time: 'jour',
  biome: 'plains',
  ...over,
});

interface Scenario {
  name: string;
  tree: BehaviorTree;
  world: WorldState;
  autonomy: Record<Domain, { band: Band; score: number }>;
  order?: string;
  check: (d: Decision, avoidIds: number[]) => boolean;
}

async function scenarios(embedder: Embedder): Promise<Scenario[]> {
  const builder = await learn(embedder, builderLog(60), 'Batisseur');
  const fighter = await learn(embedder, fighterLog(60), 'Combattant');
  const corrected = await learn(embedder, builderLog(60), 'Batisseur');
  const [wallBranch] = await corrected.search('construire un mur', { domain: 'build' });
  const wall = wallBranch?.mechanisms.find((m) => m.mechanism?.shape === 'wall');
  if (wall) corrected.correct(wall.id);
  const empty = await learn(embedder, [], 'Personne');
  const building = { activity: ['build' as Domain], recent: ['a construit un mur 7×4 en stone bricks (symétrique, de bas en haut)'] };
  const zombie = { threats: [{ name: 'zombie', distance: 6 }] };
  return [
    { name: 'imiter un mur', tree: builder, world: world({}, building), autonomy: bands({ build: 'imitate' }), check: (d) => d.skill === 'build' && d.params.material === 'stone_bricks' },
    { name: 'se défendre (appris)', tree: fighter, world: world(zombie), autonomy: bands({ combat: 'imitate' }), check: (d) => d.skill === 'attack' && JSON.stringify(d.params.targets).includes('zombie') },
    { name: 'pas de combat non appris', tree: builder, world: world(zombie), autonomy: bands({ build: 'imitate' }), check: (d) => d.skill !== 'attack' },
    { name: 'éviter le corrigé', tree: corrected, world: world({}, building), autonomy: bands({ build: 'imitate' }), check: (d) => !(d.skill === 'build' && d.params.shape === 'wall' && d.params.material === 'stone_bricks') },
    { name: 'ordre : coupe du bois', tree: empty, world: world(), autonomy: bands(), order: 'Alex, coupe du bois', check: (d) => d.skill === 'collect' && JSON.stringify(d.params.blocks).includes('_log') },
    { name: 'ordre : suis-moi', tree: empty, world: world(), autonomy: bands(), order: 'suis-moi', check: (d) => d.skill === 'follow' },
    { name: 'proposer (combat)', tree: fighter, world: world(zombie), autonomy: bands({ combat: 'propose' }), check: (d) => d.skill === 'attack' && Boolean(d.say) },
    { name: 'initiative (agir seule)', tree: builder, world: world({}, { recent: [] }), autonomy: bands({ build: 'act' }), check: (d) => d.skill === 'build' },
  ];
}

interface Row {
  model: string;
  pass: number;
  validFirst: number;
  validRetry: number;
  /** Refus pour saturation (429) rencontrés, même si une nouvelle tentative a fini par passer. */
  rateLimited: number;
  /** Situations restées sans réponse (indisponible, erreur, délai). */
  unanswered: number;
  latency: number[];
  tokens: number;
  fails: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Un appel, avec patience face à la saturation des offres gratuites (jusqu'à 3 attentes croissantes). */
async function callWithPatience(llm: OpenRouterClient, req: Parameters<OpenRouterClient['complete']>[0], row: Row) {
  for (let wait = 0; ; wait++) {
    try {
      return await llm.complete(req);
    } catch (err) {
      const e = err as LlmError;
      if (e.status === 429 && wait < 3) {
        row.rateLimited++;
        await sleep(15_000 * (wait + 1));
        continue;
      }
      throw err;
    }
  }
}

async function evaluate(model: string, list: Scenario[]): Promise<Row> {
  const row: Row = { model, pass: 0, validFirst: 0, validRetry: 0, rateLimited: 0, unanswered: 0, latency: [], tokens: 0, fails: [] };
  let client: ReturnType<typeof clientFor>;
  try {
    client = clientFor(model);
  } catch (err) {
    row.unanswered = list.length;
    row.fails.push((err as Error).message);
    return row;
  }
  for (const s of list) {
    const text = describeSituation(s.world, s.order);
    const branches = (await s.tree.search(text, { k: 6 })).filter((b) => b.mechanisms.length > 0 || b.avoid.length > 0);
    const ctx: DecisionContext = { trigger: s.order ? 'ordre du joueur' : 'épisode du joueur', world: s.world, autonomy: s.autonomy, branches, lastOutcome: null, ...(s.order ? { order: s.order } : {}) };
    let error: string | undefined;
    let decision: Decision | null = null;
    let hardError: string | null = null;
    for (let attempt = 0; attempt < 2 && !decision && !hardError; attempt++) {
      try {
        // 2 000 tokens : laisse aux modèles « qui réfléchissent » la place de répondre après leur raisonnement
        const res = await callWithPatience(client.llm, { purpose: 'decide', model: client.id, system: systemPrompt(persona), user: userPrompt(ctx, error), maxTokens: 2000 }, row);
        row.latency.push(res.latencyMs);
        row.tokens += res.promptTokens + res.completionTokens;
        const parsed = parseDecision(res.text);
        if (parsed.ok) {
          decision = parsed.decision;
          if (attempt === 0) row.validFirst++;
          else row.validRetry++;
        } else error = parsed.error;
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes('sans contenu')) error = 'réponse vide';
        else hardError = msg;
      }
      await sleep(1500);
    }
    if (hardError) {
      row.unanswered++;
      row.fails.push(`${s.name} : ${hardError.slice(0, 90)}`);
      continue;
    }
    const avoidIds = branches.flatMap((b) => b.avoid.map((a) => a.id));
    if (decision && s.check(decision, avoidIds)) row.pass++;
    else if (decision) row.fails.push(`${s.name} : a choisi ${decision.skill} ${JSON.stringify(decision.params).slice(0, 70)}`);
    else row.fails.push(`${s.name} : sortie invalide (${(error ?? '').slice(0, 70)})`);
  }
  return row;
}

const embedder = await createEmbedder('transformers', join(process.env.DATA_DIR ?? 'data', 'models'), logger);
const list = await scenarios(embedder);
const rows: Row[] = [];
for (const model of models) {
  const r = await evaluate(model, list);
  rows.push(r);
  const lat = r.latency.length ? Math.round(r.latency.reduce((a, b) => a + b, 0) / r.latency.length) : 0;
  console.log(`\n${model}\n  réussite ${r.pass}/${list.length} · JSON valide du premier coup ${r.validFirst} (+${r.validRetry} après correction) · sans réponse ${r.unanswered} · saturations ${r.rateLimited} · latence moy. ${lat} ms · ${r.tokens} tokens`);
  for (const f of r.fails) console.log(`  ✗ ${f}`);
}
console.log('\nCLASSEMENT (réussite, puis JSON du premier coup, puis disponibilité)');
for (const r of [...rows].sort((a, b) => b.pass - a.pass || b.validFirst - a.validFirst || a.unanswered - b.unanswered)) {
  const lat = r.latency.length ? Math.round(r.latency.reduce((a, b) => a + b, 0) / r.latency.length / 100) / 10 : 0;
  console.log(`  ${String(r.pass).padStart(2)}/${list.length}  json ${r.validFirst}  sans-réponse ${r.unanswered}  saturations ${String(r.rateLimited).padStart(2)}  ${String(lat).padStart(5)} s  ${r.model}`);
}
process.exit(0);
