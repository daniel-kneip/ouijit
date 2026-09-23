/**
 * A review of a worktree's diff: what was looked at, what was written on it and
 * how it was handed back. Free of node and React, so the renderer, the main
 * process and the agent-facing formatter all read the same shape.
 */

import { formatNoteBlock, type DiffNote } from './diffNotes';

export type ReviewState = 'open' | 'accepted' | 'changes_requested';

export interface Review {
  id: string;
  worktreePath: string;
  projectPath: string;
  /** Counts from 1 per worktree; what the panel and the agent call it. */
  seq: number;
  /** The comparison it was opened on, for the heading the agent is handed. */
  base: string | null;
  branch: string | null;
  state: ReviewState;
  /** What was typed when handing it over, if anything. */
  summary: string | null;
  /**
   * The ref pinning the worktree as it stood when the review opened, so a later
   * diff can be taken against what was actually reviewed. Null where the
   * snapshot could not be written — an empty repository has no commit to hang
   * one off.
   */
  snapshotRef: string | null;
  createdAt: string;
  submittedAt: string | null;
}

export interface ReviewWithComments extends Review {
  comments: DiffNote[];
}

export interface StartReviewInput {
  worktreePath: string;
  projectPath: string;
  base: string | null;
  branch: string | null;
}

/**
 * A review's snapshot lives under `refs/ouijit/review/<seq>/<id>`: git's ref
 * store is a filesystem, so the id goes in a directory named for the sequence
 * rather than beside it, where two worktrees' review 2 would be the same file.
 */
export function reviewSnapshotRef(seq: number, id: string): string {
  return `refs/ouijit/review/${seq}/${id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)}`;
}

const SNAPSHOT_REF = /^refs\/ouijit\/review\/(\d+)\/[a-zA-Z0-9]+$/;

/** Which review a base pins the diff to, or null for an ordinary ref. */
export function reviewSeqOfBase(base: string | null): number | null {
  const found = base ? SNAPSHOT_REF.exec(base) : null;
  return found ? Number(found[1]) : null;
}

export const REVIEW_VERDICT: Record<Exclude<ReviewState, 'open'>, string> = {
  accepted: 'Accepted',
  changes_requested: 'Changes requested',
};

/**
 * The review as the block of text an agent acts on: the verdict, what was
 * typed with it, and every comment as `path:line` over the quoted source.
 *
 * No trailing newline — in a TUI that is the Enter key.
 */
export function formatReviewForAgent(review: ReviewWithComments, subject: string): string {
  const verdict = review.state === 'open' ? 'In progress' : REVIEW_VERDICT[review.state];
  const head = `Review ${review.seq} on ${subject}: ${verdict}.`;
  const count =
    review.comments.length === 0
      ? 'No comments on the code.'
      : `${review.comments.length} comment${review.comments.length === 1 ? '' : 's'}:`;

  return [head, review.summary?.trim() || null, count, ...review.comments.map(formatNoteBlock)]
    .filter(Boolean)
    .join('\n\n');
}
