import { useCallback, useEffect, useState } from 'react';
import type { Harness, HookType, ScriptHook } from '../../types';
import { useAppStore } from '../../stores/appStore';
import { HookConfigDialog } from '../dialogs/HookConfigDialog';
import { HookRowView } from './HookRowView';
import type { HookEntry } from './HookList';

const HARNESS_HOOKS: HookEntry[] = [
  { type: 'start', label: 'Start', description: 'Runs when a task moves to In Progress' },
  { type: 'continue', label: 'Continue', description: 'Runs when reopening an In Progress task' },
  { type: 'review', label: 'Review', description: 'Runs when a task moves to In Review' },
  { type: 'done', label: 'Done', description: 'Runs when a task moves to Done' },
  { type: 'run', label: 'Run', description: "Runs from a terminal's + menu" },
  { type: 'editor', label: 'Editor', description: 'Opens the task worktree in your editor' },
];

/** The harnesses every project can pick from, each a named set of hooks. */
export function HarnessSection() {
  const [harnesses, setHarnesses] = useState<Harness[]>([]);
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState<{ harness: Harness; hookType: HookType; existing?: ScriptHook } | null>(null);
  const projects = useAppStore((s) => s.projects);

  const reload = useCallback(() => {
    void window.api.harness.list().then(setHarnesses);
  }, []);
  useEffect(reload, [reload]);

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    await window.api.harness.create(name);
    setNewName('');
    reload();
  };

  const rename = async (harness: Harness, name: string) => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === harness.name) return;
    await window.api.harness.rename(harness.id, trimmed);
    reload();
  };

  const remove = async (harness: Harness) => {
    await window.api.harness.delete(harness.id);
    // Projects that used it now resolve to their own hooks; the sidebar's
    // project rows carry the assignment.
    const refreshed = await window.api.refreshProjects();
    useAppStore.getState().setProjects(refreshed);
    reload();
  };

  return (
    <section>
      <h2 className="text-sm font-semibold text-text-primary mb-2">Harnesses</h2>
      <p className="text-xs text-text-tertiary mb-4">
        A harness is a set of hooks you define once and pick per project, such as one for Claude Code and one for Kiro.
        A project can still set any hook itself; its own hook wins over the harness's.
      </p>
      <div className="space-y-4">
        {harnesses.map((harness) => {
          const users = projects.filter((p) => p.harnessId === harness.id);
          return (
            <div
              key={harness.id}
              className="glass-bevel relative border border-bezel-panel rounded-[14px] overflow-hidden divide-y divide-separator"
              style={{ background: 'var(--color-terminal-bg)' }}
            >
              <div className="flex items-center gap-3 px-3 py-2">
                <input
                  className="flex-1 min-w-0 bg-transparent border-none outline-none text-sm font-medium text-text-primary focus:ring-0"
                  defaultValue={harness.name}
                  aria-label="Harness name"
                  onBlur={(e) => void rename(harness, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  }}
                />
                <span className="text-[11px] text-text-tertiary">
                  {users.length === 0
                    ? 'Not used yet'
                    : users.length === 1
                      ? `Used by ${users[0].name}`
                      : `Used by ${users.length} projects`}
                </span>
                <button
                  type="button"
                  className="shrink-0 px-2 py-1 text-[11px] bg-transparent border-none text-text-tertiary hover:text-error transition-colors duration-150"
                  onClick={() => void remove(harness)}
                >
                  Delete
                </button>
              </div>
              {HARNESS_HOOKS.map(({ type, label, description }) => (
                <HookRowView
                  key={type}
                  label={label}
                  description={description}
                  command={harness.hooks[type]?.command}
                  onAction={() => setEditing({ harness, hookType: type, existing: harness.hooks[type] })}
                />
              ))}
            </div>
          );
        })}
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <input
            className="flex-1 min-w-0 px-3 py-1.5 text-sm text-text-primary bg-background border border-border rounded-md outline-none focus:border-accent placeholder:text-text-tertiary"
            placeholder="New harness name, e.g. Kiro"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            aria-label="New harness name"
          />
          <button type="submit" className="btn-secondary" disabled={!newName.trim()}>
            Add harness
          </button>
        </form>
      </div>
      {editing && (
        <HookConfigDialog
          projectPath=""
          hookType={editing.hookType}
          existingHook={editing.existing}
          target={{ harnessId: editing.harness.id, harnessName: editing.harness.name }}
          onClose={(result) => {
            setEditing(null);
            if (result?.saved) reload();
          }}
        />
      )}
    </section>
  );
}
