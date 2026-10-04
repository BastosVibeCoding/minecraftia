import type { Domain, Vec3Like } from '../core/types.js';
import type { EpisodeSource } from '../store/store.js';

export type EquipSlot = 'hand' | 'offhand' | 'head' | 'chest' | 'legs' | 'feet';

/**
 * Événement normalisé, quelle que soit sa source (Easy LLM, mineflayer, journal rejoué).
 * `t` est en millisecondes. Seuls les événements du joueur suivi atteignent les analyseurs.
 */
export type RawEvent =
  | { t: number; type: 'block_placed'; player: string; pos: Vec3Like; block: string }
  | { t: number; type: 'block_broken'; player: string; pos: Vec3Like; block: string; tool?: string }
  | { t: number; type: 'craft'; player: string; item: string; count: number; consumed?: Record<string, number> }
  | { t: number; type: 'equip'; player: string; slot: EquipSlot; item: string | null }
  | { t: number; type: 'attack'; player: string; target: string; targetId?: number; distance: number; weapon?: string }
  | { t: number; type: 'damaged'; player: string; health: number; amount?: number; source?: string }
  | { t: number; type: 'kill'; player: string; target: string }
  | { t: number; type: 'eat'; player: string; item: string; food?: number; health?: number }
  | { t: number; type: 'health'; player: string; health: number; food?: number }
  | { t: number; type: 'move'; player: string; pos: Vec3Like; biome?: string; dimension?: string }
  | { t: number; type: 'chat'; player: string; message: string }
  | { t: number; type: 'container'; player: string; action: 'open' | 'close'; block: string; pos: Vec3Like }
  | { t: number; type: 'death'; player: string };

export type RawEventType = RawEvent['type'];

/** Épisode agrégé : « a construit un mur 7×4 en pierre taillée, symétrique ». */
export interface Episode {
  player: string;
  domain: Domain;
  kind: string;
  summary: string;
  /** Contexte où le mécanisme s'applique (sert à la recherche de situations proches). */
  situation: { text: string; [k: string]: unknown };
  /** Comment le joueur procède : primitive + paramètres + ordre. */
  mechanism: { skill: string; [k: string]: unknown };
  params: Record<string, unknown>;
  source: EpisodeSource;
  startedAt: number;
  endedAt: number;
}
