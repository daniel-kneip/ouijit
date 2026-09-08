import { describe, test, expect, beforeEach } from 'vitest';
import {
  addTaskComment,
  createTask,
  deleteTaskByNumber,
  deleteTaskComment,
  getTaskComments,
  setTaskArchived,
  updateTaskComment,
} from '../db';

const PROJECT = '/test/task-comments';

describe('task comments', () => {
  beforeEach(async () => {
    await createTask(PROJECT, 1, 'first');
    await createTask(PROJECT, 2, 'second');
  });

  test('a comment lives with its task: added, edited, deleted, and gone when the task goes', async () => {
    expect((await addTaskComment(PROJECT, 1, '   ')).success).toBe(false);
    expect((await addTaskComment(PROJECT, 9, 'nobody home')).success).toBe(false);

    const first = await addTaskComment(PROJECT, 1, '  waiting on ops  ');
    expect(first.comment).toMatchObject({ taskNumber: 1, body: 'waiting on ops' });
    expect(first.comment?.author).toBeUndefined();
    const byAgent = await addTaskComment(PROJECT, 1, 'tests are red', 'kiro');
    expect(byAgent.comment?.author).toBe('kiro');
    await addTaskComment(PROJECT, 2, 'other task');

    let comments = await getTaskComments(PROJECT);
    expect(comments.map((c) => [c.taskNumber, c.body])).toEqual([
      [1, 'waiting on ops'],
      [1, 'tests are red'],
      [2, 'other task'],
    ]);

    expect((await updateTaskComment(PROJECT, first.comment!.id, 'waiting on ops, asked twice')).success).toBe(true);
    expect((await updateTaskComment(PROJECT, 999, 'x')).success).toBe(false);
    comments = await getTaskComments(PROJECT);
    expect(comments[0].body).toBe('waiting on ops, asked twice');
    expect(comments[0].updatedAt).toBeTruthy();
    expect(comments[1].updatedAt).toBeUndefined();

    expect((await deleteTaskComment(PROJECT, byAgent.comment!.id)).success).toBe(true);
    expect((await deleteTaskComment(PROJECT, byAgent.comment!.id)).success).toBe(false);

    // Archiving keeps the comments; deleting the task takes them along.
    await setTaskArchived(PROJECT, 1, true);
    expect((await getTaskComments(PROJECT)).filter((c) => c.taskNumber === 1)).toHaveLength(1);
    await deleteTaskByNumber(PROJECT, 1);
    expect((await getTaskComments(PROJECT)).map((c) => c.taskNumber)).toEqual([2]);
  });
});
