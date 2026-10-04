import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';

/** Champs que la physique de mineflayer pose sur l'entité du bot sans les déclarer dans ses types. */
export interface PhysicsFlags {
  isInWater?: boolean;
  isInLava?: boolean;
}

export function physicsFlags(entity: Entity): PhysicsFlags {
  return entity as unknown as PhysicsFlags;
}

/** Index 0 des métadonnées d'entité : bit 0x01 = en feu. */
export function isOnFire(entity: Entity): boolean {
  const flags = entity.metadata?.[0];
  return typeof flags === 'number' && (flags & 0x01) !== 0;
}

export function playerEntity(bot: Bot, username: string): Entity | undefined {
  return bot.players[username]?.entity;
}

/** Noms des mobs hostiles, pour les versions où `entity.type` vaut `mob`. */
export const HOSTILE_MOBS = new Set([
  'zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'creeper', 'spider', 'cave_spider',
  'enderman', 'witch', 'slime', 'magma_cube', 'phantom', 'pillager', 'vindicator', 'evoker',
  'ravager', 'blaze', 'ghast', 'wither_skeleton', 'piglin_brute', 'hoglin', 'zoglin', 'silverfish',
  'endermite', 'guardian', 'elder_guardian', 'vex', 'breeze', 'zombie_villager', 'warden', 'shulker',
]);

export function isHostile(entity: Entity): boolean {
  return entity.type === 'hostile' || (entity.name !== undefined && HOSTILE_MOBS.has(entity.name));
}

/**
 * Oxygène sur 20. `bot.oxygenLevel` de mineflayer alterne entre la valeur brute (ticks d'air, 0..300)
 * et la valeur sur 20 : on lit l'air brut dans les métadonnées (index 1) et on le ramène sur 20.
 */
export function oxygenOf(bot: Bot): number {
  const air = bot.entity?.metadata?.[1];
  if (typeof air === 'number') return normalizeOxygen(air, true);
  return normalizeOxygen(bot.oxygenLevel ?? 20, false);
}

export function normalizeOxygen(value: number, rawTicks: boolean): number {
  const v = rawTicks || value > 20 ? value / 15 : value;
  return Math.max(0, Math.min(20, Math.round(v)));
}
