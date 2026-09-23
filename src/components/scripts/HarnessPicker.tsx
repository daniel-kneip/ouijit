import { useEffect, useState } from 'react';
import type { Harness } from '../../types';
import { useAppStore } from '../../stores/appStore';
import { useProjectStore } from '../../stores/projectStore';

interface HarnessPickerProps {
  projectPath: string;
}

/** Which harness fills in the hooks this project leaves unset. */
export function HarnessPicker({ projectPath }: HarnessPickerProps) {
  const harnessId = useAppStore((s) => s.projects.find((p) => p.path === projectPath)?.harnessId);
  const [harnesses, setHarnesses] = useState<Harness[]>([]);

  useEffect(() => {
    void window.api.harness.list().then(setHarnesses);
  }, []);

  const select = async (next: string | null) => {
    await window.api.harness.setForProject(projectPath, next);
    const refreshed = await window.api.refreshProjects();
    useAppStore.getState().setProjects(refreshed);
    void useProjectStore.getState().loadProjectConfig(projectPath);
  };

  return (
    <div
      className="glass-bevel relative border border-bezel rounded-[14px] overflow-hidden"
      style={{ background: 'var(--color-terminal-bg)' }}
    >
      <div className="flex items-center gap-3 px-3 py-2">
        <div className="flex-1 min-w-0">
          <span className="text-xs font-medium text-text-primary">Harness</span>
          <span className="ml-2 text-[11px] text-text-tertiary">
            {harnesses.length === 0 ? 'None defined yet' : 'Fills in every hook this project leaves unset'}
          </span>
        </div>
        <select
          className="shrink-0 text-xs bg-transparent border border-border rounded-md px-2 py-1 text-text-primary outline-none focus:border-accent"
          value={harnessId ?? ''}
          onChange={(e) => void select(e.target.value || null)}
          aria-label="Harness"
        >
          <option value="">Project hooks only</option>
          {harnesses.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="shrink-0 px-2 py-1 text-[11px] bg-transparent border-none text-text-tertiary hover:text-text-primary transition-colors duration-150"
          onClick={() => useAppStore.getState().navigateHome({ panel: 'settings', direction: 'up' })}
        >
          Manage…
        </button>
      </div>
    </div>
  );
}
