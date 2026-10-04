import type { Bot } from 'mineflayer';
import type { Domain } from '../core/types.js';
import { isHostile, playerEntity } from '../bot/mineflayerTypes.js';
import type { StateSnapshot } from '../outcome/outcome.js';
import { topInventory, type WorldState } from './world.js';

function inventoryOf(bot: Bot): Record<string, number> {
  const inv: Record<string, number> = {};
  for (const i of bot.inventory.items()) inv[i.name] = (inv[i.name] ?? 0) + i.count;
  return inv;
}

/** État du monde compact lu depuis mineflayer. */
export function readWorld(bot: Bot, followPlayer: string, activity: Domain[], recent: string[]): WorldState | null {
  const me = bot.entity;
  if (!me?.position) return null;
  const player = playerEntity(bot, followPlayer);
  const threats = Object.values(bot.entities)
    .filter((e) => e !== me && e.position && isHostile(e))
    .map((e) => ({ name: e.name ?? 'inconnu', distance: Math.round(e.position.distanceTo(me.position)) }))
    .filter((t) => t.distance <= 16)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 5);
  const tod = bot.time?.timeOfDay ?? 6000;
  const biome = bot.blockAt(me.position)?.biome?.name ?? null;
  return {
    bot: {
      health: Math.round(bot.health ?? 20),
      food: Math.round(bot.food ?? 20),
      position: { x: Math.round(me.position.x), y: Math.round(me.position.y), z: Math.round(me.position.z) },
      dimension: bot.game?.dimension ?? 'overworld',
      heldItem: bot.heldItem?.name ?? null,
      inventory: topInventory(inventoryOf(bot)),
    },
    player: {
      name: followPlayer,
      online: Boolean(bot.players[followPlayer]),
      distance: player ? Math.round(player.position.distanceTo(me.position)) : null,
      heldItem: player?.heldItem?.name ?? null,
      activity,
      recent: recent.slice(0, 3),
    },
    threats,
    time: tod >= 13000 && tod < 23000 ? 'nuit' : 'jour',
    biome: biome && biome !== 'unknown' ? biome : null,
  };
}

export function snapshotOf(bot: Bot, deaths: number): StateSnapshot {
  return { health: bot.health ?? 0, food: bot.food ?? 0, inventory: inventoryOf(bot), deaths };
}
