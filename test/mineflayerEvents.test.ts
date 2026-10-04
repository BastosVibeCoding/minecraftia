import { EventEmitter } from 'node:events';
import type { Bot } from 'mineflayer';
import { describe, expect, it } from 'vitest';
import { MineflayerEventSource } from '../src/bot/mineflayerEvents.js';
import type { RawEvent } from '../src/observer/types.js';

function setup(fallback = false) {
  let now = 1000;
  const player = { username: 'Bastien', type: 'player', position: { x: 0, y: 64, z: 0 }, heldItem: { name: 'iron_sword' }, equipment: [] };
  const zombie = { id: 42, name: 'zombie', type: 'hostile', position: { x: 2, y: 64, z: 0 } };
  const bot = Object.assign(new EventEmitter(), { players: { Bastien: { entity: player } }, entity: {} }) as unknown as Bot & EventEmitter;
  const events: RawEvent[] = [];
  const src = new MineflayerEventSource(bot, 'Bastien', (e) => events.push(e), () => now, () => fallback);
  src.start();
  return { bot, events, player, zombie, advance: (ms: number) => (now += ms) };
}

describe('événements mineflayer du joueur suivi', () => {
  it('coup de bras puis blessure → attaque', () => {
    const { bot, events, player, zombie } = setup();
    bot.emit('entitySwingArm', player);
    bot.emit('entityHurt', zombie);
    expect(events).toEqual([expect.objectContaining({ type: 'attack', target: 'zombie', distance: 2, weapon: 'iron_sword' })]);
  });

  it('blessure puis coup de bras (ordre réel observé sur le serveur) → attaque', () => {
    const { bot, events, player, zombie } = setup();
    bot.emit('entityHurt', zombie);
    expect(events).toHaveLength(0);
    bot.emit('entitySwingArm', player);
    expect(events.map((e) => e.type)).toEqual(['attack']);
  });

  it('une blessure sans coup de bras du joueur n\'est pas une attaque', () => {
    const { bot, events, player, zombie, advance } = setup();
    bot.emit('entityHurt', zombie);
    advance(2000);
    bot.emit('entitySwingArm', player);
    expect(events).toHaveLength(0);
  });

  it('un mob tué peu après une attaque → kill', () => {
    const { bot, events, player, zombie, advance } = setup();
    bot.emit('entitySwingArm', player);
    bot.emit('entityHurt', zombie);
    advance(500);
    bot.emit('entityDead', zombie);
    expect(events.map((e) => e.type)).toEqual(['attack', 'kill']);
  });

  it('un mob hors de portée n\'est pas attribué au joueur', () => {
    const { bot, events, player, zombie } = setup();
    zombie.position = { x: 12, y: 64, z: 0 };
    bot.emit('entitySwingArm', player);
    bot.emit('entityHurt', zombie);
    expect(events).toHaveLength(0);
  });

  it('un gestionnaire en erreur ne remonte pas jusqu\'à mineflayer', () => {
    const { bot } = setup();
    expect(() => bot.emit('entityHurt', null)).not.toThrow();
  });
});
