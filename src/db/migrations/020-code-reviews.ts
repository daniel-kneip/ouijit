import type Database from 'better-sqlite3';

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      worktree_path TEXT NOT NULL,
      project_path TEXT NOT NULL,
      seq INTEGER NOT NULL,
      base TEXT,
      branch TEXT,
      state TEXT NOT NULL,
      summary TEXT,
      snapshot_ref TEXT,
      created_at TEXT NOT NULL,
      submitted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_reviews_worktree ON reviews(worktree_path);
    CREATE TABLE IF NOT EXISTS review_viewed_files (
      review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      viewed_at TEXT NOT NULL,
      PRIMARY KEY (review_id, path)
    );
  `);

  const columns = db.prepare('PRAGMA table_info(diff_notes)').all() as { name: string }[];
  if (!columns.some((c) => c.name === 'review_id')) {
    db.exec('ALTER TABLE diff_notes ADD COLUMN review_id TEXT');
  }
}
