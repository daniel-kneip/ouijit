import { describe, test, expect } from 'vitest';

import { buildEditorCommand } from '../components/terminal/editorCommand';

describe('buildEditorCommand', () => {
  test('appends the worktree path, single-quoted', () => {
    expect(buildEditorCommand('hx', '/wt/T-7')).toBe("hx '/wt/T-7'");
    expect(buildEditorCommand('code', '/wt/T-7')).toBe("code '/wt/T-7'");
  });

  test('quoting keeps a path with spaces as a single argument', () => {
    // Without quoting, `hx /My Worktrees/T 7` would reach the editor as two
    // args and open the wrong (or no) directory — the silent failure this fix
    // is about.
    expect(buildEditorCommand('hx', '/My Worktrees/T 7')).toBe("hx '/My Worktrees/T 7'");
  });

  test('escapes single quotes inside the path', () => {
    expect(buildEditorCommand('vim', "/wt/o'brien")).toBe("vim '/wt/o'\\''brien'");
  });

  test('preserves editor commands that carry their own flags', () => {
    expect(buildEditorCommand('code --new-window', '/wt/T-7')).toBe("code --new-window '/wt/T-7'");
  });

  test('VS Code and its forks open the task workspace file; other editors keep the worktree', () => {
    const ws = '/ws/kiro-harness-7.code-workspace';
    expect(buildEditorCommand('code', '/wt/kiro-harness-7', ws)).toBe(`code '${ws}'`);
    expect(buildEditorCommand('code --new-window', '/wt/kiro-harness-7', ws)).toBe(`code --new-window '${ws}'`);
    expect(buildEditorCommand('/usr/local/bin/cursor', '/wt/kiro-harness-7', ws)).toBe(`/usr/local/bin/cursor '${ws}'`);
    expect(buildEditorCommand('hx', '/wt/kiro-harness-7', ws)).toBe("hx '/wt/kiro-harness-7'");
    expect(buildEditorCommand('code', '/wt/kiro-harness-7')).toBe("code '/wt/kiro-harness-7'");
  });
});
