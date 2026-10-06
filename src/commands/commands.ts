import type { Autonomy } from '../autonomy/autonomy.js';
import { DOMAINS, type Domain } from '../core/types.js';
import type { Budget } from '../decider/budget.js';
import type { DecisionCache } from '../decider/cache.js';
import type { Decider } from '../decider/decider.js';
import type { BehaviorTree } from '../tree/tree.js';
import type { GapRecorder } from '../gaps/gaps.js';
import { sanitizeChat } from '../bot/chat.js';
import type { ConsignesStore } from '../feedback/consignes.js';

const DOMAIN_FR: Record<Domain, string> = {
  build: 'construction',
  combat: 'combat',
  mine: 'minage',
  gather: 'récolte',
  explore: 'exploration',
  craft: 'artisanat',
  survive: 'survie',
};
const BAND_FR = { observe: 'observe', imitate: 'imite', propose: 'propose', act: 'agit seul' } as const;

export interface CommandDeps {
  tree: BehaviorTree;
  autonomy: Autonomy;
  decider: Decider;
  budget: Budget;
  cache: DecisionCache;
  gaps?: GapRecorder;
  consignes?: ConsignesStore;
}

/** Une ligne de chat Minecraft fait au plus 256 caractères : on découpe proprement. */
export function chatLines(text: string, max = 240): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      if ((line + ' ' + word).trim().length > max) {
        if (line) out.push(line);
        line = word.slice(0, max);
      } else line = (line + ' ' + word).trim();
    }
    if (line) out.push(line);
  }
  return out.map((l) => sanitizeChat(l)).filter(Boolean);
}

const short = (s: string, n = 70) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Commandes en jeu pour lire ce que le bot a appris. Renvoie le texte à afficher, ou `null` si le
 * message n'est pas une commande connue.
 */
export async function runCommand(input: string, d: CommandDeps): Promise<string | null> {
  const [name, ...rest] = input.trim().split(/\s+/);
  const arg = rest.join(' ');
  switch (name?.toLowerCase()) {
    case '!aide':
      return 'Commandes : !arbre (ce que j\'ai appris), !autonomie (ma confiance par domaine), !pourquoi (ma dernière décision), !oublie <chose>, !budget, !manques (ce que je ne sais pas encore faire), !maison (ici c\'est la maison ; !maison ? ; !maison oublie), !consignes (ce que tu m\'as demandé de retenir ; !oublie consigne <n>).';

    case '!arbre': {
      const profile = d.tree.profile();
      const ranked = DOMAINS.filter((x) => profile[x] > 0).sort((a, b) => profile[b] - profile[a]);
      const overview = d.tree.overview(5);
      if (ranked.length === 0 && overview.length === 0) return 'Je n\'ai encore rien appris : je te regarde jouer.';
      const lines = [ranked.length ? `Spécialité : ${ranked.map((x) => `${DOMAIN_FR[x]} ${profile[x]}`).join(', ')}` : 'Pas encore de spécialité.'];
      for (const o of overview) {
        const how = o.best ? short(o.best) : o.corrected ? `corrigé : ${short(o.corrected, 55)}` : '—';
        lines.push(`• ${short(o.situation, 50)} (${o.weight}) → ${how}`);
      }
      return lines.join('\n');
    }

    case '!autonomie': {
      const all = d.autonomy.all();
      return DOMAINS.map((x) => `${DOMAIN_FR[x]} ${Math.round(all[x].score * 100)}% (${all[x].onRequestOnly ? 'sur demande' : BAND_FR[all[x].band]})`).join(' · ');
    }

    case '!pourquoi': {
      const last = d.decider.lastDecision;
      if (!last) return 'Je n\'ai encore pris aucune décision.';
      const dec = last.decision;
      const SOURCE_FR = { llm: `décidé par ${last.model ?? 'le modèle'}`, cache: 'situation déjà vue (cache)', fallback: 'repli sans modèle' };
      const labels = d.tree.store.getNodes(dec.basedOn).map((n) => short(n.label, 60));
      return [
        `Dernière décision : ${dec.intent} (${dec.skill}, ${SOURCE_FR[last.source]}).`,
        dec.rationale ? `Pourquoi : ${dec.rationale}` : null,
        labels.length ? `En m'appuyant sur : ${labels.join(' ; ')}` : 'Sans m\'appuyer sur un comportement appris.',
        `Situation perçue : ${short(last.situationText, 120)}`,
      ]
        .filter(Boolean)
        .join('\n');
    }

    case '!consignes': {
      const list = d.consignes?.texts() ?? [];
      if (list.length === 0) return "Tu ne m'as donné aucune consigne à retenir. Dis par exemple « retiens que… » ou « à l'avenir… ».";
      return ['Tes consignes :', ...list.map((t, i) => `${i + 1}. ${short(t, 90)}`)].join('\n');
    }

    case '!oublie': {
      if (!arg) return 'Dis-moi quoi oublier : !oublie <chose>';
      // « !oublie consigne 2 » : retire une consigne plutôt qu'un comportement appris
      const c = /^consignes?\s+(\d+)$/i.exec(arg);
      if (c && d.consignes) {
        const removed = d.consignes.remove(Number(c[1]));
        if (removed) d.cache.clear();
        return removed ? `J'oublie la consigne : « ${short(removed, 80)} ».` : `Il n'y a pas de consigne n° ${c[1]}.`;
      }
      const forgotten = await d.tree.forget(arg);
      if (forgotten.length === 0) return `Je ne trouve rien qui ressemble à « ${arg} ».`;
      d.cache.clear();
      return `J'oublie ${forgotten.length} élément(s) : ${forgotten.slice(0, 3).map((n) => short(n.label, 50)).join(' ; ')}`;
    }

    case '!manques': {
      const gaps = d.gaps?.top(6) ?? [];
      if (gaps.length === 0) return "Je n'ai repéré aucune compétence qui me manque pour l'instant.";
      return ['Ce que je ne sais pas encore faire :', ...gaps.map((g) => `• ${g.label} (${g.count}×)`)].join('\n');
    }

    case '!budget': {
      const t = d.budget.today();
      return `Aujourd'hui : ${t.calls} appel(s) au modèle, ${t.costUsd.toFixed(4)} $ sur ${d.budget.dailyUsd.toFixed(2)} $ (${t.promptTokens + t.completionTokens} tokens).${d.decider.budgetExhausted ? ' Budget atteint : je suis et je survis, sans décider.' : ''}`;
    }

    default:
      return null;
  }
}
