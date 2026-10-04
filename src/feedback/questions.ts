/**
 * Questions du joueur sur l'inventaire du bot (« t'as du bois ? », « combien de fer tu as ? ») :
 * réponse immédiate, calculée sur l'inventaire réel, sans appel au modèle.
 */

const norm = (t: string) =>
  t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’`]/g, "'")
    .trim();

/** Mot entendu → familles d'objets Minecraft, et nom à employer dans la réponse. */
const FAMILIES: { words: RegExp; label: string; match: (item: string) => boolean }[] = [
  { words: /\b(bois|buches?|troncs?)\b/, label: 'bûches', match: (i) => /_(log|stem)$/.test(i) },
  { words: /\bplanches?\b/, label: 'planches', match: (i) => i.endsWith('_planks') },
  { words: /\b(pierres?|cailloux|cobble\w*|roches?)\b/, label: 'pierres', match: (i) => /^(cobblestone|stone|cobbled_deepslate|deepslate|andesite|diorite|granite)$/.test(i) },
  { words: /\bfer\b/, label: 'fer', match: (i) => /^(raw_iron|iron_ingot|iron_ore|deepslate_iron_ore)$/.test(i) },
  { words: /\bcharbon\b/, label: 'charbon', match: (i) => /^(coal|charcoal|coal_ore|deepslate_coal_ore)$/.test(i) },
  { words: /\bdiamants?\b/, label: 'diamants', match: (i) => /^(diamond|diamond_ore|deepslate_diamond_ore)$/.test(i) },
  { words: /\b(or|lingots? d'or)\b/, label: 'or', match: (i) => /^(raw_gold|gold_ingot|gold_ore|deepslate_gold_ore)$/.test(i) },
  { words: /\btorches?\b/, label: 'torches', match: (i) => i === 'torch' },
  { words: /\b(bouffe|nourriture|manger|viande|pain)\b/, label: 'nourriture', match: (i) => /^(bread|apple|cooked_\w+|beef|porkchop|chicken|mutton|carrot|potato|baked_potato|cookie|golden_apple)$/.test(i) },
  { words: /\blaine\b/, label: 'laine', match: (i) => i.endsWith('_wool') },
];

/** Phrase interrogative (point d'interrogation, ou tournure de question en tête). */
export function isQuestion(text: string): boolean {
  const t = norm(text);
  // n'importe où dans la phrase : « alex t'as combien de bûches » (interpellation devant)
  return t.endsWith('?') || /\b(est[- ]ce que|tu as|t'as|as[- ]tu|combien|il te reste|t'en as|tu en as)\b/.test(t);
}

/** Réponse à une question d'inventaire, ou `null` si la question ne porte pas sur l'inventaire. */
export function answerInventoryQuestion(text: string, inventory: Record<string, number>): string | null {
  if (!isQuestion(text)) return null;
  const t = norm(text);
  const asked = FAMILIES.filter((f) => f.words.test(t));
  if (asked.length > 0) {
    return asked
      .map((f) => {
        const n = Object.entries(inventory).filter(([i]) => f.match(i)).reduce((s, [, c]) => s + c, 0);
        return n > 0 ? `J'ai ${n} ${f.label}.` : `Je n'ai pas de ${f.label}.`;
      })
      .join(' ');
  }
  // « qu'est-ce que tu as ? », « t'as quoi sur toi ? » : les objets les plus nombreux
  if (/(qu'est[- ]ce que tu as|t'as quoi|tu as quoi|ton inventaire|sur toi)/.test(t)) {
    const top = Object.entries(inventory)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([i, c]) => `${c} ${i.replace(/_/g, ' ')}`);
    return top.length ? `J'ai : ${top.join(', ')}.` : "Je n'ai rien sur moi.";
  }
  return null;
}
