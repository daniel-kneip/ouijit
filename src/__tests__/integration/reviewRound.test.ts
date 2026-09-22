/**
 * A round of review against a real repo and a real database.
 *
 * The point of a review is that the next one is smaller: it pins the worktree
 * as it stood, takes the comments written on it out of the outstanding queue,
 * and leaves the agent a verdict to fetch. None of that is visible from the
 * rows alone — a snapshot that quietly resolved to the last commit, or a
 * comment still counted as outstanding, both read as an ordinary review.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { _resetCacheForTesting } from '../../db';
import { liveNotes, saveNote } from '../../diffNotesService';
import { getGitFileStatus } from '../../git';
import { filesInDiff } from '../../diffSource';
import { formatReviewForAgent } from '../../reviews';
import { handOverReview, lastSubmittedReview, listReviews, markFileViewed, startReview } from '../../reviewService';

let tmpDir: string;
let repoDir: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim();
}

async function write(file: string, contents: string): Promise<void> {
  await fs.writeFile(path.join(repoDir, file), contents);
}

async function pathsSince(base: string): Promise<string[]> {
  const status = await getGitFileStatus(repoDir, base);
  return status ? filesInDiff(status).map((f) => f.path) : [];
}

function open() {
  return startReview({ worktreePath: repoDir, projectPath: repoDir, base: 'HEAD', branch: 'work' });
}

beforeEach(async () => {
  _resetCacheForTesting();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ouijit-review-'));
  repoDir = path.join(tmpDir, 'project');
  await fs.mkdir(repoDir, { recursive: true });

  git('init', '--initial-branch=main');
  git('config', 'user.email', 'test@test.com');
  git('config', 'user.name', 'Test');
  await write('a.ts', 'export const a = 1;\n');
  await write('b.ts', 'export const b = 1;\n');
  git('add', '.');
  git('commit', '-m', 'first');
  git('checkout', '-b', 'work');
  // The state under review: one file committed, one only saved.
  await write('a.ts', 'export const a = 2;\n');
  git('commit', '-am', 'bump a');
  await write('b.ts', 'export const b = 2;\n');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('a review round', () => {
  test('hands the comments over as a verdict and leaves the next diff smaller', async () => {
    const review = await open();
    expect(review.seq).toBe(1);

    // Opening it again is the same review: comments split over two would be
    // handed over in pieces.
    expect((await open()).id).toBe(review.id);

    await markFileViewed(review.id, 'a.ts', true);
    await saveNote({
      worktreePath: repoDir,
      path: 'b.ts',
      line: 1,
      side: 'RIGHT',
      snippet: 'export const b = 2;',
      body: 'call it something else',
    });
    expect(await liveNotes(repoDir)).toHaveLength(1);

    const handed = await handOverReview(review.id, 'changes_requested', '  nearly there  ');
    expect(handed?.state).toBe('changes_requested');
    expect(handed?.summary).toBe('nearly there');
    expect(handed?.comments.map((c) => c.body)).toEqual(['call it something else']);

    // Out of the outstanding queue: the verdict carried them, and a second
    // hand-over of the same comments would be the same review twice.
    expect(await liveNotes(repoDir)).toEqual([]);

    const agent = await lastSubmittedReview(repoDir);
    expect(formatReviewForAgent(agent!, 'the uncommitted changes')).toBe(
      [
        'Review 1 on the uncommitted changes: Changes requested.',
        'nearly there',
        '1 comment:',
        'b.ts:1\n> export const b = 2;\ncall it something else',
      ].join('\n\n'),
    );

    // The agent's next round, on top of what was reviewed: committed or not,
    // only what came after it is left to read.
    await write('b.ts', 'export const bee = 2;\n');
    git('commit', '-am', 'rename b');
    await write('c.ts', 'export const c = 3;\n');

    expect(await pathsSince('main')).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(await pathsSince(review.snapshotRef!)).toEqual(['b.ts', 'c.ts']);
  });

  test('numbers the next one after it and keeps the record', async () => {
    const first = await handOverReview((await open()).id, 'accepted', null);
    expect(first?.summary).toBeNull();

    const second = await open();
    expect(second.seq).toBe(2);
    expect(second.snapshotRef).not.toBe(first!.snapshotRef);

    const all = await listReviews(repoDir);
    expect(all.map((r) => [r.seq, r.state])).toEqual([
      [2, 'open'],
      [1, 'accepted'],
    ]);
    // The open one is not what an agent acts on.
    expect((await lastSubmittedReview(repoDir))?.seq).toBe(1);
  });
});
