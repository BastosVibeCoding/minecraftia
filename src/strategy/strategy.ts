import type { Branch } from '../tree/tree.js';

/**
 * Stratégie de rôle : transforme les branches apprises avant de les présenter au décideur.
 * - `mirror` (défaut) : le bot devient comme le joueur, les branches passent telles quelles.
 * - `complement` : point d'extension (le bot comblerait ce que le joueur ne fait pas) ; non implémenté,
 *   refusé explicitement au démarrage plutôt que simulé.
 */
export interface RoleStrategy {
  readonly name: 'mirror' | 'complement';
  transform(branches: Branch[]): Branch[];
}

export class MirrorStrategy implements RoleStrategy {
  readonly name = 'mirror' as const;
  transform(branches: Branch[]): Branch[] {
    return branches;
  }
}

export class StrategyNotImplementedError extends Error {
  override name = 'StrategyNotImplementedError';
}

export function createStrategy(name: 'mirror' | 'complement'): RoleStrategy {
  if (name === 'mirror') return new MirrorStrategy();
  throw new StrategyNotImplementedError(`stratégie « ${name} » non implémentée : seule « mirror » est disponible`);
}
