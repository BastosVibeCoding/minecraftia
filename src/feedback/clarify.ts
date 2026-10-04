/**
 * Ordres trop vagues pour choisir le bon outil (« va miner », « va récolter ») : le bot demande
 * d'abord quoi, puis la réponse du joueur complète l'ordre.
 */

const norm = (t: string) =>
  t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’`]/g, "'")
    .replace(/[^a-z0-9' =-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Ce qui précise une cible : minerais, matériaux, hauteur (« y=-10 »), « tout ». */
const TARGET =
  /\b(fer|charbon|diamants?|or|cuivre|redstone|lapis|emeraudes?|quartz|obsidienne|minerais?|pierres?|cailloux|pave|terre|sable|gravier|argile|bois|buches?|arbres?|troncs?|planches?|ble|carottes?|patates?|pommes? de terre|betteraves?|canne|bambou|laine|fleurs?|feuilles?|champignons?|escalier|tout|toutes?|y ?=|y -?\d+)\b/;

const MINE = /\b(mine|miner|minage|va miner)\b/;
const HARVEST = /\b(recolte|recolter|ramasse|ramasser|recupere|recuperer|collecte|collecter)\b/;

/** Question à poser avant d'obéir, ou `null` si l'ordre est assez précis. */
export function clarifyingQuestion(text: string): string | null {
  const t = norm(text);
  if (TARGET.test(t)) return null;
  if (MINE.test(t)) return 'Je mine quoi ? Du fer, du charbon, du diamant… ? Que je prenne la bonne pioche.';
  if (HARVEST.test(t)) return 'Je récolte quoi ? Du bois, de la pierre, du blé… ?';
  return null;
}
