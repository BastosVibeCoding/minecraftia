import type { Vec3Like } from '../core/types.js';
import type { RawEvent } from '../observer/types.js';

/**
 * Joueurs simulés : produisent des journaux d'événements réalistes et déterministes (graine fixe).
 * Servent au test de divergence, aux tests de l'observateur et à la simulation d'une heure de jeu.
 */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    this.s = (this.s * 1664525 + 1013904223) >>> 0;
    return this.s / 4294967296;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)]!;
  }
}

/** Événement sans horodatage ni joueur (distribué sur chaque variante de l'union). */
type EventInput = RawEvent extends infer E ? (E extends RawEvent ? Omit<E, 't' | 'player'> : never) : never;

class Timeline {
  readonly events: RawEvent[] = [];
  constructor(
    readonly player: string,
    public t: number,
  ) {}
  wait(ms: number): void {
    this.t += ms;
  }
  push(e: EventInput): void {
    this.events.push({ ...e, t: this.t, player: this.player } as RawEvent);
  }
}

function walk(tl: Timeline, from: Vec3Like, to: Vec3Like, biome = 'plains'): Vec3Like {
  const steps = Math.max(1, Math.round(Math.hypot(to.x - from.x, to.z - from.z) / 4));
  for (let i = 1; i <= steps; i++) {
    tl.wait(800);
    tl.push({ type: 'move', pos: { x: Math.round(from.x + ((to.x - from.x) * i) / steps), y: to.y, z: Math.round(from.z + ((to.z - from.z) * i) / steps) }, biome });
  }
  return to;
}

/** Mur de `len`×`h` le long de X, posé de bas en haut, rangée par rangée. */
function buildWall(tl: Timeline, origin: Vec3Like, len: number, h: number, block: string): void {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < len; x++) {
      tl.wait(350);
      tl.push({ type: 'block_placed', pos: { x: origin.x + x, y: origin.y + y, z: origin.z }, block });
    }
  }
}

/** Maison w×d×h : murs de contour d'abord (bas → haut), puis toit plein. */
function buildHouse(tl: Timeline, o: Vec3Like, w: number, d: number, h: number, wall: string, roof: string): void {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let z = 0; z < d; z++) {
        const border = x === 0 || x === w - 1 || z === 0 || z === d - 1;
        const door = z === 0 && x === Math.floor(w / 2) && y < 2;
        if (!border || door) continue;
        tl.wait(300);
        tl.push({ type: 'block_placed', pos: { x: o.x + x, y: o.y + y, z: o.z + z }, block: wall });
      }
    }
  }
  for (let x = 0; x < w; x++) {
    for (let z = 0; z < d; z++) {
      tl.wait(300);
      tl.push({ type: 'block_placed', pos: { x: o.x + x, y: o.y + h, z: o.z + z }, block: roof });
    }
  }
}

function gather(tl: Timeline, o: Vec3Like, block: string, n: number, tool: string): void {
  for (let i = 0; i < n; i++) {
    tl.wait(900);
    tl.push({ type: 'block_broken', pos: { x: o.x + (i % 3), y: o.y + Math.floor(i / 3), z: o.z }, block, tool });
  }
}

function craft(tl: Timeline, items: [string, number][]): void {
  for (const [item, count] of items) {
    tl.wait(1500);
    tl.push({ type: 'craft', item, count });
  }
}

function pause(tl: Timeline, ms: number): void {
  tl.wait(ms);
}

/** Joueur bâtisseur : murs en pierre taillée, maisons en chêne, récolte de bois, artisanat de blocs. */
export function builderLog(minutes: number, seed = 7, player = 'Batisseur'): RawEvent[] {
  const rng = new Rng(seed);
  const tl = new Timeline(player, 1_000_000);
  let pos: Vec3Like = { x: 0, y: 64, z: 0 };
  tl.push({ type: 'equip', slot: 'hand', item: 'stone_bricks' });
  const end = tl.t + minutes * 60_000;
  while (tl.t < end) {
    const site = { x: rng.int(-20, 20), y: 64, z: rng.int(-20, 20) };
    pos = walk(tl, pos, site);
    const r = rng.next();
    if (r < 0.4) buildWall(tl, site, rng.pick([5, 7, 9]), rng.pick([3, 4]), 'stone_bricks');
    else if (r < 0.7) buildHouse(tl, site, 5, 5, 3, 'oak_planks', 'spruce_planks');
    else if (r < 0.85) gather(tl, site, 'oak_log', rng.int(6, 12), 'iron_axe');
    else craft(tl, [['oak_planks', 16], ['stone_bricks', 8], ['oak_door', 1]]);
    pause(tl, 12_000);
  }
  return tl.events;
}

/** Joueur combattant : épée et bouclier, engage au contact, se replie bas en vie, fabrique des armes. */
export function fighterLog(minutes: number, seed = 11, player = 'Combattant'): RawEvent[] {
  const rng = new Rng(seed);
  const tl = new Timeline(player, 1_000_000);
  let pos: Vec3Like = { x: 0, y: 64, z: 0 };
  tl.push({ type: 'equip', slot: 'hand', item: 'iron_sword' });
  tl.push({ type: 'equip', slot: 'offhand', item: 'shield' });
  tl.push({ type: 'equip', slot: 'chest', item: 'iron_chestplate' });
  let health = 20;
  let food = 20;
  const end = tl.t + minutes * 60_000;
  while (tl.t < end) {
    pos = walk(tl, pos, { x: pos.x + rng.int(-40, 40), y: 64, z: pos.z + rng.int(-40, 40) }, rng.pick(['plains', 'forest', 'savanna']));
    const r = rng.next();
    if (r < 0.7) {
      const target = rng.pick(['zombie', 'skeleton', 'spider', 'zombie']);
      const hits = rng.int(3, 6);
      const retreat = rng.next() < 0.3;
      for (let i = 0; i < hits; i++) {
        tl.wait(600);
        tl.push({ type: 'attack', target, distance: 2 + rng.next(), weapon: 'iron_sword' });
        if (rng.next() < 0.5) {
          health = Math.max(4, health - rng.int(2, 4));
          tl.wait(200);
          tl.push({ type: 'damaged', health, source: target });
        }
        if (retreat && health <= 8) break;
      }
      if (!retreat || health > 8) {
        tl.wait(300);
        tl.push({ type: 'kill', target });
      } else {
        pos = walk(tl, pos, { x: pos.x - 12, y: 64, z: pos.z - 12 });
      }
      health = Math.min(20, health + 6);
    } else if (r < 0.85) {
      craft(tl, [rng.pick([['iron_sword', 1], ['bow', 1], ['arrow', 16], ['iron_helmet', 1]] as [string, number][])]);
    } else {
      food = rng.int(5, 8);
      tl.wait(1000);
      tl.push({ type: 'eat', item: 'cooked_beef', food, health });
      food = 20;
    }
    pause(tl, 10_000);
  }
  return tl.events;
}
