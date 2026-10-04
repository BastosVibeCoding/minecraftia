import type { Domain, Vec3Like } from '../core/types.js';
import { distance } from '../core/types.js';
import { CROP_SEED, isCrop, isOre, isTorch, readable } from './blocks.js';
import { situationContext, withContext, type PlayerState } from './context.js';
import { boundingBox, histogram, key, median, mostCommon, round, spearman } from './stats.js';
import type { Episode, RawEvent } from './types.js';

type Of<T extends RawEvent['type']> = Extract<RawEvent, { type: T }>;
type Draft = Omit<Episode, 'player' | 'source' | 'startedAt' | 'endedAt'>;

const SHAPE_FR: Record<string, string> = {
  wall: 'un mur',
  floor: 'un sol',
  path: 'un chemin',
  pillar: 'un pilier',
  enclosure: 'une enceinte',
  house: 'une maison',
  structure: 'une structure',
};

/** Construction : géométrie, matériaux, symétrie, ordre de pose, échafaudages. */
export function analyzeBuild(events: RawEvent[], state: PlayerState): Draft | null {
  const placedAt = new Map<string, Of<'block_placed'>>();
  const order: Of<'block_placed'>[] = [];
  let scaffolding = 0;
  for (const e of events) {
    if (e.type === 'block_placed') {
      placedAt.set(key(e.pos), e);
      order.push(e);
    } else if (e.type === 'block_broken' && placedAt.has(key(e.pos))) {
      placedAt.delete(key(e.pos)); // posé puis retiré dans le même épisode : échafaudage
      scaffolding++;
    }
  }
  const finals = order.filter((e) => placedAt.get(key(e.pos)) === e);
  if (finals.length < 4) return null;

  const box = boundingBox(finals.map((e) => e.pos));
  const { width: w, height: h, depth: d } = box;
  const onBorder = (p: Vec3Like) => p.x === box.min.x || p.x === box.max.x || p.z === box.min.z || p.z === box.max.z;
  const borderShare = finals.filter((e) => onBorder(e.pos)).length / finals.length;
  const topShare = finals.filter((e) => e.pos.y === box.max.y).length / (w * d);

  let shape: string;
  if (h === 1) shape = Math.min(w, d) <= 2 && Math.max(w, d) >= 4 ? 'path' : 'floor';
  else if ((w === 1 || d === 1) && h >= 2) shape = 'wall';
  else if (h >= 4 && w <= 3 && d <= 3) shape = 'pillar';
  else if (w >= 3 && d >= 3 && borderShare >= 0.7) shape = topShare >= 0.6 ? 'house' : 'enclosure';
  else shape = 'structure';

  const blocks = new Map(finals.map((e) => [key(e.pos), e.block]));
  const mirrorScore = (axis: 'x' | 'z') =>
    finals.filter((e) => {
      const m = { ...e.pos, [axis]: box.min[axis] + box.max[axis] - e.pos[axis] };
      return blocks.get(key(m)) === e.block;
    }).length / finals.length;
  const symmetry = round(Math.max(mirrorScore('x'), mirrorScore('z')), 2);
  const symmetric = symmetry >= 0.8;

  const rho = spearman(finals.map((_, i) => i), finals.map((e) => e.pos.y));
  const vertical = h === 1 ? 'flat' : rho > 0.5 ? 'bottom_up' : rho < -0.5 ? 'top_down' : 'mixed';
  const half = Math.ceil(finals.length / 2);
  const borderFirst =
    (shape === 'enclosure' || shape === 'house') &&
    finals.slice(0, half).filter((e) => onBorder(e.pos)).length / half > borderShare + 0.1;

  const palette = histogram(finals.map((e) => e.block)).slice(0, 3);
  const material = palette[0]!.value;
  const dims = { width: Math.max(w, d), height: h, depth: Math.min(w, d) };
  const { context, tags } = situationContext(state, finals[0]!.pos);
  const dimsText = shape === 'wall' ? `${dims.width}×${dims.height}` : `${w}×${d}×${h}`;
  const traits = [symmetric ? 'symétrique' : null, vertical === 'bottom_up' ? 'de bas en haut' : vertical === 'top_down' ? 'de haut en bas' : null, borderFirst ? 'contour d\'abord' : null, scaffolding > 0 ? 'avec échafaudage' : null].filter(Boolean);
  return {
    domain: 'build',
    kind: shape,
    summary: `a construit ${SHAPE_FR[shape]} ${dimsText} en ${readable(material)}${traits.length ? ` (${traits.join(', ')})` : ''}`,
    situation: { text: withContext(`construire ${SHAPE_FR[shape]}`, context), shape, ...tags },
    mechanism: { skill: 'build', shape, dims, material, palette: palette.map((p) => ({ block: p.value, share: p.share })), symmetric, order: vertical, borderFirst, scaffolding: scaffolding > 0 },
    params: { blocks: finals.length, symmetry, verticalOrderRho: round(rho, 2), borderShare: round(borderShare, 2), scaffolding },
  };
}

/** Minage ou récolte : cibles, profondeur, motif de creusage, outil. */
export function analyzeBreaking(events: RawEvent[], state: PlayerState, domain: Domain): Draft | null {
  const broken = events.filter((e): e is Of<'block_broken'> => e.type === 'block_broken');
  if (broken.length < 3) return null;
  const tool = mostCommon(broken.map((e) => e.tool ?? state.equipment.hand ?? null));
  const hist = histogram(broken.map((e) => e.block));
  const { context, tags } = situationContext(state, broken[0]!.pos);

  if (domain === 'gather') {
    const block = hist[0]!.value;
    return {
      domain: 'gather',
      kind: block,
      summary: `a récolté ${broken.length} blocs de ${readable(block)}${tool ? ` avec ${readable(tool)}` : ''}`,
      situation: { text: withContext(`récolter ${readable(block)}`, context), target: block, ...tags },
      mechanism: { skill: 'collect', block, count: broken.length, tool, targets: hist.slice(0, 3).map((h) => h.value) },
      params: { blocks: broken.length, histogram: hist.slice(0, 5) },
    };
  }

  const ores = hist.filter((h) => isOre(h.value));
  const ys = broken.map((e) => e.pos.y);
  const box = boundingBox(broken.map((e) => e.pos));
  const horizontal = Math.max(box.width, box.depth);
  const first = broken[0]!.pos;
  const last = broken[broken.length - 1]!.pos;
  const drop = first.y - last.y;
  const run = Math.hypot(last.x - first.x, last.z - first.z);
  let pattern: string;
  if (drop >= 3 && run > 0 && drop / run >= 0.6) pattern = 'staircase';
  else if (box.height <= 3 && horizontal >= 6 && Math.min(box.width, box.depth) <= 2) pattern = 'tunnel';
  else if (box.height >= 4 && horizontal <= 2) pattern = 'shaft';
  else pattern = 'quarry';
  const depthY = Math.round(median(ys)!);
  const targets = ores.length ? ores.map((o) => o.value) : [hist[0]!.value];
  const PATTERN_FR: Record<string, string> = { staircase: 'en escalier', tunnel: 'en tunnel', shaft: 'en puits', quarry: 'en carrière' };
  return {
    domain: 'mine',
    kind: pattern,
    summary: `a miné ${broken.length} blocs ${PATTERN_FR[pattern]} vers y=${depthY}${ores.length ? ` (${ores.map((o) => `${o.count} ${readable(o.value)}`).join(', ')})` : ''}`,
    situation: { text: withContext(ores.length ? `chercher ${readable(ores[0]!.value)}` : 'creuser', context), targets, ...tags },
    mechanism: { skill: 'collect', targets, pattern, depthY, tool, count: broken.length },
    params: { blocks: broken.length, ores: ores.map((o) => ({ block: o.value, count: o.count })), yMin: box.min.y, yMax: box.max.y },
  };
}

/** Semis : quelle culture, combien (les récoltes du même épisode sont analysées à part). */
export function analyzePlanting(events: RawEvent[], state: PlayerState): Draft | null {
  const sown = events.filter((e): e is Of<'block_placed'> => e.type === 'block_placed' && isCrop(e.block));
  const broken = events.filter((e) => e.type === 'block_broken').length;
  if (sown.length < 3 || sown.length < broken) return null;
  const crop = mostCommon(sown.map((e) => e.block))!;
  const seed = CROP_SEED[crop]!;
  const { context, tags } = situationContext(state, sown[0]!.pos);
  return {
    domain: 'gather',
    kind: 'plant',
    summary: `a semé ${sown.length} ${readable(crop)}`,
    situation: { text: withContext(`semer ${readable(crop)}`, context), crop, ...tags },
    mechanism: { skill: 'plant', seed, count: sown.length },
    params: { sown: sown.length },
  };
}

/** Combat : cibles, distance d'engagement, arme, bouclier, seuil de repli. */
export function analyzeCombat(events: RawEvent[], state: PlayerState): Draft | null {
  const attacks = events.filter((e): e is Of<'attack'> => e.type === 'attack');
  if (attacks.length === 0) return null;
  const damaged = events.filter((e): e is Of<'damaged'> => e.type === 'damaged');
  const kills = events.filter((e): e is Of<'kill'> => e.type === 'kill');
  const targets = histogram(attacks.map((a) => a.target));
  const engageDistance = round(median(attacks.map((a) => a.distance))!, 1);
  const weapon = mostCommon(attacks.map((a) => a.weapon ?? state.equipment.hand ?? null));
  const useShield = state.equipment.offhand === 'shield';
  const healths = damaged.map((d) => d.health);
  const minHealth = healths.length ? Math.min(...healths) : null;

  // repli : le joueur cesse d'attaquer alors que sa dernière cible est vivante et qu'il a été touché
  const lastAttack = attacks[attacks.length - 1]!;
  const lastTargetKilled = kills.some((k) => k.target === lastAttack.target && k.t >= lastAttack.t - 1000);
  const hpAtLastAttack = [...damaged].reverse().find((d) => d.t <= lastAttack.t + 500)?.health ?? null;
  const retreated = !lastTargetKilled && hpAtLastAttack !== null && hpAtLastAttack <= 12;
  const retreatHp = retreated ? hpAtLastAttack : null;
  const firstHitByPlayer = damaged.length === 0 || attacks[0]!.t <= damaged[0]!.t;
  const style = firstHitByPlayer && !retreated ? 'aggressive' : retreated ? 'cautious' : 'defensive';

  const target = targets[0]!.value;
  const { context, tags } = situationContext(state, state.pos);
  const STYLE_FR: Record<string, string> = { aggressive: 'offensif', cautious: 'prudent', defensive: 'défensif' };
  return {
    domain: 'combat',
    kind: `${style}_${target}`,
    summary: `a combattu ${targets.map((t) => `${t.count > 1 ? `${t.count}× ` : ''}${readable(t.value)}`).join(', ')} au ${weapon ? readable(weapon) : 'poing'} à ${engageDistance} blocs, style ${STYLE_FR[style]}${retreatHp !== null ? `, repli à ${retreatHp} PV` : ''}${kills.length ? `, ${kills.length} tué(s)` : ''}`,
    situation: { text: withContext(`combattre ${readable(target)}`, context), target, ...tags },
    mechanism: { skill: 'attack', targets: targets.map((t) => t.value), engageDistance, weapon, useShield, retreatHp, style },
    params: { attacks: attacks.length, kills: kills.length, hitsTaken: damaged.length, minHealth },
  };
}

const TOOL = /_(pickaxe|axe|shovel|hoe|sword)$|^(bow|crossbow|shield|fishing_rod|shears|flint_and_steel)$/;
const ARMOR = /_(helmet|chestplate|leggings|boots)$/;
const FOOD = /^(bread|cake|cookie|pumpkin_pie|.*_stew|golden_apple|golden_carrot)$/;

/** Artisanat : quoi, combien, dans quel ordre. */
export function analyzeCraft(events: RawEvent[], state: PlayerState): Draft | null {
  const crafts = events.filter((e): e is Of<'craft'> => e.type === 'craft');
  if (crafts.length === 0) return null;
  const items: { item: string; count: number }[] = [];
  for (const c of crafts) {
    const last = items[items.length - 1];
    if (last && last.item === c.item) last.count += c.count;
    else items.push({ item: c.item, count: c.count });
  }
  const category = (i: string) => (ARMOR.test(i) ? 'armor' : TOOL.test(i) ? 'tools' : FOOD.test(i) ? 'food' : 'materials');
  const kind = mostCommon(items.map((i) => category(i.item)))!;
  const KIND_FR: Record<string, string> = { armor: 'de l\'armure', tools: 'des outils', food: 'de la nourriture', materials: 'des matériaux' };
  const { context, tags } = situationContext(state, state.pos);
  return {
    domain: 'craft',
    kind,
    summary: `a fabriqué ${items.map((i) => `${i.count} ${readable(i.item)}`).join(', ')}`,
    situation: { text: withContext(`fabriquer ${KIND_FR[kind]}`, context), category: kind, ...tags },
    // `sequence` garde l'ordre (la fusion traite les listes comme des préférences, sans ordre)
    mechanism: { skill: 'craft', items: items.map((i) => i.item), sequence: items.map((i) => i.item).join(' > '), counts: Object.fromEntries(items.map((i) => [i.item, i.count])) },
    params: { crafts: crafts.length },
  };
}

/** Exploration : distance, biomes traversés, nouveaux lieux. */
export function analyzeExplore(events: RawEvent[], state: PlayerState): Draft | null {
  const moves = events.filter((e): e is Of<'move'> => e.type === 'move');
  if (moves.length < 2) return null;
  let path = 0;
  for (let i = 1; i < moves.length; i++) path += distance(moves[i - 1]!.pos, moves[i]!.pos);
  const displacement = distance(moves[0]!.pos, moves[moves.length - 1]!.pos);
  if (displacement < 32) return null;
  const biomes = [...new Set(moves.map((m) => m.biome).filter((b): b is string => Boolean(b)))];
  const { context, tags } = situationContext(state, moves[0]!.pos);
  return {
    domain: 'explore',
    kind: biomes.length > 1 ? 'traverse' : 'roam',
    summary: `a parcouru ${Math.round(path)} blocs (${Math.round(displacement)} à vol d'oiseau)${biomes.length ? ` à travers ${biomes.map(readable).join(', ')}` : ''}`,
    situation: { text: withContext('explorer les environs', context), ...tags },
    mechanism: { skill: 'explore', radius: Math.round(displacement), biomes },
    params: { path: Math.round(path), displacement: Math.round(displacement) },
  };
}

/** Gestion de la survie : quand le joueur mange, ce qu'il porte. */
export function analyzeSurvive(events: RawEvent[], state: PlayerState): Draft | null {
  const torches = events.filter((e) => e.type === 'block_placed' && isTorch(e.block)).length;
  if (torches >= 2) {
    const { context, tags } = situationContext(state, state.pos);
    return {
      domain: 'survive',
      kind: 'light',
      summary: `a posé ${torches} torches`,
      situation: { text: withContext('éclairer les environs', context), ...tags },
      mechanism: { skill: 'torch', count: Math.min(8, torches) },
      params: { torches },
    };
  }
  const eats = events.filter((e): e is Of<'eat'> => e.type === 'eat');
  const equips = events.filter((e): e is Of<'equip'> => e.type === 'equip' && e.item !== null && e.slot !== 'hand');
  const { context, tags } = situationContext(state, state.pos);
  if (eats.length > 0) {
    const foodAt = median(eats.map((e) => e.food).filter((f): f is number => typeof f === 'number'));
    const healthAt = median(eats.map((e) => e.health).filter((f): f is number => typeof f === 'number'));
    const item = mostCommon(eats.map((e) => e.item))!;
    return {
      domain: 'survive',
      kind: 'eat',
      summary: `a mangé ${readable(item)}${foodAt !== null ? ` à ${foodAt}/20 de faim` : ''}${healthAt !== null ? `, ${healthAt}/20 PV` : ''}`,
      situation: { text: withContext('avoir faim', context), ...tags },
      mechanism: { skill: 'eat', item, foodThreshold: foodAt, healthThreshold: healthAt },
      params: { meals: eats.length },
    };
  }
  if (equips.length > 0) {
    const gear = Object.fromEntries(equips.map((e) => [e.slot, e.item]));
    return {
      domain: 'survive',
      kind: 'gear',
      summary: `s'est équipé : ${equips.map((e) => readable(e.item!)).join(', ')}`,
      situation: { text: withContext('s\'équiper', context), ...tags },
      mechanism: { skill: 'equip', gear },
      params: { changes: equips.length },
    };
  }
  return null;
}
