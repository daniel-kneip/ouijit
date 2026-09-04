import { describe, test, expect } from 'vitest';
import { buildTaskWorkspace } from '../taskWorkspace';
import { getChainColor, getChainHex } from '../utils/taskChain';

describe('task workspace file', () => {
  test('names the window after the ticket and paints it in the task colour', () => {
    const workspace = buildTaskWorkspace({
      taskNumber: 42,
      name: 'Kiro harness',
      worktreePath: '/wt/kiro-harness-42',
      color: '#df9090',
    }) as {
      folders: { name: string; path: string }[];
      settings: Record<string, unknown> & { 'workbench.colorCustomizations': Record<string, string> };
    };

    expect(workspace.folders).toEqual([{ name: '#42 Kiro harness', path: '/wt/kiro-harness-42' }]);
    expect(workspace.settings['window.title']).toMatch(/^#42 Kiro harness\$\{separator\}/);
    const colours = workspace.settings['workbench.colorCustomizations'];
    expect(colours['titleBar.activeBackground']).toBe('#df9090');
    expect(colours['statusBar.background']).toBe('#df9090');
    // A light task colour gets dark text; a deep chain colour gets white.
    expect(colours['titleBar.activeForeground']).toBe('#1f2a22');
    const deep = buildTaskWorkspace({ taskNumber: 9, name: 'x', worktreePath: '/wt/x-9', color: '#763232' }) as {
      settings: { 'workbench.colorCustomizations': Record<string, string> };
    };
    expect(deep.settings['workbench.colorCustomizations']['statusBar.foreground']).toBe('#ffffff');
  });

  test('the hex colour is the same hue and lightness the app shows', () => {
    expect(getChainColor(0, 0)).toBe('hsl(0, 55%, 72%)');
    expect(getChainHex(0, 0)).toBe('#df9090');
    expect(getChainHex(7, 3)).toMatch(/^#[0-9a-f]{6}$/);
  });
});
