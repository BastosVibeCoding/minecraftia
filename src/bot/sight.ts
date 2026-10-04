import type { Bot } from 'mineflayer';

type Vec = Bot['entity']['position'];

/** Blocs pleins qui laissent passer la vue : verre, vitres, feuilles, barreaux, clôtures. */
const SEE_THROUGH = /(glass|_pane$|leaves|iron_bars|fence|chain$|scaffolding)/;

/** Ce bloc arrête le regard (bloc plein, opaque). */
export function blocksSight(b: { name: string; boundingBox: string }): boolean {
  return b.boundingBox === 'block' && !SEE_THROUGH.test(b.name);
}

/** Tout près, on sent le monstre même sans le voir (il attaque, il fait du bruit). */
const TOUCH_DISTANCE = 1.5;

interface SightWorld {
  raycast(from: Vec, direction: Vec, range: number, matcher?: (b: { name: string; boundingBox: string }) => boolean): unknown;
}

/**
 * Le bot voit-il cette entité ? Un rayon part de ses yeux vers la tête puis vers les pieds de
 * l'entité : visible si l'un des deux n'est arrêté par aucun bloc opaque. Pas de vision à travers
 * les murs (demande du joueur).
 */
export function canSee(bot: Bot, e: { position: Vec; height?: number }): boolean {
  const eyes = bot.entity.position.offset(0, 1.62, 0);
  const world = bot.world as unknown as SightWorld;
  for (const dy of [(e.height ?? 1.8) * 0.85, 0.3]) {
    const to = e.position.offset(0, dy, 0);
    const d = eyes.distanceTo(to);
    if (d <= TOUCH_DISTANCE) return true;
    const dir = to.minus(eyes).scaled(1 / d);
    try {
      if (!world.raycast(eyes, dir, d, blocksSight)) return true;
    } catch {
      return true; // monde pas encore chargé : on ne masque pas une menace
    }
  }
  return false;
}
