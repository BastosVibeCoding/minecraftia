import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import pathfinderPkg from 'mineflayer-pathfinder';
import { z } from 'zod';
// augmentations de type de `Bot` (bot.collectBlock, bot.pvp)
import type {} from 'mineflayer-collectblock';
import type {} from 'mineflayer-pvp';
import { abortableSleep, untilAborted } from '../core/abort.js';
import type { Domain } from '../core/types.js';
import { isHostile, playerEntity } from '../bot/mineflayerTypes.js';
import { canSee } from '../bot/sight.js';
import type { Action, ActionRunOutput } from './actionController.js';
import { blueprint, type BlueprintSpec } from './blueprint.js';
import { EXTRA_SKILLS } from './extra.js';
import { staircase } from './staircase.js';
import { ensureHarvestTool } from './tools.js';

const { goals } = pathfinderPkg;
type Vec3 = Bot['entity']['position'];

export interface SkillContext {
  bot: Bot;
  followPlayer: string;
  /** Signale un bloc que le bot va modifier lui-même : l'observateur ne doit pas l'attribuer au joueur. */
  touch?: (pos: { x: number; y: number; z: number }) => void;
  /** Voix du bot (chat + voix en jeu si disponible) ; à défaut, le chat. */
  speak?: (text: string) => void;
  /** Bloc à ne jamais casser (posé par un joueur, bloc de construction). */
  isProtected?: (b: { name: string; position: { x: number; y: number; z: number } }) => boolean;
  /** Réglages de déplacement normaux, remis après une récolte (collectblock impose les siens). */
  restoreMovements?: () => void;
}

export interface Skill<P extends z.ZodType = z.ZodType> {
  name: string;
  domain: Domain;
  /** Description donnée au décideur (avec les paramètres attendus). */
  description: string;
  params: P;
  timeoutMs(params: z.infer<P>): number;
  run(ctx: SkillContext, params: z.infer<P>, signal: AbortSignal): Promise<ActionRunOutput>;
}

const LOW_HEALTH = 8;
const LOW_HEALTH_SAFE_RADIUS = 8;

const fail = (reason: string, extra: Record<string, unknown> = {}): ActionRunOutput => ({ status: 'failure', detail: { reason, ...extra } });

/** Exécute une promesse mineflayer en la rattachant au signal : annulation → `onAbort` et fin immédiate. */
async function cancellable<T>(p: Promise<T>, signal: AbortSignal, onAbort: () => void): Promise<T | undefined> {
  if (signal.aborted) return undefined;
  const aborted = untilAborted(signal).then(() => {
    onAbort();
    return undefined;
  });
  try {
    return await Promise.race([p, aborted]);
  } catch (err) {
    if (signal.aborted) return undefined;
    throw err;
  }
}

function countItem(bot: Bot, name: string): number {
  return bot.inventory.items().filter((i) => i.name === name).reduce((s, i) => s + i.count, 0);
}

async function goNear(bot: Bot, pos: { x: number; y: number; z: number }, range: number, signal: AbortSignal): Promise<void> {
  await cancellable(bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, range)), signal, () => bot.pathfinder.setGoal(null));
}

// ---------- compétences ----------

const follow: Skill<z.ZodObject<{ distance: z.ZodDefault<z.ZodNumber>; seconds: z.ZodDefault<z.ZodNumber> }>> = {
  name: 'follow',
  domain: 'explore',
  description: 'follow {distance?: 1-8, seconds?: 2-60} — rester près du joueur',
  params: z.object({ distance: z.number().min(1).max(8).default(3), seconds: z.number().min(2).max(60).default(10) }),
  timeoutMs: (p) => p.seconds * 1000 + 5000,
  async run({ bot, followPlayer }, p, signal) {
    const target = playerEntity(bot, followPlayer);
    if (!target) return fail('joueur hors de vue');
    // vie basse et monstre près du joueur : ne pas revenir dans la menace que les réflexes viennent de fuir
    const threatened = Object.values(bot.entities).some((e) => e !== bot.entity && e.position && isHostile(e) && e.position.distanceTo(target.position) < LOW_HEALTH_SAFE_RADIUS);
    if (bot.health <= LOW_HEALTH && threatened) {
      await abortableSleep(Math.min(5000, p.seconds * 1000), signal);
      return fail('vie basse, je garde mes distances avec la menace', { precondition: true });
    }
    bot.pathfinder.setGoal(new goals.GoalFollow(target, p.distance), true);
    await abortableSleep(p.seconds * 1000, signal);
    if (!signal.aborted) bot.pathfinder.setGoal(null);
    return { status: 'success' };
  },
};

/**
 * Noms de blocs demandés → noms Minecraft. Un nom inconnu est pris comme une famille :
 * « ore » / « minerais » → tous les *_ore, « log » / « bois » → toutes les bûches.
 */
export function expandBlockNames(known: string[], wanted: string[]): string[] {
  const ALIASES: Record<string, string> = { minerai: 'ore', minerais: 'ore', ores: 'ore', bois: 'log', logs: 'log', buche: 'log', buches: 'log' };
  const out = new Set<string>();
  for (const raw of wanted) {
    const w = raw.toLowerCase().replace(/^minecraft:/, '');
    if (known.includes(w)) {
      out.add(w);
      continue;
    }
    const family = ALIASES[w] ?? w.replace(/s$/, '');
    for (const k of known) if (k.endsWith(`_${family}`)) out.add(k);
  }
  return [...out];
}

/** Rayon de recherche des blocs à récolter, et essais ratés d'affilée avant d'abandonner. */
const COLLECT_RADIUS = 48;
const MAX_COLLECT_MISSES = 4;

const collect = {
  name: 'collect',
  domain: 'gather' as Domain,
  description: 'collect {blocks: string[] (noms Minecraft, ex. ["oak_log"]), count: 1-32} — récolter ou miner des blocs proches',
  params: z.object({ blocks: z.array(z.string().min(1)).min(1).max(5), count: z.number().int().min(1).max(32).default(8) }),
  timeoutMs: (p: { count: number }) => Math.min(300_000, 10_000 * p.count + 20_000),
  async run(ctx: SkillContext, p: { blocks: string[]; count: number }, signal: AbortSignal): Promise<ActionRunOutput> {
    const { bot } = ctx;
    const names = expandBlockNames(Object.keys(bot.registry.blocksByName), p.blocks);
    const ids = names.map((b) => bot.registry.blocksByName[b]?.id).filter((id): id is number => id !== undefined);
    if (ids.length === 0) return fail('blocs inconnus', { blocks: p.blocks });
    // ce qui arrive dans l'inventaire : le bloc lui-même ou ce qu'il lâche (minerai de fer → fer brut, pierre → pavé)
    const counted = new Set(names);
    for (const id of ids) for (const drop of (bot.registry.blocks?.[id] as { drops?: unknown[] } | undefined)?.drops ?? []) {
      const itemId = typeof drop === 'number' ? drop : (drop as { drop?: number | { id: number } }).drop;
      const resolved = typeof itemId === 'number' ? itemId : itemId?.id;
      const item = resolved !== undefined ? bot.registry.items?.[resolved] : undefined;
      if (item) counted.add(item.name);
    }
    const have = () => [...counted].reduce((s, b) => s + countItem(bot, b), 0);
    const before = have();
    const gained = () => have() - before;
    // un bloc à la fois, le plus proche d'abord : collectblock abandonne toute sa liste dès qu'un trajet
    // tarde (« Took to long to decide path to goal »), ce qui ramenait 2 ou 3 bûches sur 30 demandées
    const skipped = new Set<string>();
    let misses = 0;
    let lastError: string | undefined;
    let seen = false;
    let onlyPlaced = true;
    try {
      while (!signal.aborted && gained() < p.count && misses < MAX_COLLECT_MISSES) {
        const candidates = bot.findBlocks({ matching: ids, maxDistance: COLLECT_RADIUS, count: 32 }).map((pos) => bot.blockAt(pos));
        let target: NonNullable<(typeof candidates)[number]> | undefined;
        for (const b of candidates) {
          if (!b) continue;
          seen = true;
          // jamais une bûche (ou autre) posée par un joueur : seulement ce qui a poussé là
          if (ctx.isProtected?.(b)) continue;
          onlyPlaced = false;
          if (!skipped.has(`${b.position.x},${b.position.y},${b.position.z}`)) {
            target = b;
            break;
          }
        }
        if (!target) break;
        // outil adapté avant chaque bloc (hache cassée en pleine récolte, pioche trop faible pour le
        // minerai) : inventaire, fabrication, coffres proches ; sinon on le demande au joueur
        const tool = await ensureHarvestTool(bot, target.name, signal).catch(() => ({ ok: true as const }));
        if (!tool.ok) {
          ctx.speak?.(tool.ask);
          if (gained() > 0) break;
          return fail(tool.ask, { precondition: true, blocks: p.blocks });
        }
        ctx.touch?.(target.position);
        const g0 = gained();
        try {
          await cancellable(bot.collectBlock.collect(target, { ignoreNoPath: true }), signal, () => void bot.collectBlock.cancelTask());
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
        if (gained() > g0) misses = 0;
        else {
          misses++;
          skipped.add(`${target.position.x},${target.position.y},${target.position.z}`);
        }
      }
    } finally {
      ctx.restoreMovements?.();
    }
    const total = gained();
    if (total > 0) return { status: 'success', detail: { gained: total, requested: p.count, ...(total < p.count && lastError ? { partial: lastError } : {}) } };
    if (!seen) return fail('aucun bloc à portée', { blocks: p.blocks });
    if (onlyPlaced) return fail('seulement des blocs posés par un joueur à portée', { blocks: p.blocks });
    return fail(lastError ?? 'rien récolté');
  },
};

const BuildParams = z.object({
  shape: z.enum(['wall', 'floor', 'path', 'pillar', 'enclosure', 'house', 'structure']),
  material: z.string().min(1),
  width: z.number().int().min(1).max(16).default(5),
  height: z.number().int().min(1).max(8).default(3),
  depth: z.number().int().min(1).max(16).default(1),
  borderFirst: z.boolean().default(false),
});

/** Coin d'un chantier praticable près du bot : sol solide, volume libre. */
function findSite(bot: Bot, spec: BlueprintSpec): Vec3 | null {
  const me = bot.entity.position.floored();
  const cells = blueprint(spec);
  const offsets = [
    [2, 2], [2, -2 - spec.depth], [-2 - spec.width, 2], [-2 - spec.width, -2 - spec.depth], [4, 0], [0, 4], [-6, 0], [0, -6],
  ];
  for (const [dx, dz] of offsets) {
    for (const dy of [0, -1, 1]) {
      const origin = me.offset(dx!, dy, dz!);
      const ok = cells.every((c) => {
        const at = bot.blockAt(origin.offset(c.x, c.y, c.z));
        const ground = c.y === 0 ? bot.blockAt(origin.offset(c.x, -1, c.z)) : null;
        return at && at.boundingBox === 'empty' && (c.y > 0 || (ground !== null && ground.boundingBox === 'block'));
      });
      if (ok) return origin;
    }
  }
  return null;
}

const build = {
  name: 'build',
  domain: 'build' as Domain,
  description: 'build {shape: wall|floor|path|pillar|enclosure|house, material: nom de bloc, width, height, depth, borderFirst?} — construire près du joueur avec les blocs de l\'inventaire',
  params: BuildParams,
  timeoutMs: (p: z.infer<typeof BuildParams>) => Math.min(300_000, 20_000 + 2_500 * blueprint(p).length),
  async run(ctx: SkillContext, p: z.infer<typeof BuildParams>, signal: AbortSignal): Promise<ActionRunOutput> {
    const { bot } = ctx;
    const cells = blueprint(p);
    const have = countItem(bot, p.material);
    if (have < Math.min(cells.length, 4)) return fail('matériaux insuffisants', { material: p.material, have, need: cells.length, precondition: true });
    const origin = findSite(bot, p);
    if (!origin) return fail('aucun emplacement libre', { precondition: true });
    let placed = 0;
    let errors = 0;
    for (const c of cells.slice(0, have)) {
      if (signal.aborted) break;
      const target = origin.offset(c.x, c.y, c.z);
      const current = bot.blockAt(target);
      if (current && current.boundingBox === 'block') continue;
      const below = bot.blockAt(target.offset(0, -1, 0));
      if (!below || below.boundingBox !== 'block') {
        errors++;
        continue;
      }
      if (bot.entity.position.distanceTo(target) > 4) await goNear(bot, target, 3, signal);
      const item = bot.inventory.items().find((i) => i.name === p.material);
      if (!item || signal.aborted) break;
      try {
        await bot.equip(item, 'hand');
        ctx.touch?.(target);
        await bot.placeBlock(below, below.position.minus(below.position).offset(0, 1, 0));
        placed++;
      } catch {
        errors++;
      }
    }
    const ratio = placed / cells.length;
    if (ratio >= 0.8) return { status: 'success', detail: { placed, of: cells.length } };
    // à court de blocs : la façon de faire n'est pas en cause, c'est l'inventaire
    const ranOut = countItem(bot, p.material) === 0 && have < cells.length;
    return fail(ranOut ? 'matériaux épuisés' : 'construction incomplète', { placed, of: cells.length, errors, precondition: ranOut });
  },
};

/** Portée de recherche des cibles, et nombre maximal de cibles abattues par ordre. */
const ATTACK_RADIUS = 32;
const MAX_KILLS = 8;

const attack = {
  name: 'attack',
  domain: 'combat' as Domain,
  description: 'attack {targets: string[] (noms de mobs, ou ["hostile"]), engageDistance: 2-3.5, retreatHp: 0-20, useShield} — combattre la cible la plus proche',
  params: z.object({
    targets: z.array(z.string().min(1)).min(1).max(5),
    engageDistance: z.number().min(2).max(3.5).default(3),
    retreatHp: z.number().min(0).max(20).default(6),
    useShield: z.boolean().default(false),
  }),
  timeoutMs: () => 45_000,
  async run(ctx: SkillContext, p: { targets: string[]; engageDistance: number; retreatHp: number; useShield: boolean }, signal: AbortSignal): Promise<ActionRunOutput> {
    const { bot } = ctx;
    const wanted = (e: Entity) => (p.targets.includes('hostile') ? isHostile(e) : p.targets.includes(e.name ?? ''));
    // seulement ce qu'il voit : pas de cible repérée à travers un mur
    const nextTarget = () => bot.nearestEntity((e) => e !== bot.entity && wanted(e) && e.position.distanceTo(bot.entity.position) < ATTACK_RADIUS && canSee(bot, e));
    if (!nextTarget()) return fail('aucune cible', { targets: p.targets, precondition: true });
    const weapon = bot.inventory.items().find((i) => i.name.endsWith('_sword')) ?? bot.inventory.items().find((i) => i.name.endsWith('_axe'));
    if (weapon) await bot.equip(weapon, 'hand');
    const shield = p.useShield ? bot.inventory.items().find((i) => i.name === 'shield') : undefined;
    if (shield) await bot.equip(shield, 'off-hand');
    bot.pvp.attackRange = p.engageDistance;
    // « tue les poules » : on enchaîne tant qu'il reste des cibles à portée (pvp va jusqu'à elles)
    const killed: string[] = [];
    while (!signal.aborted && killed.length < MAX_KILLS) {
      const target = nextTarget();
      if (!target) break;
      void bot.pvp.attack(target);
      while (!signal.aborted && target.isValid) {
        if (bot.health <= p.retreatHp) {
          bot.pvp.forceStop();
          ctx.restoreMovements?.();
          return killed.length ? { status: 'success', detail: { killed, retreated: true } } : fail('repli', { health: bot.health, retreated: true });
        }
        await abortableSleep(150, signal);
      }
      if (!target.isValid) killed.push(target.name ?? 'cible');
    }
    bot.pvp.forceStop();
    ctx.restoreMovements?.();
    if (killed.length) return { status: 'success', detail: { killed } };
    return fail('interrompu');
  },
};

const craft = {
  name: 'craft',
  domain: 'craft' as Domain,
  description: 'craft {item: nom d\'objet, count: 1-16} — fabriquer (avec un établi proche si nécessaire)',
  params: z.object({ item: z.string().min(1), count: z.number().int().min(1).max(16).default(1) }),
  timeoutMs: () => 30_000,
  async run({ bot }: SkillContext, p: { item: string; count: number }, signal: AbortSignal): Promise<ActionRunOutput> {
    const item = bot.registry.itemsByName[p.item];
    if (!item) return fail('objet inconnu', { item: p.item, precondition: true });
    const tableBlock = bot.findBlock({ matching: bot.registry.blocksByName.crafting_table!.id, maxDistance: 6 }) ?? undefined;
    const recipe = bot.recipesFor(item.id, null, 1, tableBlock ?? null)[0];
    if (!recipe) return fail('ingrédients ou établi manquants', { item: p.item, precondition: true });
    if (recipe.requiresTable && tableBlock) await goNear(bot, tableBlock.position, 2, signal);
    const before = countItem(bot, p.item);
    await cancellable(bot.craft(recipe, p.count, tableBlock), signal, () => undefined);
    const made = countItem(bot, p.item) - before;
    return made > 0 ? { status: 'success', detail: { made } } : fail('fabrication sans résultat');
  },
};

const explore = {
  name: 'explore',
  domain: 'explore' as Domain,
  description: 'explore {radius: 8-64} — partir explorer les environs puis revenir',
  params: z.object({ radius: z.number().min(8).max(64).default(24) }),
  timeoutMs: () => 90_000,
  async run({ bot }: SkillContext, p: { radius: number }, signal: AbortSignal): Promise<ActionRunOutput> {
    const angle = Math.random() * Math.PI * 2;
    const me = bot.entity.position;
    const goal = new goals.GoalNearXZ(me.x + Math.cos(angle) * p.radius, me.z + Math.sin(angle) * p.radius, 3);
    await cancellable(bot.pathfinder.goto(goal), signal, () => bot.pathfinder.setGoal(null));
    return { status: 'success', detail: { distance: Math.round(bot.entity.position.distanceTo(me)) } };
  },
};

const BAD_FOOD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'suspicious_stew']);
const eat = {
  name: 'eat',
  domain: 'survive' as Domain,
  description: 'eat {} — manger la meilleure nourriture de l\'inventaire',
  params: z.object({}),
  timeoutMs: () => 10_000,
  async run({ bot }: SkillContext): Promise<ActionRunOutput> {
    const foods = bot.registry.foodsByName;
    const food = bot.inventory
      .items()
      .filter((i) => foods[i.name] && !BAD_FOOD.has(i.name))
      .sort((a, b) => (foods[b.name]?.foodPoints ?? 0) - (foods[a.name]?.foodPoints ?? 0))[0];
    if (!food) return fail('pas de nourriture', { precondition: true });
    if (bot.food >= 20) return fail('pas faim', { precondition: true });
    await bot.equip(food, 'hand');
    await bot.consume();
    return { status: 'success', detail: { item: food.name } };
  },
};

const ARMOR_SLOT: Record<string, 'head' | 'torso' | 'legs' | 'feet'> = { helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' };
const equip = {
  name: 'equip',
  domain: 'survive' as Domain,
  description: 'equip {item: nom d\'objet} — tenir un outil ou porter une pièce d\'armure',
  params: z.object({ item: z.string().min(1) }),
  timeoutMs: () => 5_000,
  async run({ bot }: SkillContext, p: { item: string }): Promise<ActionRunOutput> {
    const it = bot.inventory.items().find((i) => i.name === p.item);
    if (!it) return fail('objet absent de l\'inventaire', { item: p.item, precondition: true });
    const piece = Object.keys(ARMOR_SLOT).find((k) => p.item.endsWith(`_${k}`));
    await bot.equip(it, piece ? ARMOR_SLOT[piece]! : p.item === 'shield' ? 'off-hand' : 'hand');
    return { status: 'success' };
  },
};

const say = {
  name: 'say',
  domain: 'explore' as Domain,
  description: 'say {text} — parler au joueur (court)',
  params: z.object({ text: z.string().min(1).max(200) }),
  timeoutMs: () => 3_000,
  async run({ bot, speak }: SkillContext, p: { text: string }): Promise<ActionRunOutput> {
    if (speak) speak(p.text);
    else bot.chat(p.text);
    return { status: 'success' };
  },
};

/** Bibliothèque : des primitives génériques ; leurs paramètres et leur enchaînement viennent de l'arbre. */
export const SKILLS: Record<string, Skill> = Object.fromEntries(
  [follow, collect, build, attack, craft, explore, eat, equip, say, staircase, ...EXTRA_SKILLS].map((s) => [s.name, s as unknown as Skill]),
);

export type SkillName = keyof typeof SKILLS;

export function skillCatalogue(): string {
  return Object.values(SKILLS)
    .map((s) => `- ${s.description}`)
    .join('\n');
}

export class SkillParamsError extends Error {
  override name = 'SkillParamsError';
}

/** Valide les paramètres et fabrique l'action exécutable par le contrôleur. */
export function toAction(ctx: SkillContext, name: string, rawParams: unknown): Action {
  const skill = SKILLS[name];
  if (!skill) throw new SkillParamsError(`compétence inconnue : ${name}`);
  const parsed = skill.params.safeParse(rawParams ?? {});
  if (!parsed.success) throw new SkillParamsError(`paramètres invalides pour ${name} : ${z.prettifyError(parsed.error)}`);
  const params = parsed.data as Record<string, unknown>;
  return {
    name,
    domain: skill.domain,
    params,
    timeoutMs: skill.timeoutMs(params),
    run: (signal) => skill.run(ctx, params, signal),
  };
}
