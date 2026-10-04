import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import { BotConnection, type CreateBot } from './bot/connection.js';
import { EasyLlmTelemetry } from './bot/easyLlm.js';
import { EasyLlmMapper } from './bot/easyLlmMapping.js';
import { MineflayerEventSource } from './bot/mineflayerEvents.js';
import { Observer } from './observer/observer.js';
import type { Episode, RawEvent } from './observer/types.js';
import type { BehaviorTree } from './tree/tree.js';
import type { Config } from './config/schema.js';
import { EventBus } from './core/bus.js';
import type { Clock } from './core/clock.js';
import type { BusEvents } from './core/events.js';
import type { Logger } from './core/logger.js';
import { ReflexEngine } from './reflexes/engine.js';
import { MineflayerReflexExecutor } from './reflexes/mineflayerExecutor.js';
import { MineflayerReflexHost } from './reflexes/mineflayerHost.js';
import { ActionController } from './skills/actionController.js';
import { followAction } from './skills/follow.js';

const { pathfinder, Movements } = pathfinderPkg;
const IDLE_CHECK_MS = 1000;
const OBSERVER_TICK_MS = 1000;
const FOLLOW_SLICE_MS = 10000;

/** Session de jeu : tout ce qui vit entre une apparition du bot et sa déconnexion. */
interface Session {
  bot: Bot;
  actions: ActionController;
  reflexes: ReflexEngine;
  events: MineflayerEventSource;
  idleTimer: NodeJS.Timeout;
}

export interface CompanionDeps {
  tree: BehaviorTree;
}

/** Assemble les modules. Une nouvelle session est créée à chaque (re)connexion. */
export class Companion {
  readonly bus: EventBus<BusEvents>;
  private readonly connection: BotConnection;
  private session: Session | null = null;
  readonly observer: Observer;
  private readonly telemetry: EasyLlmTelemetry;
  private readonly mapper: EasyLlmMapper;
  private observerTimer: NodeJS.Timeout | null = null;
  private ingestQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly clock: Clock,
    createBot: CreateBot,
    private readonly deps: CompanionDeps,
  ) {
    this.bus = new EventBus<BusEvents>(logger);
    this.observer = new Observer(config.followPlayer, (e) => this.onEpisode(e), { logger: logger.child({ module: 'observateur' }) });
    this.mapper = new EasyLlmMapper(() => clock.now());
    this.telemetry = new EasyLlmTelemetry(
      { port: config.telemetry.port, capturePath: config.telemetry.capturePath, logger: logger.child({ module: 'easy-llm' }) },
      (msg) => {
        for (const e of this.mapper.map(msg)) this.observe(e);
        const pos = this.mapper.positionOf(config.followPlayer);
        if (pos) this.telemetry.setFocus(pos);
      },
    );
    this.connection = new BotConnection(
      { ...config.minecraft, ...config.reconnect },
      createBot,
      clock,
      logger.child({ module: 'connexion' }),
    );
    this.connection.on('ready', (bot) => this.onReady(bot));
    this.connection.on('lost', (reason) => this.onLost(reason));
  }

  start(): void {
    this.telemetry.start();
    this.observerTimer = setInterval(() => this.observer.tick(this.clock.now()), OBSERVER_TICK_MS);
    this.connection.start();
  }

  stop(): void {
    this.endSession();
    this.connection.stop();
    if (this.observerTimer) clearInterval(this.observerTimer);
    this.observer.flush();
    this.telemetry.stop();
  }

  /** Point d'entrée unique des événements du joueur, quelle que soit leur source. */
  observe(e: RawEvent): void {
    this.observer.push(e);
  }

  /** Les épisodes sont versés dans l'arbre un par un, dans l'ordre (calcul d'embedding asynchrone). */
  private onEpisode(episode: Episode): void {
    this.logger.info({ domain: episode.domain, kind: episode.kind, source: episode.source }, episode.summary);
    this.ingestQueue = this.ingestQueue
      .then(async () => {
        const result = await this.deps.tree.ingest(episode);
        this.bus.emit('episode:observed', { episode, result });
      })
      .catch((err: unknown) => this.logger.error({ err }, "ingestion d'épisode en erreur"));
  }

  private onReady(bot: Bot): void {
    this.endSession();
    try {
      if (!bot.pathfinder) bot.loadPlugin(pathfinder);
      const movements = new Movements(bot);
      movements.canDig = false;
      bot.pathfinder.setMovements(movements);
    } catch (err) {
      this.logger.error({ err }, 'initialisation du pathfinder impossible');
    }

    const actions = new ActionController(
      this.clock,
      () => {
        bot.pathfinder?.setGoal(null);
        bot.clearControlStates();
      },
      (r) => this.bus.emit('action:result', r),
    );
    const reflexes = new ReflexEngine(
      new MineflayerReflexHost(bot, this.config.followPlayer),
      actions,
      new MineflayerReflexExecutor(bot, this.config.followPlayer),
      this.config.reflexes,
      this.clock,
      this.logger.child({ module: 'réflexes' }),
      (e) => this.bus.emit('reflex:triggered', e),
      this.config.reflexes.maxReflexMs,
    );
    reflexes.start();
    bot.on('death', () => {
      this.logger.warn('le bot est mort');
      actions.abort('mort', 'death');
    });

    const events = new MineflayerEventSource(
      bot,
      this.config.followPlayer,
      (e) => this.observe(e),
      () => this.clock.now(),
      () => !this.telemetry.connected,
    );
    events.start();

    const idleTimer = setInterval(() => {
      if (actions.isBusy || actions.blockReason) return;
      void actions.run(followAction(bot, this.config.followPlayer, this.config.actions.followDistance, FOLLOW_SLICE_MS));
    }, IDLE_CHECK_MS);

    this.session = { bot, actions, reflexes, events, idleTimer };
    this.bus.emit('bot:ready', { username: bot.username });
  }

  private onLost(reason: string): void {
    this.endSession();
    this.bus.emit('bot:lost', { reason });
  }

  private endSession(): void {
    const s = this.session;
    if (!s) return;
    this.session = null;
    clearInterval(s.idleTimer);
    s.events.stop();
    s.reflexes.stop();
    s.actions.abort('fin de session');
  }
}
