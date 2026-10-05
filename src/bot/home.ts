import type { Clock } from '../core/clock.js';
import { getMeta, setMeta, type Db } from '../store/db.js';

export type Pos = { x: number; y: number; z: number };

/** Délai avant de reproposer une maison devinée après un refus du joueur. */
const ASK_AGAIN_MS = 6 * 3600_000;

/**
 * La maison du bot : désignée par le joueur (« ici c'est la maison », `!maison`), ou devinée puis
 * confirmée. Autour d'elle, une zone protégée où le bot ne casse rien.
 */
export class HomeStore {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    readonly radius: number,
  ) {}

  get(): Pos | null {
    const raw = getMeta(this.db, 'maison');
    if (!raw) return null;
    try {
      const p = JSON.parse(raw) as Pos;
      return typeof p.x === 'number' && typeof p.y === 'number' && typeof p.z === 'number' ? p : null;
    } catch {
      return null;
    }
  }

  set(p: Pos): Pos {
    const home = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
    setMeta(this.db, 'maison', JSON.stringify(home));
    return home;
  }

  clear(): void {
    this.db.prepare("DELETE FROM meta WHERE key = 'maison'").run();
  }

  /** Dans la zone protégée (même hauteur à 16 blocs près : un jardin, un sous-sol). */
  inZone(p: Pos): boolean {
    const h = this.get();
    if (!h) return false;
    return Math.hypot(p.x - h.x, p.z - h.z) <= this.radius && Math.abs(p.y - h.y) <= 16;
  }

  distance(p: Pos): number | null {
    const h = this.get();
    return h ? Math.hypot(p.x - h.x, p.y - h.y, p.z - h.z) : null;
  }

  /** Le joueur a refusé une maison devinée : on ne repropose pas avant un moment. */
  refuseGuess(): void {
    setMeta(this.db, 'maison:refus', String(this.clock.now()));
  }

  mayAsk(): boolean {
    const refused = getMeta(this.db, 'maison:refus');
    return !this.get() && (refused === undefined || this.clock.now() - Number(refused) >= ASK_AGAIN_MS);
  }
}

/** Blocs qui font une maison : où l'on dort, range et fabrique. */
const HOME_MARKERS: { match: (b: string) => boolean; weight: number; fr: string }[] = [
  { match: (b) => b.endsWith('_bed'), weight: 15, fr: 'un lit' },
  { match: (b) => b === 'chest' || b === 'barrel' || b === 'trapped_chest', weight: 8, fr: 'des coffres' },
  { match: (b) => b === 'crafting_table', weight: 6, fr: 'un établi' },
  { match: (b) => b === 'furnace' || b === 'blast_furnace' || b === 'smoker', weight: 5, fr: 'un four' },
  { match: (b) => b.endsWith('_door'), weight: 4, fr: 'une porte' },
];

/**
 * Devine la maison à partir des blocs posés par les joueurs : le coin (16 blocs) qui en concentre le
 * plus, avec un bonus pour lit, coffres, établi, four et porte. Il faut au moins un lit ou un coffre.
 */
export function guessHome(blocks: (Pos & { block: string })[]): { home: Pos; reason: string } | null {
  if (blocks.length < 10) return null;
  let best: { home: Pos; score: number; markers: Set<string> } | null = null;
  for (const c of blocks) {
    const near = blocks.filter((b) => Math.hypot(b.x - c.x, b.z - c.z) <= 16 && Math.abs(b.y - c.y) <= 8);
    const markers = new Set<string>();
    let score = near.length;
    for (const b of near) {
      const m = HOME_MARKERS.find((x) => x.match(b.block));
      if (m) {
        score += m.weight;
        markers.add(m.fr);
      }
    }
    if (!best || score > best.score) {
      // centre du coin : moyenne des blocs proches (la maison est un lieu, pas un bloc)
      const n = near.length;
      const home = { x: Math.round(near.reduce((s, b) => s + b.x, 0) / n), y: Math.round(near.reduce((s, b) => s + b.y, 0) / n), z: Math.round(near.reduce((s, b) => s + b.z, 0) / n) };
      best = { home, score, markers };
    }
  }
  if (!best || !(best.markers.has('un lit') || best.markers.has('des coffres'))) return null;
  return { home: best.home, reason: [...best.markers].join(', ') };
}

/** « ici c'est la maison », « c'est ici chez nous », « voici notre maison » : désignation par le joueur. */
export function isHomeDesignation(text: string): boolean {
  const t = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return /\b(ici|la|voici|voila)\b.*\b(maison|chez (nous|moi|toi)|base)\b|\b(maison|base)\b.*\b(est |c'est )?ici\b/.test(t) && !/\?/.test(t) && !/\b(rentre|retourne|va|vas|reviens|range)\b/.test(t);
}
