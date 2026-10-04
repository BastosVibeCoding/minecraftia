import type { Domain, Vec3Like } from '../core/types.js';
import { distance } from '../core/types.js';
import type { Logger } from '../core/logger.js';
import { analyzeBreaking, analyzeBuild, analyzeCombat, analyzeCraft, analyzeExplore, analyzeSurvive } from './analyzers.js';
import { brokenBlockDomain } from './blocks.js';
import { cellOf, newPlayerState, type PlayerState } from './context.js';
import type { Episode, RawEvent } from './types.js';

/** Silence (ms) après lequel un épisode est clos, par activité. */
export const DEFAULT_GAPS: Record<Domain, number> = {
  build: 8000,
  mine: 8000,
  gather: 8000,
  combat: 6000,
  craft: 15000,
  explore: 20000,
  survive: 3000,
};

interface Bucket {
  domain: Domain;
  events: RawEvent[];
  startedAt: number;
  lastAt: number;
  anchor: Vec3Like | null;
}

export interface ObserverOptions {
  gaps?: Partial<Record<Domain, number>>;
  /** Un épisode localisé se clôt si l'activité s'éloigne de plus de cette distance de son point de départ. */
  maxSpread?: number;
  logger?: Logger;
}

function posOf(e: RawEvent): Vec3Like | null {
  return 'pos' in e ? e.pos : null;
}

/**
 * Transforme le flux d'événements du joueur suivi en épisodes (pas une ligne par bloc posé).
 * Une activité = un seau ; un seau se clôt après un silence, un éloignement ou à la demande.
 */
export class Observer {
  readonly state: PlayerState = newPlayerState();
  private buckets = new Map<Domain, Bucket>();
  private teachingUntil = 0;
  private readonly gaps: Record<Domain, number>;
  private readonly maxSpread: number;

  constructor(
    private readonly player: string,
    private readonly onEpisode: (e: Episode) => void,
    private readonly opts: ObserverOptions = {},
  ) {
    this.gaps = { ...DEFAULT_GAPS, ...opts.gaps };
    this.maxSpread = opts.maxSpread ?? 24;
  }

  /** Ouvre une fenêtre d'enseignement : les épisodes qui la recoupent sont marqués `taught`. */
  startTeaching(until: number): void {
    this.teachingUntil = Math.max(this.teachingUntil, until);
  }

  push(e: RawEvent): void {
    if (e.player !== this.player) return;
    this.closeExpired(e.t);
    this.updateState(e);
    const domain = this.classify(e);
    if (!domain) return;

    const pos = posOf(e);
    let bucket = this.buckets.get(domain);
    if (bucket && domain !== 'explore' && pos && bucket.anchor && distance(pos, bucket.anchor) > this.maxSpread) {
      this.close(domain);
      bucket = undefined;
    }
    if (!bucket) {
      bucket = { domain, events: [], startedAt: e.t, lastAt: e.t, anchor: pos };
      this.buckets.set(domain, bucket);
    }
    bucket.events.push(e);
    bucket.lastAt = e.t;
  }

  /** Activités en cours du joueur (épisodes encore ouverts). */
  activity(): Domain[] {
    return [...this.buckets.keys()].filter((d) => d !== 'explore' || (this.buckets.get(d)?.events.length ?? 0) > 3);
  }

  /** À appeler régulièrement : clôt les épisodes dont l'activité s'est tue. */
  tick(now: number): void {
    this.closeExpired(now);
  }

  /** Clôt tous les épisodes en cours (fin de session, fin de rejeu). */
  flush(): void {
    for (const d of [...this.buckets.keys()]) this.close(d);
  }

  private closeExpired(now: number): void {
    for (const [d, b] of this.buckets) if (now - b.lastAt > this.gaps[d]) this.close(d);
  }

  private classify(e: RawEvent): Domain | null {
    switch (e.type) {
      case 'block_placed':
        return 'build';
      case 'block_broken':
        return brokenBlockDomain(e.block);
      case 'attack':
      case 'kill':
        return 'combat';
      case 'damaged':
        return this.buckets.has('combat') ? 'combat' : null;
      case 'craft':
        return 'craft';
      case 'move':
        return 'explore';
      case 'eat':
        return 'survive';
      case 'equip':
        return e.slot === 'hand' ? null : 'survive';
      default:
        return null;
    }
  }

  private updateState(e: RawEvent): void {
    const s = this.state;
    switch (e.type) {
      case 'equip':
        s.equipment[e.slot] = e.item;
        break;
      case 'damaged':
        s.health = e.health;
        break;
      case 'health':
        s.health = e.health;
        if (e.food !== undefined) s.food = e.food;
        break;
      case 'eat':
        if (e.food !== undefined) s.food = e.food;
        break;
      case 'move': {
        const prev = s.pos;
        s.pos = e.pos;
        if (e.biome) s.biome = e.biome;
        if (e.dimension) s.dimension = e.dimension;
        const cell = cellOf(e.pos);
        if (!prev || cellOf(prev) !== cell) s.visits.set(cell, (s.visits.get(cell) ?? 0) + 1);
        break;
      }
      case 'attack':
        if (e.weapon) s.equipment.hand = e.weapon;
        break;
      default:
        break;
    }
  }

  private close(domain: Domain): void {
    const b = this.buckets.get(domain);
    if (!b) return;
    this.buckets.delete(domain);
    let draft;
    try {
      switch (domain) {
        case 'build':
          draft = analyzeBuild(b.events, this.state);
          break;
        case 'mine':
        case 'gather':
          draft = analyzeBreaking(b.events, this.state, domain);
          break;
        case 'combat':
          draft = analyzeCombat(b.events, this.state);
          break;
        case 'craft':
          draft = analyzeCraft(b.events, this.state);
          break;
        case 'explore':
          draft = analyzeExplore(b.events, this.state);
          break;
        case 'survive':
          draft = analyzeSurvive(b.events, this.state);
          break;
      }
    } catch (err) {
      this.opts.logger?.warn({ err, domain }, 'analyse d\'épisode en erreur');
      return;
    }
    if (!draft) return;
    const taught = b.startedAt <= this.teachingUntil;
    this.onEpisode({ ...draft, player: this.player, source: taught ? 'taught' : 'observed', startedAt: b.startedAt, endedAt: b.lastAt });
  }
}
