/**
 * Importe des fichiers JSON dans la base SQLite, sans perte et de façon idempotente.
 * Usage : npm run migrate -- <fichier.json | dossier> [--db data/minecraftia.db] [--embedder transformers|hashing]
 * Format reconnu : voir src/store/legacyImport.ts. Tout autre JSON est conservé brut dans legacy_import.
 */
import 'dotenv/config';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { systemClock } from '../src/core/clock.js';
import { createLogger } from '../src/core/logger.js';
import { createEmbedder } from '../src/store/embedder.js';
import { importJson } from '../src/store/legacyImport.js';
import { Store } from '../src/store/store.js';

function listJson(target: string): string[] {
  const st = statSync(target);
  if (st.isFile()) return [target];
  return readdirSync(target, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.json'))
    .map((e) => join(e.parentPath, e.name))
    .sort();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const opt = (name: string, def: string) => {
    const i = args.indexOf(name);
    if (i < 0) return def;
    const v = args[i + 1] ?? def;
    args.splice(i, 2);
    return v;
  };
  const dbPath = opt('--db', join(process.env.DATA_DIR ?? 'data', 'minecraftia.db'));
  const embedderKind = opt('--embedder', 'transformers') as 'transformers' | 'hashing';
  const target = args[0];
  if (!target) {
    console.error('usage : npm run migrate -- <fichier.json | dossier> [--db chemin] [--embedder transformers|hashing]');
    process.exit(1);
  }
  const logger = createLogger({ level: 'info' });
  const embedder = await createEmbedder(embedderKind, join(process.env.DATA_DIR ?? 'data', 'models'), logger);
  const store = await Store.open(dbPath, embedder, systemClock, { logger });
  let failed = 0;
  for (const file of listJson(resolve(target))) {
    try {
      const report = await importJson(store, file, readFileSync(file, 'utf8'));
      logger.info(report, report.skipped ? 'déjà importé' : 'importé');
    } catch (err) {
      failed++;
      logger.error({ err, file }, 'import en échec');
    }
  }
  store.close();
  process.exit(failed > 0 ? 1 : 0);
}

void main();
