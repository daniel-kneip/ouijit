import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Review, ReviewState, ReviewWithComments } from '../../reviews';
import { useProjectStore } from '../../stores/projectStore';
import { describeError } from '../../utils/describeError';

/**
 * The review a worktree is under, the files it has been through, and the
 * reviews it has been through before.
 *
 * All of it comes from the database, so which files have been read survives the
 * panel closing, the window changing and the app restarting — the one thing
 * local state could not do.
 */
export function useReview(worktreePath: string, projectPath: string, base: string | null, branch: string | null) {
  const [review, setReview] = useState<ReviewWithComments | null>(null);
  const [viewed, setViewed] = useState<ReadonlySet<string>>(new Set());
  const [past, setPast] = useState<Review[]>([]);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [open, all] = await Promise.all([
        window.api.reviews.current(worktreePath),
        window.api.reviews.list(worktreePath),
      ]);
      setReview(open);
      setPast(all.filter((r) => r.state !== 'open'));
      setViewed(new Set(open ? await window.api.reviews.viewed(open.id) : []));
    } catch {
      // The diff is still readable without them.
      setReview(null);
      setPast([]);
      setViewed(new Set());
    }
  }, [worktreePath]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // What the reader is looking at is part of the hand-over, and they can change
  // it after opening the review.
  const id = review?.id;
  useEffect(() => {
    if (id) void window.api.reviews.retarget(id, base);
  }, [id, base]);

  const run = useCallback(
    async (verb: string, write: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await write();
      } catch (error) {
        useProjectStore.getState().addToast(`Could not ${verb}: ${describeError(error)}`, 'error');
        return false;
      } finally {
        setBusy(false);
      }
      await reload();
      return true;
    },
    [reload],
  );

  const start = useCallback(
    () => run('start the review', () => window.api.reviews.start({ worktreePath, projectPath, base, branch })),
    [run, worktreePath, projectPath, base, branch],
  );

  const handOver = useCallback(
    (state: Exclude<ReviewState, 'open'>, summary: string | null) =>
      run('hand the review over', async () => {
        if (id) await window.api.reviews.handOver(id, state, summary);
      }),
    [run, id],
  );

  const abandon = useCallback(
    () =>
      run('drop the review', async () => {
        if (id) await window.api.reviews.abandon(id);
      }),
    [run, id],
  );

  /** Optimistic: the mark is what folding a file looks like, and must not lag it. */
  const markViewed = useCallback(
    (path: string, next: boolean) => {
      if (!id) return;
      setViewed((prev) => {
        const all = new Set(prev);
        if (next) all.add(path);
        else all.delete(path);
        return all;
      });
      void window.api.reviews.markViewed(id, path, next);
    },
    [id],
  );

  return useMemo(
    () => ({ review, viewed, past, busy, start, handOver, abandon, markViewed, reload }),
    [review, viewed, past, busy, start, handOver, abandon, markViewed, reload],
  );
}

export type ReviewSession = ReturnType<typeof useReview>;
