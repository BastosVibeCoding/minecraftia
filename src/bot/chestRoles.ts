import { getMeta, setMeta, type Db } from '../store/db.js';

type Pos = { x: number; y: number; z: number };

const key = (p: Pos) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

/**
 * Rôles des coffres, retenus d'un tri à l'autre : sans mémoire, le rôle (famille dominante) changeait
 * après chaque tri et les objets faisaient des allers-retours (cas réel). Un panneau l'emporte toujours.
 */
export class ChestRoles {
  constructor(private readonly db: Db) {}

  private all(): Record<string, string> {
    try {
      return JSON.parse(getMeta(this.db, 'coffres') ?? '{}') as Record<string, string>;
    } catch {
      return {};
    }
  }

  get(p: Pos): string | null {
    return this.all()[key(p)] ?? null;
  }

  setMany(entries: [Pos, string][]): void {
    const roles = this.all();
    for (const [p, r] of entries) roles[key(p)] = r;
    setMeta(this.db, 'coffres', JSON.stringify(roles));
  }
}
