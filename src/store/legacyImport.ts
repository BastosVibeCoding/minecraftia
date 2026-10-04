import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DOMAINS, type Domain } from '../core/types.js';
import type { Store } from './store.js';

/**
 * Import JSON → SQLite, sans perte et idempotent.
 *
 * Chaque fichier est d'abord recopié tel quel dans `legacy_import` (chemin `$`) : rien n'est jamais
 * perdu, même ce qui n'est pas compris. Les fichiers au format `minecraftia-export` sont en plus mappés
 * vers les tables (épisodes, nœuds, autonomie), chaque élément gardant sa copie brute et sa cible.
 *
 * Format `minecraftia-export` v1 :
 * {
 *   "format": "minecraftia-export", "version": 1,
 *   "episodes": [{ "player", "domain", "kind", "summary", "params"?, "source"?, "startedAt", "endedAt" }],
 *   "nodes":    [{ "domain", "situation", "mechanism"?, "weight"?, "uses"? }],
 *   "autonomy": { "<domaine>": <score 0..1> }
 * }
 */

const DomainSchema = z.enum(DOMAINS);

const EpisodeSchema = z.object({
  player: z.string().min(1),
  domain: DomainSchema,
  kind: z.string().min(1),
  summary: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
  source: z.enum(['observed', 'taught', 'corrected', 'legacy']).default('legacy'),
  startedAt: z.number(),
  endedAt: z.number(),
});

const NodeSchema = z.object({
  domain: DomainSchema,
  situation: z.string().min(1),
  mechanism: z.record(z.string(), z.unknown()).optional(),
  weight: z.number().default(1),
  uses: z.number().int().nonnegative().default(0),
});

const ExportSchema = z.object({
  format: z.literal('minecraftia-export'),
  version: z.literal(1),
  episodes: z.array(z.unknown()).default([]),
  nodes: z.array(z.unknown()).default([]),
  autonomy: z.record(z.string(), z.unknown()).default({}),
});

export interface ImportReport {
  file: string;
  skipped: boolean;
  episodes: number;
  nodes: number;
  autonomy: number;
  unmapped: string[];
}

export function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export async function importJson(store: Store, sourceFile: string, content: string): Promise<ImportReport> {
  const hash = contentHash(content);
  const report: ImportReport = { file: sourceFile, skipped: false, episodes: 0, nodes: 0, autonomy: 0, unmapped: [] };
  if (store.hasLegacy(hash, '$')) return { ...report, skipped: true };

  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    // JSON invalide : conservé brut (encodé en chaîne JSON), signalé comme non mappé
    store.insertLegacy({ sourceFile, contentHash: hash, jsonPath: '$', rawJson: JSON.stringify(content), mappedTo: null });
    return { ...report, unmapped: ['$ (JSON invalide)'] };
  }

  const parsed = ExportSchema.safeParse(data);
  if (!parsed.success) {
    store.insertLegacy({ sourceFile, contentHash: hash, jsonPath: '$', rawJson: content, mappedTo: null });
    return { ...report, unmapped: ['$ (format non reconnu, conservé brut)'] };
  }
  const exp = parsed.data;

  // vecteurs calculés avant la transaction (opération asynchrone)
  const nodeItems = exp.nodes.map((raw, i) => ({ raw, i, parsed: NodeSchema.safeParse(raw) }));
  const valid = nodeItems.filter((n) => n.parsed.success);
  const vectors = await store.embedder.embed(valid.map((n) => n.parsed.data!.situation));
  const vectorOf = new Map(valid.map((n, j) => [n.i, vectors[j]!]));

  store.db.transaction(() => {
    store.insertLegacy({ sourceFile, contentHash: hash, jsonPath: '$', rawJson: content, mappedTo: 'minecraftia-export' });

    exp.episodes.forEach((raw, i) => {
      const path = `$.episodes[${i}]`;
      const ep = EpisodeSchema.safeParse(raw);
      let mapped: string | null = null;
      if (ep.success) {
        mapped = `episodes:${store.insertEpisode(ep.data)}`;
        report.episodes++;
      } else report.unmapped.push(path);
      store.insertLegacy({ sourceFile, contentHash: hash, jsonPath: path, rawJson: JSON.stringify(raw), mappedTo: mapped });
    });

    for (const item of nodeItems) {
      const path = `$.nodes[${item.i}]`;
      let mapped: string | null = null;
      if (item.parsed.success) {
        const n = item.parsed.data;
        const root = store.domainRoot(n.domain);
        const situationId = store.insertNodeWithVector(
          { parentId: root, level: 'situation', domain: n.domain, label: n.situation, situation: { text: n.situation }, weight: n.weight, uses: n.uses },
          vectorOf.get(item.i),
        );
        mapped = `nodes:${situationId}`;
        if (n.mechanism) {
          const mechId = store.insertNodeWithVector(
            {
              parentId: situationId,
              level: 'mechanism',
              domain: n.domain,
              label: `${n.situation} → ${JSON.stringify(n.mechanism)}`,
              mechanism: n.mechanism,
              weight: n.weight,
              uses: n.uses,
            },
            vectorOf.get(item.i),
          );
          mapped += `,nodes:${mechId}`;
        }
        report.nodes++;
      } else report.unmapped.push(path);
      store.insertLegacy({ sourceFile, contentHash: hash, jsonPath: path, rawJson: JSON.stringify(item.raw), mappedTo: mapped });
    }

    for (const [domain, score] of Object.entries(exp.autonomy)) {
      const path = `$.autonomy.${domain}`;
      const d = DomainSchema.safeParse(domain);
      const s = z.number().min(0).max(1).safeParse(score);
      let mapped: string | null = null;
      if (d.success && s.success) {
        store.setAutonomy(d.data as Domain, s.data, 'importé', 'import JSON', s.data);
        mapped = `autonomy:${domain}`;
        report.autonomy++;
      } else report.unmapped.push(path);
      store.insertLegacy({ sourceFile, contentHash: hash, jsonPath: path, rawJson: JSON.stringify(score), mappedTo: mapped });
    }
  })();

  return report;
}
