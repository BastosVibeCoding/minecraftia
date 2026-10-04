/**
 * Simule une heure de jeu (joueur bâtisseur, combattant, puis mixte) et affiche décisions, appels
 * LLM, tokens et coût estimé au tarif de Haiku 4.5, comparés au budget quotidien.
 * Usage : npm run sim:hour [-- <minutes> <budget_usd>]
 */
import { createLogger } from '../src/core/logger.js';
import type { RawEvent } from '../src/observer/types.js';
import { simulateSession } from '../src/sim/hour.js';
import { builderLog, fighterLog } from '../src/sim/players.js';

const minutes = Number(process.argv[2] ?? 60);
const budget = Number(process.argv[3] ?? 1);
const logger = createLogger({ level: 'silent' });

function mixed(): RawEvent[] {
  // alterne des blocs de 10 minutes de construction et de combat, comme un joueur polyvalent
  const out: RawEvent[] = [];
  const b = builderLog(minutes, 21, 'Joueur');
  const f = fighterLog(minutes, 22, 'Joueur');
  const block = 10 * 60_000;
  const t0 = 1_000_000;
  for (const e of b) if (Math.floor((e.t - t0) / block) % 2 === 0) out.push(e);
  for (const e of f) if (Math.floor((e.t - t0) / block) % 2 === 1) out.push(e);
  return out;
}

const scenarios: [string, RawEvent[], string][] = [
  ['bâtisseur', builderLog(minutes), 'Batisseur'],
  ['combattant', fighterLog(minutes), 'Combattant'],
  ['mixte', mixed(), 'Joueur'],
];

let worst = 0;
for (const [name, log, player] of scenarios) {
  const r = await simulateSession({ log, player, dailyBudgetUsd: budget, logger });
  worst = Math.max(worst, r.costUsd);
  const bands = Object.entries(r.autonomy)
    .filter(([, a]) => a.score > 0)
    .map(([d, a]) => `${d} ${Math.round(a.score * 100)}% ${a.band}`)
    .join(', ');
  console.log(
    `${name.padEnd(11)} ${r.minutes} min · ${r.episodes} épisodes · ${r.decisions} décisions (LLM ${r.bySource.llm}, cache ${r.bySource.cache}, repli ${r.bySource.fallback}) · ` +
      `${r.promptTokens + r.completionTokens} tokens · ${r.costUsd.toFixed(4)} $ · autonomie : ${bands}`,
  );
}
console.log(`pire scénario : ${worst.toFixed(4)} $ pour ${minutes} min, budget quotidien ${budget.toFixed(2)} $ → ${worst < budget ? 'SOUS le budget' : 'AU-DESSUS du budget'}`);
process.exit(worst < budget ? 0 : 1);
