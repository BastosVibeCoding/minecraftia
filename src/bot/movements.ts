import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';

const { Movements } = pathfinderPkg;

/** Portes qu'on ouvre à la main (pas les portes en fer, qui demandent de la redstone). */
export const isHandDoor = (name: string) => name.endsWith('_door') && name !== 'iron_door';

/** Coût d'un pas dans l'eau : le bot préfère la terre ferme dès qu'un détour raisonnable existe. */
export const LIQUID_COST = 4;

interface PathBlock {
  name: string;
  safe: boolean;
  physical: boolean;
  openable: boolean;
  getProperties?: () => Record<string, unknown>;
}

/**
 * Règle de passage d'une porte pour le pathfinder :
 * - porte ouverte : traversable telle quelle ;
 * - porte fermée : la moitié basse s'ouvre (« utiliser » le bloc), la moitié haute suit.
 * Le pathfinder d'origine ne connaît que les portillons, et seulement si `canOpenDoors`.
 */
export function adaptDoor(b: PathBlock): void {
  if (!b.name || !isHandDoor(b.name)) return;
  const props = b.getProperties?.() ?? {};
  const open = props.open === true || props.open === 'true';
  if (open || props.half === 'upper') {
    b.safe = true;
    b.physical = false;
    b.openable = false;
  } else {
    b.openable = true;
  }
}

export interface MovementOptions {
  /** Autoriser à creuser pour passer (récolte) ; sinon jamais. */
  canDig?: boolean;
  /** Blocs à ne jamais casser (posés par un joueur, blocs de construction). */
  isProtected?: (b: { name: string; position: { x: number; y: number; z: number } }) => boolean;
}

/**
 * Déplacements des bots : ouverture des portes et portillons, l'eau évitée quand c'est possible,
 * et jamais un bloc protégé cassé, même quand creuser est permis.
 */
export function companionMovements(bot: Bot, opts: MovementOptions = {}): InstanceType<typeof Movements> {
  const m = new Movements(bot);
  m.canDig = opts.canDig ?? false;
  const isProtected = opts.isProtected;
  if (isProtected) {
    const areas = (m as unknown as { exclusionAreasBreak: ((b: { name: string; position: { x: number; y: number; z: number } }) => number)[] }).exclusionAreasBreak;
    areas.push((b) => (isProtected(b) ? 100 : 0));
  }
  m.canOpenDoors = true;
  (m as unknown as { liquidCost: number }).liquidCost = LIQUID_COST;
  const getBlock = m.getBlock.bind(m);
  m.getBlock = (pos, dx, dy, dz) => {
    const b = getBlock(pos, dx, dy, dz) as unknown as PathBlock;
    adaptDoor(b);
    return b as unknown as ReturnType<typeof getBlock>;
  };
  return m;
}
