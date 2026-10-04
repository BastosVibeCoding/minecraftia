/**
 * Diagnostic de la chaîne de fournisseurs (LLM_CHAIN) : une vraie décision envoyée à chaque maillon,
 * puis à la chaîne entière. Indique qui répond, en combien de temps, et si la décision est valide.
 * Usage (là où se trouvent les clés) : node dist/scripts/chain-check.js
 */
import 'dotenv/config';
import { createLogger } from '../src/core/logger.js';
import { DOMAINS, type Domain } from '../src/core/types.js';
import { buildChain } from '../src/decider/chain.js';
import { systemPrompt, userPrompt, type Band } from '../src/decider/prompt.js';
import { parseDecision } from '../src/decider/schema.js';

const spec = process.env.LLM_CHAIN;
if (!spec) {
  console.error('LLM_CHAIN absent');
  process.exit(1);
}
const logger = createLogger({ level: 'silent' });
const chain = buildChain(spec, process.env, logger);
if (!chain) {
  console.error('aucun fournisseur utilisable (clés manquantes ?)');
  process.exit(1);
}

const autonomy = Object.fromEntries(DOMAINS.map((d) => [d, { band: (d === 'gather' ? 'imitate' : 'observe') as Band, score: d === 'gather' ? 0.35 : 0.05 }])) as Record<Domain, { band: Band; score: number }>;
const req = {
  purpose: 'decide' as const,
  model: 'chaîne',
  maxTokens: 400,
  system: systemPrompt({ name: 'Alex', gender: 'feminine' }),
  user: userPrompt({
    trigger: 'ordre du joueur',
    order: 'Alex, coupe du bois',
    world: {
      bot: { health: 20, food: 18, position: { x: 0, y: 64, z: 0 }, dimension: 'overworld', heldItem: null, inventory: { iron_axe: 1 } },
      player: { name: 'Bilboquet86', online: true, distance: 3, heldItem: null, activity: [], recent: [] },
      threats: [],
      time: 'jour',
      biome: 'forest',
    },
    autonomy,
    branches: [],
    lastOutcome: null,
  }),
};

for (const entry of chain.entries) {
  const started = Date.now();
  try {
    const res = await entry.client.complete({ ...req, model: entry.model, maxTokens: Math.max(req.maxTokens, entry.maxTokens) });
    const parsed = parseDecision(res.text);
    console.log(`✓ ${entry.name.padEnd(55)} ${String(Date.now() - started).padStart(6)} ms  ${parsed.ok ? `${parsed.decision.skill} ${JSON.stringify(parsed.decision.params)}` : `JSON invalide : ${parsed.error.slice(0, 60)}`}`);
  } catch (err) {
    console.log(`✗ ${entry.name.padEnd(55)} ${String(Date.now() - started).padStart(6)} ms  ${(err as Error).message.slice(0, 90)}`);
  }
}
const started = Date.now();
try {
  const res = await chain.complete(req);
  console.log(`\nchaîne complète : servie par ${res.model} en ${Date.now() - started} ms (coût compté : ${res.costUsd} $)`);
} catch (err) {
  console.log(`\nchaîne complète : échec — ${(err as Error).message}`);
}
process.exit(0);
