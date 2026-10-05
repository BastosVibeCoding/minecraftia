import { describe, expect, it } from 'vitest';
import { LEAVE_AFTER_MS, PARK_DEADLINE_MS, presenceAction } from '../src/bot/presence.js';

describe("joueur déconnecté : rentrer, ranger, puis se déconnecter (demande du joueur)", () => {
  it("reste tant que son joueur est là, ou pendant la première minute d'absence", () => {
    expect(presenceAction(true, null, 0, false)).toBe('rester');
    expect(presenceAction(false, 0, LEAVE_AFTER_MS - 1, false)).toBe('rester');
  });

  it("après une minute : rentre à la maison (une seule fois)", () => {
    expect(presenceAction(false, 0, LEAVE_AFTER_MS, false)).toBe('rentrer');
    expect(presenceAction(false, 0, LEAVE_AFTER_MS + 30_000, true)).toBe('rester');
  });

  it("au bout de cinq minutes : se déconnecte quoi qu'il arrive, même si le retour est bloqué", () => {
    expect(presenceAction(false, 0, PARK_DEADLINE_MS, true)).toBe('se déconnecter');
    expect(PARK_DEADLINE_MS).toBe(5 * 60_000);
  });
});
