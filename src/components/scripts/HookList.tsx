import { useState, useCallback, useEffect } from 'react';
import type { Harness, HookType, ScriptHook } from '../../types';
import { HookConfigDialog } from '../dialogs/HookConfigDialog';
import { HookRowView } from './HookRowView';
import { useProjectStore } from '../../stores/projectStore';
import { useAppStore } from '../../stores/appStore';

export interface HookEntry {
  type: HookType;
  label: string;
  description: string;
}

interface HookListProps {
  projectPath: string;
  hooks: HookEntry[];
  /** Render rows without the card wrapper (for embedding in a shared card) */
  bare?: boolean;
}

export function HookList({ projectPath, hooks: hookEntries, bare }: HookListProps) {
  const [hooks, setHooks] = useState<Record<string, ScriptHook | undefined>>({});
  const [editingHook, setEditingHook] = useState<{ hookType: HookType; existing?: ScriptHook } | null>(null);
  const harnessId = useAppStore((s) => s.projects.find((p) => p.path === projectPath)?.harnessId);
  const [harness, setHarness] = useState<Harness | null>(null);

  const loadHooks = useCallback(() => {
    window.api.hooks.get(projectPath).then((h) => {
      setHooks(h as Record<string, ScriptHook | undefined>);
    });
  }, [projectPath]);

  // The harness assignment lives on the project row, so a change to it is a
  // change to which hooks resolve here.
  useEffect(() => {
    loadHooks();
    if (!harnessId) {
      setHarness(null);
      return;
    }
    void window.api.harness.list().then((all) => setHarness(all.find((h) => h.id === harnessId) ?? null));
  }, [loadHooks, harnessId]);

  // The hook rows are local state (the store only tracks which types are
  // configured), so a `ouijit hook set` while this panel is open needs its own
  // re-read to avoid showing the old command.
  useEffect(() => {
    return window.api.onCliChange((payload) => {
      if (payload.resource === 'hooks' && payload.project === projectPath) loadHooks();
    });
  }, [loadHooks, projectPath]);

  const handleDialogClose = useCallback(
    (result: { saved: boolean } | null) => {
      setEditingHook(null);
      if (result?.saved) {
        loadHooks();
        // Keep the shared projectStore in sync so terminal headers and kanban
        // column badges see the new hook without a stale window.
        useProjectStore.getState().loadProjectConfig(projectPath);
      }
    },
    [loadHooks, projectPath],
  );

  const rows = hookEntries.map(({ type, label, description }) => {
    const hook = hooks[type];
    const inherited = hook?.source === 'harness';
    return (
      <HookRowView
        key={type}
        label={label}
        description={inherited && harness ? `${description} · from ${harness.name}` : description}
        command={hook?.command}
        actionLabel={inherited ? 'Override' : undefined}
        onAction={() => setEditingHook({ hookType: type, existing: hook })}
      />
    );
  });

  return (
    <>
      {bare ? (
        rows
      ) : (
        <div
          className="glass-bevel relative border border-bezel rounded-[14px] overflow-hidden divide-y divide-separator"
          style={{
            background: 'var(--color-terminal-bg)',
          }}
        >
          {rows}
        </div>
      )}
      {editingHook && (
        <HookConfigDialog
          projectPath={projectPath}
          hookType={editingHook.hookType}
          existingHook={editingHook.existing}
          inheritedFrom={editingHook.existing?.source === 'harness' ? harness?.name : undefined}
          onClose={handleDialogClose}
        />
      )}
    </>
  );
}
