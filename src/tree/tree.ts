import type { Logger } from '../core/logger.js';
import { DOMAINS, type Domain } from '../core/types.js';
import type { Episode } from '../observer/types.js';
import type { NodeRecord, Store } from '../store/store.js';
import { mechanismSignature, mergeMechanism, publicMechanism, type Mechanism } from './merge.js';

/** Poids apporté par une observation, selon sa source (une correction pèse plus que tout). */
export const SOURCE_WEIGHT = { observed: 1, taught: 3, corrected: 5, legacy: 1 } as const;

/** Variations de poids des retours sur une action (voir PLAN.md §3.2). */
export const FEEDBACK = {
  approval: 2,
  success: 0.5,
  failure: -1,
  /** correction : poids × CORRECTION_FACTOR puis + CORRECTION_PENALTY */
  correctionFactor: 0.2,
  correctionPenalty: -5,
} as const;

const HOUR = 3_600_000;

export interface TreeOptions {
  /** Similarité cosinus au-delà de laquelle une situation nouvelle rejoint une situation connue. */
  mergeThreshold?: number;
  /** Demi-vie des poids, en temps de jeu actif. */
  halfLifeMs?: number;
  /** Horloge de jeu actif (par défaut : l'horloge du store). */
  playTime?: () => number;
  logger?: Logger;
}

export interface IngestResult {
  episodeId: number;
  situationId: number;
  mechanismId: number;
  createdSituation: boolean;
  createdMechanism: boolean;
}

/** Branche pertinente envoyée au décideur : une situation et ses mécanismes classés. */
export interface Branch {
  situationId: number;
  domain: Domain;
  situation: string;
  similarity: number;
  weight: number;
  score: number;
  mechanisms: { id: number; label: string; weight: number; uses: number; mechanism: Record<string, unknown> | null }[];
  /** Mécanismes corrigés par le joueur (poids négatif) : à ne pas reproduire. */
  avoid: { id: number; label: string; mechanism: Record<string, unknown> | null }[];
}

/**
 * Arbre de comportements : domaine → situation → mécanismes concurrents.
 * Les poids décroissent paresseusement (appliqué à la lecture) selon le temps de jeu actif.
 */
export class BehaviorTree {
  readonly mergeThreshold: number;
  readonly halfLifeMs: number;
  private readonly playTime: () => number;

  constructor(
    readonly store: Store,
    readonly opts: TreeOptions = {},
  ) {
    this.mergeThreshold = opts.mergeThreshold ?? 0.88;
    this.halfLifeMs = opts.halfLifeMs ?? 6 * HOUR;
    this.playTime = opts.playTime ?? (() => store.now());
  }

  // ---------- poids ----------

  /** Poids courant après décroissance (sans l'écrire). */
  effectiveWeight(n: Pick<NodeRecord, 'weight' | 'decayedAt'>, at = this.playTime()): number {
    const dt = Math.max(0, at - n.decayedAt);
    return n.weight * 2 ** (-dt / this.halfLifeMs);
  }

  /** Applique une variation de poids (après décroissance) et la consigne comme preuve. */
  adjust(nodeId: number, delta: number, kind: string, refs: { episodeId?: number; utteranceId?: number; decisionId?: number } = {}, counters: { use?: boolean; success?: boolean; failure?: boolean } = {}): NodeRecord | undefined {
    const n = this.store.getNode(nodeId);
    if (!n) return undefined;
    const at = this.playTime();
    const weight = this.effectiveWeight(n, at) + delta;
    this.store.updateNode(nodeId, {
      weight,
      decayedAt: at,
      ...(counters.use ? { uses: n.uses + 1, lastUsedAt: this.store.now() } : {}),
      ...(counters.success ? { successes: n.successes + 1 } : {}),
      ...(counters.failure ? { failures: n.failures + 1 } : {}),
    });
    this.store.addEvidence({ nodeId, kind, delta, ...refs });
    return this.store.getNode(nodeId);
  }

  /** Approbation du joueur sur un mécanisme utilisé. */
  approve(mechanismId: number, refs: { utteranceId?: number; decisionId?: number } = {}): void {
    this.store.db.transaction(() => {
      const m = this.adjust(mechanismId, FEEDBACK.approval, 'approval', refs);
      if (m?.parentId) this.adjust(m.parentId, FEEDBACK.approval / 2, 'approval', refs);
    })();
  }

  /** Résultat d'une action fondée sur ce mécanisme. */
  recordOutcome(mechanismId: number, success: boolean, decisionId?: number): void {
    this.adjust(mechanismId, success ? FEEDBACK.success : FEEDBACK.failure, success ? 'success' : 'failure', { decisionId }, { use: true, success, failure: !success });
  }

  /**
   * Correction du joueur : pénalité forte et immédiate sur le mécanisme visé.
   * Le poids devient en général négatif : le mécanisme passe dans la liste « à éviter ».
   */
  correct(mechanismId: number, refs: { utteranceId?: number; decisionId?: number } = {}): NodeRecord | undefined {
    const n = this.store.getNode(mechanismId);
    if (!n) return undefined;
    const current = this.effectiveWeight(n);
    const target = current * FEEDBACK.correctionFactor + FEEDBACK.correctionPenalty;
    return this.adjust(mechanismId, target - current, 'correction', refs);
  }

  // ---------- arrivée des épisodes ----------

  /** Situation existante la plus proche dans le même domaine, si elle dépasse le seuil de fusion. */
  findSimilarSituation(domain: string, vector: Float32Array): { node: NodeRecord; similarity: number } | null {
    const hits = this.store.index.search(vector, 10);
    const nodes = new Map(this.store.getNodes(hits.map((h) => h.id)).map((n) => [n.id, n]));
    for (const h of hits) {
      const n = nodes.get(h.id);
      if (n && n.level === 'situation' && n.domain === domain && n.status === 'active' && h.similarity >= this.mergeThreshold) {
        return { node: n, similarity: h.similarity };
      }
    }
    return null;
  }

  async ingest(ep: Episode): Promise<IngestResult> {
    const [vector] = await this.store.embedder.embed([ep.situation.text]);
    const w = SOURCE_WEIGHT[ep.source];
    const at = this.playTime();

    return this.store.db.transaction(() => {
      const episodeId = this.store.insertEpisode({
        player: ep.player,
        domain: ep.domain,
        kind: ep.kind,
        summary: ep.summary,
        params: { ...ep.params, situation: ep.situation, mechanism: ep.mechanism },
        source: ep.source,
        startedAt: ep.startedAt,
        endedAt: ep.endedAt,
      });

      const similar = this.findSimilarSituation(ep.domain, vector!);
      let situationId: number;
      let createdSituation = false;
      if (similar) {
        situationId = similar.node.id;
        this.adjust(situationId, w, ep.source, { episodeId }, { use: true });
      } else {
        situationId = this.store.insertNodeWithVector(
          { parentId: this.store.domainRoot(ep.domain), level: 'situation', domain: ep.domain, label: ep.situation.text, situation: ep.situation, weight: w, uses: 1, decayedAt: at },
          vector,
        );
        this.store.addEvidence({ nodeId: situationId, kind: ep.source, delta: w, episodeId });
        createdSituation = true;
      }

      const signature = mechanismSignature(ep.mechanism);
      const sibling = this.store
        .listNodes({ parentId: situationId, level: 'mechanism', status: 'active' })
        .find((m) => m.mechanism && mechanismSignature(m.mechanism as Mechanism) === signature);
      let mechanismId: number;
      let createdMechanism = false;
      if (sibling) {
        mechanismId = sibling.id;
        this.store.updateNode(mechanismId, { mechanism: mergeMechanism(sibling.mechanism as Mechanism, ep.mechanism, w), label: ep.summary });
        this.adjust(mechanismId, w, ep.source, { episodeId }, { use: true });
      } else {
        mechanismId = this.store.insertNodeWithVector(
          { parentId: situationId, level: 'mechanism', domain: ep.domain, label: ep.summary, mechanism: mergeMechanism(null, ep.mechanism, w), weight: w, uses: 1, decayedAt: at },
          undefined,
        );
        this.store.addEvidence({ nodeId: mechanismId, kind: ep.source, delta: w, episodeId });
        createdMechanism = true;
      }
      return { episodeId, situationId, mechanismId, createdSituation, createdMechanism };
    })();
  }

  // ---------- lecture ----------

  /**
   * Branches pertinentes pour une situation décrite en texte : similarité sémantique pondérée par
   * le poids appris. Seules ces branches sont envoyées au décideur.
   */
  async search(text: string, opts: { k?: number; domain?: Domain; minSimilarity?: number } = {}): Promise<Branch[]> {
    const [vector] = await this.store.embedder.embed([text]);
    return this.searchVector(vector!, opts);
  }

  searchVector(vector: Float32Array, opts: { k?: number; domain?: Domain; minSimilarity?: number } = {}): Branch[] {
    const k = opts.k ?? 6;
    const at = this.playTime();
    const hits = this.store.index.search(vector, k * 5);
    const nodes = new Map(this.store.getNodes(hits.map((h) => h.id)).map((n) => [n.id, n]));
    const branches: Branch[] = [];
    for (const h of hits) {
      const s = nodes.get(h.id);
      if (!s || s.level !== 'situation' || s.status !== 'active') continue;
      if (opts.domain && s.domain !== opts.domain) continue;
      if (h.similarity < (opts.minSimilarity ?? 0.2)) continue;
      const weight = this.effectiveWeight(s, at);
      if (weight <= 0) continue;
      const children = this.store.listNodes({ parentId: s.id, level: 'mechanism', status: 'active' }).map((m) => ({ m, w: this.effectiveWeight(m, at) }));
      const mechanisms = children
        .filter((c) => c.w > 0)
        .sort((a, b) => b.w - a.w)
        .map(({ m, w }) => ({ id: m.id, label: m.label, weight: round(w), uses: m.uses, mechanism: publicMechanism(m.mechanism) }));
      const avoid = children.filter((c) => c.w < 0).map(({ m }) => ({ id: m.id, label: m.label, mechanism: publicMechanism(m.mechanism) }));
      branches.push({ situationId: s.id, domain: s.domain, situation: s.label, similarity: round(h.similarity, 3), weight: round(weight), score: h.similarity * (1 + Math.log1p(weight)), mechanisms, avoid });
    }
    return branches.sort((a, b) => b.score - a.score).slice(0, k);
  }

  /** Poids cumulé par domaine : la spécialité qui émerge. */
  profile(): Record<Domain, number> {
    const at = this.playTime();
    const out = Object.fromEntries(DOMAINS.map((d) => [d, 0])) as Record<Domain, number>;
    for (const n of this.store.listNodes({ level: 'mechanism', status: 'active' })) {
      const w = this.effectiveWeight(n, at);
      if (w > 0) out[n.domain] += w;
    }
    for (const d of DOMAINS) out[d] = round(out[d]);
    return out;
  }

  /** Vue d'ensemble pour `!arbre` : situations les plus lourdes et leur meilleur mécanisme. */
  overview(limit = 5): { domain: Domain; situation: string; weight: number; best: string | null }[] {
    const at = this.playTime();
    return this.store
      .listNodes({ level: 'situation', status: 'active' })
      .map((s) => {
        const best = this.store
          .listNodes({ parentId: s.id, level: 'mechanism', status: 'active' })
          .map((m) => ({ m, w: this.effectiveWeight(m, at) }))
          .filter((x) => x.w > 0)
          .sort((a, b) => b.w - a.w)[0];
        return { domain: s.domain, situation: s.label, weight: round(this.effectiveWeight(s, at)), best: best?.m.label ?? null };
      })
      .filter((x) => x.weight > 0)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, limit);
  }

  /**
   * `!oublie <chose>` : met de côté (réversible) les situations et mécanismes proches de la description.
   * Renvoie les nœuds oubliés.
   */
  async forget(text: string, minSimilarity = 0.55): Promise<NodeRecord[]> {
    const [vector] = await this.store.embedder.embed([text]);
    const situations = this.store.index
      .search(vector!, 20)
      .filter((h) => h.similarity >= minSimilarity)
      .map((h) => this.store.getNode(h.id))
      .filter((n): n is NodeRecord => n !== undefined && n.level === 'situation' && n.status === 'active');
    const words = text.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const mechanisms = this.store
      .listNodes({ level: 'mechanism', status: 'active' })
      .filter((m) => words.length > 0 && words.every((w) => m.label.toLowerCase().includes(w)));
    const forgotten = [...situations, ...mechanisms];
    this.store.db.transaction(() => {
      for (const n of forgotten) {
        this.store.updateNode(n.id, { status: 'forgotten' });
        this.store.addEvidence({ nodeId: n.id, kind: 'forget', delta: 0 });
      }
    })();
    return forgotten;
  }

  /** Annule un oubli. */
  restore(ids: number[]): void {
    for (const id of ids) this.store.updateNode(id, { status: 'active' });
  }
}

function round(v: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
