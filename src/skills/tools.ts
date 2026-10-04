import type { Bot } from 'mineflayer';
import { countItem, goNear, placeNearby } from './extra.js';

export type ToolKind = 'axe' | 'pickaxe' | 'shovel' | 'hoe';

/** Outil conseillé pour un bloc (même quand la main suffit) : hache pour le bois, pioche pour la pierre. */
export function toolFor(block: string): ToolKind | null {
  if (/_(log|stem|wood|hyphae)$/.test(block)) return 'axe';
  if (/(stone|_ore$|deepslate|andesite|diorite|granite|tuff|netherrack|basalt|blackstone|obsidian|calcite)/.test(block)) return 'pickaxe';
  if (/^(dirt|grass_block|sand|red_sand|gravel|clay|mud|soul_sand|soul_soil|snow_block|podzol|mycelium)$/.test(block)) return 'shovel';
  return null;
}

/** Matériaux par niveau d'outil, du moins cher au plus cher (l'or, fragile, est laissé de côté). */
const TIERS = [
  { tier: 'wooden', fr: 'en bois', material: 'planches', matches: (n: string) => n.endsWith('_planks') },
  { tier: 'stone', fr: 'en pierre', material: 'pavés', matches: (n: string) => n === 'cobblestone' || n === 'cobbled_deepslate' || n === 'blackstone' },
  { tier: 'iron', fr: 'en fer', material: 'lingots de fer', matches: (n: string) => n === 'iron_ingot' },
  { tier: 'diamond', fr: 'en diamant', material: 'diamants', matches: (n: string) => n === 'diamond' },
] as const;

const KIND_FR: Record<ToolKind, string> = { axe: 'une hache', pickaxe: 'une pioche', shovel: 'une pelle', hoe: 'une houe' };
const BLOCK_FR: Record<string, string> = {
  iron_ore: 'du fer', deepslate_iron_ore: 'du fer', gold_ore: "de l'or", deepslate_gold_ore: "de l'or", diamond_ore: 'du diamant', deepslate_diamond_ore: 'du diamant',
  redstone_ore: 'de la redstone', deepslate_redstone_ore: 'de la redstone', lapis_ore: 'du lapis', deepslate_lapis_ore: 'du lapis', emerald_ore: "de l'émeraude",
  deepslate_emerald_ore: "de l'émeraude", copper_ore: 'du cuivre', deepslate_copper_ore: 'du cuivre', coal_ore: 'du charbon', deepslate_coal_ore: 'du charbon', obsidian: "de l'obsidienne",
  stone: 'de la pierre', oak_log: 'du bois',
};

/** Unités de matériau par outil (3 têtes ; 2 pour la houe, 1 pour la pelle). */
const HEAD: Record<ToolKind, number> = { axe: 3, pickaxe: 3, shovel: 1, hoe: 2 };

type Inventory = Record<string, number>;

/** Outils capables de récolter ce bloc (`harvestTools` de minecraft-data) ; `null` = la main suffit. */
export function requiredTools(bot: Bot, block: string): string[] | null {
  const b = bot.registry.blocksByName[block] as { harvestTools?: Record<string, boolean> } | undefined;
  if (!b?.harvestTools) return null;
  return Object.keys(b.harvestTools).map((id) => bot.registry.items[Number(id)]?.name).filter((n): n is string => Boolean(n));
}

export function hasTool(items: { name: string }[], kind: ToolKind): boolean {
  return items.some((i) => i.name.endsWith(`_${kind}`));
}

/**
 * Plan d'outillage pour un bloc : outil déjà en main, outil à fabriquer avec ce qu'on a, ou ce qui
 * manque (formulé pour le joueur). `allowed` : noms d'outils acceptés (null = n'importe quel niveau).
 */
export function toolPlan(inventory: Inventory, kind: ToolKind, allowed: string[] | null, tableAvailable: boolean): { have: string } | { craft: string } | { missing: string } {
  const ok = (name: string) => allowed === null || allowed.includes(name);
  const owned = Object.keys(inventory).find((n) => n.endsWith(`_${kind}`) && ok(n));
  if (owned) return { have: owned };
  const count = (m: (n: string) => boolean) => Object.entries(inventory).filter(([n]) => m(n)).reduce((s, [, c]) => s + c, 0);
  const planks = count((n) => n.endsWith('_planks')) + 4 * count((n) => /_(log|stem)$/.test(n));
  const sticks = count((n) => n === 'stick');
  // bois nécessaire en plus de la tête : 2 bâtons (2 planches) si besoin, 4 planches d'établi si aucun n'est là
  const extraWood = (sticks >= 2 ? 0 : 2) + (tableAvailable || (inventory.crafting_table ?? 0) > 0 ? 0 : 4);
  const candidates = TIERS.filter((t) => ok(`${t.tier}_${kind}`));
  for (const t of candidates) {
    const head = HEAD[kind];
    const enough = t.tier === 'wooden' ? planks >= head + extraWood : count(t.matches) >= head && planks >= extraWood;
    if (enough) return { craft: `${t.tier}_${kind}` };
  }
  const cheapest = candidates[0];
  if (!cheapest) return { missing: `${KIND_FR[kind]} adaptée` };
  return { missing: `${KIND_FR[kind]} ${cheapest.fr} ou ${HEAD[kind]} ${cheapest.material}` };
}

/** Demande à formuler au joueur quand rien n'est disponible. */
export function askForTool(block: string, missing: string): string {
  return `Pour récolter ${BLOCK_FR[block] ?? block.replace(/_/g, ' ')}, il me faut ${missing}. Je n'en ai pas, ni dans les coffres à côté : tu peux m'en donner ?`;
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

async function ensurePlanks(bot: Bot, needed: number): Promise<void> {
  const planks = () => bot.inventory.items().filter((i) => i.name.endsWith('_planks')).reduce((s, i) => s + i.count, 0);
  while (planks() < needed) {
    const log = bot.inventory.items().find((i) => /_(log|stem)$/.test(i.name));
    if (!log || !(await craftOne(bot, log.name.replace(/_(log|stem)$/, '_planks'), null))) return;
  }
}

function inventoryOf(bot: Bot): Inventory {
  const inv: Inventory = {};
  for (const i of bot.inventory.items()) inv[i.name] = (inv[i.name] ?? 0) + i.count;
  return inv;
}

/** Va chercher dans les coffres proches un outil accepté, ou de quoi en fabriquer un. */
async function fetchFromChests(bot: Bot, kind: ToolKind, allowed: string[] | null, signal: AbortSignal): Promise<void> {
  const ids = ['chest', 'barrel', 'trapped_chest'].map((n) => bot.registry.blocksByName[n]?.id).filter((id): id is number => id !== undefined);
  const chests = bot.findBlocks({ matching: ids, maxDistance: 16, count: 3 });
  const ok = (name: string) => allowed === null || allowed.includes(name);
  const wanted = (name: string) =>
    (name.endsWith(`_${kind}`) && ok(name)) || name === 'stick' || name.endsWith('_planks') || /_(log|stem)$/.test(name) || TIERS.some((t) => t.tier !== 'wooden' && ok(`${t.tier}_${kind}`) && t.matches(name));
  for (const pos of chests) {
    if (signal.aborted) return;
    const block = bot.blockAt(pos);
    if (!block) continue;
    await goNear(bot, pos, 2, signal);
    try {
      const window = await bot.openContainer(block);
      try {
        const tool = window.containerItems().find((i) => i.name.endsWith(`_${kind}`) && ok(i.name));
        if (tool) {
          await window.withdraw(tool.type, null, 1);
          return;
        }
        for (const it of window.containerItems().filter((i) => wanted(i.name)).slice(0, 4)) await window.withdraw(it.type, null, Math.min(it.count, 8));
      } finally {
        window.close();
      }
    } catch {
      // coffre inaccessible : on passe au suivant
    }
    if (toolPlanFor(bot, kind, allowed) !== 'missing') return;
  }
}

function toolPlanFor(bot: Bot, kind: ToolKind, allowed: string[] | null): 'have' | 'craft' | 'missing' {
  const table = bot.findBlock({ matching: bot.registry.blocksByName.crafting_table!.id, maxDistance: 16 });
  const plan = toolPlan(inventoryOf(bot), kind, allowed, Boolean(table));
  return 'have' in plan ? 'have' : 'craft' in plan ? 'craft' : 'missing';
}

/**
 * Outil pour récolter un bloc : déjà dans l'inventaire, sinon fabriqué (planches, bâtons, établi posé
 * si besoin), sinon pris dans un coffre proche puis fabriqué. Renvoie `{ ok: false, ask }` quand il
 * faut le demander au joueur ; `{ ok: true }` aussi quand la main suffit et qu'aucun outil n'est possible.
 */
export async function ensureHarvestTool(bot: Bot, block: string, signal: AbortSignal): Promise<{ ok: true; crafted?: string } | { ok: false; ask: string }> {
  const kind = toolFor(block);
  const allowed = requiredTools(bot, block);
  if (!kind) return { ok: true };
  const tableBlock = () => bot.findBlock({ matching: bot.registry.blocksByName.crafting_table!.id, maxDistance: 16 });
  let plan = toolPlan(inventoryOf(bot), kind, allowed, Boolean(tableBlock()));
  if ('have' in plan) return { ok: true };
  if ('missing' in plan) {
    await fetchFromChests(bot, kind, allowed, signal);
    plan = toolPlan(inventoryOf(bot), kind, allowed, Boolean(tableBlock()));
    if ('have' in plan) return { ok: true };
    // la main suffit (bûches, terre) : on continue sans outil, sans déranger le joueur
    if ('missing' in plan) return allowed === null ? { ok: true } : { ok: false, ask: askForTool(block, plan.missing) };
  }
  const tool = plan.craft;
  let table = tableBlock();
  await ensurePlanks(bot, (tool.startsWith('wooden') ? HEAD[kind] : 0) + 2 + (table || countItem(bot, 'crafting_table') ? 0 : 4));
  if (countItem(bot, 'stick') < 2 && !(await craftOne(bot, 'stick', null))) return allowed === null ? { ok: true } : { ok: false, ask: askForTool(block, `${KIND_FR[kind]}`) };
  if (!table) {
    if (countItem(bot, 'crafting_table') === 0) await craftOne(bot, 'crafting_table', null);
    table = await placeNearby(bot, 'crafting_table');
  }
  if (table) await goNear(bot, table.position, 2, signal);
  if (table && !signal.aborted && (await craftOne(bot, tool, table))) return { ok: true, crafted: tool };
  const tier = TIERS.find((t) => tool.startsWith(`${t.tier}_`));
  return allowed === null ? { ok: true } : { ok: false, ask: askForTool(block, `${KIND_FR[kind]}${tier ? ` ${tier.fr}` : ''}`) };
}
