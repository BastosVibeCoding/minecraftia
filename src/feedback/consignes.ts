import type { Clock } from '../core/clock.js';
import { getMeta, setMeta, type Db } from '../store/db.js';

/** Nombre maximal de consignes gardées (les plus anciennes partent en premier). */
const MAX_CONSIGNES = 20;

export interface Consigne {
  text: string;
  at: number;
}

const norm = (t: string) =>
  t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’`]/g, "'")
    .trim();

/**
 * Consigne durable du joueur (« retiens que… », « à l'avenir… », « je n'aime pas que tu… »,
 * « ne fais plus jamais… ») : à garder d'une partie à l'autre, pas un ordre ponctuel.
 */
export function isStandingInstruction(text: string): boolean {
  const t = norm(text);
  if (t.endsWith('?')) return false;
  return /\b(retiens|souviens[- ]toi|rappelle[- ]toi|n'oublie (pas|jamais)|a l'avenir|desormais|dorenavant|a partir de maintenant|la prochaine fois|je (n'aime|n'veux|ne veux|deteste|veux) pas que tu|j'aime pas que tu|ne \w+ plus jamais|plus jamais de|toujours (mettre|ranger|prendre|faire|utiliser)|mets toujours|range toujours|prends toujours|fais toujours|utilise toujours)\b/.test(t);
}

/** Consignes du joueur, retenues en base et données au modèle à chaque décision. */
export class ConsignesStore {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  all(): Consigne[] {
    try {
      return JSON.parse(getMeta(this.db, 'consignes') ?? '[]') as Consigne[];
    } catch {
      return [];
    }
  }

  add(text: string): void {
    const list = this.all().filter((c) => norm(c.text) !== norm(text));
    list.push({ text: text.trim().slice(0, 200), at: this.clock.now() });
    setMeta(this.db, 'consignes', JSON.stringify(list.slice(-MAX_CONSIGNES)));
  }

  /** Retire la consigne n° `n` (à partir de 1) ; renvoie son texte, ou `null`. */
  remove(n: number): string | null {
    const list = this.all();
    const [removed] = list.splice(n - 1, 1);
    if (!removed) return null;
    setMeta(this.db, 'consignes', JSON.stringify(list));
    return removed.text;
  }

  texts(): string[] {
    return this.all().map((c) => c.text);
  }
}
