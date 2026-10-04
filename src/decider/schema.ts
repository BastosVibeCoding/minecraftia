import { z } from 'zod';
import { DOMAINS } from '../core/types.js';
import { SKILLS } from '../skills/library.js';

const SKILL_NAMES = Object.keys(SKILLS) as [string, ...string[]];

/** Décision renvoyée par le LLM, validée par schéma avant toute exécution. */
export const DecisionSchema = z.object({
  skill: z.enum([...SKILL_NAMES, 'none']),
  params: z.record(z.string(), z.unknown()).default({}),
  domain: z.enum(DOMAINS),
  intent: z.string().min(1).max(160),
  /** Identifiants des mécanismes de l'arbre sur lesquels la décision s'appuie. */
  basedOn: z.array(z.number().int()).max(6).default([]),
  needsApproval: z.boolean().default(false),
  say: z.string().max(200).optional(),
  rationale: z.string().max(400).default(''),
});

export type Decision = z.infer<typeof DecisionSchema>;

/** Paramètres entiers des compétences (dimensions, quantités). */
const INTEGER_PARAMS = new Set(['width', 'height', 'depth', 'count']);

/**
 * Écarts de forme sans conséquence, fréquents chez les modèles (constatés au banc d'essai) :
 * champ facultatif à `null` au lieu d'être omis. On les retire plutôt que de rejeter la décision.
 */
function tolerate(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (v !== null) out[k] = v;
  return out;
}

/**
 * Dimensions recopiées des moyennes apprises (« 7,29 ») ou écrites en texte (« 7 ») : arrondies en entiers.
 * Les bornes de chaque compétence restent appliquées ensuite par son schéma.
 */
function normalizeParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === null) continue;
    const n = typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : v;
    out[k] = INTEGER_PARAMS.has(k) && typeof n === 'number' ? Math.round(n) : n;
  }
  return out;
}

/** Extrait et valide la décision d'un texte de LLM ; renvoie une erreur lisible pour la nouvelle tentative. */
export function parseDecision(text: string): { ok: true; decision: Decision } | { ok: false; error: string } {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, error: 'aucun objet JSON dans la réponse' };
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    return { ok: false, error: `JSON invalide : ${(err as Error).message}` };
  }
  const parsed = DecisionSchema.safeParse(tolerate(raw));
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
  const d = parsed.data;
  if (d.skill !== 'none') {
    const params = SKILLS[d.skill]!.params.safeParse(normalizeParams(d.params));
    if (!params.success) return { ok: false, error: `paramètres de ${d.skill} : ${z.prettifyError(params.error)}` };
    d.params = params.data as Record<string, unknown>;
  }
  return { ok: true, decision: d };
}
