import { Writable } from 'node:stream';
import { createLogger, type Logger } from '../src/core/logger.js';
import type { SurvivalSnapshot } from '../src/reflexes/types.js';
import type { WorldState } from '../src/decider/world.js';

/** Logger qui capture les lignes JSON émises, pour vérifier le contenu des journaux. */
export function captureLogger(secrets: string[] = []): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  return { logger: createLogger({ level: 'trace', secrets, destination: stream }), lines };
}

export const silentLogger: Logger = createLogger({ level: 'silent' });

export function safeSnapshot(over: Partial<SurvivalSnapshot> = {}): SurvivalSnapshot {
  return {
    health: 20,
    food: 20,
    oxygen: 20,
    position: { x: 0, y: 64, z: 0 },
    velocityY: 0,
    onGround: true,
    inLava: false,
    onFire: false,
    inWater: false,
    headInWater: false,
    heightAboveGround: 0,
    hostiles: [],
    hasFood: true,
    hasWaterBucket: false,
    ...over,
  };
}

export const THRESHOLDS = {
  lowHealth: 8,
  eatBelowFood: 6,
  drowningOxygen: 8,
  dangerousFall: 5,
  threatRadius: 8,
  maxHostiles: 3,
  creeperRadius: 4,
};

/** État du monde de référence : le joueur construit, le bot a de la pierre taillée. */
export function world(over: Partial<WorldState> = {}): WorldState {
  return {
    bot: { health: 20, food: 20, position: { x: 0, y: 64, z: 0 }, dimension: 'overworld', heldItem: null, inventory: { stone_bricks: 64 } },
    player: { name: 'Bastien', online: true, distance: 3, heldItem: 'stone_bricks', activity: ['build'], recent: ['a construit un mur 7×4 en stone bricks'] },
    threats: [],
    time: 'jour',
    biome: 'plains',
    ...over,
  };
}
