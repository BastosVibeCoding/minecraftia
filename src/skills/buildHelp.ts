import type { Bot } from 'mineflayer';
import { z } from 'zod';
import type { Domain } from '../core/types.js';
import type { ActionRunOutput } from './actionController.js';
import { countItem, give, goNear, withdrawFromChests } from './extra.js';
import type { SkillContext } from './library.js';

type Pos = { x: number; y: number; z: number };
export type Placement = Pos & { block: string; at: number };

const fail = (reason: string, extra: Record<string, unknown> = {}): ActionRunOutput => ({ status: 'failure', detail: { reason, ...extra } });

/** Fenêtre de temps prise en compte pour « ce que je viens de construire ». */
const RECENT_MS = 10 * 60_000;

/** Faces voisines par ordre de préférence pour s'appuyer en posant un bloc (dessous d'abord). */
const NEIGHBOURS: [number, number, number][] = [
  [0, -1, 0],
  [1, 0, 0],
  [-1, 0, 0],
  [0, 0, 1],
  [0, 0, -1],
  [0, 1, 0],
];

/**
 * Pose un bloc de l'inventaire à une position précise, en s'appuyant sur n'importe quelle face
 * voisine solide (pas seulement par-dessus). Renvoie `true` si le bloc est en place.
 */
export async function placeBlockAt(ctx: SkillContext, target: Bot['entity']['position'], itemName: string, signal: AbortSignal): Promise<boolean> {
  const { bot } = ctx;
  const current = bot.blockAt(target);
  if (current && current.boundingBox === 'block') return current.name === itemName;
  for (const [dx, dy, dz] of NEIGHBOURS) {
    const ref = bot.blockAt(target.offset(dx, dy, dz));
    if (!ref || ref.boundingBox !== 'block') continue;
    if (bot.entity.position.distanceTo(target) > 4) await goNear(bot, target, 3, signal);
    const item = bot.inventory.items().find((i) => i.name === itemName);
    if (!item || signal.aborted) return false;
    try {
      await bot.equip(item, 'hand');
      ctx.touch?.(target);
      // face de la référence tournée vers la case visée
      await bot.placeBlock(ref, ref.position.offset(-dx, -dy, -dz).minus(ref.position));
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

/** Assure `count` blocs de ce type sur soi, en complétant avec les coffres proches. */
async function stockUp(bot: Bot, block: string, count: number, signal: AbortSignal): Promise<number> {
  const missing = count - countItem(bot, block);
  if (missing > 0) await withdrawFromChests(bot, (n) => n === block, missing, signal);
  return countItem(bot, block);
}

/**
 * Le mur que le joueur vient de construire : blocs du même type que son dernier bloc posé, alignés
 * sur un axe (x ou z). Renvoie l'axe, la ligne fixe, l'étendue et la hauteur.
 */
export function detectWall(placements: Placement[]): { block: string; axis: 'x' | 'z'; fixed: number; from: number; to: number; minY: number; maxY: number; last: Placement } | null {
  const last = placements[0];
  if (!last) return null;
  const same = placements.filter((p) => p.block === last.block && Math.abs(p.x - last.x) <= 16 && Math.abs(p.z - last.z) <= 16 && Math.abs(p.y - last.y) <= 8);
  const onX = same.filter((p) => p.z === last.z);
  const onZ = same.filter((p) => p.x === last.x);
  const spread = (ps: Placement[], k: 'x' | 'z') => (ps.length ? Math.max(...ps.map((p) => p[k])) - Math.min(...ps.map((p) => p[k])) : 0);
  const axis: 'x' | 'z' = spread(onX, 'x') >= spread(onZ, 'z') ? 'x' : 'z';
  const line = axis === 'x' ? onX : onZ;
  if (line.length < 2 || spread(line, axis) < 1) return null;
  const coords = line.map((p) => p[axis]);
  return {
    block: last.block,
    axis,
    fixed: axis === 'x' ? last.z : last.x,
    from: Math.min(...coords),
    to: Math.max(...coords),
    minY: Math.min(...line.map((p) => p.y)),
    maxY: Math.max(...line.map((p) => p.y)),
    last,
  };
}

/**
 * Cases à remplir pour prolonger le mur : depuis le bout le plus proche du dernier bloc posé, vers
 * l'extérieur, sur `length` colonnes, toute la hauteur du mur, de bas en haut.
 */
export function wallExtension(wall: NonNullable<ReturnType<typeof detectWall>>, length: number): Pos[] {
  const lastCoord = wall.last[wall.axis];
  const dir = Math.abs(lastCoord - wall.to) <= Math.abs(lastCoord - wall.from) ? 1 : -1;
  const start = dir > 0 ? wall.to : wall.from;
  const cells: Pos[] = [];
  for (let y = wall.minY; y <= wall.maxY; y++) {
    for (let k = 1; k <= length; k++) {
      const c = start + dir * k;
      cells.push(wall.axis === 'x' ? { x: c, y, z: wall.fixed } : { x: wall.fixed, y, z: c });
    }
  }
  return cells;
}

/** Prolonger le mur que le joueur vient de construire. */
export const extendWall = {
  name: 'extend_wall',
  domain: 'build' as Domain,
  description: "extend_wall {length?: 1-32, toPlayer?: boolean} — prolonger le mur que le joueur vient de construire (même bloc, même hauteur) ; toPlayer : jusqu'à l'endroit où se tient le joueur",
  params: z.object({ length: z.number().int().min(1).max(32).default(5), toPlayer: z.boolean().default(false) }),
  timeoutMs: () => 240_000,
  async run(ctx: SkillContext, p: { length: number; toPlayer: boolean }, signal: AbortSignal): Promise<ActionRunOutput> {
    const { bot } = ctx;
    const wall = detectWall(ctx.recentPlacements?.(RECENT_MS) ?? []);
    if (!wall) return fail("je ne vois pas de mur que tu viens de construire : pose au moins deux blocs alignés", { precondition: true });
    let length = p.length;
    const player = bot.players[ctx.followPlayer]?.entity?.position;
    if (p.toPlayer && player) {
      const target = Math.round(wall.axis === 'x' ? player.x : player.z);
      length = Math.max(1, Math.min(32, Math.max(target - wall.to, wall.from - target)));
    }
    const cells = wallExtension(wall, length);
    await stockUp(bot, wall.block, cells.length, signal);
    if (countItem(bot, wall.block) === 0) return fail(`pas de ${wall.block.replace(/_/g, ' ')}, ni sur moi ni dans les coffres`, { precondition: true });
    const me = bot.entity.position;
    let placed = 0;
    for (const c of cells) {
      if (signal.aborted || countItem(bot, wall.block) === 0) break;
      if (await placeBlockAt(ctx, me.offset(c.x - me.x, c.y - me.y, c.z - me.z).floored(), wall.block, signal)) placed++;
    }
    return placed > 0 ? { status: 'success', detail: { placed, of: cells.length } } : fail('aucun bloc posé');
  },
};

/** Relevé de ce que le joueur vient de construire : blocs proches du dernier posé, en coordonnées relatives. */
export function blueprintOfRecent(placements: Placement[]): { cells: (Pos & { block: string })[]; size: Pos; origin: Pos } | null {
  const last = placements[0];
  if (!last) return null;
  const near = placements.filter((p) => Math.abs(p.x - last.x) <= 12 && Math.abs(p.y - last.y) <= 12 && Math.abs(p.z - last.z) <= 12);
  if (near.length < 2) return null;
  const origin = { x: Math.min(...near.map((p) => p.x)), y: Math.min(...near.map((p) => p.y)), z: Math.min(...near.map((p) => p.z)) };
  const cells = near
    .map((p) => ({ x: p.x - origin.x, y: p.y - origin.y, z: p.z - origin.z, block: p.block }))
    .sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);
  const size = { x: Math.max(...cells.map((c) => c.x)) + 1, y: Math.max(...cells.map((c) => c.y)) + 1, z: Math.max(...cells.map((c) => c.z)) + 1 };
  return { cells, size, origin };
}

/** Reproduire à côté ce que le joueur vient de construire. */
export const copyBuild = {
  name: 'copy_build',
  domain: 'build' as Domain,
  description: "copy_build {} — reconstruire à l'identique, juste à côté, ce que le joueur vient de construire",
  params: z.object({}),
  timeoutMs: () => 300_000,
  async run(ctx: SkillContext, _p: Record<string, never>, signal: AbortSignal): Promise<ActionRunOutput> {
    const { bot } = ctx;
    const plan = blueprintOfRecent(ctx.recentPlacements?.(RECENT_MS) ?? []);
    if (!plan) return fail("je ne vois rien que tu viens de construire à copier", { precondition: true });
    // à côté de l'original, du côté où il y a de la place (est, ouest, sud, nord)
    const me = bot.entity.position;
    const at = (x: number, y: number, z: number) => me.offset(x - me.x, y - me.y, z - me.z).floored();
    const shifts: [number, number][] = [
      [plan.size.x + 2, 0],
      [-(plan.size.x + 2), 0],
      [0, plan.size.z + 2],
      [0, -(plan.size.z + 2)],
    ];
    const free = shifts.find(([sx, sz]) => plan.cells.every((c) => bot.blockAt(at(plan.origin.x + c.x + sx, plan.origin.y + c.y, plan.origin.z + c.z + sz))?.boundingBox !== 'block'));
    if (!free) return fail('pas de place libre à côté pour la copie', { precondition: true });
    const needs: Record<string, number> = {};
    for (const c of plan.cells) needs[c.block] = (needs[c.block] ?? 0) + 1;
    for (const [block, n] of Object.entries(needs)) await stockUp(bot, block, n, signal);
    const lacking = Object.entries(needs).filter(([b, n]) => countItem(bot, b) < n).map(([b, n]) => `${n - countItem(bot, b)} ${b.replace(/_/g, ' ')}`);
    if (lacking.length === Object.keys(needs).length && Object.keys(needs).every((b) => countItem(bot, b) === 0)) {
      ctx.speak?.(`Pour copier, il me manque ${lacking.join(', ')}. Tu peux m'en donner ?`);
      return fail(`il manque ${lacking.join(', ')}`, { precondition: true });
    }
    let placed = 0;
    for (const c of plan.cells) {
      if (signal.aborted) break;
      if (await placeBlockAt(ctx, at(plan.origin.x + c.x + free[0], plan.origin.y + c.y, plan.origin.z + c.z + free[1]), c.block, signal)) placed++;
    }
    if (lacking.length) ctx.speak?.(`Copie incomplète : il me manque ${lacking.join(', ')}.`);
    return placed > 0 ? { status: 'success', detail: { placed, of: plan.cells.length } } : fail('aucun bloc posé');
  },
};

/** Apporter des objets au joueur : pris dans les coffres, fabriqués si besoin, puis donnés. */
export const bring = {
  name: 'bring',
  domain: 'gather' as Domain,
  description: 'bring {item: nom Minecraft, count: 1-256} — apporter des objets au joueur (pris dans les coffres, fabriqués si besoin, puis donnés en main propre)',
  params: z.object({ item: z.string().min(1), count: z.number().int().min(1).max(256).default(16) }),
  timeoutMs: () => 240_000,
  async run(ctx: SkillContext, p: { item: string; count: number }, signal: AbortSignal): Promise<ActionRunOutput> {
    const { bot } = ctx;
    await stockUp(bot, p.item, p.count, signal);
    // pas assez : on fabrique le reste si c'est faisable (planches à partir de bûches…)
    if (countItem(bot, p.item) < p.count && ctx.craft) await ctx.craft(p.item, p.count - countItem(bot, p.item), signal);
    const have = countItem(bot, p.item);
    if (have === 0) return fail(`pas de ${p.item.replace(/_/g, ' ')}, ni dans les coffres, ni à fabriquer`, { precondition: true });
    const r = await give.run(ctx, { item: p.item, count: Math.min(have, p.count) }, signal);
    if (r.status === 'success' && have < p.count) ctx.speak?.(`Je n'en ai trouvé que ${have}.`);
    return r;
  },
};

export const BUILD_HELP_SKILLS = [extendWall, copyBuild, bring];
