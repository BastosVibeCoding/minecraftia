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
  const parsed = DecisionSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
  const d = parsed.data;
  if (d.skill !== 'none') {
    const params = SKILLS[d.skill]!.params.safeParse(d.params);
    if (!params.success) return { ok: false, error: `paramètres de ${d.skill} : ${z.prettifyError(params.error)}` };
    d.params = params.data as Record<string, unknown>;
  }
  return { ok: true, decision: d };
}
