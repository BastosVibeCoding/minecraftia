import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import { BotConnection, type CreateBot } from './bot/connection.js';
import { EasyLlmTelemetry } from './bot/easyLlm.js';
import { EasyLlmMapper } from './bot/easyLlmMapping.js';
import { MineflayerEventSource } from './bot/mineflayerEvents.js';
import { Observer } from './observer/observer.js';
import type { Episode, RawEvent } from './observer/types.js';
import type { PlayClock } from './tree/playClock.js';
import type { Autonomy } from './autonomy/autonomy.js';
import type { ProposalBroker } from './autonomy/proposals.js';
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
import { DecisionLoop } from './decider/loop.js';
import type { Decider } from './decider/decider.js';
import type { DecisionCache } from './decider/cache.js';
import type { ModelRouter } from './decider/router.js';
import { readWorld, snapshotOf } from './decider/mineflayerWorld.js';
import { plugin as collectBlockPlugin } from 'mineflayer-collectblock';
import { plugin as pvpPlugin } from 'mineflayer-pvp';

const { pathfinder, Movements } = pathfinderPkg;
const IDLE_CHECK_MS = 1000;
const OBSERVER_TICK_MS = 1000;
const RECENT_EPISODES = 5;
const OWN_BLOCK_MS = 15_000;

/** Session de jeu : tout ce qui vit entre une apparition du bot et sa déconnexion. */
interface Session {
  bot: Bot;
  actions: ActionController;
  reflexes: ReflexEngine;
  events: MineflayerEventSource;
  loop: DecisionLoop;
  idleTimer: NodeJS.Timeout;
  deaths: number;
}

export interface CompanionDeps {
  tree: BehaviorTree;
  playClock: PlayClock;
  decider: Decider;
  cache: DecisionCache;
  router: ModelRouter;
  autonomy: Autonomy;
  proposals: ProposalBroker;
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
  /** Résumés des derniers épisodes du joueur (le plus récent d'abord), pour l'état du monde. */
  private recent: string[] = [];
  /** Blocs modifiés par le bot lui-même (clé « x,y,z » → instant) : jamais attribués au joueur. */
  private ownBlocks = new Map<string, number>();

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
    this.observerTimer = setInterval(() => {
      this.observer.tick(this.clock.now());
      // le temps de jeu actif (décroissance des poids) n'avance que si le joueur suivi est là
      this.deps.playClock.setActive(Boolean(this.session?.bot.players[this.config.followPlayer]));
    }, OBSERVER_TICK_MS);
    this.connection.start();
  }

  stop(): void {
    this.endSession();
    this.connection.stop();
    if (this.observerTimer) clearInterval(this.observerTimer);
    this.deps.playClock.setActive(false);
    this.observer.flush();
    this.telemetry.stop();
  }

  /** Point d'entrée unique des événements du joueur, quelle que soit leur source. */
  observe(e: RawEvent): void {
    if ((e.type === 'block_placed' || e.type === 'block_broken') && this.isOwnBlock(e.pos, e.t)) return;
    this.observer.push(e);
  }

  /** Le bot va modifier ce bloc : on s'en souvient quelques secondes pour ne pas apprendre de soi-même. */
  touchBlock(pos: { x: number; y: number; z: number }): void {
    const now = this.clock.now();
    this.ownBlocks.set(`${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`, now);
    if (this.ownBlocks.size > 2000) for (const [k, t] of this.ownBlocks) if (now - t > OWN_BLOCK_MS) this.ownBlocks.delete(k);
  }

  private isOwnBlock(pos: { x: number; y: number; z: number }, t: number): boolean {
    const at = this.ownBlocks.get(`${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`);
    return at !== undefined && Math.abs(t - at) <= OWN_BLOCK_MS;
  }

  /** Les épisodes sont versés dans l'arbre un par un, dans l'ordre (calcul d'embedding asynchrone). */
  private onEpisode(episode: Episode): void {
    this.logger.info({ domain: episode.domain, kind: episode.kind, source: episode.source }, episode.summary);
    this.ingestQueue = this.ingestQueue
      .then(async () => {
        const result = await this.deps.tree.ingest(episode);
        this.deps.autonomy.observe(episode.domain, episode.source, result.episodeId);
        this.recent = [episode.summary, ...this.recent].slice(0, RECENT_EPISODES);
        this.bus.emit('episode:observed', { episode, result });
        // le joueur vient de faire quelque chose : occasion de décider (imiter, proposer, agir)
        this.session?.loop.request('épisode du joueur');
      })
      .catch((err: unknown) => this.logger.error({ err }, "ingestion d'épisode en erreur"));
  }

  private onReady(bot: Bot): void {
    this.endSession();
    try {
      if (!bot.pathfinder) bot.loadPlugin(pathfinder);
      if (!bot.collectBlock) bot.loadPlugin(collectBlockPlugin);
      if (!bot.pvp) bot.loadPlugin(pvpPlugin);
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
        bot.pvp?.forceStop();
        void bot.collectBlock?.cancelTask().catch(() => undefined);
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
      if (this.session) this.session.deaths++;
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

    const loop = new DecisionLoop({
      decider: this.deps.decider,
      actions,
      tree: this.deps.tree,
      router: this.deps.router,
      skillContext: { bot, followPlayer: this.config.followPlayer, touch: (pos) => this.touchBlock(pos) },
      world: () => readWorld(bot, this.config.followPlayer, this.observer.activity(), this.recent),
      snapshot: () => snapshotOf(bot, this.session?.deaths ?? 0),
      clock: this.clock,
      logger: this.logger.child({ module: 'décideur' }),
      autonomy: this.deps.autonomy,
      proposals: this.deps.proposals,
    });
    const idleTimer = setInterval(() => loop.onIdle(), IDLE_CHECK_MS);

    this.session = { bot, actions, reflexes, events, loop, idleTimer, deaths: 0 };
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
    s.loop.stop();
    s.events.stop();
    s.reflexes.stop();
    s.actions.abort('fin de session');
  }
}
