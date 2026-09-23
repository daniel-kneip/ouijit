import type Database from 'better-sqlite3';

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL REFERENCES projects(path) ON DELETE CASCADE,
      task_number INTEGER NOT NULL,
      body TEXT NOT NULL,
      author TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(project_path, task_number);
  `);
}
