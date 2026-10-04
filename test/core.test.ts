import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/bus.js';
import { ManualClock } from '../src/core/clock.js';
import { scrub } from '../src/core/logger.js';
import { ConfigError, loadConfig } from '../src/config/load.js';
import { captureLogger } from './helpers.js';

describe('configuration', () => {
  it('applique les valeurs par défaut et lit .env', () => {
    const c = loadConfig({ FOLLOW_PLAYER: 'Bastien', MC_PORT: '25570', DAILY_BUDGET_USD: '2.5' });
    expect(c.followPlayer).toBe('Bastien');
    expect(c.minecraft.port).toBe(25570);
    expect(c.minecraft.version).toBe('1.21');
    expect(c.strategy).toBe('mirror');
    expect(c.openrouter.dailyBudgetUsd).toBe(2.5);
    expect(c.openrouter.modelFast).toBe('anthropic/claude-haiku-4.5');
  });

  it('refuse une configuration sans joueur à suivre', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
  });

  it('refuse une stratégie inconnue', () => {
    expect(() => loadConfig({ FOLLOW_PLAYER: 'a', STRATEGY: 'chaos' })).toThrow(ConfigError);
  });

  it('accepte complement dans le schéma (point d\'extension)', () => {
    expect(loadConfig({ FOLLOW_PLAYER: 'a', STRATEGY: 'complement' }).strategy).toBe('complement');
  });
});

describe('journalisation', () => {
  it('masque la clé OpenRouter, les champs sensibles et les motifs de clés', () => {
    const key = 'sk-or-v1-abcdef0123456789abcdef';
    const { logger, lines } = captureLogger([key]);
    logger.info({ apiKey: key, nested: { token: 'xyz123456' }, url: `https://x?k=${key}` }, `appel avec ${key}`);
    logger.error({ err: new Error(`échec Bearer ${key}`) }, 'erreur');
    const out = lines.join('\n');
    expect(out).not.toContain(key);
    expect(out).not.toContain('xyz123456');
    expect(out).toContain('***');
  });

  it('scrub laisse intactes les valeurs ordinaires', () => {
    expect(scrub({ a: 1, b: 'texte', c: [true] })).toEqual({ a: 1, b: 'texte', c: [true] });
  });
});

describe('bus', () => {
  it('un abonné en erreur n\'empêche pas les autres de recevoir l\'événement', () => {
    const { logger, lines } = captureLogger();
    const bus = new EventBus<{ ping: number }>(logger);
    const got: number[] = [];
    bus.on('ping', () => {
      throw new Error('boum');
    });
    bus.on('ping', (n) => got.push(n));
    expect(() => bus.emit('ping', 7)).not.toThrow();
    expect(got).toEqual([7]);
    expect(lines.join('')).toContain('boum');
  });
});

describe('horloge manuelle', () => {
  it('déclenche les minuteries dans l\'ordre', () => {
    const clock = new ManualClock();
    const order: string[] = [];
    clock.setTimeout(() => order.push('b'), 20);
    clock.setTimeout(() => order.push('a'), 10);
    const c = clock.setTimeout(() => order.push('x'), 15);
    c.cancel();
    clock.advance(25);
    expect(order).toEqual(['a', 'b']);
    expect(clock.now()).toBe(25);
  });
});
