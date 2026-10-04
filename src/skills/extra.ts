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
  for (const pos of bot.findBlocks({ matching: ids, maxDistance: 16, count: 3 })) {
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
      const fuelPerItem = fuelName.includes('coal') ? 1 / 8 : fuelName.endsWith('_log') || fuelName.endsWith('_planks') ? 1 / 1.5 : 1;
      await window.putFuel(bot.registry.itemsByName[fuelName]!.id, null, Math.min(countItem(bot, fuelName), Math.max(1, Math.ceil(count * fuelPerItem))));
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

/** Ranger dans le coffre le plus proche (tout, ou les objets demandés), en gardant outils, armes et nourriture. */
export const store = {
  name: 'store',
  domain: 'survive' as Domain,
  description: 'store {items?: string[]} — ranger dans le coffre le plus proche (tout sauf outils, armes et nourriture si items est absent)',
  params: z.object({ items: z.array(z.string().min(1)).max(10).optional() }),
  timeoutMs: () => 40_000,
  async run({ bot }: SkillContext, p: { items?: string[] }, signal: AbortSignal): Promise<ActionRunOutput> {
    const chest = nearest(bot, ['chest', 'barrel', 'trapped_chest'], 16);
    if (!chest) return fail('aucun coffre à portée', { precondition: true });
    await goNear(bot, chest.position, 2, signal);
    const keep = (name: string) => isEquipment(name) || bot.registry.foodsByName[name] !== undefined;
    const window = await bot.openContainer(chest);
    let moved = 0;
    try {
      for (const item of bot.inventory.items()) {
        if (signal.aborted) break;
        if (p.items ? !p.items.includes(item.name) : keep(item.name)) continue;
        try {
          await window.deposit(item.type, null, item.count);
          moved += item.count;
        } catch {
          break; // coffre plein
        }
      }
    } finally {
      window.close();
    }
    return moved > 0 ? { status: 'success', detail: { moved } } : fail('rien à ranger ou coffre plein');
  },
};

/** Prendre des objets dans le coffre le plus proche. */
export const retrieve = {
  name: 'retrieve',
  domain: 'survive' as Domain,
  description: 'retrieve {item: nom d\'objet, count: 1-64} — prendre un objet dans le coffre le plus proche',
  params: z.object({ item: z.string().min(1), count: z.number().int().min(1).max(64).default(16) }),
  timeoutMs: () => 30_000,
  async run({ bot }: SkillContext, p: { item: string; count: number }, signal: AbortSignal): Promise<ActionRunOutput> {
    const type = bot.registry.itemsByName[p.item];
    if (!type) return fail('objet inconnu', { precondition: true });
    const chest = nearest(bot, ['chest', 'barrel', 'trapped_chest'], 16);
    if (!chest) return fail('aucun coffre à portée', { precondition: true });
    await goNear(bot, chest.position, 2, signal);
    const before = countItem(bot, p.item);
    const window = await bot.openContainer(chest);
    try {
      const available = window.containerItems().filter((i) => i.type === type.id).reduce((s, i) => s + i.count, 0);
      if (available === 0) return fail(`pas de ${p.item} dans le coffre`, { precondition: true });
      await window.withdraw(type.id, null, Math.min(p.count, available));
    } finally {
      window.close();
    }
    const got = countItem(bot, p.item) - before;
    return got > 0 ? { status: 'success', detail: { got } } : fail('rien pris');
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

export const EXTRA_SKILLS = [plant, smelt, furnaceTake, store, retrieve, torch, sleep, give, place, pickup];
