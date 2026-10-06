/**
 * Évaluation de la compréhension vocale : stratégies small seul, small + retranscription précise,
 * small + correction par le modèle de langage, et la combinaison des deux.
 * Entrée : le fichier de la comparaison des modèles (stt_bench.json : phrases de référence et transcriptions).
 * Usage : node dist/scripts/voice-eval.js <stt_bench.json>   (lit LLM_CHAIN et les clés du .env)
 */
import { readFileSync } from 'node:fs';
import { systemClock } from '../src/core/clock.js';
import { createLogger } from '../src/core/logger.js';
import { Budget } from '../src/decider/budget.js';
import { buildChain } from '../src/decider/chain.js';
import { classifyByRules, UtteranceClassifier } from '../src/feedback/classifier.js';
import { answerInventoryQuestion } from '../src/feedback/questions.js';
import { openDatabase } from '../src/store/db.js';

type Bench = Record<string, { latence_moy_s: number; exemples: [string, string][] }>;

const words = (t: string) =>
  t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

function wer(ref: string, hyp: string): number {
  const r = words(ref);
  const h = words(hyp);
  const d = Array.from({ length: r.length + 1 }, (_, i) => Array.from({ length: h.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (r[i - 1] === h[j - 1] ? 0 : 1));
  return d[r.length]![h.length]! / Math.max(1, r.length);
}

const KEYWORDS = ['jambieres', 'casque', 'buches', 'bouleau', 'diamant', 'grotte', 'fer', 'coffre', 'mur', 'trie', 'coffres', 'zombie', 'charbon', 'lingots', 'maison', 'graines', 'betterave', 'pioche', 'vitres'];

/** Le bot « comprend » la phrase : ordre, correction, enseignement ou question reconnus par les règles. */
function understood(text: string): boolean {
  const bot = /\blea\b/i.test(words(text).join(' ')) ? 'Lea' : 'Alex';
  return classifyByRules(text, bot).label !== 'chatter' || answerInventoryQuestion(text, {}) !== null;
}

async function main(): Promise<void> {
  const bench = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as Bench;
  const small = bench.small!;
  const turbo = bench['large-v3-turbo']!;
  const logger = createLogger({ level: 'warn' });
  const chain = buildChain(process.env.LLM_CHAIN ?? '', process.env, logger);
  if (!chain) throw new Error('LLM_CHAIN absent');
  const { db } = openDatabase(':memory:');
  const classifier = new UtteranceClassifier(chain, new Budget(db, systemClock, 1), 'fast', 'Alex', 'feminine');

  type Row = { strategy: string; wer: number; keys: number; understood: boolean; latency: number };
  const rows: Row[] = [];
  let corrLat = 0;
  let corrCalls = 0;
  for (let i = 0; i < small.exemples.length; i++) {
    const [ref, s] = small.exemples[i]!;
    const t = turbo.exemples[i]![1];
    const keyScore = (hyp: string) => {
      const ks = KEYWORDS.filter((k) => words(ref).includes(k));
      return ks.length ? ks.filter((k) => words(hyp).includes(k)).length / ks.length : 1;
    };
    const push = (strategy: string, hyp: string, latency: number) => rows.push({ strategy, wer: wer(ref, hyp), keys: keyScore(hyp), understood: understood(hyp), latency });
    const ok = understood(s);
    push('1. small seul', s, small.latence_moy_s);
    push('2. small, turbo si incompris', ok ? s : t, small.latence_moy_s + (ok ? 0 : turbo.latence_moy_s));
    let corrected = s;
    let extra = 0;
    if (!ok) {
      const t0 = Date.now();
      corrected = (await classifier.correctTranscript(s)) ?? s;
      extra = (Date.now() - t0) / 1000;
      corrLat += extra;
      corrCalls++;
    }
    push('3. small, correction si incompris', corrected, small.latence_moy_s + extra);
    let combo = s;
    let comboLat = small.latence_moy_s;
    if (!ok) {
      combo = t;
      comboLat += turbo.latence_moy_s;
      if (!understood(t)) {
        const t0 = Date.now();
        combo = (await classifier.correctTranscript(t)) ?? t;
        comboLat += (Date.now() - t0) / 1000;
      }
    }
    push('4. combinaison (turbo puis correction)', combo, comboLat);
    push('(référence) turbo seul', t, turbo.latence_moy_s);
  }
  const strategies = [...new Set(rows.map((r) => r.strategy))];
  console.log(`phrases : ${small.exemples.length} ; incomprises par small : ${corrCalls} ; correction : ${corrCalls ? (corrLat / corrCalls).toFixed(2) : '-'} s en moyenne`);
  for (const s of strategies) {
    const rs = rows.filter((r) => r.strategy === s);
    const avg = (f: (r: Row) => number) => rs.reduce((a, r) => a + f(r), 0) / rs.length;
    console.log(
      `${s.padEnd(40)} erreurs ${(100 * avg((r) => r.wer)).toFixed(1)} %  mots-clés ${(100 * avg((r) => r.keys)).toFixed(1)} %  comprises ${(100 * avg((r) => (r.understood ? 1 : 0))).toFixed(0)} %  délai moyen ${avg((r) => r.latency).toFixed(2)} s`,
    );
  }
}

void main();
