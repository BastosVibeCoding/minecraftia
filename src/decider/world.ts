import { createHash } from 'node:crypto';
import type { Domain, Vec3Like } from '../core/types.js';

/** État du monde compact (≈ 300 tokens) envoyé au décideur. */
export interface WorldState {
  bot: {
    health: number;
    food: number;
    position: Vec3Like;
    dimension: string;
    heldItem: string | null;
    inventory: Record<string, number>;
  };
  player: {
    name: string;
    online: boolean;
    distance: number | null;
    heldItem: string | null;
    /** Activités en cours du joueur (épisodes ouverts dans l'observateur). */
    activity: Domain[];
    /** Résumés des derniers épisodes observés, du plus récent au plus ancien. */
    recent: string[];
  };
  threats: { name: string; distance: number }[];
  time: 'jour' | 'nuit';
  biome: string | null;
}

const ACTIVITY_FR: Record<Domain, string> = {
  build: 'construit',
  mine: 'mine',
  gather: 'récolte',
  combat: 'combat',
  explore: 'explore',
  craft: 'fabrique',
  survive: 'gère sa survie',
};

/** Description textuelle de la situation, utilisée pour retrouver les branches proches dans l'arbre. */
export function describeSituation(w: WorldState, order?: string): string {
  const parts: string[] = [];
  if (order) parts.push(order);
  if (w.threats.length > 0) parts.push(`un ${w.threats[0]!.name} approche, combattre ${w.threats[0]!.name}`);
  if (w.player.activity.length > 0) parts.push(`le joueur ${w.player.activity.map((a) => ACTIVITY_FR[a]).join(' et ')}`);
  if (w.player.recent[0]) parts.push(w.player.recent[0]);
  if (w.bot.food <= 8) parts.push('avoir faim');
  if (parts.length === 0) parts.push('le joueur est inactif près de la base, que faire');
  parts.push(w.time === 'nuit' ? 'la nuit' : 'le jour');
  if (w.biome) parts.push(`biome ${w.biome.replace(/_/g, ' ')}`);
  return parts.join(' ; ');
}

/** Résumé d'inventaire limité aux objets les plus nombreux. */
export function topInventory(inv: Record<string, number>, n = 15): Record<string, number> {
  return Object.fromEntries(Object.entries(inv).sort((a, b) => b[1] - a[1]).slice(0, n));
}

const level = (v: number) => (v >= 15 ? 'ok' : v >= 8 ? 'moyen' : 'bas');

/**
 * Signature d'une situation, quantifiée pour que deux situations quasi identiques partagent la même
 * entrée de cache : vie et faim par paliers, menaces par type, activité, branches retenues, autonomie.
 */
export function situationHash(w: WorldState, branchIds: number[], bands: Record<string, string>): string {
  const q = {
    hp: level(w.bot.health),
    food: level(w.bot.food),
    threats: [...new Set(w.threats.map((t) => t.name))].sort(),
    activity: [...w.player.activity].sort(),
    recent: w.player.recent[0] ?? null,
    time: w.time,
    inv: Object.keys(topInventory(w.bot.inventory, 8)).sort(),
    branches: [...branchIds].sort((a, b) => a - b),
    bands,
  };
  return createHash('sha1').update(JSON.stringify(q)).digest('hex').slice(0, 16);
}
