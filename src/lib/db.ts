import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Project, Asset, Job } from "./types";

export const dataDir = path.resolve(
  /* turbopackIgnore: true */ process.env.YINGKE_DATA_DIR ||
    path.join(process.cwd(), ".data"),
);
let connection: DatabaseSync | undefined;
export function db() {
  if (connection) return connection;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(dataDir, "media"), { recursive: true, mode: 0o700 });
  const sql = new DatabaseSync(path.join(dataDir, "studio.sqlite"));
  sql.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS worker_lock (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL, trim_start REAL NOT NULL DEFAULT 0, trim_end REAL NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('source','reference')), name TEXT NOT NULL, path TEXT NOT NULL,
      mime TEXT NOT NULL, bytes INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      duration REAL, width INTEGER, height INTEGER, thumbnail TEXT, error TEXT, created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_source ON assets(project_id) WHERE kind='source' AND status!='failed';
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued', progress INTEGER NOT NULL DEFAULT 0,
      payload TEXT NOT NULL, output TEXT, error TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0, request_key TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
      UNIQUE(owner_id, request_key)
    );
    CREATE INDEX IF NOT EXISTS projects_owner ON projects(owner_id, updated_at);
    CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status, created_at);
    CREATE INDEX IF NOT EXISTS assets_project ON assets(project_id);
  `);
  connection = sql;
  return sql;
}
export function transaction<T>(fn: () => T): T {
  const sql = db();
  sql.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    sql.exec("COMMIT");
    return result;
  } catch (error) {
    sql.exec("ROLLBACK");
    throw error;
  }
}
export function projectFor(id: string, owner: string) {
  return db()
    .prepare("SELECT * FROM projects WHERE id=? AND owner_id=?")
    .get(id, owner) as Project | undefined;
}
export function assetFor(id: string, owner: string) {
  return db()
    .prepare(
      "SELECT a.* FROM assets a JOIN projects p ON p.id=a.project_id WHERE a.id=? AND p.owner_id=?",
    )
    .get(id, owner) as Asset | undefined;
}
export function jobFor(id: string, owner: string) {
  return db()
    .prepare("SELECT * FROM jobs WHERE id=? AND owner_id=?")
    .get(id, owner) as Job | undefined;
}
export function storagePath(relative: string) {
  const full = path.resolve(dataDir, relative);
  if (!full.startsWith(dataDir + path.sep))
    throw new Error("Invalid storage path");
  return full;
}
