/**
 * Ordres en plusieurs étapes (« récupère le fer dans le four et mets-le dans le coffre ») : découpés
 * là où un « et » / « puis » / « ensuite » introduit un nouveau verbe d'action.
 */
const NEXT_STEP =
  /\s*,?\s+(?:et|puis|ensuite|apr[eè]s)\s+(?:(?:tu\s+)?(?:le|la|les|l'|me|moi)\s*)?(?=(?:mets|met|pose|range|donne|apporte|ram[eè]ne|va|viens|reviens|fabrique|craft|cuis|plante|stocke|d[eé]pose|garde|ramasse|r[eé]cup[eè]re|coupe|mine|creuse|construis|tue|attaque|mange|dors|allume)\b)/i;

export function splitOrder(text: string): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  for (let guard = 0; guard < 4; guard++) {
    const m = NEXT_STEP.exec(rest);
    if (!m || m.index === 0) break;
    parts.push(rest.slice(0, m.index).trim());
    rest = rest.slice(m.index + m[0].length).trim();
  }
  parts.push(rest);
  return parts.filter(Boolean);
}
