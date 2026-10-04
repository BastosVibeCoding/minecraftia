import { z } from 'zod';
import { DOMAINS, type Domain } from '../core/types.js';
import type { Budget } from '../decider/budget.js';
import { LlmError, type LlmClient } from '../decider/llm.js';

export type UtteranceLabel = 'correction' | 'approval' | 'teaching' | 'order' | 'chatter';

export interface Classification {
  label: UtteranceLabel;
  /** Second sens éventuel (« non, construis plutôt en bois » = correction + ordre). */
  also?: UtteranceLabel;
  domain?: Domain;
  confidence: number;
  classifier: 'rules' | 'llm';
}

const norm = (t: string) =>
  t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’`]/g, "'")
    .trim();

/** Mots de remplissage en tête de phrase, fréquents à l'oral : « là, », « ok, », « allez », « euh »… */
const FILLER = '(?:(?:la|ok|okay|bon|allez|alors|euh|donc|bah|ben|vas[- ]y|et)[ ,!]+)*';

const RULES: Record<Exclude<UtteranceLabel, 'chatter'>, RegExp[]> = {
  correction: [
    /^(non|nan|nope|no)\b/,
    /pas comme (ca|ça)/,
    /\barrete\b|\bstop\b|\bhalte\b/,
    /c'est pas (ca|bien|comme)|ce n'est pas (ca|bien)/,
    /n'importe quoi|\bmauvais\b|\brate\b|\bnul\b/,
    /\b(il )?(ne )?faut pas\b|pas besoin de|ne (le )?fais plus|fais plus (ca|ça)/,
    /(ne )?fais pas (ca|ça)|ne fais pas/,
  ],
  approval: [
    /^(oui|ouais|ouep|yes|ok|okay|d'accord|vas[- ]y|go|carrement)\b/,
    /\b(bien joue|bravo|parfait|super|genial|top|nickel|excellent|exactement|c'est (ca|ça|bien)|bon travail|merci)\b/,
  ],
  // « comme ça » enseigne, sauf dans « pas comme ça » (correction)
  teaching: [/\bregarde\b|\bobserve\b/, /je (te )?montre/, /(?<!pas )comme (ca|ça)\b(?! ?\?)/, /fais comme moi|voila comment|apprends/],
  order: [
    // verbe à l'impératif en tête de phrase ou après « non, » / « plutôt »
    new RegExp(`(^${FILLER}|[,;.!] *|\\bplutot )(construis|construit|batis|bati|pose|mine|creuse|coupe|recolte|recupere|ramasse|reprends|prends|prend |trouve|clique|ramene-moi|chope|attaque|tue|suis[- ]moi|viens|va |fabrique|craft|mange|explore|reste|donne|equipe|protege|defends|fais |fait |apporte|rapporte|ramene|aide[- ]moi|cherche|plante|seme|cuis|range|dors|allume)(?! ?(pas|plus)\\b)`),
    new RegExp(`^${FILLER}(tu peux|peux[- ]tu|pourrais[- ]tu|tu pourrais|tu vas|il faut que tu|j'ai besoin)\\b`),
    /(s'il te plait|s'te plait|\bstp\b)/,
  ],
};

const DOMAIN_WORDS: [Domain, RegExp][] = [
  ['build', /construi|bati|mur|maison|toit|sol|pose|bloc|brique/],
  ['combat', /attaque|tue|combat|zombie|squelette|monstre|mob|epee|defend|protege/],
  ['mine', /mine|creuse|minerai|fer|diamant|charbon|grotte|pioche/],
  ['gather', /coupe|bois|arbre|recolte|ramasse|ble|bucheron/],
  ['craft', /fabrique|craft|etabli|outil/],
  ['explore', /explore|cherche|va voir|decouvr/],
  ['survive', /mange|faim|vie|soigne|armure/],
];

function inferDomain(t: string): Domain | undefined {
  return DOMAIN_WORDS.find(([, r]) => r.test(t))?.[0];
}

/**
 * Retire l'interpellation du personnage (« Alex, coupe du bois », « hé Alex … », « …, Alex ») :
 * sans cela, le verbe d'un ordre n'est plus en tête de phrase.
 */
export function stripVocative(normalized: string, botName: string): string {
  // le nom est normalisé (minuscules, sans accents) puis échappé pour servir dans une expression régulière
  const name = norm(botName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const leading = new RegExp(`^(?:(?:he+|hey|eh|dis|ok|bon|allez)[\\s,!]*)?${name}\\b[\\s,!:.]*`);
  const trailing = new RegExp(`[\\s,]+${name}[\\s!.?]*$`);
  return normalized.replace(leading, '').replace(trailing, '').trim();
}

/**
 * Texte de réponse à afficher : le modèle emballe parfois sa phrase en JSON (`{ "response": "…" }`)
 * ou dans un bloc de code (cas réel dans le chat) ; on n'en garde que la phrase.
 */
export function plainReply(raw: string): string {
  let t = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  if (t.startsWith('{')) {
    try {
      const v = JSON.parse(t) as unknown;
      const first = v && typeof v === 'object' ? Object.values(v).find((x) => typeof x === 'string') : undefined;
      if (typeof first === 'string') t = first;
    } catch {
      // JSON abîmé : on garde ce qui est entre les premiers guillemets de valeur
      const m = /:\s*"([^"]+)"/.exec(t);
      if (m) t = m[1]!;
    }
  }
  return t.replace(/^["«\s]+|["»\s]+$/g, '').replace(/\s+/g, ' ').trim();
}

/** Phrase normalisée, sans l'interpellation du personnage (« Alex, donne » → « donne »). */
export function withoutVocative(text: string, botName: string): string {
  return stripVocative(norm(text), botName);
}

/** La phrase interpelle le personnage par son nom (« Alex, … », « …, Léa »). */
export function isAddressed(text: string, botName: string): boolean {
  const t = norm(text);
  return stripVocative(t, botName) !== t;
}

/** Étage 1 : règles locales, gratuites. `ambiguous` = laisser trancher le LLM. */
export function classifyByRules(text: string, botName = 'Alex'): Classification & { ambiguous: boolean } {
  const t = stripVocative(norm(text), botName);
  const hits = (Object.keys(RULES) as (keyof typeof RULES)[]).filter((k) => RULES[k].some((r) => r.test(t)));
  const domain = inferDomain(t);
  const priority: UtteranceLabel[] = ['correction', 'teaching', 'order', 'approval'];
  const sorted = priority.filter((p) => hits.includes(p as keyof typeof RULES));
  if (sorted.length === 0) {
    // phrase longue mentionnant le jeu sans motif reconnu : à faire trancher
    const ambiguous = t.split(/\s+/).length >= 4 && domain !== undefined;
    return { label: 'chatter', confidence: ambiguous ? 0.4 : 0.8, classifier: 'rules', ambiguous, ...(domain ? { domain } : {}) };
  }
  const label = sorted[0]!;
  const also = sorted[1];
  // « non » seul est une correction sûre ; « non mais construis… » mêle correction et ordre : cohérent
  // « ok, tu vas ramasser… » : l'ordre l'emporte sur l'acquiescement
  const ambiguous =
    sorted.length > 1 && !(label === 'correction' && also === 'order') && !(label === 'teaching' && also === 'order') && !(label === 'order' && also === 'approval');
  return { label, ...(also ? { also } : {}), ...(domain ? { domain } : {}), confidence: ambiguous ? 0.5 : 0.9, classifier: 'rules', ambiguous };
}

const LlmClassification = z.object({
  label: z.enum(['correction', 'approval', 'teaching', 'order', 'chatter']),
  also: z.enum(['correction', 'approval', 'teaching', 'order', 'chatter']).nullish(),
  domain: z.enum(DOMAINS).nullish(),
  confidence: z.number().min(0).max(1).default(0.7),
});

const system = (botName: string) => `Tu classes une phrase dite par un joueur de Minecraft au personnage IA qui l'accompagne. Ce personnage s'appelle ${botName} : une phrase qui commence par « ${botName} » s'adresse à lui (« ${botName} coupe du bois » est un ordre).
Catégories : correction (il désapprouve ce que fait le personnage), approval (il approuve), teaching (il montre comment faire : « regarde »), order (il demande une action), chatter (bavardage).
Réponds uniquement en JSON : {"label": "...", "also": "<seconde catégorie ou null>", "domain": "build|combat|mine|gather|explore|craft|survive|null", "confidence": 0..1}`;

/**
 * Classifieur d'énoncés en deux étages : règles locales, puis petit LLM seulement si c'est ambigu
 * (et si le budget le permet). Sans LLM, la meilleure hypothèse des règles est conservée.
 */
export class UtteranceClassifier {
  constructor(
    private readonly llm: LlmClient | null,
    private readonly budget: Budget | null,
    private readonly model: string,
    private readonly botName = 'Alex',
    private readonly gender: 'feminine' | 'masculine' = 'feminine',
  ) {}

  /**
   * Réponse de conversation (« raconte-moi une blague ») : une ou deux phrases, dans le personnage.
   * `null` sans modèle, budget épuisé ou erreur : le bot se tait plutôt que d'inventer.
   */
  async reply(text: string): Promise<string | null> {
    if (!this.llm || !this.budget || this.budget.exhausted()) return null;
    const who = this.gender === 'feminine' ? 'une compagne' : 'un compagnon';
    const system = `Tu es ${this.botName}, ${who} de jeu dans Minecraft, qui parle français. Réponds au joueur en une ou deux phrases courtes, naturelles et amicales (pas de liste, pas d'emoji, pas de « / » en début de phrase). Tu ne peux pas promettre d'actions : si on te demande d'agir, dis simplement que tu essaies.`;
    try {
      const res = await this.llm.complete({ purpose: 'chat', model: this.model, system, user: text, maxTokens: 120 });
      this.budget.record({ purpose: 'chat', model: res.model, promptTokens: res.promptTokens, completionTokens: res.completionTokens, costUsd: res.costUsd, latencyMs: res.latencyMs, ok: true });
      const out = plainReply(res.text).slice(0, 240);
      return out || null;
    } catch (err) {
      this.budget.record({ purpose: 'chat', model: this.model, promptTokens: 0, completionTokens: 0, costUsd: 0, latencyMs: 0, ok: false, error: err instanceof LlmError ? err.message : String(err) });
      return null;
    }
  }

  async classify(text: string, context = ''): Promise<Classification> {
    const rules = classifyByRules(text, this.botName);
    const { ambiguous, ...base } = rules;
    if (!ambiguous || !this.llm || !this.budget || this.budget.exhausted()) return base;
    try {
      const res = await this.llm.complete({ purpose: 'classify', model: this.model, system: system(this.botName), user: `${context ? `Contexte : ${context}\n` : ''}Phrase : « ${text} »`, maxTokens: 80 });
      this.budget.record({ purpose: 'classify', model: res.model, promptTokens: res.promptTokens, completionTokens: res.completionTokens, costUsd: res.costUsd, latencyMs: res.latencyMs, ok: true });
      const start = res.text.indexOf('{');
      const parsed = LlmClassification.safeParse(JSON.parse(res.text.slice(start, res.text.lastIndexOf('}') + 1)));
      if (!parsed.success) return base;
      const p = parsed.data;
      return { label: p.label, ...(p.also ? { also: p.also } : {}), ...((p.domain ?? base.domain) ? { domain: (p.domain ?? base.domain)! } : {}), confidence: p.confidence, classifier: 'llm' };
    } catch (err) {
      this.budget.record({ purpose: 'classify', model: this.model, promptTokens: 0, completionTokens: 0, costUsd: 0, latencyMs: 0, ok: false, error: err instanceof LlmError ? err.message : String(err) });
      return base;
    }
  }
}
