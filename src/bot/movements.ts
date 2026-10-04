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

/**
 * Déplacements des bots : jamais de minage pour passer, ouverture des portes et portillons,
 * l'eau évitée quand c'est possible.
 */
export function companionMovements(bot: Bot): InstanceType<typeof Movements> {
  const m = new Movements(bot);
  m.canDig = false;
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
