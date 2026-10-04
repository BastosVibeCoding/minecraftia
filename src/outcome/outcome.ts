import type { ActionResult } from '../skills/actionController.js';
import type { ActionStatus } from '../core/types.js';

/** Ce que l'on compare avant et après une action. */
export interface StateSnapshot {
  health: number;
  food: number;
  inventory: Record<string, number>;
  deaths: number;
}

export interface Outcome {
  status: ActionStatus;
  /** Échec dû à une précondition (pas de matériaux, pas de cible) : ni la branche ni l'autonomie ne sont jugées. */
  precondition: boolean;
  inventoryDelta: Record<string, number>;
  healthDelta: number;
  summary: string;
}

export function inventoryDelta(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const d = (after[k] ?? 0) - (before[k] ?? 0);
    if (d !== 0) out[k] = d;
  }
  return out;
}

/** Résultat d'une action : réussi, raté, mort (inventaire, vie), à partir du statut et des instantanés. */
export function evaluateOutcome(result: ActionResult, before: StateSnapshot, after: StateSnapshot): Outcome {
  const died = after.deaths > before.deaths;
  const status: ActionStatus = died ? 'death' : result.status;
  const precondition = status === 'failure' && result.detail?.precondition === true;
  const delta = inventoryDelta(before.inventory, after.inventory);
  const healthDelta = Math.round((after.health - before.health) * 10) / 10;
  const gains = Object.entries(delta).filter(([, v]) => v > 0).map(([k, v]) => `+${v} ${k}`);
  const losses = Object.entries(delta).filter(([, v]) => v < 0).map(([k, v]) => `${v} ${k}`);
  const reason = result.reason ?? (typeof result.detail?.reason === 'string' ? result.detail.reason : undefined);
  const STATUS_FR: Record<ActionStatus, string> = { success: 'réussi', failure: 'raté', death: 'mort', preempted: 'interrompu', timeout: 'délai dépassé' };
  const summary = [`${result.action} : ${STATUS_FR[status]}`, reason ? `(${reason})` : null, [...gains, ...losses].slice(0, 6).join(', ') || null, healthDelta !== 0 ? `vie ${healthDelta > 0 ? '+' : ''}${healthDelta}` : null]
    .filter(Boolean)
    .join(' ');
  return { status, precondition, inventoryDelta: delta, healthDelta, summary };
}

/** Faut-il juger la branche sur ce résultat ? Les préemptions (réflexes, joueur) et préconditions ne comptent pas. */
export function judged(o: Outcome): boolean {
  return !o.precondition && o.status !== 'preempted';
}
