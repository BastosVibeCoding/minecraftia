import type { Logger } from '../core/logger.js';
import type { Episode } from '../observer/types.js';
import type { NodeRecord, Store } from '../store/store.js';
import { mechanismSignature, mergeMechanism, type Mechanism } from './merge.js';

/** Poids apporté par une observation, selon sa source (une correction pèse plus que tout). */
export const SOURCE_WEIGHT = { observed: 1, taught: 3, corrected: 5, legacy: 1 } as const;

export interface TreeOptions {
  /** Similarité cosinus au-delà de laquelle une situation nouvelle rejoint une situation connue. */
  mergeThreshold?: number;
  logger?: Logger;
}

export interface IngestResult {
  episodeId: number;
  situationId: number;
  mechanismId: number;
  createdSituation: boolean;
  createdMechanism: boolean;
}

/**
 * Arbre de comportements : domaine → situation → mécanismes concurrents.
 * Cette partie gère l'arrivée des épisodes (fusion ou création). La dynamique des poids
 * (renforcement, décroissance, correction, oubli) et la recherche sont dans `dynamics.ts`.
 */
export class BehaviorTree {
  readonly mergeThreshold: number;

  constructor(
    readonly store: Store,
    readonly opts: TreeOptions = {},
  ) {
    this.mergeThreshold = opts.mergeThreshold ?? 0.88;
  }

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
    const now = this.store.now();

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
        const s = similar.node;
        this.store.updateNode(situationId, { weight: s.weight + w, uses: s.uses + 1, lastUsedAt: now });
      } else {
        situationId = this.store.insertNodeWithVector(
          { parentId: this.store.domainRoot(ep.domain), level: 'situation', domain: ep.domain, label: ep.situation.text, situation: ep.situation, weight: w, uses: 1 },
          vector,
        );
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
        this.store.updateNode(mechanismId, {
          weight: sibling.weight + w,
          uses: sibling.uses + 1,
          lastUsedAt: now,
          mechanism: mergeMechanism(sibling.mechanism as Mechanism, ep.mechanism, w),
        });
      } else {
        mechanismId = this.store.insertNodeWithVector(
          {
            parentId: situationId,
            level: 'mechanism',
            domain: ep.domain,
            label: ep.summary,
            mechanism: mergeMechanism(null, ep.mechanism, w),
            weight: w,
            uses: 1,
          },
          undefined,
        );
        createdMechanism = true;
      }
      this.store.addEvidence({ nodeId: situationId, kind: ep.source, delta: w, episodeId });
      this.store.addEvidence({ nodeId: mechanismId, kind: ep.source, delta: w, episodeId });
      return { episodeId, situationId, mechanismId, createdSituation, createdMechanism };
    })();
  }
}
