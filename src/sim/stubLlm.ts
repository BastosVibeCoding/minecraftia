import type { LlmClient, LlmRequest, LlmResponse } from '../decider/llm.js';
import { CONTEXT_MARK, type Band } from '../decider/prompt.js';

interface Ctx {
  autonomy: Record<string, { band: Band }>;
  world: { bot: { inventory: Record<string, number> } };
  branches: { domain: string; mechanisms: { id: number; mechanism: Record<string, unknown> | null }[]; avoid: { id: number }[] }[];
}

/**
 * LLM simulé « rationnel » pour les tests et la simulation d'une heure : lit le contexte JSON du
 * prompt et applique les règles du prompt système (meilleur mécanisme de la meilleure branche
 * utilisable, jamais un mécanisme à éviter, bande d'autonomie respectée). Compte des tokens réalistes
 * (≈ 4 caractères par token) pour mesurer les coûts. Aucun appel réseau.
 */
export class RationalStubLlm implements LlmClient {
  calls: LlmRequest[] = [];
  /** Réponses forcées (ex. JSON invalide) consommées avant le comportement rationnel. */
  scripted: string[] = [];

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(req);
    const text = this.scripted.shift() ?? this.decide(req.user);
    return {
      text,
      model: req.model,
      promptTokens: Math.ceil((req.system.length + req.user.length) / 4),
      completionTokens: Math.ceil(text.length / 4),
      costUsd: null,
      latencyMs: 1,
    };
  }

  private decide(user: string): string {
    const i = user.indexOf(CONTEXT_MARK);
    const jsonText = user.slice(i + CONTEXT_MARK.length).split('\n\n')[0]!;
    const ctx = JSON.parse(jsonText) as Ctx;
    for (const b of ctx.branches) {
      const band = ctx.autonomy[b.domain]?.band ?? 'observe';
      if (band === 'observe') continue;
      const avoid = new Set(b.avoid.map((a) => a.id));
      const m = b.mechanisms.find((x) => !avoid.has(x.id) && x.mechanism);
      if (!m) continue;
      const action = toSkill(m.mechanism!);
      if (!action) continue;
      return JSON.stringify({
        ...action,
        domain: b.domain,
        intent: `reproduire : ${String(m.mechanism!.skill)}`,
        basedOn: [m.id],
        needsApproval: band === 'propose',
        ...(band === 'propose' ? { say: 'Je peux m\'en occuper ?' } : {}),
        rationale: 'mécanisme le plus lourd de la branche la plus proche',
      });
    }
    return JSON.stringify({ skill: 'follow', params: {}, domain: 'explore', intent: 'suivre', basedOn: [], rationale: 'rien d\'utilisable' });
  }
}

const num = (v: unknown, d: number) => (typeof v === 'number' ? v : d);
const first = (v: unknown) => (Array.isArray(v) ? (v[0] as string | undefined) : typeof v === 'string' ? v : undefined);

/** Traduit un mécanisme appris en appel de compétence (mêmes paramètres, pas la même séquence). */
export function toSkill(m: Record<string, unknown>): { skill: string; params: Record<string, unknown> } | null {
  switch (m.skill) {
    case 'build': {
      const dims = (m.dims ?? {}) as Record<string, unknown>;
      return { skill: 'build', params: { shape: m.shape, material: m.material, width: Math.round(num(dims.width, 5)), height: Math.round(num(dims.height, 3)), depth: Math.round(num(dims.depth, 1)), borderFirst: m.borderFirst === true } };
    }
    case 'attack':
      return { skill: 'attack', params: { targets: (m.targets as string[] | undefined) ?? ['hostile'], engageDistance: Math.min(3.5, Math.max(2, num(m.engageDistance, 3))), retreatHp: num(m.retreatHp, 6), useShield: m.useShield === true } };
    case 'collect': {
      const block = first(m.targets) ?? first(m.block);
      return block ? { skill: 'collect', params: { blocks: [block], count: Math.min(32, Math.max(1, Math.round(num(m.count, 8)))) } } : null;
    }
    case 'craft': {
      const item = first(m.items);
      return item ? { skill: 'craft', params: { item, count: 1 } } : null;
    }
    case 'explore':
      return { skill: 'explore', params: { radius: Math.min(64, Math.max(8, num(m.radius, 24))) } };
    case 'eat':
      return { skill: 'eat', params: {} };
    case 'equip': {
      const gear = Object.values((m.gear ?? {}) as Record<string, string>)[0];
      return gear ? { skill: 'equip', params: { item: gear } } : null;
    }
    default:
      return null;
  }
}
