import type { Clock } from '../core/clock.js';
import type { Db } from '../store/db.js';

type Pos = { x: number; y: number; z: number };

const key = (p: Pos) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

/**
 * Blocs de construction : presque toujours posés par quelqu'un. Protégés partout, ce qui couvre
 * aussi les constructions antérieures au registre des blocs posés.
 */
const BUILDING_BLOCK =
  /(planks|bricks|_slab$|_stairs$|_wall$|fence|glass|wool$|carpet$|concrete|glazed_terracotta|^(white|orange|magenta|light_blue|yellow|lime|pink|gray|light_gray|cyan|purple|blue|brown|green|red|black)_terracotta$|^polished_|^smooth_|^chiseled_|^cut_|^stripped_|_door$|trapdoor$|torch|lantern|_bed$|^chest$|^trapped_chest$|^barrel$|furnace$|smoker$|crafting_table|bookshelf|^ladder$|^cobblestone$|^mossy_cobblestone$|_sign$|banner$|^hay_block$|^bell$|^anvil$|^scaffolding$|^farmland$)/;

export const isBuildingBlock = (name: string) => BUILDING_BLOCK.test(name);

/**
 * Registre persistant des blocs posés par les joueurs (et l'autre bot) : le bot ne les casse jamais,
 * ni pour passer, ni pour récolter. Un bloc cassé sort du registre.
 */
export class PlacedBlocks {
  private readonly positions = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {
    for (const r of db.prepare('SELECT pos FROM placed_blocks').all() as { pos: string }[]) this.positions.add(r.pos);
  }

  placed(pos: Pos, block: string, player: string): void {
    const k = key(pos);
    this.positions.add(k);
    this.db
      .prepare('INSERT INTO placed_blocks(pos, block, player, at) VALUES (?, ?, ?, ?) ON CONFLICT(pos) DO UPDATE SET block = excluded.block, player = excluded.player, at = excluded.at')
      .run(k, block, player, this.clock.now());
  }

  broken(pos: Pos): void {
    const k = key(pos);
    if (!this.positions.delete(k)) return;
    this.db.prepare('DELETE FROM placed_blocks WHERE pos = ?').run(k);
  }

  has(pos: Pos): boolean {
    return this.positions.has(key(pos));
  }

  /** Tous les blocs posés connus, avec leur nom (pour deviner la maison). */
  all(): { x: number; y: number; z: number; block: string }[] {
    return (this.db.prepare('SELECT pos, block FROM placed_blocks').all() as { pos: string; block: string }[]).map((r) => {
      const [x, y, z] = r.pos.split(',').map(Number) as [number, number, number];
      return { x, y, z, block: r.block };
    });
  }

  /** Blocs posés par ce joueur depuis `since`, du plus récent au plus ancien (pour prolonger ou copier). */
  recentBy(player: string, since: number): { x: number; y: number; z: number; block: string; at: number }[] {
    return (this.db.prepare('SELECT pos, block, at FROM placed_blocks WHERE player = ? AND at >= ? ORDER BY at DESC LIMIT 400').all(player, since) as { pos: string; block: string; at: number }[]).map((r) => {
      const [x, y, z] = r.pos.split(',').map(Number) as [number, number, number];
      return { x, y, z, block: r.block, at: r.at };
    });
  }

  get size(): number {
    return this.positions.size;
  }

  /** Bloc à ne pas casser : posé par un joueur, ou bloc de construction. */
  isProtected(b: { name: string; position: Pos }): boolean {
    return isBuildingBlock(b.name) || this.has(b.position);
  }
}
