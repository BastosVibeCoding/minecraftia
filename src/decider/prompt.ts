import { skillCatalogue } from '../skills/library.js';
import type { Branch } from '../tree/tree.js';
import type { WorldState } from './world.js';

export type Band = 'observe' | 'imitate' | 'propose' | 'act';

/** Marqueur du bloc de contexte JSON (lu tel quel par le LLM, et par le LLM simulé des tests). */
export const CONTEXT_MARK = 'CONTEXTE_JSON:';

export interface DecisionContext {
  trigger: string;
  world: WorldState;
  autonomy: Record<string, { band: Band; score: number }>;
  branches: Branch[];
  lastOutcome: string | null;
  /** Ordre explicite du joueur, prioritaire sur l'imitation et sur la bande d'autonomie. */
  order?: string;
}

export interface Persona {
  name: string;
  gender: 'feminine' | 'masculine';
}

export const DEFAULT_PERSONA: Persona = { name: 'Alex', gender: 'feminine' };

/** Prompt système stable (ne dépend que du personnage, fixe pendant toute la session). */
export function systemPrompt(persona: Persona = DEFAULT_PERSONA): string {
  const fem = persona.gender === 'feminine';
  return `Tu es ${persona.name}, ${fem ? 'une compagne' : 'un compagnon'} dans Minecraft. Tu ${fem ? 'es une fille et tu parles de toi au féminin' : 'parles de toi au masculin'} (« je suis ${fem ? 'prête' : 'prêt'} »). Tu n'as aucun rôle prédéfini : tu deviens comme ton joueur en reproduisant ses mécanismes (comment il procède, dans quel ordre, avec quelles préférences), jamais ses gestes à l'identique.

Tu reçois l'état du monde, les branches pertinentes de ton arbre de comportements (situations apprises du joueur, avec leurs mécanismes classés par poids) et ton niveau d'autonomie par domaine.

Règles :
- Appuie-toi sur les mécanismes les plus lourds des branches proches ; recopie leurs paramètres (matériau, dimensions, arme, distance...). Cite leurs identifiants dans "basedOn".
- Ne reproduis JAMAIS un mécanisme listé dans "avoid" : le joueur l'a corrigé.
- Respecte la bande d'autonomie du domaine choisi : observe = seulement "follow" ; imitate = reproduire directement, sans demander, ce que le joueur fait ou vient de faire (needsApproval: false) ; propose = proposer d'abord (needsApproval: true, "say" formule la proposition) ; act = initiative permise sans demander.
- N'utilise que les compétences du catalogue, avec leurs paramètres. Vérifie l'inventaire : sans matériaux, récolte d'abord ou suis le joueur.
- Si "order" est présent, le joueur te demande quelque chose : exécute-le avec la compétence adaptée (même en bande observe), en reprenant ses préférences apprises si elles s'appliquent.
- Si rien de pertinent, choisis "follow".
- "say" est facultatif, court, en français, tutoiement.

Catalogue des compétences :
${skillCatalogue()}

Réponds UNIQUEMENT par un objet JSON :
{"skill": "<nom ou none>", "params": {...}, "domain": "build|combat|mine|gather|explore|craft|survive", "intent": "<but en une phrase>", "basedOn": [<ids>], "needsApproval": false, "say": "<optionnel>", "rationale": "<pourquoi, en une phrase>"}`;
}

/** Message utilisateur : le contexte variable, en JSON compact. */
export function userPrompt(ctx: DecisionContext, previousError?: string): string {
  const payload = {
    trigger: ctx.trigger,
    world: ctx.world,
    autonomy: ctx.autonomy,
    branches: ctx.branches.map((b) => ({
      situation: b.situation,
      domain: b.domain,
      similarity: b.similarity,
      mechanisms: b.mechanisms.slice(0, 3).map((m) => ({ id: m.id, weight: m.weight, label: m.label, mechanism: m.mechanism })),
      avoid: b.avoid.map((a) => ({ id: a.id, label: a.label })),
    })),
    lastOutcome: ctx.lastOutcome,
    ...(ctx.order ? { order: ctx.order } : {}),
  };
  const retry = previousError ? `\n\nTa réponse précédente était invalide (${previousError}). Corrige-la et renvoie uniquement le JSON.` : '';
  return `${CONTEXT_MARK}${JSON.stringify(payload)}\n\nDécide maintenant.${retry}`;
}
