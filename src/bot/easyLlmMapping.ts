import type { Vec3Like } from '../core/types.js';
import { distance } from '../core/types.js';
import { stripNamespace } from '../observer/blocks.js';
import type { EquipSlot, RawEvent } from '../observer/types.js';
import type { EasyLlmMessage } from './easyLlm.js';

/**
 * Traduction des messages Easy LLM en `RawEvent`. Format relevé sur le vrai mod (capture du
 * 2026-10-04, fixture `test/fixtures/easyllm-capture.jsonl`) :
 * - `players_tick` : position, biome, vie, faim, équipement de chaque joueur ;
 * - `block_break` : bloc cassé, avec joueur et outil (attribution exacte) ;
 * - `block_update` : bloc changé, SANS joueur → pose attribuée au joueur proche qui vient de frapper ;
 * - `swing_hand`, `craft_item`, `chat`, `container_close`.
 * Aucun événement d'attaque n'existe : le combat vient de l'adaptateur mineflayer.
 * Le temps vient du tick serveur (50 ms par tick), recalé sur l'horloge locale au premier message.
 */

const EQUIP_KEYS: Record<string, EquipSlot> = {
  mainhand: 'hand',
  offhand: 'offhand',
  head: 'head',
  chest: 'chest',
  legs: 'legs',
  feet: 'feet',
};

/** Blocs qu'une pose remplace sans que le joueur ait à les casser. */
const REPLACEABLE = new Set(['air', 'cave_air', 'void_air', 'water', 'lava', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'snow', 'dead_bush', 'seagrass', 'vine', 'fire']);

const REACH = 6;
const SWING_WINDOW_TICKS = 8;
const MOVE_EMIT_DISTANCE = 4;

interface PlayerTrack {
  pos: Vec3Like | null;
  lastEmittedPos: Vec3Like | null;
  lastSwingTick: number;
  health: number | null;
  food: number | null;
  equipment: Partial<Record<EquipSlot, string | null>>;
}

type Rec = Record<string, unknown>;

const asRec = (v: unknown): Rec => (v && typeof v === 'object' ? (v as Rec) : {});
const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const asNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function vec(v: unknown): Vec3Like | null {
  if (Array.isArray(v) && v.length >= 3 && v.every((x) => typeof x === 'number')) {
    const [x, y, z] = v as [number, number, number];
    return { x, y, z };
  }
  if (typeof v === 'string') {
    const parts = v.split(',').map(Number);
    if (parts.length >= 3 && parts.every(Number.isFinite)) return { x: parts[0]!, y: parts[1]!, z: parts[2]! };
  }
  const r = asRec(v);
  const x = asNum(r.x);
  const y = asNum(r.y);
  const z = asNum(r.z);
  return x !== undefined && y !== undefined && z !== undefined ? { x, y, z } : null;
}

const blockName = (v: unknown) => stripNamespace(asStr(asRec(v).blockName) ?? 'unknown');

export class EasyLlmMapper {
  private players = new Map<string, PlayerTrack>();
  private baseTick: number | null = null;
  private baseMs = 0;
  /** Messages dont le type n'est pas traduit, par type (pour repérer une évolution du protocole). */
  readonly ignored = new Map<string, number>();

  constructor(private readonly now: () => number) {}

  /** Dernière position connue d'un joueur (pour recentrer la zone de blocs suivie). */
  positionOf(player: string): Vec3Like | null {
    return this.players.get(player)?.pos ?? null;
  }

  map(msg: EasyLlmMessage): RawEvent[] {
    if (msg.type === 'event_batch' && Array.isArray(msg.items)) return msg.items.flatMap((i) => this.map(asRec(i)));
    const type = asStr(msg.type);
    const data = asRec(msg.data);
    const tick = asNum(msg.tick);
    const t = this.timeOf(tick);
    switch (type) {
      case 'players_tick':
        return this.playersTick(data, t);
      case 'swing_hand': {
        const name = asStr(data.playerName);
        if (name && tick !== undefined) this.track(name).lastSwingTick = tick;
        return [];
      }
      case 'block_break': {
        const player = asStr(asRec(data.player).name);
        const pos = vec(data.pos);
        if (!player || !pos) return [];
        const tool = asStr(asRec(data.tool).itemName);
        return [{ t, type: 'block_broken', player, pos, block: blockName(data.block), ...(tool ? { tool: stripNamespace(tool) } : {}) }];
      }
      case 'block_update':
        return this.blockUpdate(data, t, tick);
      case 'craft_item': {
        const player = asStr(data.playerName);
        const item = asStr(data.item);
        if (!player || !item) return [];
        const consumed = Object.fromEntries(Object.entries(asRec(data.consumed)).filter(([, v]) => typeof v === 'number')) as Record<string, number>;
        return [{ t, type: 'craft', player, item: stripNamespace(item), count: asNum(data.count) ?? 1, consumed }];
      }
      case 'chat': {
        const player = asStr(asRec(data.player).name) ?? asStr(data.playerName);
        const message = asStr(data.message);
        return player && message ? [{ t, type: 'chat', player, message }] : [];
      }
      case 'container_close': {
        const player = asStr(data.playerName);
        const pos = vec(data.containerPos) ?? (player ? this.track(player).pos : null);
        if (!player || !pos) return [];
        return [{ t, type: 'container', player, action: 'close', block: stripNamespace(asStr(data.containerBlock) ?? 'container'), pos }];
      }
      case 'player_move_start':
      case 'player_move_end':
      case 'block_snapshot':
      case 'heard_audio_batch':
        return []; // positions couvertes par players_tick ; l'audio est traité par le canal voix
      default:
        if (type) this.ignored.set(type, (this.ignored.get(type) ?? 0) + 1);
        return [];
    }
  }

  private timeOf(tick: number | undefined): number {
    if (tick === undefined) return this.now();
    if (this.baseTick === null || tick < this.baseTick) {
      this.baseTick = tick;
      this.baseMs = this.now();
    }
    return this.baseMs + (tick - this.baseTick) * 50;
  }

  private track(name: string): PlayerTrack {
    let p = this.players.get(name);
    if (!p) {
      p = { pos: null, lastEmittedPos: null, lastSwingTick: -Infinity, health: null, food: null, equipment: {} };
      this.players.set(name, p);
    }
    return p;
  }

  private playersTick(data: Rec, t: number): RawEvent[] {
    const out: RawEvent[] = [];
    for (const raw of Object.values(asRec(data.players))) {
      const p = asRec(raw);
      const name = asStr(p.name);
      if (!name) continue;
      const visible = asRec(p.visible);
      const hidden = asRec(p.hidden);
      const tr = this.track(name);
      const pos = vec(visible.position);
      if (pos) {
        tr.pos = pos;
        if (!tr.lastEmittedPos || distance(pos, tr.lastEmittedPos) >= MOVE_EMIT_DISTANCE) {
          tr.lastEmittedPos = pos;
          const biome = asStr(hidden.biome);
          out.push({ t, type: 'move', player: name, pos, ...(biome ? { biome: stripNamespace(biome) } : {}) });
        }
      }
      const eq = asRec(visible.equipment);
      for (const [key, slot] of Object.entries(EQUIP_KEYS)) {
        const item = asStr(eq[key]) ? stripNamespace(asStr(eq[key])!) : null;
        if ((tr.equipment[slot] ?? null) !== item) {
          tr.equipment[slot] = item;
          out.push({ t, type: 'equip', player: name, slot, item });
        }
      }
      const health = asNum(hidden.health);
      const food = asNum(hidden.food);
      if (health !== undefined && tr.health !== null && health < tr.health) {
        out.push({ t, type: 'damaged', player: name, health, amount: tr.health - health });
      }
      if (food !== undefined && tr.food !== null && food > tr.food && tr.equipment.hand) {
        out.push({ t, type: 'eat', player: name, item: tr.equipment.hand, food: tr.food, ...(health !== undefined ? { health } : {}) });
      }
      if ((health !== undefined && health !== tr.health) || (food !== undefined && food !== tr.food)) {
        out.push({ t, type: 'health', player: name, health: health ?? tr.health ?? 20, ...(food !== undefined ? { food } : {}) });
      }
      if (health !== undefined) tr.health = health;
      if (food !== undefined) tr.food = food;
    }
    return out;
  }

  private blockUpdate(data: Rec, t: number, tick: number | undefined): RawEvent[] {
    const pos = vec(data.pos);
    if (!pos || tick === undefined) return [];
    const oldName = blockName(data.old);
    const newName = blockName(data.new);
    // les casses arrivent déjà attribuées par block_break ; ici on ne garde que les poses
    if (REPLACEABLE.has(newName) || !REPLACEABLE.has(oldName)) return [];
    let best: { name: string; d: number } | null = null;
    for (const [name, tr] of this.players) {
      if (!tr.pos || tick - tr.lastSwingTick > SWING_WINDOW_TICKS || tick < tr.lastSwingTick) continue;
      const d = distance(tr.pos, pos);
      if (d <= REACH && (!best || d < best.d)) best = { name, d };
    }
    return best ? [{ t, type: 'block_placed', player: best.name, pos, block: newName }] : [];
  }
}
