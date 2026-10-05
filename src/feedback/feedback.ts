import type { Autonomy } from '../autonomy/autonomy.js';
import type { ProposalBroker } from '../autonomy/proposals.js';
import type { Clock } from '../core/clock.js';
import type { Logger } from '../core/logger.js';
import type { DecisionCache } from '../decider/cache.js';
import type { DecisionRecord } from '../decider/decider.js';
import type { DecisionLoop } from '../decider/loop.js';
import type { Observer } from '../observer/observer.js';
import type { ActionController } from '../skills/actionController.js';
import type { Store } from '../store/store.js';
import type { BehaviorTree } from '../tree/tree.js';
import type { GapRecorder } from '../gaps/gaps.js';
import { isAddressed, withoutVocative, type Classification, type UtteranceClassifier } from './classifier.js';
import { answerInventoryQuestion, answerProgressQuestion, answerStatusQuestion, isBareGive, mentionedItems, mentionsAnItem } from './questions.js';
import { clarifyingQuestion } from './clarify.js';

export interface FeedbackDeps {
  classifier: UtteranceClassifier;
  tree: BehaviorTree;
  autonomy: Autonomy;
  cache: DecisionCache;
  proposals: ProposalBroker;
  observer: Observer;
  store: Store;
  clock: Clock;
  logger: Logger;
  loop: () => DecisionLoop | null;
  actions: () => ActionController | null;
  lastDecision: () => DecisionRecord | null;
  lastDecisionAt: () => number;
  say: (text: string) => void;
  teachWindowMs?: number;
  /** Phrases adressées au bot mais non comprises → manques. */
  gaps?: GapRecorder;
  botName?: string;
  /** Inventaire actuel du bot, pour répondre aux questions (« t'as du bois ? »). */
  inventory?: () => Record<string, number> | null;
  /** Dernier objet récolté par le bot (pour « donne » tout court). */
  lastGained?: () => { item: string; at: number } | null;
  /** Vie et faim du bot, pour « t'as faim ? », « ça va ? ». */
  status?: () => { health: number; food: number } | null;
  /** Action en cours et résultat de la dernière, pour « t'as fini ? ». */
  progress?: () => { current: string | null; lastOutcome: string | null };
}

/** Au-delà, un « bien » ou un « non » ne vise plus la dernière décision. */
const FEEDBACK_WINDOW_MS = 120_000;
/** Intervalle minimal entre deux réponses de conversation (pas de bavardage en rafale). */
const CHAT_INTERVAL_MS = 15_000;
/** Délai pour répondre à « je mine quoi ? » ; ensuite la question est oubliée. */
const CLARIFY_WINDOW_MS = 60_000;

/**
 * Retours du joueur (chat ou voix) → effets sur l'arbre, l'autonomie et la boucle.
 * Une correction pèse plus que tout et s'applique immédiatement : l'action en cours est coupée,
 * le mécanisme pénalisé, le cache du domaine vidé, et une nouvelle décision est demandée.
 */
export class FeedbackHandler {
  /** Ordre vague en attente de précision (« va miner » → « je mine quoi ? »). */
  private pendingOrder: { text: string; until: number } | null = null;
  private lastChatAt = -Infinity;
  /** Dernière phrase qui parlait d'un objet (« t'as combien de fer ? »). */
  private lastMention: { text: string; at: number } | null = null;

  constructor(private readonly deps: FeedbackDeps) {}

  /** Objet visé par un « donne » sans précision : évoqué ou récolté en dernier, s'il est dans l'inventaire. */
  private lastItem(inv: Record<string, number>): string | null {
    const mention = this.lastMention ? { item: mentionedItems(this.lastMention.text, inv)[0], at: this.lastMention.at } : null;
    const gained = this.deps.lastGained?.() ?? null;
    const candidates = [mention, gained && (inv[gained.item] ?? 0) > 0 ? gained : null].filter((c): c is { item: string; at: number } => Boolean(c?.item));
    candidates.sort((a, b) => b.at - a.at);
    return candidates[0]?.item ?? null;
  }

  async handle(player: string, text: string, channel: 'chat' | 'voice'): Promise<Classification> {
    const d = this.deps;
    // réponse à « je mine quoi ? » : elle complète l'ordre en attente
    const pending = this.pendingOrder;
    this.pendingOrder = null;
    if (pending && d.clock.now() <= pending.until) {
      const order = `${pending.text} : ${text}`;
      d.logger.info({ channel }, `précision du joueur : « ${order} »`);
      d.loop()?.order(order);
      return { label: 'order', confidence: 0.9, classifier: 'rules' };
    }
    // question sur l'inventaire : réponse directe, ni ordre ni retour sur la dernière action
    // appelée par son seul nom (« Léa ? ») : elle répond, sans rien décider
    if (d.botName && isAddressed(text, d.botName) && withoutVocative(text, d.botName).replace(/[^a-z0-9]/g, '') === '') {
      d.say('Oui ?');
      return { label: 'chatter', confidence: 0.9, classifier: 'rules' };
    }
    const inv = d.inventory?.();
    // « donne » tout court : le dernier objet évoqué (question, ordre) ou récolté, le plus récent des deux
    if (inv && isBareGive(d.botName ? withoutVocative(text, d.botName) : text)) {
      const item = this.lastItem(inv);
      if (item) {
        const order = `donne-moi tes ${item}`;
        d.logger.info({ channel }, `« ${text} » → ${order}`);
        d.loop()?.order(order);
        return { label: 'order', confidence: 0.9, classifier: 'rules' };
      }
    }
    if (mentionsAnItem(text)) this.lastMention = { text, at: d.clock.now() };
    const st = d.status?.();
    const pr = d.progress?.();
    const answer = (pr ? answerProgressQuestion(text, pr) : null) ?? (st ? answerStatusQuestion(text, st) : null) ?? (inv ? answerInventoryQuestion(text, inv) : null);
    if (answer) {
      d.say(answer);
      d.logger.info({ channel }, `question du joueur : « ${text} » → ${answer}`);
      return { label: 'chatter', confidence: 0.9, classifier: 'rules' };
    }
    const recent = this.recentDecision();
    const context = recent ? `le bot vient de faire : ${recent.decision.intent}` : '';
    const c = await d.classifier.classify(text, context);
    const r = d.store.db
      .prepare('INSERT INTO utterances(player, channel, text, label, classifier, confidence, domain, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(player, channel, text, c.label, c.classifier, c.confidence, c.domain ?? null, d.clock.now());
    const utteranceId = Number(r.lastInsertRowid);
    d.logger.info({ channel, label: c.label, also: c.also, classifier: c.classifier }, `retour du joueur : « ${text} »`);

    // une proposition attend sa réponse : oui / non
    if (d.proposals.open && (c.label === 'approval' || c.label === 'correction')) {
      d.proposals.answer(c.label === 'approval' ? 'yes' : 'no');
      return c;
    }

    switch (c.label) {
      case 'correction':
        this.correct(recent, c, utteranceId);
        if (c.also === 'order') d.loop()?.order(text);
        else d.loop()?.request('correction du joueur', true);
        break;
      case 'approval':
        if (recent) {
          for (const id of recent.decision.basedOn) d.tree.approve(id, { utteranceId, decisionId: recent.id });
          d.autonomy.apply(recent.decision.domain, 'approval', utteranceId);
        }
        break;
      case 'teaching':
        d.observer.startTeaching(d.clock.now() + (d.teachWindowMs ?? 90_000));
        d.say('Je regarde !');
        if (c.also === 'order') d.loop()?.order(text);
        break;
      case 'order': {
        // ordre trop vague pour choisir l'outil : on demande d'abord quoi
        const question = clarifyingQuestion(text);
        if (question) {
          this.pendingOrder = { text, until: d.clock.now() + CLARIFY_WINDOW_MS };
          d.say(question);
        } else d.loop()?.order(text);
        break;
      }
      case 'chatter':
        if (d.botName && isAddressed(text, d.botName)) {
          d.gaps?.misunderstood(text);
          // on lui parle : il répond, sans agir (au plus une fois toutes les 15 s)
          if (d.clock.now() - this.lastChatAt >= CHAT_INTERVAL_MS) {
            this.lastChatAt = d.clock.now();
            const answer = await d.classifier.reply(text);
            if (answer) d.say(answer);
          }
        }
        break;
    }
    return c;
  }

  private recentDecision(): DecisionRecord | null {
    const last = this.deps.lastDecision();
    if (!last || last.decision.skill === 'follow') return null;
    return this.deps.clock.now() - this.deps.lastDecisionAt() <= FEEDBACK_WINDOW_MS ? last : null;
  }

  private correct(recent: DecisionRecord | null, c: Classification, utteranceId: number): void {
    const d = this.deps;
    d.actions()?.abort('correction du joueur');
    const domain = recent?.decision.domain ?? c.domain;
    if (recent) for (const id of recent.decision.basedOn) d.tree.correct(id, { utteranceId, decisionId: recent.id });
    if (domain) {
      d.autonomy.apply(domain, 'correction', utteranceId);
      // reproche d'une initiative (pas d'un ordre) : dans ce domaine, le bot n'agira plus que sur demande
      if (recent && recent.trigger !== 'ordre du joueur' && recent.decision.domain === domain) d.autonomy.restrictToRequests(domain);
      d.cache.invalidateDomain(domain);
    }
    d.say('D\'accord, j\'arrête.');
  }
}
