/** Joueur suivi absent : délai avant de rentrer à la maison, puis déconnexion garantie. */
export const LEAVE_AFTER_MS = 60_000;
export const PARK_DEADLINE_MS = 5 * 60_000;

export type PresenceAction = 'rester' | 'rentrer' | 'se déconnecter';

/**
 * Que faire selon la présence du joueur suivi : rester avec lui ; après une minute d'absence, rentrer
 * à la maison et ranger ; au bout de cinq minutes, se déconnecter quoi qu'il arrive (demande du joueur :
 * même si le retour à la maison échoue). Chaque bot ne regarde que son propre joueur.
 */
export function presenceAction(present: boolean, absentSince: number | null, now: number, leaving: boolean): PresenceAction {
  if (present || absentSince === null) return 'rester';
  const absent = now - absentSince;
  if (absent >= PARK_DEADLINE_MS) return 'se déconnecter';
  if (absent >= LEAVE_AFTER_MS && !leaving) return 'rentrer';
  return 'rester';
}
