import { typedHandle } from '../helpers';
import { saveAttachment } from '../../attachments';
import { createTaskWorktree, createTodoTask, checkTaskWorktree, recoverTaskWorktree } from '../../worktree';
import {
  addTaskComment,
  deleteTaskComment,
  getTaskComments,
  setTaskMergeTarget,
  setTaskName,
  setTaskParent,
  updateTaskComment,
} from '../../db';
import { writeTaskWorkspace } from '../../taskWorkspace';
import {
  beginTask,
  setTaskStatusWithHooks,
  reorderTaskWithHooks,
  deleteTaskWithWorktree,
  archiveTask,
  unarchiveTask,
  getTasksWithWorkspaces,
  getArchivedTasksWithWorkspaces,
  getTaskWithWorkspace,
  createBranchFromTask,
  updateTaskDescription,
} from '../../taskLifecycle';

export function registerTaskHandlers(): void {
  typedHandle('task:create', (projectPath, name, prompt) => createTodoTask(projectPath, name, prompt));

  typedHandle('task:create-and-start', (projectPath, name, prompt, branchName) =>
    createTaskWorktree(projectPath, name, prompt, branchName),
  );

  typedHandle('task:start', (projectPath, taskNumber, branchName) => beginTask(projectPath, taskNumber, branchName));

  typedHandle('task:get-all', (projectPath) => getTasksWithWorkspaces(projectPath));
  typedHandle('task:get-by-number', (projectPath, taskNumber) => getTaskWithWorkspace(projectPath, taskNumber));

  typedHandle('task:set-status', (projectPath, taskNumber, status) =>
    setTaskStatusWithHooks(projectPath, taskNumber, status),
  );

  typedHandle('task:delete', (projectPath, taskNumber) => deleteTaskWithWorktree(projectPath, taskNumber));

  typedHandle('task:archive', (projectPath, taskNumber) => archiveTask(projectPath, taskNumber));

  typedHandle('task:unarchive', (projectPath, taskNumber) => unarchiveTask(projectPath, taskNumber));

  typedHandle('task:get-archived', (projectPath) => getArchivedTasksWithWorkspaces(projectPath));

  typedHandle('task:comments', (projectPath) => getTaskComments(projectPath));

  typedHandle('task:comment-add', (projectPath, taskNumber, body) => addTaskComment(projectPath, taskNumber, body));

  typedHandle('task:comment-update', (projectPath, id, body) => updateTaskComment(projectPath, id, body));

  typedHandle('task:comment-delete', (projectPath, id) => deleteTaskComment(projectPath, id));

  typedHandle('task:set-merge-target', (projectPath, taskNumber, mergeTarget) =>
    setTaskMergeTarget(projectPath, taskNumber, mergeTarget),
  );

  typedHandle('task:set-name', (projectPath, taskNumber, name) => setTaskName(projectPath, taskNumber, name));

  typedHandle('task:workspace-file', (projectPath, taskNumber, worktreePath) =>
    writeTaskWorkspace(projectPath, taskNumber, worktreePath),
  );

  typedHandle('task:set-description', (projectPath, taskNumber, description) =>
    updateTaskDescription(projectPath, taskNumber, description),
  );

  typedHandle('task:reorder', (projectPath, taskNumber, newStatus, targetIndex) =>
    reorderTaskWithHooks(projectPath, taskNumber, newStatus, targetIndex),
  );

  typedHandle('task:check-worktree', (projectPath, taskNumber) => checkTaskWorktree(projectPath, taskNumber));

  typedHandle('task:recover', (projectPath, taskNumber) => recoverTaskWorktree(projectPath, taskNumber));

  typedHandle('task:create-from-task', (projectPath, parentTaskNumber, name) =>
    createBranchFromTask(projectPath, parentTaskNumber, name),
  );

  typedHandle('task:set-parent', (projectPath, taskNumber, parentTaskNumber, mergeTarget) =>
    setTaskParent(projectPath, taskNumber, parentTaskNumber, mergeTarget),
  );

  typedHandle('task:save-attachment', (data, ext) => saveAttachment(data, ext));
}
