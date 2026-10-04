import { createHash } from 'node:crypto';
import type { Logger } from '../core/logger.js';

/** Transforme des textes de situation en vecteurs normalisés. */
export interface Embedder {
  /** Identifiant stocké dans `meta` : s'il change, l'index est reconstruit. */
  readonly name: string;
  readonly dims: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export const EMBEDDING_DIMS = 384;

function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] = v[i]! / n;
  return v;
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 1);
}

/**
 * Embedder déterministe sans modèle : mots et trigrammes de caractères hachés dans 384 dimensions.
 * Capte le recouvrement lexical, pas les synonymes. Sert aux tests et de repli hors-ligne.
 */
export class HashingEmbedder implements Embedder {
  readonly name = 'hashing-v1';
  readonly dims = EMBEDDING_DIMS;

  embed(texts: string[]): Promise<Float32Array[]> {
    return Promise.resolve(texts.map((t) => this.embedOne(t)));
  }

  private embedOne(text: string): Float32Array {
    const v = new Float32Array(this.dims);
    const add = (feature: string, weight: number) => {
      const h = createHash('md5').update(feature).digest();
      const idx = h.readUInt32LE(0) % this.dims;
      const sign = (h[4]! & 1) === 0 ? 1 : -1;
      v[idx] = v[idx]! + sign * weight;
    };
    for (const tok of tokens(text)) {
      add(`w:${tok}`, 1);
      const padded = `#${tok}#`;
      for (let i = 0; i + 3 <= padded.length; i++) add(`c:${padded.slice(i, i + 3)}`, 0.3);
    }
    return normalize(v);
  }
}

type FeatureExtractor = (texts: string[], opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>;

/** Modèle multilingue local (transformers.js, ONNX) : capte le sens, y compris en français. */
export class TransformersEmbedder implements Embedder {
  readonly name: string;
  readonly dims = EMBEDDING_DIMS;
  private extractor: Promise<FeatureExtractor> | null = null;

  constructor(
    private readonly model = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
    private readonly cacheDir = 'data/models',
  ) {
    this.name = `transformers:${model}:q8`;
  }

  /** Charge le modèle (téléchargé une fois dans `cacheDir`). */
  load(): Promise<FeatureExtractor> {
    if (!this.extractor) {
      this.extractor = (async () => {
        const { pipeline, env } = await import('@huggingface/transformers');
        env.cacheDir = this.cacheDir;
        return (await pipeline('feature-extraction', this.model, { dtype: 'q8' })) as unknown as FeatureExtractor;
      })();
      this.extractor.catch(() => (this.extractor = null));
    }
    return this.extractor;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const fe = await this.load();
    const out = await fe(texts, { pooling: 'mean', normalize: true });
    return out.tolist().map((row) => Float32Array.from(row));
  }
}

/** Modèle local si possible, sinon repli déterministe (journalisé). */
export async function createEmbedder(kind: 'transformers' | 'hashing', cacheDir: string, logger?: Logger): Promise<Embedder> {
  if (kind === 'hashing') return new HashingEmbedder();
  const t = new TransformersEmbedder(undefined, cacheDir);
  try {
    await t.load();
    return t;
  } catch (err) {
    logger?.warn({ err }, 'modèle d\'embeddings indisponible : repli sur l\'embedder déterministe');
    return new HashingEmbedder();
  }
}
