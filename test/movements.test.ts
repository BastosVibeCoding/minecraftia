import { describe, expect, it } from 'vitest';
import { adaptDoor, isHandDoor } from '../src/bot/movements.js';

const block = (name: string, props: Record<string, unknown>) => ({
  name,
  safe: false,
  physical: true,
  openable: false,
  getProperties: () => props,
});

describe('passage des portes', () => {
  it("porte fermée : la moitié basse s'ouvre, la moitié haute suit", () => {
    const lower = block('oak_door', { open: false, half: 'lower' });
    const upper = block('oak_door', { open: false, half: 'upper' });
    adaptDoor(lower);
    adaptDoor(upper);
    expect(lower.openable).toBe(true);
    expect(upper).toMatchObject({ safe: true, physical: false, openable: false });
  });

  it("porte ouverte : on la traverse sans la refermer", () => {
    const b = block('spruce_door', { open: true, half: 'lower' });
    adaptDoor(b);
    expect(b).toMatchObject({ safe: true, openable: false });
  });

  it("porte en fer et autres blocs : inchangés", () => {
    expect(isHandDoor('iron_door')).toBe(false);
    const iron = block('iron_door', { open: false, half: 'lower' });
    const stone = block('stone', {});
    adaptDoor(iron);
    adaptDoor(stone);
    expect(iron).toMatchObject({ safe: false, openable: false });
    expect(stone).toMatchObject({ safe: false, openable: false });
  });

  it("bloc hors chargement (sans nom) : ignoré", () => {
    expect(() => adaptDoor({ safe: false, physical: false, openable: false } as never)).not.toThrow();
  });
});
