/**
 * Starting, marking up and handing over a review of a worktree's diff.
 *
 * Apart from `src/reviews.ts`, which the renderer imports for the type and the
 * hand-over format: this half touches the database and git, so importing it
 * there would drag both into the renderer bundle.
 */

import { randomUUID } from 'node:crypto';
import {
  adoptLooseDiffNotes,
  deleteReview,
  getOpenReview,
  getReview,
  getReviewNotes,
  getReviewViewedFiles,
  getReviews,
  insertReview,
  nextReviewSeq,
  setReviewBase,
  setReviewFileViewed,
  submitReview,
  type ReviewRow,
} from './db';
import { dropRef, pinWorktreeState } from './git';
import { toDiffNote } from './diffNotesService';
import { reviewSnapshotRef, type Review, type ReviewWithComments, type StartReviewInput } from './reviews';

function toReview(row: ReviewRow): Review {
  return {
    id: row.id,
    worktreePath: row.worktree_path,
    projectPath: row.project_path,
    seq: row.seq,
    base: row.base,
    branch: row.branch,
    state: row.state,
    summary: row.summary,
    snapshotRef: row.snapshot_ref,
    createdAt: row.created_at,
    submittedAt: row.submitted_at,
  };
}

/**
 * Opens a review and pins what it is of. A worktree has one open review at a
 * time, so starting while one is open answers with that one rather than
 * splitting the comments between two.
 */
export async function startReview(input: StartReviewInput): Promise<Review> {
  const standing = await getOpenReview(input.worktreePath);
  if (standing) return toReview(standing);

  const id = randomUUID();
  const seq = await nextReviewSeq(input.worktreePath);
  const ref = reviewSnapshotRef(seq, id);
  const pinned = await pinWorktreeState(input.worktreePath, ref);

  const row: ReviewRow = {
    id,
    worktree_path: input.worktreePath,
    project_path: input.projectPath,
    seq,
    base: input.base,
    branch: input.branch,
    state: 'open',
    summary: null,
    snapshot_ref: pinned ? ref : null,
    created_at: new Date().toISOString(),
    submitted_at: null,
  };
  await insertReview(row);
  return toReview(row);
}

/** The open review of a worktree, with the comments written on it so far. */
export async function currentReview(worktreePath: string): Promise<ReviewWithComments | null> {
  const row = await getOpenReview(worktreePath);
  return row ? withComments(row) : null;
}

export async function listReviews(worktreePath: string): Promise<Review[]> {
  return (await getReviews(worktreePath)).map(toReview);
}

/** The newest review already handed over, which is what an agent acts on. */
export async function lastSubmittedReview(worktreePath: string): Promise<ReviewWithComments | null> {
  const row = (await getReviews(worktreePath)).find((r) => r.state !== 'open');
  return row ? withComments(row) : null;
}

export async function reviewWithComments(id: string): Promise<ReviewWithComments | null> {
  const row = await getReview(id);
  return row ? withComments(row) : null;
}

async function withComments(row: ReviewRow): Promise<ReviewWithComments> {
  return { ...toReview(row), comments: (await getReviewNotes(row.id)).map(toDiffNote) };
}

export async function viewedFiles(reviewId: string): Promise<string[]> {
  return getReviewViewedFiles(reviewId);
}

export async function markFileViewed(reviewId: string, filePath: string, viewed: boolean): Promise<void> {
  await setReviewFileViewed(reviewId, filePath, viewed, new Date().toISOString());
}

/** The comparison the review is being read on, so its hand-over says what it was of. */
export async function retargetReview(reviewId: string, base: string | null): Promise<void> {
  await setReviewBase(reviewId, base);
}

/**
 * Hands the review over. Every note on the worktree that is not already part of
 * a review joins this one: what the reviewer wrote before opening it is as much
 * a part of the verdict as what they wrote after.
 */
export async function handOverReview(
  id: string,
  state: 'accepted' | 'changes_requested',
  summary: string | null,
): Promise<ReviewWithComments | null> {
  const row = await getReview(id);
  if (!row || row.state !== 'open') return null;
  await adoptLooseDiffNotes(row.worktree_path, id);
  await submitReview(id, state, summary?.trim() ? summary.trim() : null, new Date().toISOString());
  return reviewWithComments(id);
}

/**
 * Drops an open review and the state it pinned. Its comments stay: they are
 * notes on the diff, and were before the review was opened.
 */
export async function abandonReview(id: string): Promise<{ success: boolean }> {
  const row = await getReview(id);
  if (!row || row.state !== 'open') return { success: false };
  if (row.snapshot_ref) await dropRef(row.worktree_path, row.snapshot_ref);
  await deleteReview(id);
  return { success: true };
}
