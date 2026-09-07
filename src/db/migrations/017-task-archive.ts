import type Database from 'better-sqlite3';

export function up(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info('tasks')").all() as { name: string }[];
  if (!columns.some((c) => c.name === 'archived_at')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN archived_at TEXT`);
  }
}
