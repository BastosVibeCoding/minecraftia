import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import pathfinderPkg from 'mineflayer-pathfinder';
import { z } from 'zod';
import { abortableSleep } from '../core/abort.js';
import type { Domain } from '../core/types.js';
import type { ActionRunOutput } from './actionController.js';
import type { SkillContext } from './library.js';

const { goals } = pathfinderPkg;

const fail = (reason: string, extra: Record<string, unknown> = {}): ActionRunOutput => ({ status: 'failure', detail: { reason, ...extra } });

export function countItem(bot: Bot, name: string): number {
  return bot.inventory.items().filter((i) => i.name === name).reduce((s, i) => s + i.count, 0);
}

export async function goNear(bot: Bot, b: { x: number; y: number; z: number }, range: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const onAbort = () => bot.pathfinder.setGoal(null);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await bot.pathfinder.goto(new goals.GoalNear(b.x, b.y, b.z, range));
  } catch {
    // trajet impossible ou interrompu : l'appelant constate le résultat
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** Bloc nommé le plus proche (dans `maxDistance`). */
function nearest(bot: Bot, names: string[], maxDistance = 16): Block | null {
  const ids = names.map((n) => bot.registry.blocksByName[n]?.id).filter((id): id is number => id !== undefined);
  return ids.length ? bot.findBlock({ matching: ids, maxDistance }) : null;
}

/** Pose un bloc de l'inventaire à côté du bot (sur le sol), pour le four ou le coffre manquant. */
export async function placeNearby(bot: Bot, itemName: string): Promise<Block | null> {
  return placeAround(bot, itemName, bot.entity.position.floored(), [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]]);
}

/** Pose un bloc de l'inventaire sur la première case libre (sol solide dessous) autour de `center`. */
export async function placeAround(bot: Bot, itemName: string, center: Bot['entity']['position'], offsets: number[][]): Promise<Block | null> {
  const item = bot.inventory.items().find((i) => i.name === itemName);
  if (!item) return null;
  for (const [dx, dz] of offsets) {
    const target = center.offset(dx!, 0, dz!);
    const ground = bot.blockAt(target.offset(0, -1, 0));
    const here = bot.blockAt(target);
    if (!ground || ground.boundingBox !== 'block' || !here || here.boundingBox !== 'empty') continue;
    try {
      await bot.equip(item, 'hand');
      await bot.placeBlock(ground, ground.position.minus(ground.position).offset(0, 1, 0));
      return bot.blockAt(target);
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Prend dans les coffres proches (3 au plus, 16 blocs) les objets voulus, jusqu'à `max`.
 * Renvoie le nombre d'objets pris.
 */
export async function withdrawFromChests(bot: Bot, wanted: (name: string) => boolean, max: number, signal: AbortSignal): Promise<number> {
  const ids = ['chest', 'barrel', 'trapped_chest'].map((n) => bot.registry.blocksByName[n]?.id).filter((id): id is number => id !== undefined);
  let got = 0;
  for (const pos of bot.findBlocks({ matching: ids, maxDistance: CHEST_RADIUS, count: 8 })) {
    if (signal.aborted || got >= max) break;
    const chest = bot.blockAt(pos);
    if (!chest) continue;
    await goNear(bot, pos, 2, signal);
    try {
      const window = await bot.openContainer(chest);
      try {
        for (const it of window.containerItems().filter((i) => wanted(i.name))) {
          if (got >= max) break;
          const n = Math.min(it.count, max - got);
          await window.withdraw(it.type, null, n);
          got += n;
        }
      } finally {
        window.close();
      }
    } catch {
      // coffre inaccessible : on passe au suivant
    }
  }
  return got;
}

const SEEDS: Record<string, string> = { wheat_seeds: 'wheat', carrot: 'carrots', potato: 'potatoes', beetroot_seeds: 'beetroots' };

/** Planter : sème sur une terre labourée libre ; laboure d'abord la terre voisine si une houe est disponible. */
export const plant = {
  name: 'plant',
  domain: 'gather' as Domain,
  description: 'plant {seed: wheat_seeds|carrot|potato|beetroot_seeds, count: 1-32} — semer (laboure la terre avec une houe si besoin)',
  params: z.object({ seed: z.enum(['wheat_seeds', 'carrot', 'potato', 'beetroot_seeds']), count: z.number().int().min(1).max(32).default(8) }),
  timeoutMs: (p: { count: number }) => Math.min(180_000, 10_000 + 5_000 * p.count),
  async run(ctx: SkillContext, p: { seed: string; count: number }, signal: AbortSignal): Promise<ActionRunOutput> {
    const { bot } = ctx;
    if (countItem(bot, p.seed) === 0) return fail(`pas de ${p.seed}`, { precondition: true });
    const hoe = bot.inventory.items().find((i) => i.name.endsWith('_hoe'));
    let planted = 0;
    for (let n = 0; n < p.count && !signal.aborted; n++) {
      const farmland = bot.findBlock({
        matching: bot.registry.blocksByName.farmland!.id,
        maxDistance: 16,
        useExtraInfo: (b) => bot.blockAt(b.position.offset(0, 1, 0))?.name === 'air',
      });
      let soil: Block | null = farmland;
      if (!soil && hoe) {
        const dirt = bot.findBlock({
          matching: ['dirt', 'grass_block'].map((x) => bot.registry.blocksByName[x]!.id),
          maxDistance: 8,
          useExtraInfo: (b) => bot.blockAt(b.position.offset(0, 1, 0))?.name === 'air',
        });
        if (dirt) {
          await goNear(bot, dirt.position, 3, signal);
          await bot.equip(hoe, 'hand');
          ctx.touch?.(dirt.position);
          await bot.activateBlock(dirt).catch(() => undefined);
          await abortableSleep(250, signal);
          soil = bot.blockAt(dirt.position);
          if (soil?.name !== 'farmland') soil = null;
        }
      }
      if (!soil) break;
      await goNear(bot, soil.position, 3, signal);
      const seed = bot.inventory.items().find((i) => i.name === p.seed);
      if (!seed || signal.aborted) break;
      try {
        await bot.equip(seed, 'hand');
        ctx.touch?.(soil.position.offset(0, 1, 0));
        await bot.placeBlock(soil, soil.position.minus(soil.position).offset(0, 1, 0));
        if (bot.blockAt(soil.position.offset(0, 1, 0))?.name === SEEDS[p.seed]) planted++;
      } catch {
        break;
      }
    }
    if (planted > 0) return { status: 'success', detail: { planted } };
    return fail(hoe ? 'aucune terre à semer' : 'aucune terre labourée et pas de houe', { precondition: true });
  },
};

/** Cuire au four : utilise un four proche (ou en pose un), attend la cuisson, reprend le résultat. */
/** Combustibles acceptés, du meilleur au moins bon. */
const FUELS = ['coal', 'charcoal', 'coal_block', 'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'cherry_log', 'mangrove_log', 'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'stick'];

export const smelt = {
  name: 'smelt',
  domain: 'craft' as Domain,
  description: 'smelt {item: objet à cuire (raw_iron, raw_gold, beef, porkchop, sand…), count: 1-16, fuel?: coal|charcoal|oak_planks…} — cuire au four',
  params: z.object({ item: z.string().min(1), count: z.number().int().min(1).max(16).default(4), fuel: z.string().optional() }),
  timeoutMs: (p: { count: number }) => 30_000 + 11_000 * p.count,
  async run(ctx: SkillContext, p: { item: string; count: number; fuel?: string }, signal: AbortSignal): Promise<ActionRunOutput> {
    const { bot } = ctx;
    const input = bot.registry.itemsByName[p.item];
    if (!input) return fail(`objet inconnu : ${p.item}`, { precondition: true });
    if (countItem(bot, p.item) === 0) await withdrawFromChests(bot, (n) => n === p.item, p.count, signal);
    if (countItem(bot, p.item) === 0) return fail(`pas de ${p.item}, ni sur moi ni dans les coffres`, { precondition: true });
    const fuels = p.fuel ? [p.fuel] : FUELS;
    let fuelName = fuels.find((f) => countItem(bot, f) > 0);
    // pas de combustible sur soi : on en cherche dans les coffres, sinon on le demande au joueur
    if (!fuelName && (await withdrawFromChests(bot, (n) => fuels.includes(n), 16, signal)) > 0) fuelName = fuels.find((f) => countItem(bot, f) > 0);
    if (!fuelName) {
      ctx.speak?.("Il me faut du combustible pour le four (du charbon ou du bois). Je n'en ai pas, ni dans les coffres à côté : tu peux m'en donner ?");
      return fail('pas de combustible', { precondition: true });
    }
    let furnace = nearest(bot, ['furnace'], 16);
    if (!furnace) furnace = await placeNearby(bot, 'furnace');
    if (!furnace) return fail('aucun four', { precondition: true });
    await goNear(bot, furnace.position, 2, signal);
    const window = await bot.openFurnace(furnace);
    try {
      const count = Math.min(p.count, countItem(bot, p.item));
      // four déjà occupé (cas réel : « destination full ») : on récupère ce qui a cuit et ce qui
      // attend dans l'entrée s'il s'agit d'autre chose ; un autre combustible déjà en place sert tel quel
      if (window.outputItem()) await window.takeOutput().catch(() => null);
      const waiting = window.inputItem();
      if (waiting && waiting.type !== input.id) await window.takeInput().catch(() => null);
      const fuelPerItem = fuelName.includes('coal') ? 1 / 8 : fuelName.endsWith('_log') || fuelName.endsWith('_planks') ? 1 / 1.5 : 1;
      const loaded = window.fuelItem();
      if (!loaded || loaded.type === bot.registry.itemsByName[fuelName]!.id) {
        await window.putFuel(bot.registry.itemsByName[fuelName]!.id, null, Math.min(countItem(bot, fuelName), Math.max(1, Math.ceil(count * fuelPerItem))));
      }
      await window.putInput(input.id, null, count);
      let taken = 0;
      const deadline = Date.now() + 11_000 * count + 5_000;
      while (!signal.aborted && taken < count && Date.now() < deadline) {
        await abortableSleep(1000, signal);
        const out = window.outputItem();
        if (out && out.count > 0) {
          const got = await window.takeOutput().catch(() => null);
          taken += got?.count ?? 0;
        }
      }
      return taken > 0 ? { status: 'success', detail: { smelted: taken } } : fail('cuisson sans résultat');
    } finally {
      window.close();
    }
  },
};

/** Outils, armes, armure et torches : le bot les garde (ni rangés, ni donnés sans le demander). */
export const isEquipment = (name: string) => /_(sword|axe|pickaxe|shovel|hoe|helmet|chestplate|leggings|boots)$|^(shield|bow|crossbow|torch)$/.test(name);

/** Récupérer ce qui a cuit dans le four le plus proche (« récupère le fer dans le four »). */
export const furnaceTake = {
  name: 'furnace_take',
  domain: 'craft' as Domain,
  description: 'furnace_take {} — récupérer ce qui a cuit (lingots, nourriture…) dans tous les fours proches',
  params: z.object({}),
  timeoutMs: () => 60_000,
  async run(ctx: SkillContext, _p: Record<string, never>, signal: AbortSignal): Promise<ActionRunOutput> {
    const { bot } = ctx;
    const ids = ['furnace', 'blast_furnace', 'smoker'].map((n) => bot.registry.blocksByName[n]?.id).filter((id): id is number => id !== undefined);
    // « récupère le fer dans les trois fours » : tous les fours à portée, du plus proche au plus loin
    const furnaces = bot.findBlocks({ matching: ids, maxDistance: 24, count: 8 });
    if (furnaces.length === 0) return fail('aucun four à portée', { precondition: true });
    const taken: Record<string, number> = {};
    for (const pos of furnaces) {
      if (signal.aborted) break;
      const furnace = bot.blockAt(pos);
      if (!furnace) continue;
      await goNear(bot, pos, 2, signal);
      if (signal.aborted) break;
      try {
        const window = await bot.openFurnace(furnace);
        try {
          const out = window.outputItem();
          if (out && out.count > 0) {
            const got = await window.takeOutput();
            taken[out.name] = (taken[out.name] ?? 0) + (got?.count ?? out.count);
          }
        } finally {
          window.close();
        }
      } catch {
        // four inaccessible : on passe au suivant
      }
    }
    const total = Object.values(taken).reduce((s, n) => s + n, 0);
    if (total === 0) return fail(furnaces.length > 1 ? `les ${furnaces.length} fours sont vides` : 'le four est vide', { precondition: true });
    return { status: 'success', detail: { taken, furnaces: furnaces.length } };
  },
};

/** Distance de recherche du coffre pour ranger ou reprendre (16 blocs ne suffisaient pas, cas réel). */
const CHEST_RADIUS = 32;

/** Ranger dans le coffre le plus proche (tout, ou les objets demandés), en gardant outils, armes et nourriture. */
/** Famille d'un objet, pour ranger avec ses semblables (bûches avec les bûches, minerais avec les minerais). */
export function familyOf(name: string): string {
  if (/_(log|stem|wood|hyphae)$/.test(name)) return 'bois';
  if (name.endsWith('_planks') || name === 'stick') return 'planches';
  if (/(_ore$|^raw_|_ingot$|_nugget$|^coal$|^charcoal$|^diamond$|^emerald$|^lapis_lazuli$|^redstone$|^quartz$|^copper_ingot$)/.test(name)) return 'minerais';
  if (/^(cobblestone|cobbled_deepslate|stone|deepslate|andesite|diorite|granite|tuff|calcite|dirt|coarse_dirt|gravel|sand|red_sand|clay_ball|flint)$/.test(name)) return 'terre et pierre';
  if (/(seeds$|^wheat$|^carrot$|^potato$|^beetroot$|^sugar_cane$|^pumpkin$|^melon_slice$|^bamboo$|_sapling$)/.test(name)) return 'cultures';
  if (/(_wool$|^string$|^leather$|^feather$|^bone$|^gunpowder$|^rotten_flesh$|^spider_eye$|^ender_pearl$)/.test(name)) return 'butin';
  return name.split('_').pop() ?? name;
}

export interface ChestSurvey {
  /** Objets déjà présents (nom → quantité). */
  contents: Record<string, number>;
  /** Cases libres. */
  free: number;
}

/**
 * Où ranger chaque objet : dans le coffre qui contient déjà le même objet, sinon des objets de la même
 * famille, sinon dans celui qui a le plus de place (cas réel : trois coffres à la maison, le bot
 * rangeait tout dans le plus proche). Renvoie, pour chaque objet, l'ordre des coffres à essayer.
 */
export function planStorage(items: string[], chests: ChestSurvey[]): Record<string, number[]> {
  const byFree = chests.map((_, i) => i).sort((a, b) => chests[b]!.free - chests[a]!.free);
  const plan: Record<string, number[]> = {};
  for (const name of items) {
    const same = chests.map((c, i) => [i, c.contents[name] ?? 0] as const).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([i]) => i);
    const fam = familyOf(name);
    const family = chests
      .map((c, i) => [i, Object.entries(c.contents).filter(([n]) => familyOf(n) === fam).reduce((s, [, n]) => s + n, 0)] as const)
      .filter(([i, n]) => n > 0 && !same.includes(i))
      .sort((a, b) => b[1] - a[1])
      .map(([i]) => i);
    const rest = byFree.filter((i) => !same.includes(i) && !family.includes(i));
    plan[name] = [...same, ...family, ...rest];
  }
  return plan;
}

const CHEST_NAMES = ['chest', 'barrel', 'trapped_chest'];

export const store = {
  name: 'store',
  domain: 'survive' as Domain,
  description: 'store {items?: string[]} — ranger dans les coffres de la maison (sinon les coffres proches), chaque objet avec ses semblables ; tout sauf outils, armes et nourriture si items est absent',
  params: z.object({ items: z.array(z.string().min(1)).max(10).optional() }),
  timeoutMs: () => 180_000, // trajet jusqu'à la maison et tour des coffres compris
  async run({ bot, home }: SkillContext, p: { items?: string[] }, signal: AbortSignal): Promise<ActionRunOutput> {
    // maison connue : on range dans ses coffres plutôt que dans le coffre le plus proche
    const h = home?.();
    const me = bot.entity.position;
    if (h && Math.hypot(h.x - me.x, h.y - me.y, h.z - me.z) > 12) await travelHome(bot, h, signal);
    const ids = CHEST_NAMES.map((n) => bot.registry.blocksByName[n]?.id).filter((id): id is number => id !== undefined);
    const positions = bot.findBlocks({ matching: ids, maxDistance: CHEST_RADIUS, count: 8 });
    if (positions.length === 0) return fail('aucun coffre à portée', { precondition: true });
    const keep = (name: string) => isEquipment(name) || bot.registry.foodsByName[name] !== undefined;
    const toStore = () => bot.inventory.items().filter((i) => (p.items ? p.items.some((w) => i.name === w || matchingItems([i], w).length > 0) : !keep(i.name)));
    if (toStore().length === 0) return fail('rien à ranger', { precondition: true });
    // 1. tour des coffres : ce que chacun contient et la place libre
    const surveys: ChestSurvey[] = [];
    for (const pos of positions) {
      if (signal.aborted) return fail('interrompu');
      const block = bot.blockAt(pos);
      if (!block) {
        surveys.push({ contents: {}, free: 0 });
        continue;
      }
      await goNear(bot, pos, 2, signal);
      try {
        const window = await bot.openContainer(block);
        const contents: Record<string, number> = {};
        for (const it of window.containerItems()) contents[it.name] = (contents[it.name] ?? 0) + it.count;
        surveys.push({ contents, free: Math.max(0, window.inventoryStart - window.containerItems().length) });
        window.close();
      } catch {
        surveys.push({ contents: {}, free: 0 });
      }
    }
    // 2. chaque objet dans son coffre, en passant au suivant si celui-ci est plein
    const plan = planStorage([...new Set(toStore().map((i) => i.name))], surveys);
    const byChest = new Map<number, string[]>();
    for (const [name, order] of Object.entries(plan)) byChest.set(order[0]!, [...(byChest.get(order[0]!) ?? []), name]);
    let moved = 0;
    const left: string[] = [];
    const deposit = async (chestIndex: number, names: string[]): Promise<string[]> => {
      const block = bot.blockAt(positions[chestIndex]!);
      if (!block || signal.aborted) return names;
      await goNear(bot, positions[chestIndex]!, 2, signal);
      const failed: string[] = [];
      try {
        const window = await bot.openContainer(block);
        try {
          for (const name of names) {
            for (const it of bot.inventory.items().filter((i) => i.name === name)) {
              // quantité notée avant : l'inventaire peut se mettre à jour pendant le dépôt
              const n = it.count;
              try {
                await window.deposit(it.type, null, n);
                moved += n;
              } catch {
                failed.push(name); // coffre plein
                break;
              }
            }
          }
        } finally {
          window.close();
        }
      } catch {
        return names;
      }
      return failed;
    };
    for (const [chestIndex, names] of byChest) left.push(...(await deposit(chestIndex, names)));
    // coffre plein : les objets restants vont au coffre suivant de leur ordre
    for (const name of left) {
      for (const next of plan[name]!.slice(1)) {
        if ((await deposit(next, [name])).length === 0) break;
      }
    }
    return moved > 0 ? { status: 'success', detail: { moved, chests: byChest.size } } : fail('coffres pleins');
  },
};

/** Prendre des objets dans les coffres proches (tous, pas seulement le plus proche). */
export const retrieve = {
  name: 'retrieve',
  domain: 'survive' as Domain,
  description: "retrieve {item: nom d'objet ou famille (ex. \"coal\", \"log\"), count: 1-64} — prendre un objet dans les coffres proches",
  params: z.object({ item: z.string().min(1), count: z.number().int().min(1).max(64).default(16) }),
  timeoutMs: () => 90_000,
  async run({ bot, home }: SkillContext, p: { item: string; count: number }, signal: AbortSignal): Promise<ActionRunOutput> {
    const h = home?.();
    const me = bot.entity.position;
    if (h && Math.hypot(h.x - me.x, h.y - me.y, h.z - me.z) > 12) await travelHome(bot, h, signal);
    const wanted = (name: string) => name === p.item || matchingItems([{ name }], p.item).length > 0;
    const got = await withdrawFromChests(bot, wanted, p.count, signal);
    return got > 0 ? { status: 'success', detail: { got } } : fail(`pas de ${p.item} dans les coffres`, { precondition: true });
  },
};

/** Poser des torches autour de soi, sur le sol, là où il fait sombre en priorité. */
export const torch = {
  name: 'torch',
  domain: 'survive' as Domain,
  description: 'torch {count: 1-8} — poser des torches au sol autour de soi',
  params: z.object({ count: z.number().int().min(1).max(8).default(2) }),
  timeoutMs: (p: { count: number }) => 5_000 + 3_000 * p.count,
  async run(ctx: SkillContext, p: { count: number }, signal: AbortSignal): Promise<ActionRunOutput> {
    const { bot } = ctx;
    if (countItem(bot, 'torch') === 0) return fail('pas de torche', { precondition: true });
    const me = bot.entity.position.floored();
    const spots = [[2, 0], [-2, 0], [0, 2], [0, -2], [3, 3], [-3, -3], [3, -3], [-3, 3]]
      .map(([dx, dz]) => me.offset(dx!, 0, dz!))
      .filter((pos) => bot.blockAt(pos)?.name === 'air' && bot.blockAt(pos.offset(0, -1, 0))?.boundingBox === 'block')
      .sort((a, b) => (bot.blockAt(a)?.light ?? 15) - (bot.blockAt(b)?.light ?? 15));
    let placed = 0;
    for (const pos of spots.slice(0, p.count)) {
      if (signal.aborted) break;
      const item = bot.inventory.items().find((i) => i.name === 'torch');
      const ground = bot.blockAt(pos.offset(0, -1, 0));
      if (!item || !ground) break;
      try {
        await bot.equip(item, 'hand');
        ctx.touch?.(pos);
        await bot.placeBlock(ground, ground.position.minus(ground.position).offset(0, 1, 0));
        placed++;
      } catch {
        continue;
      }
    }
    return placed > 0 ? { status: 'success', detail: { placed } } : fail('aucun endroit où poser');
  },
};

/** Dormir dans le lit le plus proche (la nuit ou pendant un orage). */
export const sleep = {
  name: 'sleep',
  domain: 'survive' as Domain,
  description: 'sleep {} — dormir dans le lit le plus proche (la nuit)',
  params: z.object({}),
  timeoutMs: () => 60_000,
  async run({ bot }: SkillContext, _p: Record<string, never>, signal: AbortSignal): Promise<ActionRunOutput> {
    const bed = bot.findBlock({ matching: (b) => bot.isABed(b), maxDistance: 24 });
    if (!bed) return fail('aucun lit à portée', { precondition: true });
    const tod = bot.time?.timeOfDay ?? 0;
    if (tod < 12_542 && !bot.isRaining) return fail('il fait jour', { precondition: true });
    await goNear(bot, bed.position, 2, signal);
    try {
      await bot.sleep(bed);
    } catch (err) {
      return fail(`impossible de dormir : ${(err as Error).message}`);
    }
    // dort jusqu'au matin (ou jusqu'à interruption par un réflexe)
    while (!signal.aborted && bot.isSleeping) await abortableSleep(1000, signal);
    if (bot.isSleeping) await bot.wake().catch(() => undefined);
    return { status: 'success' };
  },
};

/**
 * Objets de l'inventaire qui correspondent à une demande : nom exact (« oak_log ») ou famille
 * (« log » → tous les *_log, « planks » → toutes les planches).
 */
export function matchingItems<T extends { name: string }>(items: T[], wanted: string): T[] {
  const w = wanted.toLowerCase().replace(/^minecraft:/, '');
  const exact = items.filter((i) => i.name === w);
  return exact.length ? exact : items.filter((i) => i.name.endsWith(`_${w}`) || i.name.startsWith(`${w}_`));
}

/** Donner : rejoint le joueur suivi et lui lance les objets demandés. */
export const give = {
  name: 'give',
  domain: 'gather' as Domain,
  description: "give {item: string (nom Minecraft ou famille, ex. \"oak_log\", \"log\", \"planks\", ou \"all\" pour tout sauf l'équipement), count?: 1-256} — donner des objets au joueur (tous si count absent)",
  params: z.object({ item: z.string().min(1), count: z.number().int().min(1).max(256).optional() }),
  timeoutMs: () => 40_000,
  async run(ctx: SkillContext, p: { item: string; count?: number | undefined }, signal: AbortSignal): Promise<ActionRunOutput> {
    const { bot } = ctx;
    // « donne » tout court (all, tout) : tout sauf l'équipement et la nourriture
    const everything = /^(all|tout|tous|everything|\*)$/i.test(p.item.trim());
    const stacks = everything ? bot.inventory.items().filter((i) => !isEquipment(i.name) && bot.registry.foodsByName?.[i.name] === undefined) : matchingItems(bot.inventory.items(), p.item);
    if (stacks.length === 0) return fail(`pas de ${p.item} dans l'inventaire`, { precondition: true });
    const target = bot.players[ctx.followPlayer]?.entity;
    if (!target) return fail('joueur hors de vue');
    await goNear(bot, target.position, 2, signal);
    if (signal.aborted) return fail('interrompu');
    await bot.lookAt(target.position.offset(0, 1.6, 0), true);
    let left = p.count ?? Infinity;
    let given = 0;
    for (const s of stacks) {
      if (left <= 0 || signal.aborted) break;
      const n = Math.min(left, s.count);
      await bot.toss(s.type, null, n);
      given += n;
      left -= n;
    }
    return given > 0 ? { status: 'success', detail: { given, item: p.item } } : fail('rien donné');
  },
};

/** Poser un objet de l'inventaire (four, coffre, établi…), à côté d'un bloc désigné ou du bot. */
export const place = {
  name: 'place',
  domain: 'build' as Domain,
  description: 'place {item: nom Minecraft (ex. "furnace", "chest", "crafting_table"), near?: bloc de référence (ex. "crafting_table")} — poser cet objet à côté du bloc désigné, sinon à côté de moi',
  params: z.object({ item: z.string().min(1), near: z.string().min(1).optional() }),
  timeoutMs: () => 30_000,
  async run(ctx: SkillContext, p: { item: string; near?: string | undefined }, signal: AbortSignal): Promise<ActionRunOutput> {
    const { bot } = ctx;
    const stack = matchingItems(bot.inventory.items(), p.item)[0];
    if (!stack) return fail(`pas de ${p.item} dans l'inventaire`, { precondition: true });
    const ring = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
    let placed: Block | null;
    if (p.near) {
      const ref = nearest(bot, [p.near.replace(/^minecraft:/, '')], 24);
      if (!ref) return fail(`pas de ${p.near} à portée`, { precondition: true });
      await goNear(bot, ref.position, 2, signal);
      if (signal.aborted) return fail('interrompu');
      placed = await placeAround(bot, stack.name, ref.position, ring);
    } else placed = await placeAround(bot, stack.name, bot.entity.position.floored(), ring);
    if (!placed) return fail('aucune place libre à côté');
    ctx.touch?.(placed.position);
    return { status: 'success', detail: { item: stack.name, at: placed.position } };
  },
};

/** Ramasser les objets tombés au sol autour du bot (après une mort, une explosion, un coffre cassé…). */
export const pickup = {
  name: 'pickup',
  domain: 'gather' as Domain,
  description: 'pickup {radius?: 4-24} — ramasser les objets tombés au sol autour de moi (« reprends tes affaires »)',
  params: z.object({ radius: z.number().min(4).max(24).default(16) }),
  timeoutMs: () => 60_000,
  async run(ctx: SkillContext, p: { radius: number }, signal: AbortSignal): Promise<ActionRunOutput> {
    const { bot } = ctx;
    const before = bot.inventory.items().reduce((s, i) => s + i.count, 0);
    const dropped = () =>
      Object.values(bot.entities)
        .filter((e) => e.name === 'item' && e.position.distanceTo(bot.entity.position) <= p.radius)
        .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
    if (dropped().length === 0) return fail('aucun objet au sol à portée', { precondition: true });
    const tried = new Set<number>();
    for (let n = 0; n < 32 && !signal.aborted; n++) {
      const next = dropped().find((e) => !tried.has(e.id));
      if (!next) break;
      tried.add(next.id);
      // marcher sur l'objet suffit à le ramasser
      await goNear(bot, next.position, 0.5, signal);
    }
    const gained = bot.inventory.items().reduce((s, i) => s + i.count, 0) - before;
    return gained > 0 ? { status: 'success', detail: { gained } } : fail("objets hors d'atteinte");
  },
};

/**
 * Trajet jusqu'à la maison, par étapes de 48 blocs : le pathfinder abandonne les trajets trop longs
 * d'un coup. S'arrête à 4 blocs de la maison.
 */
export async function travelHome(bot: Bot, h: { x: number; y: number; z: number }, signal: AbortSignal): Promise<boolean> {
  for (let hop = 0; hop < 12 && !signal.aborted; hop++) {
    const me = bot.entity.position;
    const d = Math.hypot(h.x - me.x, h.z - me.z);
    if (d <= 4 && Math.abs(h.y - me.y) <= 4) return true;
    if (d <= 48) {
      await goNear(bot, h, 3, signal);
      continue;
    }
    const k = 48 / d;
    const stepGoal = { x: me.x + (h.x - me.x) * k, y: me.y, z: me.z + (h.z - me.z) * k };
    const before = bot.entity.position.clone();
    await goNearXZ(bot, stepGoal, signal);
    if (bot.entity.position.distanceTo(before) < 2) return false; // bloqué
  }
  const me = bot.entity.position;
  return Math.hypot(h.x - me.x, h.z - me.z) <= 6;
}

async function goNearXZ(bot: Bot, p: { x: number; z: number }, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const stop = () => bot.pathfinder.setGoal(null);
  signal.addEventListener('abort', stop, { once: true });
  try {
    await bot.pathfinder.goto(new goals.GoalNearXZ(p.x, p.z, 3));
  } catch {
    // étape impossible : l'appelant constate qu'on n'a pas bougé
  } finally {
    signal.removeEventListener('abort', stop);
  }
}

/** Rentrer à la maison (« rentre à la maison »), même de loin. */
export const goHome = {
  name: 'go_home',
  domain: 'explore' as Domain,
  description: 'go_home {} — rentrer à la maison',
  params: z.object({}),
  timeoutMs: () => 180_000,
  async run(ctx: SkillContext, _p: Record<string, never>, signal: AbortSignal): Promise<ActionRunOutput> {
    const h = ctx.home?.();
    if (!h) return fail("je ne sais pas encore où est la maison : dis « ici c'est la maison » quand tu y es", { precondition: true });
    return (await travelHome(ctx.bot, h, signal)) ? { status: 'success', detail: { home: h } } : fail('chemin vers la maison bloqué');
  },
};

export const EXTRA_SKILLS = [plant, smelt, furnaceTake, store, retrieve, torch, sleep, give, place, pickup, goHome];
