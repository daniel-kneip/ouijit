import type Database from 'better-sqlite3';

export interface ReviewRow {
  id: string;
  worktree_path: string;
  project_path: string;
  seq: number;
  base: string | null;
  branch: string | null;
  state: 'open' | 'accepted' | 'changes_requested';
  summary: string | null;
  snapshot_ref: string | null;
  created_at: string;
  submitted_at: string | null;
}

/**
 * Reviews of a worktree's diff, newest first, and which files each one has been
 * shown. A submitted review is a record: nothing rewrites it, and its comments
 * (the `diff_notes` rows carrying its id) outlive the code they were about.
 */
export class ReviewRepo {
  constructor(private db: Database.Database) {}

  getForWorktree(worktreePath: string): ReviewRow[] {
    return this.db
      .prepare('SELECT * FROM reviews WHERE worktree_path = ? ORDER BY seq DESC')
      .all(worktreePath) as ReviewRow[];
  }

  get(id: string): ReviewRow | undefined {
    return this.db.prepare('SELECT * FROM reviews WHERE id = ?').get(id) as ReviewRow | undefined;
  }

  open(worktreePath: string): ReviewRow | undefined {
    return this.db
      .prepare("SELECT * FROM reviews WHERE worktree_path = ? AND state = 'open' ORDER BY seq DESC LIMIT 1")
      .get(worktreePath) as ReviewRow | undefined;
  }

  nextSeq(worktreePath: string): number {
    const row = this.db.prepare('SELECT MAX(seq) AS top FROM reviews WHERE worktree_path = ?').get(worktreePath) as {
      top: number | null;
    };
    return (row.top ?? 0) + 1;
  }

  insert(row: ReviewRow): void {
    this.db
      .prepare(
        `INSERT INTO reviews (id, worktree_path, project_path, seq, base, branch, state, summary, snapshot_ref, created_at, submitted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.worktree_path,
        row.project_path,
        row.seq,
        row.base,
        row.branch,
        row.state,
        row.summary,
        row.snapshot_ref,
        row.created_at,
        row.submitted_at,
      );
  }

  submit(id: string, state: 'accepted' | 'changes_requested', summary: string | null, at: string): void {
    this.db
      .prepare("UPDATE reviews SET state = ?, summary = ?, submitted_at = ? WHERE id = ? AND state = 'open'")
      .run(state, summary, at, id);
  }

  setBase(id: string, base: string | null): void {
    this.db.prepare('UPDATE reviews SET base = ? WHERE id = ?').run(base, id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM reviews WHERE id = ?').run(id);
  }

  deleteForWorktree(worktreePath: string): void {
    this.db.prepare('DELETE FROM reviews WHERE worktree_path = ?').run(worktreePath);
  }

  viewedFiles(reviewId: string): string[] {
    return (
      this.db.prepare('SELECT path FROM review_viewed_files WHERE review_id = ? ORDER BY path').all(reviewId) as {
        path: string;
      }[]
    ).map((r) => r.path);
  }

  setViewed(reviewId: string, filePath: string, viewed: boolean, at: string): void {
    if (viewed) {
      this.db
        .prepare(
          `INSERT INTO review_viewed_files (review_id, path, viewed_at) VALUES (?, ?, ?)
           ON CONFLICT(review_id, path) DO UPDATE SET viewed_at = excluded.viewed_at`,
        )
        .run(reviewId, filePath, at);
      return;
    }
    this.db.prepare('DELETE FROM review_viewed_files WHERE review_id = ? AND path = ?').run(reviewId, filePath);
  }
}
