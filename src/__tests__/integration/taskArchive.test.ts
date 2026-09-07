/**
 * Archiving hides a task and keeps everything it owns; deleting removes the
 * task with its worktree and branch. Runs against a real git repo.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { createTask, getTaskByNumber, _resetCacheForTesting } from '../../db';
import { getWorktreeBaseDir } from '../../worktree';
import {
  archiveTask,
  deleteTaskWithWorktree,
  getArchivedTasksWithWorkspaces,
  getTasksWithWorkspaces,
  unarchiveTask,
} from '../../taskLifecycle';

let tmpDir: string;
let repoDir: string;
let worktreeDir: string;

function branches(): string[] {
  return execSync("git branch --format='%(refname:short)'", { cwd: repoDir, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

beforeEach(async () => {
  _resetCacheForTesting();
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ouijit-archive-'));
  repoDir = path.join(tmpDir, `archive-${path.basename(tmpDir)}`);
  await fsp.mkdir(repoDir, { recursive: true });
  execSync('git init -b main', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  execSync('git commit --allow-empty -m "Initial commit"', { cwd: repoDir });
  // `listWorktrees` only reports worktrees under the managed directory.
  worktreeDir = path.join(getWorktreeBaseDir(path.basename(repoDir)), 'ship-it-1');
  await fsp.mkdir(path.dirname(worktreeDir), { recursive: true });
  execSync(`git worktree add -b ship-it-1 "${worktreeDir}"`, { cwd: repoDir });
  await createTask(repoDir, 1, 'Ship it', { branch: 'ship-it-1', worktreePath: worktreeDir });
  await createTask(repoDir, 2, 'Follow-up', { status: 'todo', parentTaskNumber: 1 });
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.rm(getWorktreeBaseDir(path.basename(repoDir)), { recursive: true, force: true });
});

describe('archive and delete', () => {
  test('an archived task leaves the board with its worktree and branch intact, and comes back as it was', async () => {
    expect((await archiveTask(repoDir, 1)).success).toBe(true);

    expect((await getTasksWithWorkspaces(repoDir)).map((t) => t.taskNumber)).toEqual([2]);
    const archived = await getArchivedTasksWithWorkspaces(repoDir);
    expect(archived.map((t) => t.taskNumber)).toEqual([1]);
    expect(archived[0].archivedAt).toBeTruthy();
    expect(archived[0].worktreePath).toBe(worktreeDir);
    expect(fs.existsSync(worktreeDir)).toBe(true);
    expect(branches()).toContain('ship-it-1');
    // The child keeps its parent: nothing about the chain changed.
    expect((await getTaskByNumber(repoDir, 2))?.parentTaskNumber).toBe(1);

    expect((await unarchiveTask(repoDir, 1)).success).toBe(true);
    expect((await getTasksWithWorkspaces(repoDir)).map((t) => t.taskNumber).sort()).toEqual([1, 2]);
    expect(await getArchivedTasksWithWorkspaces(repoDir)).toEqual([]);
    expect((await getTaskByNumber(repoDir, 1))?.archivedAt).toBeUndefined();

    expect((await archiveTask(repoDir, 99)).success).toBe(false);
  });

  test('deleting removes the worktree, the branch and the record, and detaches the children', async () => {
    const result = await deleteTaskWithWorktree(repoDir, 1);
    expect(result.success).toBe(true);

    expect(fs.existsSync(worktreeDir)).toBe(false);
    expect(branches()).not.toContain('ship-it-1');
    expect(execSync('git worktree list', { cwd: repoDir, encoding: 'utf8' })).not.toContain('ship-it-1');
    expect(await getTaskByNumber(repoDir, 1)).toBeNull();
    expect((await getTaskByNumber(repoDir, 2))?.parentTaskNumber).toBeUndefined();
  });
});
