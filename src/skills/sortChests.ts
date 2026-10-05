import type { Bot } from 'mineflayer';
import { z } from 'zod';
import { abortableSleep } from '../core/abort.js';
import type { Domain } from '../core/types.js';
import type { ActionRunOutput } from './actionController.js';
import { familyOf, goNear, isEquipment, travelHome, type ChestSurvey } from './extra.js';
import type { SkillContext } from './library.js';

type Pos = { x: number; y: number; z: number };

/** Famille « fourre-tout » : ce qui n'a pas de coffre à soi. */
export const DIVERS = 'divers';

/** Mots d'un panneau → famille de rangement. */
const SIGN_WORDS: [RegExp, string][] = [
  [/\b(bois|buches?|troncs?)\b/, 'bois'],
  [/\bplanches?\b/, 'planches'],
  [/\b(minerais?|fer|or|charbon|diamants?|cuivre|lingots?|redstone|lapis|emeraudes?)\b/, 'minerais'],
  [/\b(pierres?|terre|cailloux|paves?|sable|gravier|roches?)\b/, 'terre et pierre'],
  [/\b(cultures?|graines?|ble|carottes?|patates?|plantes?|ferme)\b/, 'cultures'],
  [/\b(nourriture|bouffe|manger|viandes?|pain)\b/, 'nourriture'],
  [/\b(butin|mobs?|monstres?|os|laine|cordes?|poudre)\b/, 'butin'],
  [/\b(outils?|armes?|armures?|equipement)\b/, 'outils'],
  [/\b(divers|autres?|reste|vrac|bazar)\b/, DIVERS],
];

/** Famille indiquée par le texte d'un panneau, ou `null` s'il ne dit rien de reconnaissable. */
export function signFamily(text: string): string | null {
  const t = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return SIGN_WORDS.find(([r]) => r.test(t))?.[1] ?? null;
}

/** Nourriture qu'on ne mange pas : rangée avec le butin des monstres. */
const BAD_FOOD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish']);

/** Famille de rangement d'un objet (nourriture et équipement à part). */
export function sortFamily(name: string, isFood: boolean): string {
  if (BAD_FOOD.has(name)) return 'butin';
  if (isFood) return 'nourriture';
  if (isEquipment(name)) return 'outils';
  return familyOf(name);
}

/**
 * Rôle de chaque coffre : la famille écrite sur son panneau ; sinon le rôle retenu d'un tri précédent ;
 * sinon la famille dominante de son contenu ; coffre vide = « divers ». Une famille qui a un coffre à
 * panneau n'est jamais le rôle d'un coffre sans panneau (cas réel : steaks rangés dans un coffre
 * « nourriture » deviné au lieu de celui marqué « nourriture ») : ce coffre prend sa famille suivante.
 */
export function assignRoles(chests: ChestSurvey[], labels: (string | null)[], family: (name: string) => string, remembered: (string | null)[] = []): string[] {
  const labelled = new Set(labels.filter((l): l is string => Boolean(l) && l !== DIVERS));
  return chests.map((c, i) => {
    const label = labels[i];
    if (label) return label;
    const kept = remembered[i];
    if (kept && !labelled.has(kept)) return kept;
    const totals: Record<string, number> = {};
    for (const [name, n] of Object.entries(c.contents)) totals[family(name)] = (totals[family(name)] ?? 0) + n;
    const top = Object.entries(totals)
      .filter(([f]) => !labelled.has(f))
      .sort((a, b) => b[1] - a[1])[0];
    return top ? top[0] : DIVERS;
  });
}

export interface Move {
  from: number;
  to: number;
  item: string;
  count: number;
}

/**
 * Déplacements pour que chaque objet soit dans un coffre de sa famille : vers le coffre de sa
 * famille s'il y en a un, sinon vers un coffre « divers » ; sinon il reste où il est.
 */
export function planMoves(chests: ChestSurvey[], roles: string[], family: (name: string) => string, labels: (string | null)[] = []): Move[] {
  const moves: Move[] = [];
  const divers = roles.findIndex((r) => r === DIVERS);
  // sans coffre « divers » : le coffre sans panneau le plus libre recueille ce qui n'a pas de place
  const overflowFor = (from: number) => {
    if (divers >= 0 && divers !== from) return divers;
    const candidates = chests.map((c, j) => [j, c.free] as const).filter(([j]) => j !== from && !labels[j]);
    return candidates.sort((x, y) => y[1] - x[1])[0]?.[0] ?? -1;
  };
  for (const [i, c] of chests.entries()) {
    for (const [item, count] of Object.entries(c.contents)) {
      const f = family(item);
      if (roles[i] === f) continue;
      const target = roles.findIndex((r, j) => j !== i && r === f);
      // un coffre à panneau ne garde que sa famille (cas réel : objets divers restés dans « nourriture ») ;
      // un coffre sans panneau garde ce qui n'a nulle part où aller
      const to = target >= 0 ? target : labels[i] ? overflowFor(i) : roles[i] !== DIVERS && divers >= 0 && divers !== i ? divers : -1;
      if (to >= 0) moves.push({ from: i, to, item, count });
    }
  }
  return moves;
}

const CHESTS = ['chest', 'barrel', 'trapped_chest'];
/** Pause entre la fermeture d'un coffre et l'ouverture du suivant. */
const WINDOW_GAP_MS = 400;


/** Panneau posé sur le coffre (sur un côté ou dessus) : son texte, sinon `null`. */
function signOn(bot: Bot, pos: Pos): string | null {
  const at = bot.blockAt(pos as Bot['entity']['position']);
  if (!at) return null;
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
    const b = bot.blockAt(at.position.offset(dx!, dy!, dz!)) as (ReturnType<Bot['blockAt']> & { getSignText?: () => string[] }) | null;
    if (b && b.name.endsWith('_sign') && b.getSignText) {
      const text = b.getSignText().join(' ').trim();
      if (text) return text;
    }
  }
  return null;
}

/** Trier les coffres de la maison : chaque coffre garde une famille (panneau, sinon contenu dominant). */
export const sortChests = {
  name: 'sort_chests',
  domain: 'survive' as Domain,
  description: 'sort_chests {} — trier les coffres de la maison : chaque coffre garde une famille (celle écrite sur son panneau, sinon celle qui y domine), le reste va au coffre « divers »',
  params: z.object({}),
  timeoutMs: () => 240_000,
  async run(ctx: SkillContext, _p: Record<string, never>, signal: AbortSignal): Promise<ActionRunOutput> {
    const { bot } = ctx;
    const h = ctx.home?.();
    const me = bot.entity.position;
    if (h && Math.hypot(h.x - me.x, h.y - me.y, h.z - me.z) > 12) await travelHome(bot, h, signal);
    const ids = CHESTS.map((n) => bot.registry.blocksByName[n]?.id).filter((id): id is number => id !== undefined);
    // un coffre double compte une fois : on garde sa moitié droite (ou le coffre simple)
    const positions = bot
      .findBlocks({ matching: ids, maxDistance: 32, count: 16 })
      .filter((p) => (bot.blockAt(p)?.getProperties?.() as { type?: string } | undefined)?.type !== 'left')
      .slice(0, 8);
    if (positions.length < 2) return { status: 'failure', detail: { reason: 'il faut au moins deux coffres pour trier', precondition: true } };
    const foods = bot.registry.foodsByName ?? {};
    const family = (name: string) => sortFamily(name, foods[name] !== undefined);

    const errors: string[] = [];
    const open = async (i: number) => {
      const block = bot.blockAt(positions[i]!);
      if (!block) return null;
      await goNear(bot, positions[i]!, 2, signal);
      // laisser au serveur le temps de fermer la fenêtre précédente avant d'en ouvrir une autre
      await abortableSleep(WINDOW_GAP_MS, signal).catch(() => undefined);
      return bot.openContainer(block).catch((err: unknown) => {
        errors.push(`ouverture du coffre ${i + 1} : ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });
    };
    // 1. tour des coffres : contenu, place libre, panneau
    const surveys: ChestSurvey[] = [];
    const labels: (string | null)[] = [];
    for (let i = 0; i < positions.length; i++) {
      if (signal.aborted) return { status: 'failure', detail: { reason: 'interrompu' } };
      const sign = signOn(bot, positions[i]!);
      labels.push(sign ? signFamily(sign) : null);
      const w = await open(i);
      const contents: Record<string, number> = {};
      if (w) {
        for (const it of w.containerItems()) contents[it.name] = (contents[it.name] ?? 0) + it.count;
        surveys.push({ contents, free: Math.max(0, w.inventoryStart - w.containerItems().length) });
        w.close();
      } else surveys.push({ contents, free: 0 });
    }
    const roles = assignRoles(surveys, labels, family, positions.map((p) => ctx.chestRoles?.get(p) ?? null));
    ctx.chestRoles?.setMany(positions.map((p, i) => [p, roles[i]!]));
    const moves = planMoves(surveys, roles, family, labels);
    if (moves.length === 0) {
      ctx.speak?.('Les coffres sont déjà triés.');
      return { status: 'success', detail: { moved: 0, roles } };
    }

    // 2. coffre par coffre : on retire ce qui n'est pas à sa place (selon la place dans l'inventaire),
    //    puis on le dépose dans le coffre de sa famille
    let moved = 0;
    const stuck: { item: string; count: number }[] = [];
    for (const from of [...new Set(moves.map((m) => m.from))]) {
      if (signal.aborted) break;
      const mine = moves.filter((m) => m.from === from);
      const carried: { item: string; count: number; to: number }[] = [];
      const w = await open(from);
      if (!w) continue;
      try {
        for (const m of mine) {
          if (bot.inventory.emptySlotCount() < 2) break;
          for (const it of w.containerItems().filter((x) => x.name === m.item)) {
            if (bot.inventory.emptySlotCount() < 2) break;
            // ce qui est vraiment arrivé dans l'inventaire : un retrait raté ne doit jamais faire
            // déposer les affaires du bot à la place (cas réel : sa pioche partie dans un coffre)
            // coffre ouvert : l'inventaire du bot n'est mis à jour qu'à la fermeture, on compte donc dans
            // la partie « joueur » de la fenêtre du coffre (cas réel : tout restait sur lui, « 0 déplacé »)
            const before = w.count(it.type, null);
            await w.withdraw(it.type, null, it.count).catch(() => null);
            const got = w.count(it.type, null) - before;
            if (got > 0) carried.push({ item: m.item, count: got, to: m.to });
          }
        }
      } finally {
        w.close();
      }
      const notDeposited: { item: string; count: number }[] = [];
      for (const to of [...new Set(carried.map((c) => c.to))]) {
        const batch = carried.filter((x) => x.to === to);
        const dest = await open(to);
        if (!dest) {
          notDeposited.push(...batch);
          continue;
        }
        try {
          for (const c of batch) {
            const type = bot.registry.itemsByName[c.item]?.id;
            if (type === undefined) continue;
            const ok = await dest.deposit(type, null, c.count).then(
              () => true,
              (err: unknown) => (errors.push(`dépôt de ${c.item} dans le coffre ${to + 1} : ${err instanceof Error ? err.message : String(err)}`), false),
            );
            if (ok) moved += c.count;
            else notDeposited.push(c);
          }
        } finally {
          dest.close();
        }
      }
      // pas pu déposer : on remet dans le coffre d'origine plutôt que de tout garder sur soi
      if (notDeposited.length) {
        const back = await open(from);
        if (back) {
          try {
            for (const c of notDeposited) {
              const type = bot.registry.itemsByName[c.item]?.id;
              const ok = type !== undefined && (await back.deposit(type, null, c.count).then(() => true, () => false));
              if (!ok) stuck.push(c);
            }
          } finally {
            back.close();
          }
        } else stuck.push(...notDeposited);
      }
    }
    // court, à la demande du joueur : pas le détail des coffres
    ctx.speak?.(moved > 0 ? 'Tri fini.' : "Je n'ai rien pu déplacer.");
    if (stuck.length) ctx.speak?.(`Un coffre est plein, j'ai gardé sur moi : ${stuck.map((i) => `${i.count} ${i.item.replace(/_/g, ' ')}`).join(', ')}.`);
    return moved > 0
      ? { status: 'success', detail: { moved, roles, ...(errors.length ? { errors } : {}) } }
      : { status: 'failure', detail: { reason: errors[0] ?? "rien n'a pu être déplacé", roles, errors } };
  },
};
