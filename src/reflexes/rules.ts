import type { ReflexDecision, ReflexThresholds, SurvivalSnapshot } from './types.js';

/** En plein combat, il faut ce multiple de `maxHostiles` pour fuir (3 → 6 monstres). */
export const FIGHTING_HOSTILES_FACTOR = 2;

/**
 * Règles de survie : fonction pure, sans LLM, sans accès à l'arbre ni à l'autonomie.
 * Renvoie le réflexe le plus urgent, ou null si tout va bien.
 */
export function evaluateReflexes(s: SurvivalSnapshot, t: ReflexThresholds): ReflexDecision | null {
  if (s.inLava) return { kind: 'escape_lava', priority: 100, reason: 'dans la lave' };

  if (!s.onGround && !s.inWater && s.velocityY < -0.5 && s.heightAboveGround >= t.dangerousFall && s.hasWaterBucket) {
    return { kind: 'break_fall', priority: 90, reason: `chute de ${Math.round(s.heightAboveGround)} blocs` };
  }

  if (s.headInWater && s.oxygen <= t.drowningOxygen) {
    return { kind: 'surface', priority: 80, reason: `noyade (oxygène ${s.oxygen}/20)` };
  }

  if (s.onFire && !s.inWater) return { kind: 'extinguish', priority: 70, reason: 'en feu' };

  const near = s.hostiles.filter((h) => h.distance <= t.threatRadius);
  const creeper = s.hostiles.find((h) => h.name === 'creeper' && h.distance <= t.creeperRadius);
  if (creeper) return { kind: 'flee', priority: 60, reason: `creeper à ${creeper.distance.toFixed(1)} blocs` };
  // en combat (ordre « défends-moi », « attaque »), le nombre seul ne fait plus fuir, sauf encerclement
  const tooMany = s.fighting ? t.maxHostiles * FIGHTING_HOSTILES_FACTOR : t.maxHostiles;
  if (near.length >= tooMany) return { kind: 'flee', priority: 60, reason: `${near.length} hostiles proches` };

  if (s.health <= t.lowHealth) {
    const close = near.some((h) => h.distance <= 6);
    if (close) return { kind: 'flee', priority: 55, reason: `vie basse (${s.health}/20) et menace proche` };
    if (s.hasFood && s.food < 20) return { kind: 'eat', priority: 50, reason: `vie basse (${s.health}/20)` };
  }

  if (s.food <= t.eatBelowFood && s.hasFood && near.length === 0) {
    return { kind: 'eat', priority: 30, reason: `faim (${s.food}/20)` };
  }

  return null;
}
