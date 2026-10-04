import type { Vec3Like } from '../core/types.js';

/** Tout ce que les réflexes ont le droit de lire. Aucune donnée apprise n'y figure. */
export interface SurvivalSnapshot {
  health: number; // 0..20
  food: number; // 0..20
  oxygen: number; // 0..20
  position: Vec3Like;
  velocityY: number;
  onGround: boolean;
  inLava: boolean;
  onFire: boolean;
  inWater: boolean;
  headInWater: boolean;
  /** Hauteur de vide sous les pieds (0 au sol, Infinity si rien de solide en dessous dans la portée). */
  heightAboveGround: number;
  hostiles: { name: string; distance: number; position: Vec3Like }[];
  hasFood: boolean;
  hasWaterBucket: boolean;
  followedPlayer?: Vec3Like;
}

export type ReflexKind = 'escape_lava' | 'extinguish' | 'surface' | 'break_fall' | 'flee' | 'eat';

export interface ReflexDecision {
  kind: ReflexKind;
  /** Plus grand = plus urgent. Un réflexe plus urgent peut remplacer un réflexe en cours. */
  priority: number;
  reason: string;
}

export interface ReflexThresholds {
  lowHealth: number;
  eatBelowFood: number;
  drowningOxygen: number;
  dangerousFall: number;
  threatRadius: number;
  maxHostiles: number;
  creeperRadius: number;
}
