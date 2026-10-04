/**
 * Migrations versionnées, appliquées dans l'ordre au démarrage.
 * Le SQL est embarqué ici (et non dans des fichiers .sql) pour être livré avec le build sans copie.
 * Ne jamais modifier une migration publiée : en ajouter une nouvelle.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'schéma initial',
    sql: `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE episodes (
  id INTEGER PRIMARY KEY,
  player TEXT NOT NULL,
  domain TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  params_json TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('observed','taught','corrected','legacy')),
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL
);
CREATE INDEX episodes_time ON episodes(ended_at);

CREATE TABLE nodes (
  id INTEGER PRIMARY KEY,
  parent_id INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK (level IN ('domain','situation','mechanism')),
  domain TEXT NOT NULL,
  label TEXT NOT NULL,
  situation_json TEXT,
  mechanism_json TEXT,
  weight REAL NOT NULL DEFAULT 0,
  uses INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  decayed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','forgotten'))
);
CREATE INDEX nodes_domain ON nodes(domain, status, weight DESC);
CREATE INDEX nodes_parent ON nodes(parent_id);

CREATE TABLE node_embeddings (
  node_id INTEGER PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL
);

CREATE TABLE node_evidence (
  id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  delta REAL NOT NULL,
  episode_id INTEGER,
  utterance_id INTEGER,
  decision_id INTEGER,
  at INTEGER NOT NULL
);
CREATE INDEX node_evidence_node ON node_evidence(node_id, at);

CREATE TABLE autonomy (
  domain TEXT PRIMARY KEY,
  score REAL NOT NULL,
  band TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE autonomy_events (
  id INTEGER PRIMARY KEY,
  domain TEXT NOT NULL,
  delta REAL NOT NULL,
  reason TEXT NOT NULL,
  ref_id INTEGER,
  at INTEGER NOT NULL
);

CREATE TABLE utterances (
  id INTEGER PRIMARY KEY,
  player TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('chat','voice')),
  text TEXT NOT NULL,
  label TEXT NOT NULL,
  classifier TEXT NOT NULL,
  confidence REAL NOT NULL,
  domain TEXT,
  at INTEGER NOT NULL
);

CREATE TABLE decisions (
  id INTEGER PRIMARY KEY,
  trigger TEXT NOT NULL,
  situation_hash TEXT NOT NULL,
  model TEXT,
  cached INTEGER NOT NULL,
  node_ids_json TEXT NOT NULL,
  decision_json TEXT NOT NULL,
  rationale TEXT NOT NULL,
  autonomy_json TEXT NOT NULL,
  at INTEGER NOT NULL
);

CREATE TABLE outcomes (
  id INTEGER PRIMARY KEY,
  decision_id INTEGER REFERENCES decisions(id),
  status TEXT NOT NULL CHECK (status IN ('success','failure','death','preempted','timeout')),
  details_json TEXT NOT NULL,
  at INTEGER NOT NULL
);

CREATE TABLE decision_cache (
  situation_hash TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  decision_json TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);

CREATE TABLE llm_calls (
  id INTEGER PRIMARY KEY,
  purpose TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cost_usd REAL,
  latency_ms INTEGER,
  ok INTEGER NOT NULL,
  error TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX llm_calls_day ON llm_calls(at);

CREATE TABLE legacy_import (
  id INTEGER PRIMARY KEY,
  source_file TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  json_path TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  mapped_to TEXT,
  imported_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX legacy_import_unique ON legacy_import(content_hash, json_path);
`,
  },
  {
    version: 2,
    name: 'compétences manquantes repérées',
    sql: `
CREATE TABLE skill_gaps (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('ordre','outil','pose')),
  label TEXT NOT NULL,
  example TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL
);
`,
  },
  {
    version: 3,
    name: 'blocs posés par les joueurs (protégés)',
    sql: `
CREATE TABLE placed_blocks (
  pos TEXT PRIMARY KEY,
  block TEXT NOT NULL,
  player TEXT NOT NULL,
  at INTEGER NOT NULL
);
`,
  },
];
