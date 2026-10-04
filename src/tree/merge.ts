/**
 * Fusion de mécanismes : on retient des préférences, pas des séquences.
 * - nombres : moyenne pondérée par le poids des observations ;
 * - catégories (chaînes, booléens) : décompte pondéré, la valeur dominante devient la préférence ;
 * - listes de chaînes : décompte par élément, on garde les plus fréquents ;
 * - objets : fusion récursive.
 * Les décomptes vivent dans `_stats`, invisible pour le décideur (retiré par `publicMechanism`).
 */
export type Mechanism = { skill: string; [k: string]: unknown };

interface Stats {
  n: number; // poids cumulé
  num: Record<string, number>; // moyennes courantes
  tally: Record<string, Record<string, number>>; // décomptes pondérés
}

const MAX_LIST = 5;

function emptyStats(): Stats {
  return { n: 0, num: {}, tally: {} };
}

function flatten(obj: Record<string, unknown>, prefix = ''): [string, unknown][] {
  const out: [string, unknown][] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (k === '_stats' || v === undefined) continue;
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...flatten(v as Record<string, unknown>, path));
    else out.push([path, v]);
  }
  return out;
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts.slice(0, -1)) {
    if (!cur[p] || typeof cur[p] !== 'object' || Array.isArray(cur[p])) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

function top(tally: Record<string, number>): string {
  return Object.entries(tally).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
}

function decode(token: string): unknown {
  if (token === 'true') return true;
  if (token === 'false') return false;
  if (token === 'null') return null;
  return token.startsWith('s:') ? token.slice(2) : token;
}

function encode(v: unknown): string {
  return typeof v === 'string' ? `s:${v}` : String(v);
}

/** Fusionne une nouvelle observation `incoming` (de poids `w`) dans le mécanisme existant. */
export function mergeMechanism(existing: Mechanism | null, incoming: Mechanism, w: number): Mechanism {
  const prev = (existing?._stats as Stats | undefined) ?? (existing ? seedStats(existing) : emptyStats());
  const stats: Stats = { n: prev.n + w, num: { ...prev.num }, tally: structuredClone(prev.tally) };
  const result: Record<string, unknown> = { skill: incoming.skill };

  for (const [path, value] of flatten(incoming)) {
    if (path === 'skill') continue;
    if (typeof value === 'number') {
      const old = stats.num[path];
      stats.num[path] = old === undefined ? value : (old * prev.n + value * w) / stats.n;
    } else if (Array.isArray(value)) {
      const t = (stats.tally[path] ??= {});
      for (const item of value) {
        const k = typeof item === 'object' ? JSON.stringify(item) : encode(item);
        t[k] = (t[k] ?? 0) + w;
      }
      stats.tally[`${path}#list`] = { yes: 1 };
    } else {
      const t = (stats.tally[path] ??= {});
      const k = encode(value);
      t[k] = (t[k] ?? 0) + w;
    }
  }

  for (const [path, v] of Object.entries(stats.num)) setPath(result, path, Math.round(v * 100) / 100);
  for (const [path, t] of Object.entries(stats.tally)) {
    if (path.endsWith('#list')) continue;
    if (stats.tally[`${path}#list`]) {
      const items = Object.entries(t)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, MAX_LIST)
        .map(([k]) => (k.startsWith('{') || k.startsWith('[') ? JSON.parse(k) : decode(k)));
      setPath(result, path, items);
    } else setPath(result, path, decode(top(t)));
  }
  result._stats = stats;
  return result as Mechanism;
}

/** Reconstruit des statistiques plausibles pour un mécanisme qui n'en a pas (import). */
function seedStats(m: Mechanism): Stats {
  const seeded = mergeMechanism(null, { ...m, _stats: undefined } as Mechanism, 1);
  return seeded._stats as Stats;
}

/** Mécanisme tel que le voit le décideur : sans les décomptes internes. */
export function publicMechanism(m: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!m) return null;
  const { _stats: _ignored, ...rest } = m;
  return rest;
}

/** Ce qui distingue deux mécanismes concurrents d'une même situation. */
export function mechanismSignature(m: Mechanism): string {
  const first = (v: unknown) => (Array.isArray(v) ? String(v[0] ?? '') : String(v ?? ''));
  switch (m.skill) {
    case 'build':
      return `build:${String(m.shape)}`;
    case 'collect':
      return `collect:${first(m.targets ?? m.block)}`;
    case 'attack':
      return `attack:${String(m.style ?? '')}`;
    case 'craft':
      return `craft:${first(m.items)}`;
    default:
      return m.skill;
  }
}

/**
 * Clé d'action comparable entre une décision (compétence + paramètres) et un mécanisme appris :
 * sert à refuser une décision qui reproduirait un mécanisme corrigé par le joueur.
 */
export function actionKey(skill: string, p: Record<string, unknown>): string {
  const first = (v: unknown) => (Array.isArray(v) ? String(v[0] ?? '') : String(v ?? ''));
  switch (skill) {
    case 'build':
      return `build:${String(p.shape)}:${String(p.material)}`;
    case 'collect':
      return `collect:${first(p.blocks ?? p.targets ?? p.block)}`;
    case 'attack':
      return `attack:${first(p.targets)}`;
    case 'craft':
      return `craft:${first(p.item ?? p.items)}`;
    default:
      return skill;
  }
}
