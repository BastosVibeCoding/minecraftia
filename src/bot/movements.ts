import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';

const { Movements } = pathfinderPkg;

/** Portes qu'on ouvre à la main (pas les portes en fer, qui demandent de la redstone). */
export const isHandDoor = (name: string) => name.endsWith('_door') && name !== 'iron_door';

/** Portes en bois et portillons : ce que le bot sait ouvrir. */
export const isPassage = (name: string) => isHandDoor(name) || name.endsWith('_fence_gate');

/** Hauteur maximale de chute acceptée sur un trajet. */
const MAX_DROP = 3;

/** Coût d'un pas dans l'eau : le bot préfère la terre ferme dès qu'un détour raisonnable existe. */
export const LIQUID_COST = 4;

/** Surcoût d'un passage (porte, portillon) : le bot l'emprunte, mais pas pour gagner un pas. */
const PASSAGE_COST = 2;

interface PathBlock {
  name: string;
  safe: boolean;
  physical: boolean;
  openable: boolean;
  getProperties?: () => Record<string, unknown>;
}

export function isOpen(b: { getProperties?: () => Record<string, unknown> }): boolean {
  const open = b.getProperties?.().open;
  return open === true || open === 'true';
}

/**
 * Règle de passage pour le pathfinder : une porte en bois ou un portillon, ouvert ou fermé, se
 * traverse. Ce n'est pas le pathfinder qui ouvre (son mécanisme reste bloqué en mode « pose de
 * bloc » après l'ouverture) : `installDoorOpener` ouvre juste avant le passage.
 */
export function adaptDoor(b: PathBlock): void {
  if (!b.name || !isPassage(b.name)) return;
  b.safe = true;
  b.physical = false;
  b.openable = false;
}

export interface MovementOptions {
  /** Autoriser à creuser pour passer (récolte) ; sinon jamais. */
  canDig?: boolean;
  /** Blocs à ne jamais casser (posés par un joueur, blocs de construction). */
  isProtected?: (b: { name: string; position: { x: number; y: number; z: number } }) => boolean;
  /** Zone où ne jamais poser d'échafaudage (la maison). */
  noScaffoldAt?: (p: { x: number; y: number; z: number }) => boolean;
}

/** Blocs courants qu'on peut poser pour monter d'un trou ou franchir un vide. */
const SCAFFOLD = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate'];

/**
 * Déplacements des bots : passage par les portes et portillons, l'eau évitée quand c'est possible,
 * et jamais un bloc protégé cassé, même quand creuser est permis.
 */
export function companionMovements(bot: Bot, opts: MovementOptions = {}): InstanceType<typeof Movements> {
  const m = new Movements(bot);
  m.canDig = opts.canDig ?? false;
  m.canOpenDoors = false;
  const isProtected = opts.isProtected;
  const areas = m as unknown as {
    exclusionAreasBreak: ((b: { name: string; position: { x: number; y: number; z: number } }) => number)[];
    exclusionAreasStep: ((b: { name: string }) => number)[];
  };
  if (isProtected) areas.exclusionAreasBreak.push((b) => (isProtected(b) ? 100 : 0));
  areas.exclusionAreasStep.push((b) => (b.name && isPassage(b.name) ? PASSAGE_COST : 0));
  (m as unknown as { liquidCost: number }).liquidCost = LIQUID_COST;
  // chute de 4 blocs = dégâts ; 3 au plus (cas réel : « Alex fell from a high place »)
  m.maxDropDown = MAX_DROP;
  // remonter d'un trou, franchir un vide : avec la terre ou la pierre qu'il porte, jamais à la maison
  const scaffold = m as unknown as { scafoldingBlocks: number[]; exclusionAreasPlace: ((b: { position: { x: number; y: number; z: number } }) => number)[] };
  scaffold.scafoldingBlocks = SCAFFOLD.map((n) => bot.registry.itemsByName[n]?.id).filter((id): id is number => id !== undefined);
  const noScaffold = opts.noScaffoldAt;
  if (noScaffold) scaffold.exclusionAreasPlace.push((b) => (noScaffold(b.position) ? 100 : 0));
  const getBlock = m.getBlock.bind(m);
  m.getBlock = (pos, dx, dy, dz) => {
    const b = getBlock(pos, dx, dy, dz) as unknown as PathBlock;
    adaptDoor(b);
    return b as unknown as ReturnType<typeof getBlock>;
  };
  (m as unknown as Record<string, unknown>)[COMPANION] = true;
  return m;
}

/** Marque des réglages construits ici (protégés) : tout autre réglage vient d'un module tiers. */
const COMPANION = '__minecraftiaMovements';

/** Ces réglages de déplacement sont-ils les nôtres (blocs des joueurs protégés) ? */
export function isCompanionMovements(m: unknown): boolean {
  return Boolean(m && (m as Record<string, unknown>)[COMPANION]);
}

type Pos = { x: number; y: number; z: number };
interface BotVec extends Pos {
  distanceTo(p: Pos): number;
  floored(): BotVec;
  offset(dx: number, dy: number, dz: number): BotVec;
}
interface DoorBot {
  entity: { position: BotVec };
  blockAt(p: Pos): ({ name: string; position: Pos; getProperties?: () => Record<string, unknown> } & object) | null;
  activateBlock(b: object): Promise<void>;
  pathfinder: { isMoving(): boolean };
}

/** Distance à laquelle le bot ouvre le passage devant lui (portée de la main). */
const OPEN_REACH = 3;
/** Délai avant de réessayer la même porte (le serveur met un instant à confirmer). */
const RETRY_MS = 1500;

/**
 * Ouvre les portes et portillons fermés qui se trouvent sur les prochains pas du chemin.
 * Appelé régulièrement ; `path` est le chemin courant du pathfinder (il raccourcit en avançant).
 */
export class DoorOpener {
  private readonly tried = new Map<string, number>();

  constructor(private readonly bot: DoorBot) {}

  /** `blockAt` de mineflayer exige un vrai vecteur : on le construit depuis la position du bot. */
  private at(p: Pos) {
    const o = this.bot.entity.position.floored();
    return this.bot.blockAt(o.offset(p.x - o.x, p.y - o.y, p.z - o.z));
  }

  step(path: Pos[], now: number): Pos | null {
    if (!this.bot.pathfinder.isMoving()) return null;
    const me = this.bot.entity.position;
    for (const node of path.slice(0, 3)) {
      for (const dy of [0, 1]) {
        const b = this.at({ x: node.x, y: node.y + dy, z: node.z });
        if (!b || !isPassage(b.name) || isOpen(b)) continue;
        if (me.distanceTo({ x: b.position.x + 0.5, y: b.position.y + 0.5, z: b.position.z + 0.5 }) > OPEN_REACH) continue;
        // une porte ouverte par sa moitié haute s'ouvre entière : on vise la moitié basse
        const target = isHandDoor(b.name) && b.getProperties?.().half === 'upper' ? this.at({ x: b.position.x, y: b.position.y - 1, z: b.position.z }) ?? b : b;
        const key = `${target.position.x},${target.position.y},${target.position.z}`;
        if (now - (this.tried.get(key) ?? -Infinity) < RETRY_MS) return null;
        this.tried.set(key, now);
        void this.bot.activateBlock(target).catch(() => {});
        return target.position;
      }
    }
    return null;
  }
}

/** Branche l'ouvreur de portes sur le pathfinder du bot (chemin courant, vérification toutes les 4 ticks). */
export function installDoorOpener(bot: Bot, now: () => number): void {
  const opener = new DoorOpener(bot as unknown as DoorBot);
  let path: Pos[] = [];
  let tick = 0;
  bot.on('path_update', (r: { path: Pos[] }) => {
    path = r.path;
  });
  bot.on('path_reset', () => {
    path = [];
  });
  bot.on('goal_reached', () => {
    path = [];
  });
  bot.on('physicsTick', () => {
    if (++tick % 4 !== 0 || path.length === 0) return;
    try {
      opener.step(path, now());
    } catch {
      // bloc illisible (chunk en cours de chargement) : on réessaiera au prochain passage
    }
  });
}

/** Blocage : déplacement de moins de STUCK_DISTANCE en STUCK_WINDOW s pendant un trajet. */
const STUCK_WINDOW = 5;
const STUCK_DISTANCE = 0.6;
const STUCK_TRIES = 3;

/**
 * Surveille les trajets : un bot qui marche sans avancer (coincé contre un bloc, dans un trou)
 * saute pour se dégager ; après trois essais, il abandonne le trajet plutôt que de rester bloqué.
 */
export class StuckWatcher {
  private samples: Pos[] = [];
  private tries = 0;

  /** Appelé chaque seconde ; renvoie ce qui a été fait. */
  step(moving: boolean, at: Pos): 'rien' | 'saut' | 'abandon' {
    if (!moving) {
      this.samples = [];
      this.tries = 0;
      return 'rien';
    }
    this.samples.push({ x: at.x, y: at.y, z: at.z });
    if (this.samples.length > STUCK_WINDOW) this.samples.shift();
    if (this.samples.length < STUCK_WINDOW) return 'rien';
    const first = this.samples[0]!;
    if (Math.hypot(at.x - first.x, at.y - first.y, at.z - first.z) >= STUCK_DISTANCE) {
      this.tries = 0;
      return 'rien';
    }
    this.samples = [];
    this.tries++;
    if (this.tries > STUCK_TRIES) {
      this.tries = 0;
      return 'abandon';
    }
    return 'saut';
  }
}

/** Branche la surveillance des blocages sur le bot (une vérification par seconde). */
export function installStuckWatcher(bot: Bot, onAbandon: () => void = () => {}): () => void {
  const watcher = new StuckWatcher();
  const timer = setInterval(() => {
    const me = bot.entity?.position;
    if (!me) return;
    const action = watcher.step(bot.pathfinder?.isMoving() ?? false, me);
    if (action === 'saut') {
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 400);
    } else if (action === 'abandon') {
      bot.pathfinder.setGoal(null);
      onAbandon();
    }
  }, 1000);
  bot.once('end', () => clearInterval(timer));
  return () => clearInterval(timer);
}
