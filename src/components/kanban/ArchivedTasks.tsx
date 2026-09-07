import { useState } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { deleteTasks, restoreTasks } from '../../services/taskArchive';
import { formatRelativeTime } from '../../utils/formatDate';
import { Icon } from '../terminal/Icon';
import { STATUS_LABELS } from './taskMenu';

interface ArchivedTaskListProps {
  projectPath: string;
}

/** The project's archived tasks, each with a way back to the board and a way out for good. */
export function ArchivedTaskList({ projectPath }: ArchivedTaskListProps) {
  const archived = useProjectStore((s) => s.archivedTasks);
  return (
    <ul className="flex flex-col gap-0.5" data-testid="archived-tasks">
      {archived.map((task) => (
        <li
          key={task.taskNumber}
          data-testid={`archived-row-${task.taskNumber}`}
          className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-ink/[0.04] text-xs"
        >
          <span className="min-w-0">
            <span className="block truncate font-medium text-text-primary">
              {task.name}
              <span className="ml-1.5 font-mono text-[10px] text-text-tertiary">#{task.taskNumber}</span>
            </span>
            <span className="block text-[11px] text-text-tertiary">
              {STATUS_LABELS[task.status]}
              {task.archivedAt && ` · archived ${formatRelativeTime(new Date(task.archivedAt))}`}
            </span>
          </span>
          <span className="flex items-center gap-1">
            <button
              type="button"
              className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-ink/[0.08] [&>svg]:w-3.5 [&>svg]:h-3.5"
              aria-label={`Restore #${task.taskNumber}`}
              title="Restore to the board"
              onClick={() => void restoreTasks(projectPath, [task.taskNumber])}
            >
              <Icon name="arrow-counter-clockwise" />
            </button>
            <button
              type="button"
              className="p-1 rounded-md text-text-tertiary hover:text-error hover:bg-error/10 [&>svg]:w-3.5 [&>svg]:h-3.5"
              aria-label={`Delete #${task.taskNumber}`}
              title="Delete with worktree and branch"
              onClick={() => deleteTasks(projectPath, [task.taskNumber])}
            >
              <Icon name="trash" />
            </button>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A ledge under the board that opens into the archive; hidden while it is empty. */
export function KanbanArchive({ projectPath }: ArchivedTaskListProps) {
  const count = useProjectStore((s) => s.archivedTasks.length);
  const [open, setOpen] = useState(false);
  if (count === 0) return null;
  return (
    <div className="pane-ledge-under relative z-10 shrink-0 flex flex-col">
      <button
        type="button"
        className="flex items-center gap-1.5 px-3 py-2 text-text-tertiary hover:text-text-primary [&>svg]:w-3.5 [&>svg]:h-3.5"
        aria-expanded={open}
        data-testid="kanban-archive-toggle"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="archive" />
        <span className="font-mono text-[11px] uppercase tracking-wide">Archive</span>
        <span className="font-mono text-[11px]">{count}</span>
        <Icon name={open ? 'caret-down' : 'caret-up'} />
      </button>
      {open && (
        <div className="px-1 pb-2 max-h-[40vh] overflow-y-auto">
          <ArchivedTaskList projectPath={projectPath} />
        </div>
      )}
    </div>
  );
}
