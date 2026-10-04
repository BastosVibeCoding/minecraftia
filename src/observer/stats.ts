import type { Vec3Like } from '../core/types.js';

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function round(v: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** Histogramme trié par fréquence décroissante, avec la part de chaque valeur. */
export function histogram(values: string[]): { value: string; count: number; share: number }[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count, share: round(count / values.length, 2) }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

export function mostCommon(values: (string | undefined | null)[]): string | null {
  const defined = values.filter((v): v is string => typeof v === 'string' && v.length > 0);
  return histogram(defined)[0]?.value ?? null;
}

export interface Box {
  min: Vec3Like;
  max: Vec3Like;
  width: number; // étendue en X
  height: number; // étendue en Y
  depth: number; // étendue en Z
}

export function boundingBox(points: Vec3Like[]): Box {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const p of points) {
    min.x = Math.min(min.x, p.x);
    min.y = Math.min(min.y, p.y);
    min.z = Math.min(min.z, p.z);
    max.x = Math.max(max.x, p.x);
    max.y = Math.max(max.y, p.y);
    max.z = Math.max(max.z, p.z);
  }
  return { min, max, width: max.x - min.x + 1, height: max.y - min.y + 1, depth: max.z - min.z + 1 };
}

/** Corrélation de rang de Spearman (sans ex æquo corrigés : suffisant pour un signal d'ordre). */
export function spearman(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const rank = (arr: number[]) => {
    const idx = arr.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
    const r = new Array<number>(n);
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && idx[j + 1]![0] === idx[i]![0]) j++;
      const avg = (i + j) / 2;
      for (let k = i; k <= j; k++) r[idx[k]![1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i]! - mx) * (ry[i]! - my);
    dx += (rx[i]! - mx) ** 2;
    dy += (ry[i]! - my) ** 2;
  }
  return dx === 0 || dy === 0 ? 0 : num / Math.sqrt(dx * dy);
}

export const key = (p: Vec3Like) => `${p.x},${p.y},${p.z}`;
