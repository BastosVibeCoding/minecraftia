import type { Clock } from '../core/clock.js';
import { getMeta, setMeta, type Db } from '../store/db.js';

const META_KEY = 'play_time_ms';
const PERSIST_EVERY_MS = 30_000;

/**
 * Temps de jeu actif cumulé : n'avance que lorsque le bot est connecté ET que le joueur suivi joue.
 * La décroissance des poids se mesure sur cette horloge : une semaine sans jouer ne fait rien oublier.
 * Persisté dans `meta` pour survivre aux redémarrages.
 */
export class PlayClock {
  private accumulated: number;
  private activeSince: number | null = null;
  private lastPersist = 0;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {
    this.accumulated = Number(getMeta(db, META_KEY) ?? 0);
  }

  get active(): boolean {
    return this.activeSince !== null;
  }

  setActive(active: boolean): void {
    const now = this.clock.now();
    if (active && this.activeSince === null) this.activeSince = now;
    if (!active && this.activeSince !== null) {
      this.accumulated += now - this.activeSince;
      this.activeSince = null;
      this.persist(true);
    }
  }

  /** Millisecondes de jeu actif depuis la création de la mémoire. */
  now(): number {
    const live = this.activeSince === null ? 0 : this.clock.now() - this.activeSince;
    const total = this.accumulated + live;
    this.persist(false, total);
    return total;
  }

  private persist(force: boolean, total = this.accumulated): void {
    const now = this.clock.now();
    if (!force && now - this.lastPersist < PERSIST_EVERY_MS) return;
    this.lastPersist = now;
    setMeta(this.db, META_KEY, String(Math.round(total)));
  }
}
