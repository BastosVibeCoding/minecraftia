import { WebSocket } from 'ws';
import type { Logger } from '../core/logger.js';

export interface Transcript {
  speaker: string;
  text: string;
  audioMs: number;
  latencyMs: number;
}

interface Pending {
  resolve: (frames: string[]) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Client du service vocal Python (transcription + synthèse), avec reconnexion automatique.
 * Si le service est absent, le bot continue sans voix (chat seul).
 */
export class VoiceClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private retryMs = 2000;
  private nextId = 1;
  private pending = new Map<string, Pending>();
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly url: string,
    private readonly logger: Logger,
    private readonly onTranscript: (t: Transcript) => void,
  ) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('service vocal arrêté'));
    }
    this.pending.clear();
  }

  /** Paquet Opus entendu (base64), transmis tel quel au service. */
  sendAudio(speaker: string, opusBase64: string, t: number): void {
    if (this.connected) this.ws!.send(JSON.stringify({ type: 'audio', speaker, t, opus: opusBase64 }));
  }

  /** Synthèse : renvoie les trames Opus (base64, 20 ms) prêtes à jouer dans le jeu. */
  synth(text: string, voice?: string, timeoutMs = 15_000): Promise<string[]> {
    if (!this.connected) return Promise.reject(new Error('service vocal indisponible'));
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('synthèse : délai dépassé'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ type: 'tts', id, text, ...(voice ? { voice } : {}) }));
    });
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.url, { maxPayload: 16 * 1024 * 1024 });
    this.ws = ws;
    ws.on('open', () => {
      this.retryMs = 2000;
      this.logger.info({ url: this.url }, 'service vocal connecté');
    });
    ws.on('message', (data) => this.handle(data.toString()));
    ws.on('error', (err) => this.logger.debug({ err: err.message }, 'service vocal : erreur'));
    ws.on('close', () => {
      if (this.ws === ws) this.ws = null;
      if (this.stopped) return;
      this.retryTimer = setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 60_000);
    });
  }

  private handle(text: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.type === 'transcript' && typeof msg.text === 'string' && typeof msg.speaker === 'string') {
      this.onTranscript({ speaker: msg.speaker, text: msg.text, audioMs: Number(msg.audio_ms ?? 0), latencyMs: Number(msg.latency_ms ?? 0) });
    } else if ((msg.type === 'tts_result' || msg.type === 'error') && typeof msg.id === 'string') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.type === 'tts_result' && Array.isArray(msg.frames)) p.resolve(msg.frames as string[]);
      else p.reject(new Error(String(msg.message ?? 'synthèse impossible')));
    }
  }
}
