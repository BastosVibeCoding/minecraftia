import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Logger } from '../core/logger.js';
import type { Vec3Like } from '../core/types.js';

export interface EasyLlmOptions {
  port: number;
  host?: string;
  /** Si défini, chaque message brut reçu est ajouté à ce fichier JSONL (relevé du protocole). */
  capturePath?: string;
  /** Demi-côté horizontal de la zone de blocs suivie autour du joueur. */
  radius?: number;
  logger: Logger;
}

export type EasyLlmMessage = Record<string, unknown>;

/**
 * Serveur WebSocket auquel le mod Easy LLM (client) se connecte depuis le serveur Minecraft.
 * Reçoit la télémétrie brute et maintient la zone de blocs abonnée centrée sur le joueur suivi.
 */
export class EasyLlmTelemetry {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private boxCenter: Vec3Like | null = null;
  private focus: Vec3Like | null = null;
  received = 0;

  constructor(
    private readonly opts: EasyLlmOptions,
    private readonly onMessage: (msg: EasyLlmMessage) => void,
  ) {}

  get connected(): boolean {
    return this.clients.size > 0;
  }

  start(): void {
    if (this.opts.capturePath) mkdirSync(dirname(this.opts.capturePath), { recursive: true });
    this.wss = new WebSocketServer({ port: this.opts.port, host: this.opts.host ?? '0.0.0.0', maxPayload: 16 * 1024 * 1024 });
    this.wss.on('connection', (ws, req) => {
      this.clients.add(ws);
      this.opts.logger.info({ from: req.socket.remoteAddress }, 'mod Easy LLM connecté');
      this.sendBox(ws);
      ws.on('message', (data) => this.handle(data.toString()));
      ws.on('close', () => {
        this.clients.delete(ws);
        this.opts.logger.warn('mod Easy LLM déconnecté');
      });
      ws.on('error', (err) => this.opts.logger.warn({ err }, 'erreur WebSocket Easy LLM'));
    });
    this.wss.on('error', (err) => this.opts.logger.error({ err }, 'serveur Easy LLM en erreur'));
    this.opts.logger.info({ port: this.opts.port }, 'serveur de télémétrie Easy LLM à l\'écoute');
  }

  stop(): void {
    for (const c of this.clients) c.terminate();
    this.clients.clear();
    this.wss?.close();
    this.wss = null;
  }

  /** Recentre la zone de blocs suivie quand le joueur s'en éloigne. */
  setFocus(pos: Vec3Like): void {
    this.focus = pos;
    const r = this.opts.radius ?? 48;
    if (!this.boxCenter || Math.hypot(pos.x - this.boxCenter.x, pos.z - this.boxCenter.z) > r / 2) {
      for (const c of this.clients) this.sendBox(c);
    }
  }

  private sendBox(ws: WebSocket): void {
    if (!this.focus) return;
    const r = this.opts.radius ?? 48;
    const c = { x: Math.round(this.focus.x), y: Math.round(this.focus.y), z: Math.round(this.focus.z) };
    this.boxCenter = c;
    ws.send(JSON.stringify({ type: 'first_access', min: { x: c.x - r, y: c.y - 32, z: c.z - r }, max: { x: c.x + r, y: c.y + 32, z: c.z + r } }));
  }

  private handle(text: string): void {
    this.received++;
    if (this.opts.capturePath) {
      try {
        appendFileSync(this.opts.capturePath, `${text}\n`);
      } catch (err) {
        this.opts.logger.warn({ err }, 'capture impossible');
      }
    }
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      this.opts.logger.debug('message Easy LLM non JSON ignoré');
      return;
    }
    if (msg && typeof msg === 'object') {
      try {
        this.onMessage(msg as EasyLlmMessage);
      } catch (err) {
        this.opts.logger.warn({ err }, 'traitement d\'un message Easy LLM en erreur');
      }
    }
  }
}
