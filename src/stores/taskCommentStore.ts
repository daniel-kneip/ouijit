import { create } from 'zustand';
import type { TaskComment } from '../types';

interface TaskCommentStore {
  projectPath: string | null;
  byTask: Record<number, TaskComment[]>;
  load: (projectPath: string) => Promise<void>;
  add: (projectPath: string, taskNumber: number, body: string) => Promise<{ success: boolean; error?: string }>;
  update: (projectPath: string, id: number, body: string) => Promise<{ success: boolean; error?: string }>;
  remove: (projectPath: string, id: number) => Promise<{ success: boolean; error?: string }>;
}

const EMPTY: TaskComment[] = [];

function groupByTask(comments: TaskComment[]): Record<number, TaskComment[]> {
  const byTask: Record<number, TaskComment[]> = {};
  for (const comment of comments) (byTask[comment.taskNumber] ??= []).push(comment);
  return byTask;
}

let loadVersion = 0;

export const useTaskCommentStore = create<TaskCommentStore>()((set, get) => ({
  projectPath: null,
  byTask: {},

  load: async (projectPath) => {
    const version = ++loadVersion;
    const comments = await window.api.task.comments(projectPath);
    if (version !== loadVersion) return;
    set({ projectPath, byTask: groupByTask(comments) });
  },

  add: async (projectPath, taskNumber, body) => {
    const result = await window.api.task.addComment(projectPath, taskNumber, body);
    if (result.success) await get().load(projectPath);
    return result;
  },

  update: async (projectPath, id, body) => {
    const result = await window.api.task.updateComment(projectPath, id, body);
    if (result.success) await get().load(projectPath);
    return result;
  },

  remove: async (projectPath, id) => {
    const result = await window.api.task.deleteComment(projectPath, id);
    if (result.success) await get().load(projectPath);
    return result;
  },
}));

export function selectTaskComments(taskNumber: number) {
  return (s: TaskCommentStore): TaskComment[] => s.byTask[taskNumber] ?? EMPTY;
}

/** The newest comment on a task, the one a glance at the board or map should show. */
export function latestComment(comments: TaskComment[]): TaskComment | undefined {
  return comments[comments.length - 1];
}
