import type Database from 'better-sqlite3';

export interface DiffNoteRow {
  id: string;
  worktree_path: string;
  path: string;
  line: number;
  start_line: number | null;
  side: 'LEFT' | 'RIGHT';
  snippet: string | null;
  body: string;
  created_at: string;
  /** The review that owns it, once one does. Null on a note written outside one. */
  review_id: string | null;
}

/**
 * Notes on a worktree's diff, waiting to be handed to the agent working in it.
 *
 * Ordered by file and line rather than by write time, so the list matches the
 * order the notes appear in the diff.
 *
 * A note handed over with a review leaves that queue for good: the review is a
 * record of what was said, so its notes are neither listed as outstanding nor
 * swept when the code they were written about changes.
 */
export class DiffNoteRepo {
  constructor(private db: Database.Database) {}

  getForWorktree(worktreePath: string): DiffNoteRow[] {
    return this.db
      .prepare(
        `SELECT n.* FROM diff_notes n
           LEFT JOIN reviews r ON r.id = n.review_id
          WHERE n.worktree_path = ? AND (r.id IS NULL OR r.state = 'open')
          ORDER BY n.path, n.line, n.created_at`,
      )
      .all(worktreePath) as DiffNoteRow[];
  }

  getForReview(reviewId: string): DiffNoteRow[] {
    return this.db
      .prepare('SELECT * FROM diff_notes WHERE review_id = ? ORDER BY path, line, created_at')
      .all(reviewId) as DiffNoteRow[];
  }

  /** Takes every note not yet part of a review into one, as submitting it does. */
  adoptLoose(worktreePath: string, reviewId: string): void {
    this.db
      .prepare('UPDATE diff_notes SET review_id = ? WHERE worktree_path = ? AND review_id IS NULL')
      .run(reviewId, worktreePath);
  }

  /**
   * An edit rewrites the body and nothing else. Where a note points is not the
   * writer's to change after the fact — the snippet is what it was written
   * about, and `move` is the only thing that renumbers it.
   */
  save(row: DiffNoteRow): void {
    this.db
      .prepare(
        `INSERT INTO diff_notes (id, worktree_path, path, line, start_line, side, snippet, body, created_at, review_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET body = excluded.body`,
      )
      .run(
        row.id,
        row.worktree_path,
        row.path,
        row.line,
        row.start_line,
        row.side,
        row.snippet,
        row.body,
        row.created_at,
        row.review_id,
      );
  }

  move(id: string, startLine: number, line: number): void {
    this.db.prepare('UPDATE diff_notes SET start_line = ?, line = ? WHERE id = ?').run(startLine, line, id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM diff_notes WHERE id = ?').run(id);
  }

  deleteMany(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const drop = this.db.prepare('DELETE FROM diff_notes WHERE id = ?');
    this.db.transaction((all: readonly string[]) => all.forEach((id) => drop.run(id)))(ids);
  }

  deleteForWorktree(worktreePath: string): void {
    this.db.prepare('DELETE FROM diff_notes WHERE worktree_path = ?').run(worktreePath);
  }

  /** "Discard all", which is about the outstanding notes and not about the record. */
  deleteOutstanding(worktreePath: string): void {
    this.db
      .prepare(
        `DELETE FROM diff_notes WHERE id IN (
           SELECT n.id FROM diff_notes n LEFT JOIN reviews r ON r.id = n.review_id
            WHERE n.worktree_path = ? AND (r.id IS NULL OR r.state = 'open'))`,
      )
      .run(worktreePath);
  }
}
