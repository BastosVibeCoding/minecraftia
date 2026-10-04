import type { Bot } from 'mineflayer';
import { countItem, goNear, placeNearby } from './extra.js';

export type ToolKind = 'axe' | 'pickaxe';

/** Outil adapté à un bloc : hache pour le bois, pioche pour la pierre et les minerais. */
export function toolFor(block: string): ToolKind | null {
  if (/_(log|stem|wood|hyphae)$/.test(block)) return 'axe';
  if (/(stone|_ore$|deepslate|andesite|diorite|granite|tuff|netherrack|basalt|blackstone|obsidian|calcite)/.test(block)) return 'pickaxe';
  return null;
}

const STONES = ['cobblestone', 'cobbled_deepslate', 'blackstone'];

/** L'inventaire contient déjà un outil de ce type (n'importe quel matériau). */
export function hasTool(items: { name: string }[], kind: ToolKind): boolean {
  return items.some((i) => i.name.endsWith(`_${kind}`));
}

/** Meilleur outil fabricable avec l'inventaire : pierre si 3 pierres, sinon bois si 3 planches. */
export function craftableTier(inventory: Record<string, number>, kind: ToolKind): string | null {
  const planks = Object.entries(inventory).filter(([n]) => n.endsWith('_planks')).reduce((s, [, c]) => s + c, 0);
  const logs = Object.entries(inventory).filter(([n]) => /_(log|stem)$/.test(n)).reduce((s, [, c]) => s + c, 0);
  const wood = planks + 4 * logs; // une bûche donne 4 planches
  const stone = STONES.some((s) => (inventory[s] ?? 0) >= 3);
  // il faut aussi 2 bâtons (2 planches) et un établi (4 planches) si aucun n'est à portée
  if (stone && wood >= 2) return `stone_${kind}`;
  if (wood >= 5) return `wooden_${kind}`;
  return null;
}

async function craftOne(bot: Bot, name: string, table: ReturnType<Bot['findBlock']>): Promise<boolean> {
  const item = bot.registry.itemsByName[name];
  if (!item) return false;
  const recipe = bot.recipesFor(item.id, null, 1, table ?? null)[0];
  if (!recipe) return false;
  try {
    await bot.craft(recipe, 1, table ?? undefined);
    return true;
  } catch {
    return false;
  }
}

/** Planches à partir de n'importe quelle bûche de l'inventaire. */
async function ensurePlanks(bot: Bot, needed: number): Promise<void> {
  const planks = () => bot.inventory.items().filter((i) => i.name.endsWith('_planks')).reduce((s, i) => s + i.count, 0);
  while (planks() < needed) {
    const log = bot.inventory.items().find((i) => /_(log|stem)$/.test(i.name));
    if (!log) return;
    const plankName = log.name.replace(/_(log|stem)$/, '_planks');
    if (!(await craftOne(bot, plankName, null))) return;
  }
}

/**
 * Se refabrique un outil s'il n'en a plus (hache cassée en pleine récolte, pas de pioche pour miner) :
 * planches depuis les bûches, bâtons, établi posé si aucun n'est proche, puis l'outil.
 * Renvoie le nom de l'outil fabriqué, `null` s'il en avait déjà un ou si les matériaux manquent.
 */
export async function ensureTool(bot: Bot, kind: ToolKind, signal: AbortSignal): Promise<string | null> {
  if (hasTool(bot.inventory.items(), kind) || signal.aborted) return null;
  const inv: Record<string, number> = {};
  for (const i of bot.inventory.items()) inv[i.name] = (inv[i.name] ?? 0) + i.count;
  const tool = craftableTier(inv, kind);
  if (!tool) return null;
  const tableId = bot.registry.blocksByName.crafting_table!.id;
  let table = bot.findBlock({ matching: tableId, maxDistance: 16 });
  await ensurePlanks(bot, (tool.startsWith('wooden') ? 3 : 0) + 2 + (table || countItem(bot, 'crafting_table') ? 0 : 4));
  if (countItem(bot, 'stick') < 2 && !(await craftOne(bot, 'stick', null))) return null;
  if (!table) {
    if (countItem(bot, 'crafting_table') === 0 && !(await craftOne(bot, 'crafting_table', null))) return null;
    table = await placeNearby(bot, 'crafting_table');
    if (!table) return null;
  }
  await goNear(bot, table.position, 2, signal);
  if (signal.aborted) return null;
  return (await craftOne(bot, tool, table)) ? tool : null;
}
