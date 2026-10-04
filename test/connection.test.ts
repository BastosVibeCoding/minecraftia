import { EventEmitter } from 'node:events';
import type { Bot } from 'mineflayer';
import { describe, expect, it } from 'vitest';
import { BotConnection } from '../src/bot/connection.js';
import { ManualClock } from '../src/core/clock.js';
import { silentLogger } from './helpers.js';

class FakeBot extends EventEmitter {
  username = 'Minecraftia';
  quitCalls = 0;
  _client = { socket: { destroyed: false } };
  quit() {
    this.quitCalls++;
    this.emit('end', 'quit');
  }
}

function setup() {
  const clock = new ManualClock();
  const bots: FakeBot[] = [];
  const conn = new BotConnection(
    { host: 'h', port: 1, username: 'Minecraftia', version: '1.21', initialDelayMs: 1000, maxDelayMs: 8000, stableAfterMs: 60000 },
    () => {
      const b = new FakeBot();
      bots.push(b);
      return b as unknown as Bot;
    },
    clock,
    silentLogger,
  );
  const events: string[] = [];
  conn.on('ready', () => events.push('ready'));
  conn.on('lost', (r) => events.push(`lost:${r}`));
  return { clock, bots, conn, events };
}

describe('connexion', () => {
  it('se reconnecte avec un délai exponentiel plafonné', () => {
    const { clock, bots, conn } = setup();
    conn.start();
    expect(bots).toHaveLength(1);
    bots[0]!.emit('end', 'socketClosed');
    clock.advance(999);
    expect(bots).toHaveLength(1);
    clock.advance(1);
    expect(bots).toHaveLength(2);
    bots[1]!.emit('end', 'x');
    clock.advance(2000);
    expect(bots).toHaveLength(3);
    bots[2]!.emit('kicked', 'serveur plein');
    clock.advance(4000);
    bots[3]!.emit('end', 'x');
    clock.advance(8000);
    bots[4]!.emit('end', 'x');
    expect(conn.nextDelayMs).toBe(8000);
  });

  it('remet le délai à zéro après une session stable', () => {
    const { clock, bots, conn, events } = setup();
    conn.start();
    bots[0]!.emit('end', 'a');
    clock.advance(1000);
    bots[1]!.emit('end', 'b');
    clock.advance(2000);
    bots[2]!.emit('spawn');
    expect(events).toContain('ready');
    clock.advance(120000);
    bots[2]!.emit('end', 'c');
    expect(conn.nextDelayMs).toBe(2000); // 1000 utilisé, puis doublé
  });

  it('ne signale qu\'une perte même si error et end arrivent ensemble', () => {
    const { bots, conn, events } = setup();
    conn.start();
    bots[0]!._client.socket.destroyed = true;
    bots[0]!.emit('error', new Error('ECONNRESET'));
    bots[0]!.emit('end', 'socketClosed');
    expect(events.filter((e) => e.startsWith('lost'))).toHaveLength(1);
  });

  it('arrêt : plus aucune reconnexion', () => {
    const { clock, bots, conn } = setup();
    conn.start();
    conn.stop();
    clock.advance(100000);
    expect(bots).toHaveLength(1);
    expect(bots[0]!.quitCalls).toBe(1);
  });
});
