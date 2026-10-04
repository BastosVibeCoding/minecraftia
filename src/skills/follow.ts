import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import { abortableSleep } from '../core/abort.js';
import { playerEntity } from '../bot/mineflayerTypes.js';
import type { Action } from './actionController.js';

const { goals } = pathfinderPkg;

/**
 * Suivre le joueur pendant `durationMs`. Comportement neutre de départ.
 * Réussit si le joueur a été suivi, échoue s'il n'est pas visible.
 */
export function followAction(bot: Bot, username: string, distance: number, durationMs: number): Action {
  return {
    name: 'follow',
    domain: 'explore',
    timeoutMs: durationMs + 5000,
    params: { player: username, distance },
    async run(signal) {
      const target = playerEntity(bot, username);
      if (!target) return { status: 'failure', detail: { reason: 'joueur hors de vue' } };
      bot.pathfinder.setGoal(new goals.GoalFollow(target, distance), true);
      await abortableSleep(durationMs, signal);
      if (!signal.aborted) bot.pathfinder.setGoal(null);
      return { status: 'success' };
    },
  };
}
