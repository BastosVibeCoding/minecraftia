import type { Db } from './db.js';

export interface VectorHit {
  id: number;
  /** Similarité cosinus dans [-1, 1] (1 = identique). */
  similarity: number;
}

/**
 * Index vectoriel des nœuds. Deux implémentations derrière la même interface :
 * sqlite-vec (KNN natif) et repli en mémoire (cosinus calculé en JS). Les deux persistent
 * les vecteurs dans `node_embeddings`, ce qui permet de passer de l'une à l'autre sans perte.
 */
export interface VectorIndex {
  readonly kind: 'sqlite-vec' | 'memory';
  upsert(id: number, vector: Float32Array): void;
  remove(id: number): void;
  search(vector: Float32Array, k: number): VectorHit[];
  get(id: number): Float32Array | undefined;
  size(): number;
  /** Vide l'index (réindexation après changement d'embedder). */
  clear(): void;
}

export function toBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function fromBlob(b: Buffer): Float32Array {
  const copy = Buffer.from(b);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

abstract class PersistedIndex {
  constructor(
    protected readonly db: Db,
    protected readonly dims: number,
  ) {}

  protected check(v: Float32Array): void {
    if (v.length !== this.dims) throw new Error(`vecteur de dimension ${v.length}, attendu ${this.dims}`);
  }

  protected persist(id: number, v: Float32Array): void {
    this.db
      .prepare('INSERT INTO node_embeddings(node_id, embedding) VALUES (?, ?) ON CONFLICT(node_id) DO UPDATE SET embedding = excluded.embedding')
      .run(id, toBlob(v));
  }

  protected unpersist(id: number): void {
    this.db.prepare('DELETE FROM node_embeddings WHERE node_id = ?').run(id);
  }

  get(id: number): Float32Array | undefined {
    const row = this.db.prepare('SELECT embedding FROM node_embeddings WHERE node_id = ?').get(id) as { embedding: Buffer } | undefined;
    return row ? fromBlob(row.embedding) : undefined;
  }
}

export class SqliteVecIndex extends PersistedIndex implements VectorIndex {
  readonly kind = 'sqlite-vec' as const;

  constructor(db: Db, dims: number) {
    super(db, dims);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS node_vec USING vec0(embedding float[${dims}] distance_metric=cosine)`);
    // reconstruit la table virtuelle si elle a été perdue (base copiée, extension rechargée)
    const vecCount = (db.prepare('SELECT count(*) AS n FROM node_vec').get() as { n: number }).n;
    const stored = (db.prepare('SELECT count(*) AS n FROM node_embeddings').get() as { n: number }).n;
    if (vecCount !== stored) {
      db.transaction(() => {
        db.exec('DELETE FROM node_vec');
        const ins = db.prepare('INSERT INTO node_vec(rowid, embedding) VALUES (?, ?)');
        for (const row of db.prepare('SELECT node_id, embedding FROM node_embeddings').iterate() as Iterable<{ node_id: number; embedding: Buffer }>) {
          ins.run(BigInt(row.node_id), row.embedding);
        }
      })();
    }
  }

  upsert(id: number, vector: Float32Array): void {
    this.check(vector);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM node_vec WHERE rowid = ?').run(BigInt(id));
      this.db.prepare('INSERT INTO node_vec(rowid, embedding) VALUES (?, ?)').run(BigInt(id), toBlob(vector));
      this.persist(id, vector);
    })();
  }

  remove(id: number): void {
    this.db.prepare('DELETE FROM node_vec WHERE rowid = ?').run(BigInt(id));
    this.unpersist(id);
  }

  search(vector: Float32Array, k: number): VectorHit[] {
    this.check(vector);
    if (k <= 0) return [];
    const rows = this.db
      .prepare('SELECT rowid AS id, distance FROM node_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance')
      .all(toBlob(vector), k) as { id: number; distance: number }[];
    return rows.map((r) => ({ id: Number(r.id), similarity: 1 - r.distance }));
  }

  size(): number {
    return (this.db.prepare('SELECT count(*) AS n FROM node_vec').get() as { n: number }).n;
  }

  clear(): void {
    this.db.exec('DELETE FROM node_vec; DELETE FROM node_embeddings;');
  }
}

export class MemoryVectorIndex extends PersistedIndex implements VectorIndex {
  readonly kind = 'memory' as const;
  private readonly vectors = new Map<number, Float32Array>();

  constructor(db: Db, dims: number) {
    super(db, dims);
    for (const row of db.prepare('SELECT node_id, embedding FROM node_embeddings').iterate() as Iterable<{ node_id: number; embedding: Buffer }>) {
      this.vectors.set(row.node_id, fromBlob(row.embedding));
    }
  }

  upsert(id: number, vector: Float32Array): void {
    this.check(vector);
    this.persist(id, vector);
    this.vectors.set(id, Float32Array.from(vector));
  }

  remove(id: number): void {
    this.unpersist(id);
    this.vectors.delete(id);
  }

  search(vector: Float32Array, k: number): VectorHit[] {
    this.check(vector);
    const hits: VectorHit[] = [];
    for (const [id, v] of this.vectors) hits.push({ id, similarity: cosine(vector, v) });
    return hits.sort((a, b) => b.similarity - a.similarity).slice(0, Math.max(0, k));
  }

  size(): number {
    return this.vectors.size;
  }

  clear(): void {
    this.db.exec('DELETE FROM node_embeddings');
    this.vectors.clear();
  }
}

export function createVectorIndex(db: Db, dims: number, vecAvailable: boolean): VectorIndex {
  return vecAvailable ? new SqliteVecIndex(db, dims) : new MemoryVectorIndex(db, dims);
}
