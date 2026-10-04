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
import { applyGuards } from '../src/decider/decider.js';
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
  omni: { baseUrl: process.env.OMNIROUTE_URL ?? 'http://127.0.0.1:20128/v1', key: process.env.OMNIROUTE_API_KEY, timeoutMs: 150_000, extras: false },
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
  console.error('usage : eval-models <modèle> [...]  (préfixes : ollama:, groq:, gemini:, omni: ; sinon OpenRouter)');
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
    ...(await moreScenarios(embedder, builder, fighter, empty)),
  ];
}

/** Épisode construit à la main, pour des mémoires contrôlées. */
function ep(domain: Domain, kind: string, summary: string, situation: string, mechanism: Episode['mechanism'], source: Episode['source'] = 'observed'): Episode {
  return { player: 'Bilboquet86', domain, kind, summary, situation: { text: situation }, mechanism, params: {}, source, startedAt: 0, endedAt: 1 };
}

async function treeOf(embedder: Embedder, episodes: Episode[], times = 3): Promise<BehaviorTree> {
  const store = await Store.open(':memory:', embedder, new ManualClock(0));
  const tree = new BehaviorTree(store, { playTime: () => 0 });
  for (let i = 0; i < times; i++) for (const e of episodes) await tree.ingest(e);
  return tree;
}

/** Douze situations de plus : tous les domaines, ordres variés, manque de matériaux, correction avec alternative. */
async function moreScenarios(embedder: Embedder, builder: BehaviorTree, fighter: BehaviorTree, empty: BehaviorTree): Promise<Scenario[]> {
  const miner = await treeOf(embedder, [
    ep('mine', 'staircase', 'a miné 12 blocs en escalier vers y=12 (4 iron ore)', 'chercher iron ore (sous terre)', { skill: 'collect', targets: ['iron_ore'], pattern: 'staircase', depthY: 12, tool: 'stone_pickaxe', count: 12 }),
  ]);
  const crafter = await treeOf(embedder, [
    ep('craft', 'tools', 'a fabriqué 1 stone pickaxe', 'fabriquer des outils', { skill: 'craft', items: ['stone_pickaxe'], sequence: 'stone_pickaxe', counts: { stone_pickaxe: 1 } }),
  ]);
  const eater = await treeOf(embedder, [ep('survive', 'eat', 'a mangé bread à 6/20 de faim', 'avoir faim', { skill: 'eat', item: 'bread', foodThreshold: 6 })]);
  const explorer = await treeOf(embedder, [ep('explore', 'roam', 'a parcouru 120 blocs à travers forest', 'explorer les environs', { skill: 'explore', radius: 40, biomes: ['forest'] })]);
  const woodBuilder = await treeOf(embedder, [
    ep('build', 'house', 'a construit une maison 5×5×3 en oak planks', 'construire une maison', { skill: 'build', shape: 'house', dims: { width: 5, height: 3, depth: 5 }, material: 'oak_planks' }),
  ]);
  const noBricks = { bot: { health: 20, food: 18, position: { x: 0, y: 64, z: 0 }, dimension: 'overworld', heldItem: null, inventory: { dirt: 3 } } };
  const hungry = { bot: { health: 14, food: 5, position: { x: 0, y: 64, z: 0 }, dimension: 'overworld', heldItem: null, inventory: { bread: 8, stone_bricks: 10 } } };
  const building = { activity: ['build' as Domain], recent: ['a construit un mur 7×4 en stone bricks (symétrique, de bas en haut)'] };
  const json = (v: unknown) => JSON.stringify(v ?? '');
  return [
    { name: 'imiter le minage', tree: miner, world: world({ bot: { health: 20, food: 18, position: { x: 0, y: 40, z: 0 }, dimension: 'overworld', heldItem: null, inventory: { iron_pickaxe: 1, torch: 16, cobblestone: 20 } } }, { activity: ['mine'], recent: ['a miné 12 blocs en escalier vers y=12 (4 iron ore)'] }), autonomy: bands({ mine: 'imitate' }), check: (d) => d.skill === 'collect' && json(d.params.blocks).includes('iron') },
    { name: 'imiter l\'artisanat', tree: crafter, world: world({ bot: { health: 20, food: 18, position: { x: 0, y: 64, z: 0 }, dimension: 'overworld', heldItem: null, inventory: { cobblestone: 12, stick: 6, crafting_table: 1 } } }, { activity: ['craft'], recent: ['a fabriqué 1 stone pickaxe'] }), autonomy: bands({ craft: 'imitate' }), check: (d) => d.skill === 'craft' && json(d.params.item).includes('pickaxe') },
    { name: 'manger quand elle a faim', tree: eater, world: world(hungry), autonomy: bands({ survive: 'imitate' }), check: (d) => d.skill === 'eat' },
    { name: 'explorer (initiative)', tree: explorer, world: world(), autonomy: bands({ explore: 'act' }), check: (d) => d.skill === 'explore' },
    { name: 'ordre : maison en bois', tree: woodBuilder, world: world(), autonomy: bands(), order: 'construis une maison en bois', check: (d) => d.skill === 'build' && d.params.shape === 'house' && json(d.params.material).includes('oak') },
    { name: 'ordre : attaque le squelette', tree: empty, world: world({ threats: [{ name: 'skeleton', distance: 9 }] }), autonomy: bands(), order: 'attaque le squelette', check: (d) => d.skill === 'attack' && json(d.params.targets).includes('skeleton') },
    { name: 'ordre : mange', tree: empty, world: world(hungry), autonomy: bands(), order: 'Alex, mange quelque chose', check: (d) => d.skill === 'eat' },
    { name: 'sans matériaux : pas de mur', tree: builder, world: world(noBricks, building), autonomy: bands({ build: 'imitate' }), check: (d) => !(d.skill === 'build' && d.params.material === 'stone_bricks') },
    { name: 'proposer (construction)', tree: builder, world: world({}, building), autonomy: bands({ build: 'propose' }), check: (d) => d.skill === 'build' && Boolean(d.say) },
    { name: 'combattant face à un mur', tree: fighter, world: world({}, building), autonomy: bands({ combat: 'imitate' }), check: (d) => d.skill !== 'build' },
    { name: 'correction + alternative', tree: builder, world: world({}, building), autonomy: bands({ build: 'imitate' }), order: 'non, construis plutôt en bois', check: (d) => d.skill === 'build' && json(d.params.material).match(/oak|spruce|birch|planks|log/) !== null },
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
  /** Réussites par situation, sur l'ensemble des répétitions. */
  perScenario: Map<string, number>;
  /** Réussites une fois les garde-fous de production appliqués (ce qu'Alex ferait réellement). */
  passProd: number;
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

async function evaluate(model: string, list: Scenario[], repeat: number): Promise<Row> {
  const row: Row = { model, pass: 0, validFirst: 0, validRetry: 0, rateLimited: 0, unanswered: 0, latency: [], tokens: 0, fails: [], perScenario: new Map(list.map((s) => [s.name, 0])), passProd: 0 };
  let client: ReturnType<typeof clientFor>;
  try {
    client = clientFor(model);
  } catch (err) {
    row.unanswered = list.length;
    row.fails.push((err as Error).message);
    return row;
  }
  for (let rep = 0; rep < repeat; rep++) for (const s of list) {
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
    if (decision && s.check(applyGuards(decision, branches, s.autonomy, Boolean(s.order), s.world.bot.inventory), avoidIds)) row.passProd++;
    if (decision && s.check(decision, avoidIds)) {
      row.pass++;
      row.perScenario.set(s.name, (row.perScenario.get(s.name) ?? 0) + 1);
    }
    else if (decision) row.fails.push(`${s.name} : a choisi ${decision.skill} ${JSON.stringify(decision.params).slice(0, 70)}`);
    else row.fails.push(`${s.name} : sortie invalide (${(error ?? '').slice(0, 70)})`);
  }
  return row;
}

const embedder = await createEmbedder('transformers', join(process.env.DATA_DIR ?? 'data', 'models'), logger);
const list = await scenarios(embedder);
const repeat = Math.max(1, Number(process.env.EVAL_REPEAT ?? 1));
const total = list.length * repeat;
const rows: Row[] = [];
for (const model of models) {
  const r = await evaluate(model, list, repeat);
  rows.push(r);
  const lat = r.latency.length ? Math.round(r.latency.reduce((a, b) => a + b, 0) / r.latency.length) : 0;
  // régularité : situations où toutes les répétitions donnent le même verdict
  const steady = [...r.perScenario.values()].filter((n) => n === 0 || n === repeat).length;
  console.log(`
${model}
  réussite ${r.pass}/${total} (${Math.round((100 * r.pass) / total)} %) · en production ${r.passProd}/${total} (${Math.round((100 * r.passProd) / total)} %) · régularité ${steady}/${list.length} · JSON du premier coup ${r.validFirst} (+${r.validRetry}) · sans réponse ${r.unanswered} · saturations ${r.rateLimited} · latence moy. ${lat} ms · ${r.tokens} tokens`);
  const weak = [...r.perScenario.entries()].filter(([, n]) => n < repeat).map(([name, n]) => `${name} ${n}/${repeat}`);
  if (weak.length) console.log(`  situations ratées au moins une fois : ${weak.join(' ; ')}`);
  for (const f of [...new Set(r.fails)].slice(0, 12)) console.log(`  ✗ ${f}`);
}
console.log(`
CLASSEMENT (${list.length} situations × ${repeat})`);
for (const r of [...rows].sort((a, b) => b.passProd - a.passProd || b.pass - a.pass || a.unanswered - b.unanswered)) {
  const lat = r.latency.length ? Math.round(r.latency.reduce((a, b) => a + b, 0) / r.latency.length / 100) / 10 : 0;
  const steady = [...r.perScenario.values()].filter((n) => n === 0 || n === repeat).length;
  console.log(`  prod ${String(Math.round((100 * r.passProd) / total)).padStart(3)} %  brut ${String(Math.round((100 * r.pass) / total)).padStart(3)} %  régularité ${steady}/${list.length}  json ${r.validFirst}  sans-réponse ${r.unanswered}  saturations ${String(r.rateLimited).padStart(2)}  ${String(lat).padStart(5)} s  ${r.model}`);
}
process.exit(0);
