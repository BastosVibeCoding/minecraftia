import type { Vec3Like } from '../core/types.js';

export type Shape = 'wall' | 'floor' | 'path' | 'pillar' | 'enclosure' | 'house' | 'structure';

export interface BlueprintSpec {
  shape: Shape;
  width: number;
  height: number;
  depth: number;
  borderFirst?: boolean;
  /** Laisse une ouverture d'une porte (2 de haut) au milieu du premier côté. */
  door?: boolean;
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(v)));

/**
 * Plan de construction : liste ordonnée de positions relatives (origine = coin bas, X = largeur,
 * Z = profondeur). L'ordre de pose reproduit la façon de faire apprise (bas → haut, contour d'abord).
 * Les dimensions sont bornées pour qu'une décision du LLM ne lance jamais un chantier démesuré.
 */
export function blueprint(spec: BlueprintSpec): Vec3Like[] {
  const w = clamp(spec.width, 1, 16);
  const h = clamp(spec.height, 1, 8);
  const d = clamp(spec.depth, 1, 16);
  const cells: Vec3Like[] = [];

  switch (spec.shape) {
    case 'wall':
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) cells.push({ x, y, z: 0 });
      break;
    case 'floor':
      for (let x = 0; x < w; x++) for (let z = 0; z < d; z++) cells.push({ x, y: 0, z });
      break;
    case 'path':
      for (let x = 0; x < w; x++) for (let z = 0; z < Math.min(d, 2); z++) cells.push({ x, y: 0, z });
      break;
    case 'pillar':
      for (let y = 0; y < h; y++) for (let x = 0; x < Math.min(w, 2); x++) for (let z = 0; z < Math.min(d, 2); z++) cells.push({ x, y, z });
      break;
    case 'enclosure':
    case 'house':
    case 'structure': {
      const ww = Math.max(3, w);
      const dd = Math.max(3, d);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < ww; x++) {
          for (let z = 0; z < dd; z++) {
            const border = x === 0 || x === ww - 1 || z === 0 || z === dd - 1;
            if (!border) continue;
            if (spec.door !== false && z === 0 && x === Math.floor(ww / 2) && y < 2) continue;
            cells.push({ x, y, z });
          }
        }
      }
      if (spec.shape === 'house') for (let x = 0; x < ww; x++) for (let z = 0; z < dd; z++) cells.push({ x, y: h, z });
      break;
    }
  }

  // ordre de pose : toujours couche par couche vers le haut (un bloc posé a besoin d'un support ;
  // « de haut en bas » n'existe qu'avec un échafaudage), contour avant l'intérieur si demandé
  const borderRank = (p: Vec3Like) => {
    if (!spec.borderFirst) return 0;
    const maxX = Math.max(...cells.map((c) => c.x));
    const maxZ = Math.max(...cells.map((c) => c.z));
    return p.x === 0 || p.z === 0 || p.x === maxX || p.z === maxZ ? 0 : 1;
  };
  return [...cells].sort((a, b) => a.y - b.y || borderRank(a) - borderRank(b) || a.x - b.x || a.z - b.z);
}

/** Nombre de blocs nécessaires. */
export function blocksNeeded(spec: BlueprintSpec): number {
  return blueprint(spec).length;
}
