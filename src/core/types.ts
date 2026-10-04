/** Taxonomie des domaines d'activité. Ce ne sont pas des rôles : tous partent à zéro. */
export const DOMAINS = ['build', 'combat', 'mine', 'gather', 'explore', 'craft', 'survive'] as const;
export type Domain = (typeof DOMAINS)[number];

export type ActionStatus = 'success' | 'failure' | 'death' | 'preempted' | 'timeout';

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export function distance(a: Vec3Like, b: Vec3Like): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
