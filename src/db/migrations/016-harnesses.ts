import type Database from 'better-sqlite3';

/**
 * A harness is a named set of hooks kept outside any project, so the same
 * agent setup (Claude Code, Kiro, ...) can be picked per project instead of
 * typed into each one. A project's own hooks stay where they are and win over
 * the harness's.
 */
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS harnesses (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS harness_hooks (
      harness_id TEXT NOT NULL REFERENCES harnesses(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      command TEXT NOT NULL,
      description TEXT,
      restart_if_running INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (harness_id, type)
    );
  `);

  const columns = db.prepare("PRAGMA table_info('projects')").all() as { name: string }[];
  if (!columns.some((c) => c.name === 'harness_id')) {
    db.exec(`ALTER TABLE projects ADD COLUMN harness_id TEXT`);
  }
}
