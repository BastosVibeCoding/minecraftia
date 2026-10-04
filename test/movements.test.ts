import { describe, expect, it } from 'vitest';
import { adaptDoor, DoorOpener, isHandDoor, isPassage } from '../src/bot/movements.js';

const block = (name: string, props: Record<string, unknown>) => ({
  name,
  safe: false,
  physical: true,
  openable: false,
  getProperties: () => props,
});

describe('passage des portes (cas réel : le bot ouvrait la porte puis restait bloqué)', () => {
  it("porte et portillon, ouverts ou fermés : traversables pour le calcul du chemin, jamais « utilisés » par le pathfinder", () => {
    for (const b of [block('oak_door', { open: false, half: 'lower' }), block('oak_door', { open: false, half: 'upper' }), block('spruce_door', { open: true, half: 'lower' }), block('birch_fence_gate', { open: false })]) {
      adaptDoor(b);
      expect(b).toMatchObject({ safe: true, physical: false, openable: false });
    }
  });

  it('porte en fer et autres blocs : inchangés', () => {
    expect(isHandDoor('iron_door')).toBe(false);
    expect(isPassage('iron_door')).toBe(false);
    const iron = block('iron_door', { open: false, half: 'lower' });
    const stone = block('stone', {});
    adaptDoor(iron);
    adaptDoor(stone);
    expect(iron).toMatchObject({ safe: false, openable: false });
    expect(stone).toMatchObject({ safe: false, openable: false });
  });

  it('bloc hors chargement (sans nom) : ignoré', () => {
    expect(() => adaptDoor({ safe: false, physical: false, openable: false } as never)).not.toThrow();
  });
});

describe('ouvreur de portes', () => {
  function world(doors: Record<string, { name: string; props: Record<string, unknown> }>, moving = true, at = { x: 0, y: 64, z: 0 }) {
    const activated: string[] = [];
    const pos = { ...at, distanceTo: (p: { x: number; y: number; z: number }) => Math.hypot(p.x - at.x, p.y - at.y, p.z - at.z) };
    const bot = {
      entity: { position: pos },
      blockAt: (p: { x: number; y: number; z: number }) => {
        const d = doors[`${p.x},${p.y},${p.z}`];
        return d ? { name: d.name, position: p, getProperties: () => d.props } : { name: 'air', position: p };
      },
      activateBlock: async (b: { position: { x: number; y: number; z: number } }) => void activated.push(`${b.position.x},${b.position.y},${b.position.z}`),
      pathfinder: { isMoving: () => moving },
    };
    return { opener: new DoorOpener(bot as never), activated };
  }

  it('ouvre la porte fermée sur les prochains pas, une seule fois le temps que le serveur réponde', () => {
    const { opener, activated } = world({ '1,64,0': { name: 'oak_door', props: { open: false, half: 'lower' } } });
    const path = [{ x: 1, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }];
    expect(opener.step(path, 0)).toEqual({ x: 1, y: 64, z: 0 });
    expect(opener.step(path, 500)).toBeNull();
    expect(activated).toEqual(['1,64,0']);
  });

  it("vise la moitié basse quand seule la moitié haute est sur le chemin", () => {
    const { opener, activated } = world({
      '1,64,0': { name: 'oak_door', props: { open: false, half: 'lower' } },
      '1,65,0': { name: 'oak_door', props: { open: false, half: 'upper' } },
    });
    opener.step([{ x: 1, y: 64, z: 0 }], 0);
    expect(activated).toEqual(['1,64,0']);
  });

  it("laisse les portes ouvertes, lointaines, ou quand le bot ne bouge pas", () => {
    expect(world({ '1,64,0': { name: 'oak_door', props: { open: true, half: 'lower' } } }).opener.step([{ x: 1, y: 64, z: 0 }], 0)).toBeNull();
    expect(world({ '9,64,0': { name: 'oak_door', props: { open: false, half: 'lower' } } }).opener.step([{ x: 9, y: 64, z: 0 }], 0)).toBeNull();
    expect(world({ '1,64,0': { name: 'oak_door', props: { open: false, half: 'lower' } } }, false).opener.step([{ x: 1, y: 64, z: 0 }], 0)).toBeNull();
  });
});
