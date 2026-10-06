import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import { z } from 'zod';
import type { Domain } from '../core/types.js';
import type { ActionRunOutput } from './actionController.js';
import type { SkillContext } from './library.js';
import { ensureHarvestTool } from './tools.js';

const { goals } = pathfinderPkg;

const DIRS = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] } as const;
type Dir = keyof typeof DIRS;

/** Direction cardinale la plus proche du regard du bot (lacet mineflayer : 0 = nord, sens trigonométrique). */
export function facing(yaw: number): Dir {
  const dx = -Math.sin(yaw);
  const dz = -Math.cos(yaw);
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? 'east' : 'west';
  return dz > 0 ? 'south' : 'north';
}

type Pos = { x: number; y: number; z: number };
interface Cell {
  name: string;
  boundingBox: string;
}

/**
 * Une marche : les trois blocs à creuser devant (tête, pieds, marche du dessous) et le bloc qui doit
 * porter le bot. Refus si de la lave ou de l'eau touche le passage, ou s'il n'y a rien dessous (grotte).
 */
export function planStep(at: (dx: number, dy: number, dz: number) => Cell | null, dir: Dir): { dig: [number, number, number][] } | { stop: string } {
  const [dx, dz] = DIRS[dir];
  const dig: [number, number, number][] = [
    [dx, 1, dz],
    [dx, 0, dz],
    [dx, -1, dz],
  ];
  const liquid = (c: Cell | null) => c !== null && (c.name === 'lava' || c.name === 'water');
  for (const [x, y, z] of dig) {
    for (const [ox, oy, oz] of [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const c = at(x + ox!, y + oy!, z + oz!);
      if (liquid(c)) return { stop: c!.name === 'lava' ? 'lave près de l\'escalier' : 'eau près de l\'escalier' };
    }
  }
  const floor = at(dx, -2, dz);
  if (!floor || floor.boundingBox !== 'block') return { stop: 'vide sous la prochaine marche' };
  return { dig };
}

/** Creuser un escalier vers le bas jusqu'à une hauteur donnée, dans une direction cardinale. */
export const staircase = {
  name: 'staircase',
  domain: 'mine' as Domain,
  description: 'staircase {targetY: hauteur à atteindre (ex. -10, 11), direction?: north|south|east|west} — creuser un escalier vers le bas jusqu\'à cette hauteur (s\'arrête devant la lave, l\'eau ou le vide)',
  params: z.object({ targetY: z.number().int().min(-60).max(320), direction: z.enum(['north', 'south', 'east', 'west']).optional() }),
  timeoutMs: () => 300_000,
  async run(ctx: SkillContext, p: { targetY: number; direction?: Dir | undefined }, signal: AbortSignal): Promise<ActionRunOutput> {
    const { bot } = ctx;
    const startY = Math.floor(bot.entity.position.y);
    if (startY <= p.targetY) return { status: 'failure', detail: { reason: `déjà à y=${startY}, l'escalier ne fait que descendre`, precondition: true } };
    const tool = await ensureHarvestTool(bot, 'stone', signal, ctx).catch(() => ({ ok: true as const }));
    if (!tool.ok) {
      ctx.speak?.(tool.ask);
      return { status: 'failure', detail: { reason: tool.ask, precondition: true } };
    }
    const dir = p.direction ?? facing(bot.entity.yaw);
    let steps = 0;
    while (!signal.aborted && Math.floor(bot.entity.position.y) > p.targetY) {
      const me = bot.entity.position.floored();
      const at = (dx: number, dy: number, dz: number) => bot.blockAt(me.offset(dx, dy, dz));
      const plan = planStep(at, dir);
      if ('stop' in plan) return result(bot, steps, startY, plan.stop);
      for (const [x, y, z] of plan.dig) {
        // le gravier et le sable retombent : on recreuse tant que la case n'est pas libre
        for (let tries = 0; tries < 6 && !signal.aborted; tries++) {
          const b = at(x, y, z);
          if (!b || b.boundingBox !== 'block') break;
          if (ctx.isProtected?.(b)) return result(bot, steps, startY, 'bloc posé par un joueur sur le chemin');
          ctx.touch?.(b.position);
          await dig(bot, b, signal);
        }
      }
      if (signal.aborted) break;
      const target = me.offset(DIRS[dir][0], -1, DIRS[dir][1]);
      await goTo(bot, target, signal);
      if (Math.floor(bot.entity.position.y) >= me.y) return result(bot, steps, startY, 'impossible de descendre sur la marche');
      steps++;
    }
    return result(bot, steps, startY, signal.aborted ? 'interrompu' : undefined);
  },
};

function result(bot: Bot, steps: number, startY: number, reason?: string): ActionRunOutput {
  const y = Math.floor(bot.entity.position.y);
  if (steps === 0) return { status: 'failure', detail: { reason: reason ?? 'aucune marche creusée', y } };
  return { status: 'success', detail: { steps, from: startY, y, ...(reason ? { stopped: reason } : {}) } };
}

async function dig(bot: Bot, b: Parameters<Bot['dig']>[0], signal: AbortSignal): Promise<void> {
  const onAbort = () => bot.stopDigging();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const tool = bot.pathfinder.bestHarvestTool(b);
    if (tool) await bot.equip(tool, 'hand');
    await bot.dig(b, true);
  } catch {
    // bloc déjà parti ou creusage interrompu : la boucle constate l'état réel
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function goTo(bot: Bot, p: Pos, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const onAbort = () => bot.pathfinder.setGoal(null);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await bot.pathfinder.goto(new goals.GoalBlock(p.x, p.y, p.z));
  } catch {
    // trajet impossible : l'appelant vérifie la hauteur atteinte
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
