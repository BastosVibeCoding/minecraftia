import type { Clock } from '../core/clock.js';
import type { Logger } from '../core/logger.js';
import type { Domain } from '../core/types.js';
import { getMeta, openDatabase, setMeta, type Db } from './db.js';
import type { Embedder } from './embedder.js';
import { createVectorIndex, type VectorIndex } from './vectorIndex.js';

export type EpisodeSource = 'observed' | 'taught' | 'corrected' | 'legacy';
export type NodeLevel = 'domain' | 'situation' | 'mechanism';

export interface EpisodeRecord {
  id: number;
  player: string;
  domain: Domain;
  kind: string;
  summary: string;
  params: Record<string, unknown>;
  source: EpisodeSource;
  startedAt: number;
  endedAt: number;
}

export interface NodeRecord {
  id: number;
  parentId: number | null;
  level: NodeLevel;
  domain: Domain;
  label: string;
  situation: Record<string, unknown> | null;
  mechanism: Record<string, unknown> | null;
  weight: number;
  uses: number;
  successes: number;
  failures: number;
  lastUsedAt: number | null;
  decayedAt: number;
  createdAt: number;
  status: 'active' | 'forgotten';
}

interface NodeRow {
  id: number;
  parent_id: number | null;
  level: NodeLevel;
  domain: Domain;
  label: string;
  situation_json: string | null;
  mechanism_json: string | null;
  weight: number;
  uses: number;
  successes: number;
  failures: number;
  last_used_at: number | null;
  decayed_at: number;
  created_at: number;
  status: 'active' | 'forgotten';
}

function toNode(r: NodeRow): NodeRecord {
  return {
    id: r.id,
    parentId: r.parent_id,
    level: r.level,
    domain: r.domain,
    label: r.label,
    situation: r.situation_json ? (JSON.parse(r.situation_json) as Record<string, unknown>) : null,
    mechanism: r.mechanism_json ? (JSON.parse(r.mechanism_json) as Record<string, unknown>) : null,
    weight: r.weight,
    uses: r.uses,
    successes: r.successes,
    failures: r.failures,
    lastUsedAt: r.last_used_at,
    decayedAt: r.decayed_at,
    createdAt: r.created_at,
    status: r.status,
  };
}

export interface NewNode {
  parentId: number | null;
  level: NodeLevel;
  domain: Domain;
  label: string;
  situation?: Record<string, unknown> | null;
  mechanism?: Record<string, unknown> | null;
  weight?: number;
  uses?: number;
  /** Instant (en temps de jeu actif) à partir duquel le poids décroît. Par défaut : maintenant. */
  decayedAt?: number;
}

/**
 * Accès aux données. Ne contient aucune règle d'apprentissage : le renforcement, la décroissance
 * et la recherche pertinente vivent dans `src/tree/`. Chaque phase y ajoute ses tables.
 */
export class Store {
  private constructor(
    readonly db: Db,
    readonly index: VectorIndex,
    readonly embedder: Embedder,
    private readonly clock: Clock,
  ) {}

  static async open(path: string, embedder: Embedder, clock: Clock, opts: { vector?: 'auto' | 'off'; logger?: Logger } = {}): Promise<Store> {
    const { db, vecAvailable } = openDatabase(path, opts);
    const index = createVectorIndex(db, embedder.dims, vecAvailable);
    const store = new Store(db, index, embedder, clock);
    await store.reindexIfEmbedderChanged(opts.logger);
    return store;
  }

  close(): void {
    this.db.close();
  }

  now(): number {
    return this.clock.now();
  }

  /** Si l'embedder a changé depuis la dernière ouverture, recalcule tous les vecteurs. */
  async reindexIfEmbedderChanged(logger?: Logger): Promise<boolean> {
    const previous = getMeta(this.db, 'embedder');
    if (previous === this.embedder.name) return false;
    const nodes = this.db.prepare("SELECT id, label FROM nodes WHERE level != 'domain'").all() as { id: number; label: string }[];
    this.index.clear();
    const batch = 32;
    for (let i = 0; i < nodes.length; i += batch) {
      const slice = nodes.slice(i, i + batch);
      const vectors = await this.embedder.embed(slice.map((n) => n.label));
      this.db.transaction(() => slice.forEach((n, j) => this.index.upsert(n.id, vectors[j]!)))();
    }
    setMeta(this.db, 'embedder', this.embedder.name);
    if (previous) logger?.info({ from: previous, to: this.embedder.name, nodes: nodes.length }, 'index vectoriel reconstruit');
    return true;
  }

  // ---------- épisodes ----------

  insertEpisode(e: Omit<EpisodeRecord, 'id'>): number {
    const r = this.db
      .prepare(
        'INSERT INTO episodes(player, domain, kind, summary, params_json, source, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(e.player, e.domain, e.kind, e.summary, JSON.stringify(e.params), e.source, e.startedAt, e.endedAt);
    return Number(r.lastInsertRowid);
  }

  listEpisodes(limit = 100): EpisodeRecord[] {
    const rows = this.db.prepare('SELECT * FROM episodes ORDER BY ended_at DESC, id DESC LIMIT ?').all(limit) as {
      id: number;
      player: string;
      domain: Domain;
      kind: string;
      summary: string;
      params_json: string;
      source: EpisodeSource;
      started_at: number;
      ended_at: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      player: r.player,
      domain: r.domain,
      kind: r.kind,
      summary: r.summary,
      params: JSON.parse(r.params_json) as Record<string, unknown>,
      source: r.source,
      startedAt: r.started_at,
      endedAt: r.ended_at,
    }));
  }

  // ---------- nœuds ----------

  /** Insère un nœud et, sauf pour les racines de domaine, son vecteur. */
  async insertNode(n: NewNode): Promise<number> {
    const vector = n.level === 'domain' ? undefined : (await this.embedder.embed([n.label]))[0];
    return this.insertNodeWithVector(n, vector);
  }

  insertNodeWithVector(n: NewNode, vector: Float32Array | undefined): number {
    const now = this.clock.now();
    return this.db.transaction(() => {
      const r = this.db
        .prepare(
          `INSERT INTO nodes(parent_id, level, domain, label, situation_json, mechanism_json, weight, uses, decayed_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          n.parentId,
          n.level,
          n.domain,
          n.label,
          n.situation ? JSON.stringify(n.situation) : null,
          n.mechanism ? JSON.stringify(n.mechanism) : null,
          n.weight ?? 0,
          n.uses ?? 0,
          n.decayedAt ?? now,
          now,
        );
      const id = Number(r.lastInsertRowid);
      if (vector) this.index.upsert(id, vector);
      return id;
    })();
  }

  /** Racine d'un domaine (créée au besoin, poids nul : aucun rôle préprogrammé). */
  domainRoot(domain: Domain): number {
    const row = this.db.prepare("SELECT id FROM nodes WHERE level = 'domain' AND domain = ?").get(domain) as { id: number } | undefined;
    if (row) return row.id;
    return this.insertNodeWithVector({ parentId: null, level: 'domain', domain, label: domain }, undefined);
  }

  getNode(id: number): NodeRecord | undefined {
    const row = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as NodeRow | undefined;
    return row ? toNode(row) : undefined;
  }

  getNodes(ids: number[]): NodeRecord[] {
    if (ids.length === 0) return [];
    const rows = this.db.prepare(`SELECT * FROM nodes WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as NodeRow[];
    return rows.map(toNode);
  }

  listNodes(filter: { domain?: Domain; level?: NodeLevel; status?: 'active' | 'forgotten'; parentId?: number } = {}): NodeRecord[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.domain) (where.push('domain = ?'), args.push(filter.domain));
    if (filter.level) (where.push('level = ?'), args.push(filter.level));
    if (filter.status) (where.push('status = ?'), args.push(filter.status));
    if (filter.parentId !== undefined) (where.push('parent_id = ?'), args.push(filter.parentId));
    const sql = `SELECT * FROM nodes ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY weight DESC, id`;
    return (this.db.prepare(sql).all(...args) as NodeRow[]).map(toNode);
  }

  /** Met à jour les champs dynamiques d'un nœud (poids, compteurs, statut, paramètres fusionnés). */
  updateNode(
    id: number,
    patch: Partial<Pick<NodeRecord, 'weight' | 'uses' | 'successes' | 'failures' | 'lastUsedAt' | 'decayedAt' | 'status' | 'situation' | 'mechanism' | 'label'>>,
  ): void {
    const cols: string[] = [];
    const args: unknown[] = [];
    const map: Record<string, string> = {
      weight: 'weight',
      uses: 'uses',
      successes: 'successes',
      failures: 'failures',
      lastUsedAt: 'last_used_at',
      decayedAt: 'decayed_at',
      status: 'status',
      label: 'label',
    };
    for (const [k, col] of Object.entries(map)) {
      const v = patch[k as keyof typeof patch];
      if (v !== undefined) (cols.push(`${col} = ?`), args.push(v));
    }
    if (patch.situation !== undefined) (cols.push('situation_json = ?'), args.push(patch.situation ? JSON.stringify(patch.situation) : null));
    if (patch.mechanism !== undefined) (cols.push('mechanism_json = ?'), args.push(patch.mechanism ? JSON.stringify(patch.mechanism) : null));
    if (cols.length === 0) return;
    this.db.prepare(`UPDATE nodes SET ${cols.join(', ')} WHERE id = ?`).run(...args, id);
  }

  addEvidence(e: { nodeId: number; kind: string; delta: number; episodeId?: number; utteranceId?: number; decisionId?: number }): void {
    this.db
      .prepare('INSERT INTO node_evidence(node_id, kind, delta, episode_id, utterance_id, decision_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(e.nodeId, e.kind, e.delta, e.episodeId ?? null, e.utteranceId ?? null, e.decisionId ?? null, this.clock.now());
  }

  // ---------- autonomie ----------

  getAutonomy(): Record<string, { score: number; band: string; updatedAt: number }> {
    const rows = this.db.prepare('SELECT domain, score, band, updated_at FROM autonomy').all() as {
      domain: string;
      score: number;
      band: string;
      updated_at: number;
    }[];
    return Object.fromEntries(rows.map((r) => [r.domain, { score: r.score, band: r.band, updatedAt: r.updated_at }]));
  }

  setAutonomy(domain: Domain, score: number, band: string, reason: string, delta: number, refId?: number): void {
    const now = this.clock.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO autonomy(domain, score, band, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(domain) DO UPDATE SET score = excluded.score, band = excluded.band, updated_at = excluded.updated_at`,
        )
        .run(domain, score, band, now);
      this.db.prepare('INSERT INTO autonomy_events(domain, delta, reason, ref_id, at) VALUES (?, ?, ?, ?, ?)').run(domain, delta, reason, refId ?? null, now);
    })();
  }

  // ---------- import hérité ----------

  hasLegacy(contentHash: string, jsonPath: string): boolean {
    return this.db.prepare('SELECT 1 FROM legacy_import WHERE content_hash = ? AND json_path = ?').get(contentHash, jsonPath) !== undefined;
  }

  insertLegacy(r: { sourceFile: string; contentHash: string; jsonPath: string; rawJson: string; mappedTo: string | null }): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO legacy_import(source_file, content_hash, json_path, raw_json, mapped_to, imported_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(r.sourceFile, r.contentHash, r.jsonPath, r.rawJson, r.mappedTo, this.clock.now());
  }

  listLegacy(sourceFile?: string): { sourceFile: string; contentHash: string; jsonPath: string; rawJson: string; mappedTo: string | null }[] {
    const rows = (
      sourceFile
        ? this.db.prepare('SELECT * FROM legacy_import WHERE source_file = ? ORDER BY id').all(sourceFile)
        : this.db.prepare('SELECT * FROM legacy_import ORDER BY id').all()
    ) as { source_file: string; content_hash: string; json_path: string; raw_json: string; mapped_to: string | null }[];
    return rows.map((r) => ({ sourceFile: r.source_file, contentHash: r.content_hash, jsonPath: r.json_path, rawJson: r.raw_json, mappedTo: r.mapped_to }));
  }
}
