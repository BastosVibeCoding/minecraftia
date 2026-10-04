import type { Clock } from '../core/clock.js';
import type { Logger } from '../core/logger.js';
import type { RawEvent } from '../observer/types.js';
import type { Db } from '../store/db.js';

export type GapKind = 'ordre' | 'outil' | 'pose';

export interface Gap {
  key: string;
  kind: GapKind;
  label: string;
  example: string;
  count: number;
  lastAt: number;
}

/** Outils tenus par le joueur qu'aucune compétence n'utilise encore. */
const UNSUPPORTED_TOOLS = /^(fishing_rod|bow|crossbow|trident|bucket|water_bucket|lava_bucket|milk_bucket|flint_and_steel|shears|brush|spyglass|bone_meal|lead|name_tag|saddle|elytra|firework_rocket|ender_pearl|potion|splash_potion)$/;

/** Blocs posés par le joueur que la compétence de construction ne sait pas poser correctement. */
const UNSUPPORTED_BLOCKS = /(redstone|repeater|comparator|piston|observer|hopper|dropper|dispenser|lever|_button|pressure_plate|rail|_door|trapdoor|_bed$|fence_gate|_sign$|lantern|banner|carpet|^chest$|^barrel$|^furnace$|anvil|enchanting_table|brewing_stand|cauldron|^ladder$|scaffolding)/;

const norm = (t: string) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Repère automatiquement ce que le bot ne sait pas faire : ordres non exécutés, outils et blocs
 * du joueur qu'aucune compétence ne couvre. Chaque manque est compté ; `!manques` les liste,
 * ce qui indique quelles compétences coder en priorité.
 */
export class GapRecorder {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly logger?: Logger,
  ) {}

  record(kind: GapKind, key: string, label: string, example: string): void {
    const fullKey = `${kind}:${key}`;
    const now = this.clock.now();
    const existing = this.db.prepare('SELECT count FROM skill_gaps WHERE key = ?').get(fullKey) as { count: number } | undefined;
    this.db
      .prepare(
        `INSERT INTO skill_gaps(key, kind, label, example, count, first_at, last_at) VALUES (?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(key) DO UPDATE SET count = count + 1, example = excluded.example, last_at = excluded.last_at`,
      )
      .run(fullKey, kind, label, example.slice(0, 200), now, now);
    if (!existing) this.logger?.info({ kind, label }, `compétence manquante repérée : ${label}`);
  }

  /** Un ordre du joueur n'a pas pu être traduit en action. */
  unfulfilledOrder(order: string): void {
    const key = norm(order).replace(/^(alex|lea|hey|he|dis)\s+/, '');
    if (key) this.record('ordre', key, `ordre non exécuté : « ${order.trim().slice(0, 60)} »`, order);
  }

  /** Événement du joueur suivi : outil en main ou bloc posé hors des compétences connues. */
  observe(e: RawEvent): void {
    if (e.type === 'equip' && e.slot === 'hand' && e.item && UNSUPPORTED_TOOLS.test(e.item)) {
      this.record('outil', e.item, `utilise ${e.item.replace(/_/g, ' ')}`, `${e.player} tient ${e.item}`);
    } else if (e.type === 'block_placed' && UNSUPPORTED_BLOCKS.test(e.block)) {
      this.record('pose', e.block, `pose ${e.block.replace(/_/g, ' ')}`, `${e.player} pose ${e.block}`);
    }
  }

  top(limit = 8): Gap[] {
    const rows = this.db.prepare('SELECT key, kind, label, example, count, last_at FROM skill_gaps ORDER BY count DESC, last_at DESC LIMIT ?').all(limit) as {
      key: string;
      kind: GapKind;
      label: string;
      example: string;
      count: number;
      last_at: number;
    }[];
    return rows.map((r) => ({ key: r.key, kind: r.kind, label: r.label, example: r.example, count: r.count, lastAt: r.last_at }));
  }
}
