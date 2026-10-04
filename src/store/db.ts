import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import type { Logger } from '../core/logger.js';
import { MIGRATIONS } from './migrations.js';

export type Db = Database.Database;

export interface OpenOptions {
  /** `auto` : sqlite-vec si l'extension se charge, sinon repli en mémoire. `off` : toujours le repli. */
  vector?: 'auto' | 'off';
  logger?: Logger;
}

export interface OpenedDb {
  db: Db;
  vecAvailable: boolean;
}

/** Ouvre (ou crée) la base, charge sqlite-vec si possible et applique les migrations. */
export function openDatabase(path: string, opts: OpenOptions = {}): OpenedDb {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  let vecAvailable = false;
  if (opts.vector !== 'off') {
    try {
      sqliteVec.load(db);
      vecAvailable = true;
    } catch (err) {
      opts.logger?.warn({ err }, 'sqlite-vec indisponible : repli sur la similarité en mémoire');
    }
  }
  migrate(db);
  return { db, vecAvailable };
}

export function schemaVersion(db: Db): number {
  return db.pragma('user_version', { simple: true }) as number;
}

function migrate(db: Db): void {
  const current = schemaVersion(db);
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    })();
  }
}

export function getMeta(db: Db, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
