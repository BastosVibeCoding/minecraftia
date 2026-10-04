import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import { BotConnection, type CreateBot } from './bot/connection.js';
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
const FOLLOW_SLICE_MS = 10000;

/** Session de jeu : tout ce qui vit entre une apparition du bot et sa déconnexion. */
interface Session {
  bot: Bot;
  actions: ActionController;
  reflexes: ReflexEngine;
  idleTimer: NodeJS.Timeout;
}

/** Assemble les modules. Une nouvelle session est créée à chaque (re)connexion. */
export class Companion {
  readonly bus: EventBus<BusEvents>;
  private readonly connection: BotConnection;
  private session: Session | null = null;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly clock: Clock,
    createBot: CreateBot,
  ) {
    this.bus = new EventBus<BusEvents>(logger);
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
    this.connection.start();
  }

  stop(): void {
    this.endSession();
    this.connection.stop();
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

    const idleTimer = setInterval(() => {
      if (actions.isBusy || actions.blockReason) return;
      void actions.run(followAction(bot, this.config.followPlayer, this.config.actions.followDistance, FOLLOW_SLICE_MS));
    }, IDLE_CHECK_MS);

    this.session = { bot, actions, reflexes, idleTimer };
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
    s.reflexes.stop();
    s.actions.abort('fin de session');
  }
}
