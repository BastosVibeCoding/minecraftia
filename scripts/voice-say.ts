/**
 * Fait parler un joueur dans le jeu par Simple Voice Chat (via Easy LLM Voice) : outil d'essai réel
 * de la chaîne voix (le bot doit entendre, transcrire, comprendre).
 * Prérequis : un point d'accès Easy LLM Voice pour ce joueur, pointant vers ce port.
 * Usage (dans le conteneur du bot) : node dist/scripts/voice-say.js <port> <joueur> "<phrase>"
 */
import { createLogger } from '../src/core/logger.js';
import { VoiceClient } from '../src/voice/voiceClient.js';
import { VoiceLink } from '../src/voice/voiceLink.js';

const [port, player, ...words] = process.argv.slice(2);
const text = words.join(' ');
if (!port || !player || !text) {
  console.error('usage : voice-say <port> <joueur> "<phrase>"');
  process.exit(1);
}
const logger = createLogger({ level: 'info' });
const link = new VoiceLink({ port: Number(port), playerName: player, agentId: `essai-${player}`, logger });
const voice = new VoiceClient(process.env.VOICE_URL ?? 'ws://voice:8800', logger, () => {});
link.start();
voice.start();
const deadline = Date.now() + 60_000;
while ((!link.connected || !voice.connected) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
if (!link.connected || !voice.connected) {
  logger.error({ mod: link.connected, service: voice.connected }, 'connexions incomplètes');
  process.exit(1);
}
const frames = await voice.synth(text);
logger.info({ frames: frames.length }, `${player} dit : « ${text} »`);
await link.play(frames);
await new Promise((r) => setTimeout(r, 1500));
link.stop();
voice.stop();
process.exit(0);
