import { WebSocketServer, type WebSocket } from 'ws';
import type { Logger } from '../core/logger.js';

export interface VoiceLinkOptions {
  port: number;
  playerName: string;
  agentId?: string;
  logger: Logger;
}

/**
 * Canal de sortie vers le mod Easy LLM Voice (client WebSocket) : la voix du bot est jouée dans le
 * jeu par Simple Voice Chat, depuis sa position. Protocole : `setup` à la connexion, puis
 * `voice_frame` toutes les 20 ms, `voice_stop` en fin de phrase, `interrupt` pour couper.
 */
export class VoiceLink {
  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private playing: { cancelled: boolean } | null = null;

  constructor(private readonly opts: VoiceLinkOptions) {}

  get connected(): boolean {
    return this.client !== null && this.client.readyState === this.client.OPEN;
  }

  start(): void {
    this.wss = new WebSocketServer({ port: this.opts.port, host: '0.0.0.0' });
    this.wss.on('connection', (ws) => {
      this.client?.close();
      this.client = ws;
      ws.send(
        JSON.stringify({
          type: 'setup',
          agent_id: this.opts.agentId ?? 'minecraftia',
          player_name: this.opts.playerName,
          audio_codec: 'opus',
          sample_rate: 48000,
          channels: 1,
          frame_millis: 20,
        }),
      );
      this.opts.logger.info('mod Easy LLM Voice connecté : le bot peut parler dans le jeu');
      ws.on('close', () => {
        if (this.client === ws) this.client = null;
      });
      ws.on('error', (err) => this.opts.logger.debug({ err: err.message }, 'canal voix : erreur'));
    });
    this.wss.on('error', (err) => this.opts.logger.error({ err }, 'canal voix en erreur'));
  }

  stop(): void {
    this.interrupt();
    this.client?.close();
    this.wss?.close();
  }

  /** Coupe la phrase en cours. */
  interrupt(): void {
    if (this.playing) this.playing.cancelled = true;
    if (this.connected) this.client!.send(JSON.stringify({ type: 'interrupt' }));
  }

  /** Joue des trames Opus (base64) au rythme réel ; une nouvelle phrase coupe la précédente. */
  async play(frames: string[], frameMs = 20): Promise<void> {
    if (!this.connected) throw new Error('mod Easy LLM Voice non connecté');
    if (this.playing) this.interrupt();
    const state = { cancelled: false };
    this.playing = state;
    let seq = 0;
    const start = Date.now();
    for (const frame of frames) {
      if (state.cancelled || !this.connected) break;
      this.client!.send(JSON.stringify({ type: 'voice_frame', sequence: seq, opus_data_base64: frame, whispering: false }));
      seq++;
      const wait = start + seq * frameMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    if (this.connected) this.client!.send(JSON.stringify({ type: 'voice_stop', last_sequence: Math.max(0, seq - 1) }));
    if (this.playing === state) this.playing = null;
  }
}
