import { describe, test, expect, beforeEach } from 'vitest';
import {
  _resetCacheForTesting,
  createHarness,
  deleteHarness,
  deleteHook,
  getHarnesses,
  getHooks,
  saveHarnessHook,
  saveHook,
  setProjectHarness,
} from '../../db';

const project = '/tmp/ouijit-harness-project';

beforeEach(() => {
  _resetCacheForTesting();
});

describe('harness hooks resolve under a project', () => {
  test('a project takes the harness hooks it has not set, keeps its own, and falls back when either goes away', async () => {
    const kiro = await createHarness('Kiro');
    await saveHarnessHook(kiro.id, {
      id: 'k-start',
      type: 'start',
      name: 'Start',
      command: 'kiro "$OUIJIT_TASK_DESCRIPTION"',
    });
    await saveHarnessHook(kiro.id, { id: 'k-editor', type: 'editor', name: 'Editor', command: 'code' });

    expect(await setProjectHarness(project, 'no-such-harness')).toEqual({ success: false });
    expect(await setProjectHarness(project, kiro.id)).toEqual({ success: true });

    let hooks = await getHooks(project);
    expect(hooks.start).toMatchObject({ command: 'kiro "$OUIJIT_TASK_DESCRIPTION"', source: 'harness' });
    expect(hooks.editor).toMatchObject({ command: 'code', source: 'harness' });
    expect(hooks.review).toBeUndefined();

    await saveHook(project, { id: 'p-start', type: 'start', name: 'Start', command: 'claude' });
    hooks = await getHooks(project);
    expect(hooks.start).toMatchObject({ command: 'claude', source: 'project' });
    expect(hooks.editor).toMatchObject({ command: 'code', source: 'harness' });

    await deleteHook(project, 'start');
    expect((await getHooks(project)).start).toMatchObject({
      command: 'kiro "$OUIJIT_TASK_DESCRIPTION"',
      source: 'harness',
    });

    expect((await getHarnesses()).map((h) => [h.name, Object.keys(h.hooks).sort()])).toEqual([
      ['Kiro', ['editor', 'start']],
    ]);

    await deleteHarness(kiro.id);
    expect(await getHarnesses()).toEqual([]);
    hooks = await getHooks(project);
    expect(hooks.start).toBeUndefined();
    expect(hooks.editor).toBeUndefined();
  });
});
