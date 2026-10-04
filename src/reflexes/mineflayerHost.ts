import type { Bot } from 'mineflayer';
import { distance } from '../core/types.js';
import { isHostile, isOnFire, oxygenOf, physicsFlags, playerEntity } from '../bot/mineflayerTypes.js';
import { canSee } from '../bot/sight.js';
import type { ReflexHost } from './engine.js';
import type { SurvivalSnapshot } from './types.js';

const SCAN_DEPTH = 40;
const HOSTILE_SCAN_RADIUS = 16;

/** Construit l'instantané de survie à partir de l'état mineflayer. */
export class MineflayerReflexHost implements ReflexHost {
  constructor(
    private readonly bot: Bot,
    private readonly followPlayer: string,
  ) {}

  onTick(cb: () => void): () => void {
    this.bot.on('physicsTick', cb);
    return () => this.bot.off('physicsTick', cb);
  }

  snapshot(): SurvivalSnapshot | null {
    const bot = this.bot;
    const me = bot.entity;
    if (!me?.position || bot.health === undefined) return null;
    const pos = me.position;
    const flags = physicsFlags(me);
    const eye = bot.blockAt(pos.offset(0, 1.62, 0));
    const hostiles = Object.values(bot.entities)
      .filter((e) => e !== me && e.position && isHostile(e) && distance(e.position, pos) <= HOSTILE_SCAN_RADIUS)
      // pas de vision à travers les murs : seuls les monstres en vue comptent
      .filter((e) => canSee(bot, e))
      .map((e) => ({ name: e.name ?? 'unknown', distance: distance(e.position, pos), position: e.position.clone() }));
    const items = bot.inventory.items();
    const foods = bot.registry.foodsByName;
    const followed = playerEntity(bot, this.followPlayer)?.position;
    return {
      health: bot.health,
      food: bot.food,
      oxygen: oxygenOf(bot),
      position: pos.clone(),
      velocityY: me.velocity.y,
      onGround: me.onGround,
      inLava: Boolean(flags.isInLava),
      onFire: isOnFire(me),
      inWater: Boolean(flags.isInWater),
      headInWater: eye?.name === 'water',
      heightAboveGround: this.heightAboveGround(),
      hostiles,
      hasFood: items.some((i) => foods[i.name] !== undefined),
      hasWaterBucket: items.some((i) => i.name === 'water_bucket'),
      followedPlayer: followed?.clone(),
    };
  }

  private heightAboveGround(): number {
    const exact = this.bot.entity.position;
    const pos = exact.floored();
    for (let dy = 0; dy <= SCAN_DEPTH; dy++) {
      const block = this.bot.blockAt(pos.offset(0, -dy - 1, 0));
      if (!block) return Infinity;
      if (block.boundingBox === 'block' || block.name === 'water') return dy + (exact.y - pos.y);
    }
    return Infinity;
  }
}
