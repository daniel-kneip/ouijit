/**
 * The archive list is the way back for an archived task and the way out for
 * good; deleting asks first, and closes the task's terminals before the
 * worktree goes.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, screen, waitFor } from '@testing-library/react';
import { useAppStore } from '../../stores/appStore';
import { useProjectStore } from '../../stores/projectStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { KanbanArchive } from '../../components/kanban/ArchivedTasks';
import { closeProjectTerminal } from '../../components/terminal/terminalActions';
import { archiveTasks } from '../../services/taskArchive';
import type { TaskWithWorkspace } from '../../types';

vi.mock('electron-log/renderer', () => ({
  default: { scope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));
vi.mock('../../components/terminal/terminalActions', () => ({
  closeProjectTerminal: vi.fn(),
}));

const PROJECT = '/project';

function task(taskNumber: number, extra: Partial<TaskWithWorkspace> = {}): TaskWithWorkspace {
  return {
    taskNumber,
    name: `Task ${taskNumber}`,
    status: 'done',
    order: 0,
    createdAt: '2026-01-01T00:00:00Z',
    ...extra,
  };
}

describe('archived tasks', () => {
  beforeEach(() => {
    useAppStore.setState({ activeProjectPath: PROJECT });
    useProjectStore.getState().resetForProject();
    useProjectStore.setState({ toasts: [] });
    useTerminalStore.setState({ displayStates: {}, terminalsByProject: {}, activeIndices: {} });
    vi.clearAllMocks();
  });

  test('archiving reloads both lists, the strip lists the archive, restore and delete go through the api', async () => {
    const api = window.api.task;
    const live = [task(1, { status: 'in_progress' }), task(2)];
    const archived = [task(3, { archivedAt: '2026-01-05T00:00:00Z' })];
    vi.mocked(api.getAll).mockResolvedValue(live);
    vi.mocked(api.getArchived).mockResolvedValue(archived);
    useProjectStore.setState({ tasks: [...live, ...archived] });

    const { container } = render(<KanbanArchive projectPath={PROJECT} />);
    expect(container.firstChild).toBeNull();

    await archiveTasks(PROJECT, [3]);
    expect(api.archive).toHaveBeenCalledWith(PROJECT, 3);
    expect(useProjectStore.getState().tasks.map((t) => t.taskNumber)).toEqual([1, 2]);
    expect(useProjectStore.getState().archivedTasks.map((t) => t.taskNumber)).toEqual([3]);

    fireEvent.click(await screen.findByTestId('kanban-archive-toggle'));
    const row = screen.getByTestId('archived-row-3');
    expect(row.textContent).toContain('Task 3');
    expect(row.textContent).toContain('Done');

    fireEvent.click(screen.getByRole('button', { name: 'Restore #3' }));
    await waitFor(() => expect(api.unarchive).toHaveBeenCalledWith(PROJECT, 3));

    useTerminalStore.getState().addTerminal(PROJECT, 'pty-3', { taskId: 3, label: 'agent' });
    useTerminalStore.getState().addTerminal(PROJECT, 'pty-1', { taskId: 1, label: 'other' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete #3' }));
    expect(api.delete).not.toHaveBeenCalled();
    const confirm = useProjectStore.getState().toasts.find((t) => t.actionLabel === 'Delete');
    expect(confirm?.message).toContain('worktree and branch');
    confirm!.onAction!();
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith(PROJECT, 3));
    expect(closeProjectTerminal).toHaveBeenCalledWith('pty-3');
    expect(closeProjectTerminal).not.toHaveBeenCalledWith('pty-1');
  });
});
