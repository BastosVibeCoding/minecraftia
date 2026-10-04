import type { Vec3Like } from '../core/types.js';
import type { EquipSlot } from './types.js';

/** État courant du joueur suivi, tenu à jour par l'observateur et lu par les analyseurs. */
export interface PlayerState {
  equipment: Partial<Record<EquipSlot, string | null>>;
  health: number | null;
  food: number | null;
  pos: Vec3Like | null;
  biome: string | null;
  dimension: string | null;
  /** Lieux visités : nombre de passages par case de 32×32 blocs. */
  visits: Map<string, number>;
}

export function newPlayerState(): PlayerState {
  return { equipment: {}, health: null, food: null, pos: null, biome: null, dimension: null, visits: new Map() };
}

export const CELL = 32;
export const cellOf = (p: Vec3Like) => `${Math.floor(p.x / CELL)},${Math.floor(p.z / CELL)}`;

/** Case la plus visitée : la « base » du joueur, si elle se détache nettement. */
export function baseCell(state: PlayerState): string | null {
  let best: string | null = null;
  let bestCount = 0;
  let total = 0;
  for (const [cell, n] of state.visits) {
    total += n;
    if (n > bestCount) (best = cell), (bestCount = n);
  }
  return best && bestCount >= 5 && bestCount / total >= 0.25 ? best : null;
}

/** Contexte commun à toutes les situations : où, à quelle profondeur, près de la base ou non. */
export function situationContext(state: PlayerState, at: Vec3Like | null): { context: string[]; tags: Record<string, unknown> } {
  const context: string[] = [];
  const tags: Record<string, unknown> = {};
  const pos = at ?? state.pos;
  if (state.dimension && state.dimension !== 'overworld') (context.push(`dans le ${state.dimension}`), (tags.dimension = state.dimension));
  if (pos) {
    const band = pos.y < 0 ? 'profond' : pos.y < 55 ? 'souterrain' : 'surface';
    tags.depth = band;
    if (band !== 'surface') context.push(band === 'profond' ? 'en profondeur' : 'sous terre');
    const base = baseCell(state);
    if (base && cellOf(pos) === base) (context.push('près de la base'), (tags.nearBase = true));
  }
  if (state.biome) (context.push(`biome ${state.biome.replace(/_/g, ' ')}`), (tags.biome = state.biome));
  return { context, tags };
}

export function withContext(base: string, ctx: string[]): string {
  return ctx.length ? `${base} (${ctx.join(', ')})` : base;
}
