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
  { words: /\bfours?\b/, label: 'four', match: (i) => i === 'furnace' || i === 'blast_furnace' || i === 'smoker' },
  { words: /\b(etablis?|tables? de craft|crafting table)\b/, label: 'établi', match: (i) => i === 'crafting_table' },
  { words: /\bcoffres?\b/, label: 'coffre', match: (i) => i === 'chest' || i === 'barrel' },
  { words: /\blits?\b/, label: 'lit', match: (i) => i.endsWith('_bed') },
  { words: /\bseaux?\b/, label: 'seau', match: (i) => i.endsWith('bucket') },
  { words: /\bbatons?\b/, label: 'bâtons', match: (i) => i === 'stick' },
];

const TIER_FR: Record<string, string> = { wooden: 'en bois', stone: 'en pierre', iron: 'en fer', golden: 'en or', diamond: 'en diamant', netherite: 'en netherite' };
/** Outils : on dit lesquels (« une pioche en pierre »), pas seulement combien. */
const TOOLS: { words: RegExp; kind: string; fr: string }[] = [
  { words: /\bpioches?\b/, kind: 'pickaxe', fr: 'pioche' },
  { words: /\bhaches?\b/, kind: 'axe', fr: 'hache' },
  { words: /\bpelles?\b/, kind: 'shovel', fr: 'pelle' },
  { words: /\bepees?\b/, kind: 'sword', fr: 'épée' },
  { words: /\bhoues?\b/, kind: 'hoe', fr: 'houe' },
];

function answerTool(t: string, inventory: Record<string, number>): string | null {
  const asked = TOOLS.filter((x) => x.words.test(t));
  if (asked.length === 0) return null;
  return asked
    .map((x) => {
      const owned = Object.keys(inventory)
        .filter((i) => i.endsWith(`_${x.kind}`) && !(x.kind === 'axe' && i.endsWith('_pickaxe')))
        .map((i) => `une ${x.fr} ${TIER_FR[i.slice(0, -x.kind.length - 1)] ?? ''}`.trim());
      return owned.length ? `Oui, j'ai ${owned.join(' et ')}.` : `Non, je n'ai pas de ${x.fr}.`;
    })
    .join(' ');
}

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
  const tool = answerTool(t, inventory);
  if (tool) return tool;
  const asked = FAMILIES.filter((f) => f.words.test(t));
  if (asked.length > 0) {
    return asked
      .map((f) => {
        const n = Object.entries(inventory).filter(([i]) => f.match(i)).reduce((s, [, c]) => s + c, 0);
        return n > 0 ? `J'ai ${n} ${f.label}.` : `Je n'ai pas ${/^[aeiouéèê]/.test(f.label) ? "d'" : 'de '}${f.label}.`;
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

/**
 * Objets de l'inventaire dont parle une phrase (« t'as combien de fer » → raw_iron, iron_ingot),
 * du plus nombreux au moins nombreux. Sert à « donne » tout court : le dernier objet évoqué.
 */
export function mentionedItems(text: string, inventory: Record<string, number>): string[] {
  const t = norm(text);
  const families = FAMILIES.filter((f) => f.words.test(t)).map((f) => f.match);
  const tools = TOOLS.filter((x) => x.words.test(t)).map((x) => (i: string) => i.endsWith(`_${x.kind}`) && !(x.kind === 'axe' && i.endsWith('_pickaxe')));
  const matchers = [...families, ...tools];
  return Object.entries(inventory)
    .filter(([i]) => matchers.some((m) => m(i)))
    .sort((a, b) => b[1] - a[1])
    .map(([i]) => i);
}

/** Mots qui désignent un objet, même absent de l'inventaire (pour retenir de quoi on parle). */
export function mentionsAnItem(text: string): boolean {
  const t = norm(text);
  return FAMILIES.some((f) => f.words.test(t)) || TOOLS.some((x) => x.words.test(t));
}

/** « donne », « donne-le », « donne-moi ça », « file-les-moi » : don sans objet précisé. */
export function isBareGive(text: string): boolean {
  return /^(donne|file|passe|balance)(?:[- ](?:le|la|les|moi|ca|ça|lui|nous))*[ !.?]*$/.test(norm(text));
}
