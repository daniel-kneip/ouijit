import type Database from 'better-sqlite3';

export function up(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info('harnesses')").all() as { name: string }[];
  if (!columns.some((c) => c.name === 'usage_command')) {
    db.exec(`ALTER TABLE harnesses ADD COLUMN usage_command TEXT`);
  }
}
