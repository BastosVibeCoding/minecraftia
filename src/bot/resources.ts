import type { Clock } from '../core/clock.js';
import type { Db } from '../store/db.js';

type Pos = { x: number; y: number; z: number };

/** Nombre d'endroits gardés par type de bloc (les plus récents). */
const KEEP_PER_BLOCK = 200;
/** Deux endroits plus proches que ça sont le même gisement. */
const SAME_SPOT = 6;

/**
 * Mémoire des ressources : où un joueur (ou l'autre bot) a récolté tel bloc, où le bot en a vu.
 * Quand rien n'est en vue, le bot va d'abord voir à l'endroit connu le plus proche.
 */
export class ResourceMemory {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  remember(block: string, pos: Pos, source: 'récolté' | 'vu'): void {
    const p = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
    // un même gisement n'est noté qu'une fois : on rafraîchit l'endroit déjà connu à côté
    const near = this.db
      .prepare('SELECT x, y, z FROM resource_spots WHERE block = ? AND abs(x - ?) <= ? AND abs(y - ?) <= ? AND abs(z - ?) <= ? LIMIT 1')
      .get(block, p.x, SAME_SPOT, p.y, SAME_SPOT, p.z, SAME_SPOT) as Pos | undefined;
    const at = this.clock.now();
    if (near) {
      this.db.prepare('UPDATE resource_spots SET at = ?, source = ? WHERE block = ? AND x = ? AND y = ? AND z = ?').run(at, source, block, near.x, near.y, near.z);
      return;
    }
    this.db.prepare('INSERT INTO resource_spots(block, x, y, z, source, at) VALUES (?, ?, ?, ?, ?, ?)').run(block, p.x, p.y, p.z, source, at);
    this.db
      .prepare('DELETE FROM resource_spots WHERE block = ? AND rowid NOT IN (SELECT rowid FROM resource_spots WHERE block = ? ORDER BY at DESC LIMIT ?)')
      .run(block, block, KEEP_PER_BLOCK);
  }

  /** Le bloc a disparu à cet endroit (récolté par le bot, gisement épuisé) : on l'oublie. */
  forget(block: string, pos: Pos): void {
    this.db
      .prepare('DELETE FROM resource_spots WHERE block = ? AND abs(x - ?) <= 1 AND abs(y - ?) <= 1 AND abs(z - ?) <= 1')
      .run(block, Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
  }

  /** Endroits connus pour ces blocs, du plus proche au plus loin (dans `maxDistance`), sauf ceux déjà visités. */
  nearest(blocks: string[], from: Pos, maxDistance: number, exclude: Pos[] = []): Pos[] {
    if (blocks.length === 0) return [];
    const rows = this.db.prepare(`SELECT x, y, z FROM resource_spots WHERE block IN (${blocks.map(() => '?').join(',')})`).all(...blocks) as Pos[];
    const d = (a: Pos) => Math.hypot(a.x - from.x, a.y - from.y, a.z - from.z);
    return rows
      .filter((r) => d(r) <= maxDistance && !exclude.some((e) => Math.hypot(e.x - r.x, e.y - r.y, e.z - r.z) <= SAME_SPOT))
      .sort((a, b) => d(a) - d(b));
  }
}
