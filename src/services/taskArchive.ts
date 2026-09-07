/**
 * Archiving takes a task off the board and the map and keeps everything
 * else; deleting removes its worktree, branch and record for good, so it
 * asks first and closes the task's terminals before the worktree goes.
 */

import { closeProjectTerminal } from '../components/terminal/terminalActions';
import { useProjectStore } from '../stores/projectStore';
import { useTerminalStore } from '../stores/terminalStore';

function plural(count: number): string {
  return count === 1 ? 'task' : `${count} tasks`;
}

export async function archiveTasks(projectPath: string, taskNumbers: number[]): Promise<void> {
  const results = await Promise.all(taskNumbers.map((n) => window.api.task.archive(projectPath, n)));
  const store = useProjectStore.getState();
  store.clearSelection();
  await store.loadTasksIfActive(projectPath);
  const failed = results.filter((r) => !r.success);
  if (failed.length) store.addToast(failed[0].error ?? 'Could not archive the task', 'error');
  else store.addToast(`Archived ${plural(taskNumbers.length)}`, 'success');
}

export async function restoreTasks(projectPath: string, taskNumbers: number[]): Promise<void> {
  await Promise.all(taskNumbers.map((n) => window.api.task.unarchive(projectPath, n)));
  const store = useProjectStore.getState();
  await store.loadTasksIfActive(projectPath);
  store.addToast(`Restored ${plural(taskNumbers.length)} to the board`, 'success');
}

/** Asks before anything is removed; the removal itself is `deleteTasksNow`. */
export function deleteTasks(projectPath: string, taskNumbers: number[]): void {
  useProjectStore.getState().addToast(`Delete ${plural(taskNumbers.length)}? The worktree and branch go too.`, {
    type: 'info',
    persistent: true,
    actionLabel: 'Delete',
    onAction: () => void deleteTasksNow(projectPath, taskNumbers),
  });
}

export async function deleteTasksNow(projectPath: string, taskNumbers: number[]): Promise<void> {
  const terminals = useTerminalStore.getState();
  for (const ptyId of terminals.terminalsByProject[projectPath] ?? []) {
    const taskId = terminals.displayStates[ptyId]?.taskId;
    if (taskId != null && taskNumbers.includes(taskId)) closeProjectTerminal(ptyId);
  }
  const results = await Promise.all(taskNumbers.map((n) => window.api.task.delete(projectPath, n)));
  const store = useProjectStore.getState();
  store.clearSelection();
  await store.loadTasksIfActive(projectPath);
  const failed = results.filter((r) => !r.success);
  if (failed.length) store.addToast(failed[0].error ?? 'Could not delete the task', 'error');
  else store.addToast(`Deleted ${plural(taskNumbers.length)}`, 'success');
}
