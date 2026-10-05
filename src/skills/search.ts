import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import type { ResourceMemory } from '../bot/resources.js';

const { goals } = pathfinderPkg;

type Pos = { x: number; y: number; z: number };

/** Étapes de recherche autour du point de départ (environ 30 blocs chacune, en étoile puis en diagonale). */
export const SEARCH_LEGS: [number, number][] = [
  [30, 0], [0, 30], [-30, 0], [0, -30], [30, 30], [-30, 30], [-30, -30], [30, -30],
];
/** Distance totale parcourue au maximum pendant une recherche. */
export const SEARCH_MAX_DISTANCE = 150;
/** Distance maximale d'un endroit mémorisé pour qu'on y retourne. */
const MEMORY_RANGE = 300;
/** Délai maximal d'une étape de trajet. */
const LEG_TIMEOUT_MS = 30_000;

const FR: Record<string, string> = {
  sand: 'sable', red_sand: 'sable rouge', gravel: 'gravier', clay: 'argile', dirt: 'terre', stone: 'pierre', cobblestone: 'pierre',
  oak_log: 'bois', birch_log: 'bois', spruce_log: 'bois', jungle_log: 'bois', acacia_log: 'bois', dark_oak_log: 'bois', cherry_log: 'bois', mangrove_log: 'bois',
  coal_ore: 'charbon', deepslate_coal_ore: 'charbon', iron_ore: 'fer', deepslate_iron_ore: 'fer', copper_ore: 'cuivre', deepslate_copper_ore: 'cuivre',
  gold_ore: 'or', deepslate_gold_ore: 'or', diamond_ore: 'diamant', deepslate_diamond_ore: 'diamant', redstone_ore: 'redstone', lapis_ore: 'lapis',
  sugar_cane: 'canne à sucre', pumpkin: 'citrouille', melon: 'pastèque', wheat: 'blé', bamboo: 'bambou', cactus: 'cactus',
};

/** Nom à dire au joueur pour une liste de blocs (« sable », « bois », sinon le nom Minecraft). */
export function blockNameFr(blocks: string[]): string {
  const first = blocks[0] ?? 'ça';
  return FR[first] ?? first.replace(/_/g, ' ');
}

/** Phrase quand rien n'a été trouvé, même après avoir cherché. */
export function notFoundMessage(blocks: string[]): string {
  return `Je n'ai pas trouvé de ${blockNameFr(blocks)} dans le coin, tu peux me montrer où ?`;
}

export interface SearchDeps {
  bot: Bot;
  /** Un bloc utilisable est-il en vue d'ici ? (même filtre que la récolte : pas posé par un joueur…) */
  found: () => boolean;
  names: string[];
  memory?: ResourceMemory | undefined;
  followPlayer: string;
}

async function travel(bot: Bot, goal: InstanceType<typeof goals.GoalNear> | InstanceType<typeof goals.GoalNearXZ>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const stop = () => bot.pathfinder.setGoal(null);
  const timer = setTimeout(stop, LEG_TIMEOUT_MS);
  signal.addEventListener('abort', stop, { once: true });
  try {
    await bot.pathfinder.goto(goal);
  } catch {
    // étape impossible ou trop longue : on cherche quand même d'où on est arrivé
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
  }
}

/**
 * Rien en vue : aller voir aux endroits connus (mémoire), puis chercher par étapes autour du point
 * de départ. Renvoie `true` dès qu'un bloc est en vue ; sinon revient vers le joueur et renvoie `false`.
 */
export async function searchFor(d: SearchDeps, signal: AbortSignal): Promise<boolean> {
  const { bot } = d;
  const start = bot.entity.position.clone();
  const visited: Pos[] = [];
  for (const spot of d.memory?.nearest(d.names, start, MEMORY_RANGE).slice(0, 2) ?? []) {
    await travel(bot, new goals.GoalNear(spot.x, spot.y, spot.z, 4), signal);
    if (signal.aborted) return false;
    if (d.found()) return true;
    // plus rien là-bas : gisement épuisé, on l'oublie
    for (const n of d.names) d.memory?.forget(n, spot);
    visited.push(spot);
  }
  let walked = 0;
  let from: Pos = start;
  for (const [dx, dz] of SEARCH_LEGS) {
    const to = { x: start.x + dx, y: start.y, z: start.z + dz };
    const leg = Math.hypot(to.x - from.x, to.z - from.z);
    if (walked + leg > SEARCH_MAX_DISTANCE) break;
    await travel(bot, new goals.GoalNearXZ(to.x, to.z, 3), signal);
    if (signal.aborted) return false;
    walked += leg;
    from = bot.entity.position;
    if (d.found()) return true;
  }
  // rien trouvé : retour vers le joueur, qui pourra montrer l'endroit
  const player = bot.players[d.followPlayer]?.entity;
  if (player) await travel(bot, new goals.GoalNear(player.position.x, player.position.y, player.position.z, 3), signal);
  return false;
}
