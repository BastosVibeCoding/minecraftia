import { EventEmitter } from 'node:events';
import type { Bot, BotOptions } from 'mineflayer';
import type { Clock } from '../core/clock.js';
import type { Logger } from '../core/logger.js';

export type CreateBot = (options: BotOptions) => Bot;

export interface ConnectionOptions {
  host: string;
  port: number;
  username: string;
  version: string;
  initialDelayMs: number;
  maxDelayMs: number;
  /** Une session plus longue que ceci remet le délai de reconnexion à sa valeur initiale. */
  stableAfterMs?: number;
}

interface ConnectionEvents {
  ready: [Bot];
  lost: [string];
}

/**
 * Connexion au serveur avec reconnexion automatique (délai exponentiel plafonné).
 * Émet `ready` à chaque apparition du bot dans le monde, `lost` à chaque déconnexion.
 */
export class BotConnection extends EventEmitter<ConnectionEvents> {
  private bot: Bot | null = null;
  private delay: number;
  private stopped = true;
  private reconnectTimer: { cancel(): void } | null = null;
  private connectedAt = 0;
  private attempt = 0;

  constructor(
    private readonly opts: ConnectionOptions,
    private readonly createBot: CreateBot,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {
    super();
    this.delay = opts.initialDelayMs;
  }

  get current(): Bot | null {
    return this.bot;
  }

  get nextDelayMs(): number {
    return this.delay;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.reconnectTimer?.cancel();
    this.reconnectTimer = null;
    const bot = this.bot;
    this.bot = null;
    if (bot) {
      try {
        bot.quit('arrêt');
      } catch (err) {
        this.logger.debug({ err }, 'quit en erreur');
      }
    }
  }

  private connect(): void {
    if (this.stopped) return;
    this.attempt++;
    const { host, port, username, version } = this.opts;
    this.logger.info({ host, port, username, attempt: this.attempt }, 'connexion au serveur');
    let bot: Bot;
    try {
      bot = this.createBot({ host, port, username, version, auth: 'offline', hideErrors: true });
    } catch (err) {
      this.logger.error({ err }, 'création du bot impossible');
      this.scheduleReconnect('création impossible');
      return;
    }
    this.bot = bot;
    let ended = false;
    const onEnd = (reason: string) => {
      if (ended || this.bot !== bot) return;
      ended = true;
      this.bot = null;
      bot.removeAllListeners();
      this.logger.warn({ reason }, 'connexion perdue');
      this.emit('lost', reason);
      this.scheduleReconnect(reason);
    };
    bot.once('spawn', () => {
      this.connectedAt = this.clock.now();
      this.attempt = 0;
      this.logger.info('bot apparu dans le monde');
      this.emit('ready', bot);
    });
    bot.on('kicked', (reason) => onEnd(`expulsé : ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`));
    bot.on('end', (reason) => onEnd(`fin : ${reason}`));
    bot.on('error', (err) => {
      this.logger.warn({ err }, 'erreur réseau');
      // mineflayer émet généralement `end` après `error` ; sinon on force la fin
      if (!bot._client?.socket || bot._client.socket.destroyed) onEnd(`erreur : ${err.message}`);
    });
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped) return;
    const stableAfter = this.opts.stableAfterMs ?? 60000;
    if (this.connectedAt && this.clock.now() - this.connectedAt >= stableAfter) this.delay = this.opts.initialDelayMs;
    this.connectedAt = 0;
    const wait = this.delay;
    this.delay = Math.min(this.delay * 2, this.opts.maxDelayMs);
    this.logger.info({ waitMs: wait, reason }, 'reconnexion programmée');
    this.reconnectTimer?.cancel();
    this.reconnectTimer = this.clock.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, wait);
  }
}
