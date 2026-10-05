import type { Bot } from 'mineflayer';
import { describe, expect, it } from 'vitest';
import { guessHome, HomeStore, isHomeDesignation } from '../src/bot/home.js';
import { ManualClock } from '../src/core/clock.js';
import { clampToHome, HOME_RANGE, SKILLS } from '../src/skills/library.js';
import { openDatabase } from '../src/store/db.js';
import { vec } from './helpers.js';

describe('la maison (demande du joueur)', () => {
  it("se désigne, persiste, s'oublie ; zone protégée de 24 blocs", () => {
    const { db } = openDatabase(':memory:');
    const clock = new ManualClock(0);
    const home = new HomeStore(db, clock, 24);
    expect(home.get()).toBeNull();
    home.set({ x: 100.7, y: 64.2, z: -20.4 });
    expect(new HomeStore(db, clock, 24).get()).toEqual({ x: 100, y: 64, z: -21 });
    expect(home.inZone({ x: 120, y: 60, z: -21 })).toBe(true);
    expect(home.inZone({ x: 130, y: 64, z: -21 })).toBe(false);
    expect(home.inZone({ x: 100, y: 30, z: -21 })).toBe(false);
    home.clear();
    expect(home.get()).toBeNull();
  });

  it("« ici c'est la maison » et ses variantes ; pas « rentre à la maison » ni une question", () => {
    for (const t of ["Alex, ici c'est la maison", 'voici notre maison', "c'est ici chez nous", 'la maison est ici']) expect(isHomeDesignation(t), t).toBe(true);
    for (const t of ['rentre à la maison', "c'est où la maison ?", 'range à la maison', 'coupe du bois']) expect(isHomeDesignation(t), t).toBe(false);
  });

  it("devine la maison là où sont les blocs posés, le lit et les coffres", () => {
    const house = [
      ...Array.from({ length: 30 }, (_, i) => ({ x: 200 + (i % 6), y: 64, z: 50 + Math.floor(i / 6), block: 'oak_planks' })),
      { x: 202, y: 64, z: 52, block: 'red_bed' },
      { x: 203, y: 64, z: 52, block: 'chest' },
      { x: 204, y: 64, z: 52, block: 'crafting_table' },
    ];
    const tower = Array.from({ length: 12 }, (_, i) => ({ x: 0, y: 64 + i, z: 0, block: 'cobblestone' }));
    const g = guessHome([...tower, ...house]);
    expect(g).not.toBeNull();
    expect(Math.hypot(g!.home.x - 202, g!.home.z - 52)).toBeLessThan(4);
    expect(g!.reason).toContain('un lit');
    // sans lit ni coffre, ce n'est pas une maison
    expect(guessHome(tower)).toBeNull();
  });

  it("ne propose plus une maison refusée avant un moment", () => {
    const clock = new ManualClock(0);
    const home = new HomeStore(openDatabase(':memory:').db, clock, 24);
    expect(home.mayAsk()).toBe(true);
    home.refuseGuess();
    expect(home.mayAsk()).toBe(false);
    clock.advance(7 * 3600_000);
    expect(home.mayAsk()).toBe(true);
  });

  it("exploration et recherche restent à moins de 128 blocs de la maison", () => {
    expect(clampToHome({ x: 500, z: 0 }, { x: 0, z: 0 })).toEqual({ x: HOME_RANGE, z: 0 });
    expect(clampToHome({ x: 50, z: 0 }, { x: 0, z: 0 })).toEqual({ x: 50, z: 0 });
    expect(clampToHome({ x: 500, z: 0 }, null)).toEqual({ x: 500, z: 0 });
  });

  it("« rentre à la maison » : y va par étapes ; sans maison, il explique comment la désigner", async () => {
    let pos = vec(300, 64, 0);
    const bot = {
      entity: { get position() { return pos; } },
      pathfinder: { goto: async (g: { x: number; z: number }) => void (pos = vec(g.x, 64, g.z)), setGoal: () => {} },
    } as unknown as Bot;
    const ok = await SKILLS.go_home!.run({ bot, followPlayer: 'B', home: () => ({ x: 0, y: 64, z: 0 }) }, {}, new AbortController().signal);
    expect(ok.status).toBe('success');
    expect(Math.hypot(pos.x, pos.z)).toBeLessThanOrEqual(4);
    const none = await SKILLS.go_home!.run({ bot, followPlayer: 'B', home: () => null }, {}, new AbortController().signal);
    expect(none).toMatchObject({ status: 'failure', detail: { precondition: true } });
  });
});

it("le simple mot « maison » ne déplace plus la maison (cas réel)", () => {
  for (const t of ["Alex, ici c'est la maison", 'ici la maison', "c'est ici chez nous", 'la maison est ici', "notre maison, c'est ici", 'voici notre maison', 'voilà la base']) expect(isHomeDesignation(t), t).toBe(true);
  for (const t of ['on rentre à la maison', 'la maison est belle', 'je suis dans la maison', 'va à la maison', 'elle est où la maison', 'maison', "c'est la maison de qui", 'range ça à la maison', "ce n'est pas ici la maison", 'construis une maison ici']) expect(isHomeDesignation(t), t).toBe(false);
});
