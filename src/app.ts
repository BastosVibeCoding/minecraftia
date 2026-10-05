import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import { BotConnection, type CreateBot } from './bot/connection.js';
import { EasyLlmTelemetry } from './bot/easyLlm.js';
import { EasyLlmMapper } from './bot/easyLlmMapping.js';
import { MineflayerEventSource } from './bot/mineflayerEvents.js';
import { installSafeChat } from './bot/chat.js';
import { Observer } from './observer/observer.js';
import type { Episode, RawEvent } from './observer/types.js';
import type { PlayClock } from './tree/playClock.js';
import type { Autonomy } from './autonomy/autonomy.js';
import type { ProposalBroker } from './autonomy/proposals.js';
import { isAddressed, type UtteranceClassifier } from './feedback/classifier.js';
import { FeedbackHandler } from './feedback/feedback.js';
import { chatLines, runCommand } from './commands/commands.js';
import { GapRecorder } from './gaps/gaps.js';
import { companionMovements, installDoorOpener, isCompanionMovements } from './bot/movements.js';
import { isBuildingBlock, PlacedBlocks } from './bot/placedBlocks.js';
import { ResourceMemory } from './bot/resources.js';
import { guessHome, HomeStore } from './bot/home.js';
import { ChestRoles } from './bot/chestRoles.js';
import { playerEntity } from './bot/mineflayerTypes.js';
import { toAction, type SkillContext } from './skills/library.js';
import mcProtocol from 'minecraft-protocol';
import { presenceAction } from './bot/presence.js';

const mcPing = mcProtocol.ping;
import type { Budget } from './decider/budget.js';
import { HeardAudioExtractor } from './voice/audioIn.js';
import { VoiceClient } from './voice/voiceClient.js';
import { VoiceLink } from './voice/voiceLink.js';
import { ChatSpeaker, CompositeSpeaker, VoiceSpeaker, type Speaker } from './tts/speaker.js';
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

const { pathfinder } = pathfinderPkg;
/** Rayon maximal exploré par le pathfinder autour du bot (blocs). */
const PATH_SEARCH_RADIUS = 32;
/** Fréquence de vérification des réglages de déplacement (protection des blocs des joueurs). */
const MOVEMENTS_GUARD_MS = 2000;
const IDLE_CHECK_MS = 1000;
const OBSERVER_TICK_MS = 1000;
const RECENT_EPISODES = 5;
/** Présence du joueur suivi : fréquence de vérification, délai avant de rentrer, déconnexion garantie. */
const PRESENCE_TICK_MS = 20_000;
/** Fréquence des vérifications liées à la maison (proposition, routine du soir). */
const HOME_TICK_MS = 30_000;
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
  classifier: UtteranceClassifier;
  budget: Budget;
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
  readonly feedback: FeedbackHandler;
  readonly gaps: GapRecorder;
  readonly placed: PlacedBlocks;
  readonly resources: ResourceMemory;
  readonly home: HomeStore;
  readonly chestRoles: ChestRoles;
  private homeTimer: NodeJS.Timeout | null = null;
  private presenceTimer: NodeJS.Timeout | null = null;
  /** Déconnecté volontairement en attendant le retour du joueur suivi. */
  private parked = false;
  /** Début de l'absence du joueur suivi (null : présent). */
  private absentSince: number | null = null;
  /** Routine de départ (maison, rangement) en cours. */
  private leaving = false;
  /** Une proposition de maison devinée attend sa réponse. */
  private homeAsked = false;
  /** La routine du soir (rentrer, dormir) a déjà été lancée cette nuit. */
  private nightHandled = false;
  private readonly voiceClient: VoiceClient | null;
  private readonly voiceLink: VoiceLink;
  private readonly heard: HeardAudioExtractor;
  readonly speaker: Speaker;

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
        if (this.voiceClient) for (const p of this.heard.extract(msg)) this.voiceClient.sendAudio(p.speaker, p.opusBase64, p.capturedAtMs);
        for (const e of this.mapper.map(msg)) this.observe(e);
        const pos = this.mapper.positionOf(config.followPlayer);
        if (pos) this.telemetry.setFocus(pos);
      },
    );
    this.placed = new PlacedBlocks(deps.tree.store.db, clock);
    this.resources = new ResourceMemory(deps.tree.store.db, clock);
    this.home = new HomeStore(deps.tree.store.db, clock, config.homeRadius);
    this.chestRoles = new ChestRoles(deps.tree.store.db);
    this.gaps = new GapRecorder(deps.tree.store.db, clock, logger.child({ module: 'manques' }));
    this.heard = new HeardAudioExtractor(config.followPlayer);
    this.voiceClient = config.voice.url
      ? new VoiceClient(config.voice.url, logger.child({ module: 'voix' }), (t) => {
          logger.info({ speaker: t.speaker, audioMs: t.audioMs, latencyMs: t.latencyMs }, `voix entendue : « ${t.text} »`);
          this.hear(t.speaker, t.text, 'voice');
        })
      : null;
    this.voiceLink = new VoiceLink({ port: config.voice.linkPort, playerName: config.minecraft.username, logger: logger.child({ module: 'voix' }) });
    const voiceClient = this.voiceClient;
    const link = this.voiceLink;
    this.speaker = new CompositeSpeaker(
      new ChatSpeaker((text) => this.session?.bot.chat(text)),
      voiceClient
        ? new VoiceSpeaker({
            synth: (text) => voiceClient.synth(text, config.voice.ttsVoice),
            play: (frames) => link.play(frames),
            get available() {
              return voiceClient.connected && link.connected;
            },
          })
        : null,
      logger.child({ module: 'voix' }),
    );
    this.feedback = new FeedbackHandler({
      classifier: deps.classifier,
      tree: deps.tree,
      autonomy: deps.autonomy,
      cache: deps.cache,
      proposals: deps.proposals,
      observer: this.observer,
      store: deps.tree.store,
      clock,
      logger: logger.child({ module: 'retours' }),
      loop: () => this.session?.loop ?? null,
      actions: () => this.session?.actions ?? null,
      lastDecision: () => deps.decider.lastDecision,
      lastDecisionAt: () => this.session?.loop.lastDecisionTime ?? -Infinity,
      say: (text) => void this.speaker.speak(text),
      gaps: this.gaps,
      botName: config.minecraft.username,
      setHomeHere: () => this.setHomeHere(),
      inventory: () => (this.session ? snapshotOf(this.session.bot, 0).inventory : null),
      lastGained: () => this.session?.loop.lastGained() ?? null,
      status: () => (this.session ? { health: this.session.bot.health, food: this.session.bot.food } : null),
      nearbySigns: () => {
        const bot = this.session?.bot;
        if (!bot) return [];
        return bot
          .findBlocks({ matching: (b) => b.name.endsWith('_sign'), maxDistance: 12, count: 12 })
          .map((p) => (bot.blockAt(p) as (ReturnType<Bot['blockAt']> & { getSignText?: () => string[] }) | null)?.getSignText?.().map((t) => (t ?? '').trim()).filter(Boolean).join(' / ') ?? '')
          .filter(Boolean);
      },
      where: () => {
        const bot = this.session?.bot;
        if (!bot?.entity) return null;
        const me = bot.entity.position;
        const player = playerEntity(bot, this.config.followPlayer)?.position;
        return { x: me.x, y: me.y, z: me.z, toPlayer: player ? me.distanceTo(player) : null, toHome: this.home.distance(me) };
      },
      progress: () => ({ current: this.session?.actions.current?.name ?? null, lastOutcome: this.session?.loop.lastResult ?? null }),
    });
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
    this.voiceClient?.start();
    this.voiceLink.start();
    this.observerTimer = setInterval(() => {
      this.observer.tick(this.clock.now());
      // le temps de jeu actif (décroissance des poids) n'avance que si le joueur suivi est là
      this.deps.playClock.setActive(Boolean(this.session?.bot.players[this.config.followPlayer]));
    }, OBSERVER_TICK_MS);
    this.homeTimer = setInterval(() => this.homeTick(), HOME_TICK_MS);
    this.presenceTimer = setInterval(() => void this.presenceTick().catch((err: unknown) => this.logger.error({ err }, 'suivi de présence en erreur')), PRESENCE_TICK_MS);
    // au démarrage, on ne se connecte que si son propre joueur est là ; sinon on l'attend
    void this.followedPlayerOnline().then((online) => {
      if (online) this.connection.start();
      else {
        this.parked = true;
        this.logger.info(`${this.config.followPlayer} n'est pas connecté : j'attends son arrivée`);
      }
    });
  }

  /** Contexte des compétences pour ce bot (le même pour la boucle et la routine de départ). */
  private skillContextFor(bot: Bot): SkillContext {
    return {
      bot,
      followPlayer: this.config.followPlayer,
      touch: (pos) => this.touchBlock(pos),
      isProtected: (b) => this.isProtected(b),
      resources: this.resources,
      chestRoles: this.chestRoles,
      home: () => this.home.get(),
      restoreMovements: () => bot.pathfinder.setMovements(companionMovements(bot, { isProtected: (b) => this.isProtected(b) })),
      speak: (text) => void this.speaker.speak(text),
    };
  }

  /**
   * Joueur suivi absent : au bout d'une minute, rentrer à la maison et ranger ; puis se déconnecter.
   * Déconnexion garantie au bout de cinq minutes d'absence, même si le retour échoue (demande du
   * joueur). Déconnecté, le bot interroge la liste des joueurs du serveur et revient avec son joueur.
   */
  private async presenceTick(): Promise<void> {
    const now = this.clock.now();
    if (this.parked) {
      if (await this.followedPlayerOnline()) {
        this.logger.info(`${this.config.followPlayer} est revenu : reconnexion`);
        this.parked = false;
        this.absentSince = null;
        this.connection.start();
      }
      return;
    }
    const s = this.session;
    if (!s) return;
    if (s.bot.players[this.config.followPlayer]) {
      this.absentSince = null;
      this.leaving = false;
      return;
    }
    this.absentSince ??= now;
    const action = presenceAction(false, this.absentSince, now, this.leaving);
    if (action === 'se déconnecter') return this.park('cinq minutes sans joueur');
    if (action !== 'rentrer') return;
    this.leaving = true;
    this.logger.info(`${this.config.followPlayer} est parti : retour à la maison, rangement, puis déconnexion`);
    s.loop.stop();
    s.actions.abort('joueur déconnecté');
    const ctx = this.skillContextFor(s.bot);
    for (const step of this.home.get() ? ['go_home', 'store'] : []) {
      if (this.session !== s || this.parked) return;
      await s.actions.run(toAction(ctx, step, {})).catch(() => undefined);
    }
    if (this.session === s && !this.parked) this.park('maison et rangement faits');
  }

  /** Se déconnecter jusqu'au retour du joueur suivi. */
  private park(reason: string): void {
    if (this.parked) return;
    this.parked = true;
    this.leaving = false;
    this.logger.info({ reason }, 'déconnexion en attendant le retour du joueur');
    this.endSession();
    this.connection.stop();
  }

  /** Le joueur suivi apparaît-il dans la liste des joueurs du serveur (ping de la liste des serveurs) ? */
  private async followedPlayerOnline(): Promise<boolean> {
    try {
      const status = (await mcPing({ host: this.config.minecraft.host, port: this.config.minecraft.port, version: this.config.minecraft.version })) as { players?: { sample?: { name: string }[] } };
      return (status.players?.sample ?? []).some((p) => p.name === this.config.followPlayer);
    } catch (err) {
      this.logger.debug({ err }, 'ping du serveur impossible');
      return false;
    }
  }

  /** Bloc à ne jamais casser : posé par un joueur, bloc de construction, ou dans la zone de la maison. */
  isProtected(b: { name: string; position: { x: number; y: number; z: number } }): boolean {
    return this.placed.isProtected(b) || this.home.inZone(b.position);
  }

  /** Désigne la maison là où se trouve le joueur suivi (à défaut, le bot). */
  setHomeHere(): string {
    const bot = this.session?.bot;
    if (!bot) return "Je ne suis pas connectée, je ne peux pas noter la maison.";
    const at = playerEntity(bot, this.config.followPlayer)?.position ?? bot.entity.position;
    const h = this.home.set(at);
    this.homeAsked = false;
    return `C'est noté : la maison est ici (${h.x} ${h.y} ${h.z}). Je n'y casserai rien à moins de ${this.home.radius} blocs.`;
  }

  /**
   * Toutes les 30 s : proposer une maison devinée (une fois, si le joueur est sur place), et le soir,
   * quand le joueur est rentré, rentrer aussi et dormir.
   */
  private homeTick(): void {
    const s = this.session;
    if (!s) return;
    const bot = s.bot;
    const player = playerEntity(bot, this.config.followPlayer)?.position;
    if (!this.homeAsked && this.home.mayAsk() && player) {
      const guess = guessHome(this.placed.all().slice(-1500));
      if (guess && Math.hypot(guess.home.x - player.x, guess.home.z - player.z) <= 24) {
        this.homeAsked = true;
        this.feedback.askHome(`On dirait que la maison est ici (${guess.reason}). C'est bien la maison ?`, (yes) => {
          if (yes) {
            const h = this.home.set(guess.home);
            void this.speaker.speak(`D'accord, c'est la maison (${h.x} ${h.y} ${h.z}).`);
          } else this.home.refuseGuess();
          this.homeAsked = false;
        });
      }
    }
    const h = this.home.get();
    const tod = bot.time?.timeOfDay ?? 6000;
    const night = tod >= 12542 && tod <= 23460;
    if (!night) this.nightHandled = false;
    else if (h && player && !this.nightHandled && !s.actions.isBusy && Math.hypot(player.x - h.x, player.z - h.z) <= 32) {
      this.nightHandled = true;
      this.logger.info('le joueur est rentré pour la nuit : retour à la maison et sommeil');
      s.loop.order('rentre à la maison puis dors');
    }
  }

  stop(): void {
    this.endSession();
    this.connection.stop();
    if (this.observerTimer) clearInterval(this.observerTimer);
    if (this.homeTimer) clearInterval(this.homeTimer);
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.deps.playClock.setActive(false);
    this.observer.flush();
    this.telemetry.stop();
    this.voiceClient?.stop();
    this.voiceLink.stop();
  }

  /** Point d'entrée unique des événements du joueur, quelle que soit leur source. */
  observe(e: RawEvent): void {
    if ((e.type === 'block_placed' || e.type === 'block_broken') && this.isOwnBlock(e.pos, e.t)) return;
    // tout bloc posé par un joueur (ou l'autre bot) devient intouchable ; cassé, il sort du registre
    if (e.type === 'block_placed') this.placed.placed(e.pos, e.block, e.player);
    else if (e.type === 'block_broken') {
      // ressource naturelle récoltée par un joueur : on retient l'endroit (pas une construction)
      if (!this.placed.has(e.pos) && !isBuildingBlock(e.block)) this.resources.remember(e.block, e.pos, 'récolté');
      this.placed.broken(e.pos);
    }
    if (e.player === this.config.followPlayer) this.gaps.observe(e);
    this.observer.push(e);
  }

  /** Énoncé du joueur suivi (chat ou voix transcrite). Les commandes `!…` sont traitées à part. */
  hear(player: string, text: string, channel: 'chat' | 'voice'): void {
    if (player !== this.config.followPlayer) return;
    // « Léa, donne ton fer » dit par mon joueur à l'autre bot : ce n'est pas pour moi
    const peer = this.config.peers.find((p) => isAddressed(text, p) && !isAddressed(text, this.config.minecraft.username));
    if (peer) {
      this.logger.info({ peer }, `phrase adressée à ${peer}, ignorée : « ${text} »`);
      return;
    }
    if (text.trim().startsWith('!')) {
      void this.command(text);
      return;
    }
    void this.feedback.handle(player, text, channel).catch((err: unknown) => this.logger.error({ err }, "traitement d'un retour en erreur"));
  }

  /** Commandes d'inspection (`!arbre`, `!autonomie`, `!pourquoi`, `!oublie`, `!budget`, `!aide`). */
  async command(text: string): Promise<void> {
    try {
      const [name, arg = ''] = text.trim().split(/\s+/, 2);
      if (name?.toLowerCase() === '!maison') {
        const h = this.home.get();
        const answer = /^(oublie|efface)$/i.test(arg)
          ? (this.home.clear(), "J'ai oublié la maison.")
          : /^(\?|ou|où)$/i.test(arg)
            ? h ? `La maison est en ${h.x} ${h.y} ${h.z} (zone protégée : ${this.home.radius} blocs).` : "Je ne sais pas encore où est la maison."
            : this.setHomeHere();
        for (const line of chatLines(answer)) this.session?.bot.chat(line);
        return;
      }
      const { tree, autonomy, decider, budget, cache } = this.deps;
      const answer = await runCommand(text, { tree, autonomy, decider, budget, cache, gaps: this.gaps });
      if (answer) for (const line of chatLines(answer)) this.session?.bot.chat(line);
    } catch (err) {
      this.logger.error({ err, text }, 'commande en erreur');
    }
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
    installSafeChat(bot);
    try {
      if (!bot.pathfinder) bot.loadPlugin(pathfinder);
      if (!bot.collectBlock) bot.loadPlugin(collectBlockPlugin);
      if (!bot.pvp) bot.loadPlugin(pvpPlugin);
      const isProtected = (b: { name: string; position: { x: number; y: number; z: number } }) => this.isProtected(b);
      bot.pathfinder.setMovements(companionMovements(bot, { isProtected }));
      installDoorOpener(bot, () => this.clock.now());
      // recherche de chemin bornée : sans limite, un trajet avec droit de creuser vers un bloc enfoui
      // a fait gonfler la mémoire de Léa jusqu'à 4 Go (plantage « heap out of memory »)
      (bot.pathfinder as unknown as { searchRadius: number }).searchRadius = PATH_SEARCH_RADIUS;
      // collectblock et pvp imposent leurs réglages (creuser partout, vitres comprises) : on leur
      // donne les nôtres, protégés ; pvp n'a pas besoin de creuser pour suivre une cible
      bot.collectBlock.movements = companionMovements(bot, { canDig: true, isProtected });
      (bot.pvp as unknown as { movements: unknown }).movements = companionMovements(bot, { isProtected });
      // garde : si un module remplace malgré tout nos réglages, on les remet (et on le note)
      const guard = setInterval(() => {
        const current = (bot.pathfinder as unknown as { movements?: unknown }).movements;
        if (current && !isCompanionMovements(current)) {
          this.logger.warn('réglages de déplacement remplacés par un module : blocs protégés rétablis');
          bot.pathfinder.setMovements(companionMovements(bot, { isProtected }));
        }
      }, MOVEMENTS_GUARD_MS);
      bot.once('end', () => clearInterval(guard));
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
      new MineflayerReflexExecutor(bot, this.config.followPlayer, () => this.home.get()),
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

    bot.on('chat', (username, message) => {
      if (username !== bot.username) this.hear(username, message, 'chat');
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
      skillContext: this.skillContextFor(bot),
      world: () => readWorld(bot, this.config.followPlayer, this.observer.activity(), this.recent),
      snapshot: () => snapshotOf(bot, this.session?.deaths ?? 0),
      clock: this.clock,
      logger: this.logger.child({ module: 'décideur' }),
      autonomy: this.deps.autonomy,
      proposals: this.deps.proposals,
      gaps: this.gaps,
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
