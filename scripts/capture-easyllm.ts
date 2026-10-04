/**
 * Relevé du protocole Easy LLM : écoute le mod et recopie chaque message brut dans un fichier JSONL.
 * Usage : node dist/scripts/capture-easyllm.js <sortie.jsonl> <x> <y> <z> [durée_s]
 */
import { EasyLlmTelemetry } from '../src/bot/easyLlm.js';
import { createLogger } from '../src/core/logger.js';

const [out, x, y, z, seconds] = process.argv.slice(2);
if (!out || x === undefined || y === undefined || z === undefined) {
  console.error('usage : capture-easyllm <sortie.jsonl> <x> <y> <z> [durée_s]');
  process.exit(1);
}
const logger = createLogger({ level: 'info' });
const counts = new Map<string, number>();
const telemetry = new EasyLlmTelemetry({ port: Number(process.env.TELEMETRY_PORT ?? 7891), capturePath: out, logger }, (msg) => {
  const types = msg.type === 'event_batch' && Array.isArray(msg.items) ? msg.items.map((i) => String((i as Record<string, unknown>).type)) : [String(msg.type)];
  for (const t of types) counts.set(t, (counts.get(t) ?? 0) + 1);
});
telemetry.setFocus({ x: Number(x), y: Number(y), z: Number(z) });
telemetry.start();
setTimeout(() => {
  logger.info({ received: telemetry.received, types: Object.fromEntries(counts) }, 'capture terminée');
  telemetry.stop();
  process.exit(0);
}, Number(seconds ?? 120) * 1000);
