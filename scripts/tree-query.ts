/**
 * Interroge l'arbre appris : profil par domaine, vue d'ensemble, branches pertinentes pour un texte.
 * Usage : node dist/scripts/tree-query.js ["description d'une situation"] [--db chemin]
 */
import 'dotenv/config';
import { join } from 'node:path';
import { systemClock } from '../src/core/clock.js';
import { createEmbedder } from '../src/store/embedder.js';
import { Store } from '../src/store/store.js';
import { PlayClock } from '../src/tree/playClock.js';
import { BehaviorTree } from '../src/tree/tree.js';

const args = process.argv.slice(2);
const dbIdx = args.indexOf('--db');
const dataDir = process.env.DATA_DIR ?? 'data';
const dbPath = dbIdx >= 0 ? args.splice(dbIdx, 2)[1]! : join(dataDir, 'minecraftia.db');
const text = args.join(' ');

const embedder = await createEmbedder('transformers', join(dataDir, 'models'));
const store = await Store.open(dbPath, embedder, systemClock);
const play = new PlayClock(store.db, systemClock);
const tree = new BehaviorTree(store, { playTime: () => play.now() });
console.log('temps de jeu actif :', Math.round(play.now() / 60000), 'min');
console.log('profil :', tree.profile());
console.log('vue d\'ensemble :');
for (const o of tree.overview(10)) console.log(`  [${o.domain}] ${o.situation} (poids ${o.weight}) → ${o.best ?? '—'}`);
if (text) {
  console.log(`branches pour « ${text} » :`);
  for (const b of await tree.search(text)) {
    console.log(`  [${b.domain}] ${b.situation} sim=${b.similarity} poids=${b.weight}`);
    for (const m of b.mechanisms) console.log(`     ✓ ${m.label} (poids ${m.weight})`);
    for (const a of b.avoid) console.log(`     ✗ à éviter : ${a.label}`);
  }
}
store.close();
