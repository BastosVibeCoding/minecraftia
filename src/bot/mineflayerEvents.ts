import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import type { Entity } from 'prismarine-entity';
import { distance } from '../core/types.js';
import type { Vec3Like } from '../core/types.js';
import type { RawEvent } from '../observer/types.js';
import { isHostile, playerEntity } from './mineflayerTypes.js';

const REPLACEABLE = new Set(['air', 'cave_air', 'void_air', 'water', 'lava', 'short_grass', 'tall_grass', 'fern', 'snow']);
const SWING_WINDOW_MS = 450;
const REACH = 6;
const KILL_WINDOW_MS = 4000;
const MOVE_EMIT_DISTANCE = 4;

/**
 * Événements du joueur suivi vus par le bot lui-même.
 * - Toujours : attaques (coup de bras + mob blessé à portée) et mobs tués — Easy LLM ne les fournit pas.
 * - En repli, quand Easy LLM est absent : poses et casses de blocs, déplacements, équipement.
 */
export class MineflayerEventSource {
  private lastSwing = -Infinity;
  /** Blessures de mobs pas encore rattachées à un coup de bras (le serveur envoie souvent la blessure d'abord). */
  private pendingHurts: { entity: Entity; t: number }[] = [];
  private attacked = new Map<number, number>();
  private lastMove: Vec3Like | null = null;
  private equipment: (string | null)[] = [];
  private readonly handlers: [string, (...args: never[]) => void][] = [];

  constructor(
    private readonly bot: Bot,
    private readonly player: string,
    private readonly emit: (e: RawEvent) => void,
    private readonly now: () => number,
    /** Vrai quand Easy LLM ne fournit pas la télémétrie : on attribue alors les blocs nous-mêmes. */
    private readonly fallback: () => boolean,
  ) {}

  start(): void {
    this.on('entitySwingArm', (e: Entity) => {
      if (e.username !== this.player) return;
      this.lastSwing = this.now();
      const pending = this.pendingHurts.filter((h) => this.now() - h.t <= SWING_WINDOW_MS);
      this.pendingHurts = [];
      for (const h of pending) this.recordAttack(h.entity);
    });
    this.on('entityHurt', (e: Entity) => this.onHurt(e));
    this.on('entityDead', (e: Entity) => this.onDead(e));
    this.on('blockUpdate', (oldBlock: Block | null, newBlock: Block) => this.onBlock(oldBlock, newBlock));
    this.on('entityMoved', (e: Entity) => this.onMoved(e));
    this.on('entityEquip', (e: Entity) => this.onEquip(e));
  }

  stop(): void {
    for (const [event, fn] of this.handlers) this.bot.off(event as never, fn as never);
    this.handlers.length = 0;
  }

  private on<A extends unknown[]>(event: string, fn: (...args: A) => void): void {
    const safe = (...args: A) => {
      try {
        fn(...args);
      } catch {
        // un événement mal formé ne doit jamais casser la boucle de mineflayer
      }
    };
    this.bot.on(event as never, safe as never);
    this.handlers.push([event, safe as never]);
  }

  private me(): Entity | undefined {
    return playerEntity(this.bot, this.player);
  }

  private onHurt(e: Entity): void {
    const me = this.me();
    if (!me || e === me || e === this.bot.entity || e.type === 'player') return;
    if (this.now() - this.lastSwing > SWING_WINDOW_MS) {
      this.pendingHurts = this.pendingHurts.filter((h) => this.now() - h.t <= SWING_WINDOW_MS);
      this.pendingHurts.push({ entity: e, t: this.now() });
      return;
    }
    this.recordAttack(e);
  }

  /** Coup du joueur sur un mob, s'il est à portée. */
  private recordAttack(e: Entity): void {
    const me = this.me();
    if (!me) return;
    const d = distance(me.position, e.position);
    if (d > REACH) return;
    this.attacked.set(e.id, this.now());
    const weapon = me.heldItem?.name;
    this.emit({ t: this.now(), type: 'attack', player: this.player, target: e.name ?? 'unknown', targetId: e.id, distance: Math.round(d * 10) / 10, ...(weapon ? { weapon } : {}) });
  }

  private onDead(e: Entity): void {
    const at = this.attacked.get(e.id);
    if (at === undefined) return;
    this.attacked.delete(e.id);
    if (this.now() - at <= KILL_WINDOW_MS && (isHostile(e) || e.type !== 'player')) {
      this.emit({ t: this.now(), type: 'kill', player: this.player, target: e.name ?? 'unknown' });
    }
  }

  private onBlock(oldBlock: Block | null, newBlock: Block): void {
    if (!this.fallback() || !oldBlock) return;
    const me = this.me();
    if (!me || this.now() - this.lastSwing > SWING_WINDOW_MS) return;
    const pos = { x: newBlock.position.x, y: newBlock.position.y, z: newBlock.position.z };
    if (distance(me.position, pos) > REACH) return;
    if (REPLACEABLE.has(oldBlock.name) && !REPLACEABLE.has(newBlock.name)) {
      this.emit({ t: this.now(), type: 'block_placed', player: this.player, pos, block: newBlock.name });
    } else if (!REPLACEABLE.has(oldBlock.name) && REPLACEABLE.has(newBlock.name)) {
      const tool = me.heldItem?.name;
      this.emit({ t: this.now(), type: 'block_broken', player: this.player, pos, block: oldBlock.name, ...(tool ? { tool } : {}) });
    }
  }

  private onMoved(e: Entity): void {
    if (!this.fallback() || e.username !== this.player) return;
    const pos = { x: Math.round(e.position.x), y: Math.round(e.position.y), z: Math.round(e.position.z) };
    if (this.lastMove && distance(pos, this.lastMove) < MOVE_EMIT_DISTANCE) return;
    this.lastMove = pos;
    this.emit({ t: this.now(), type: 'move', player: this.player, pos });
  }

  private onEquip(e: Entity): void {
    if (!this.fallback() || e.username !== this.player) return;
    const slots = ['hand', 'offhand', 'feet', 'legs', 'chest', 'head'] as const;
    slots.forEach((slot, i) => {
      const item = e.equipment[i]?.name ?? null;
      if ((this.equipment[i] ?? null) === item) return;
      this.equipment[i] = item;
      this.emit({ t: this.now(), type: 'equip', player: this.player, slot, item });
    });
  }
}
