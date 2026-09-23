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
  setHarnessUsageCommand,
  setProjectHarness,
} from '../../db';
import { parseUsageOutput, readHarnessUsage } from '../../harnessUsage';

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

describe('harness token usage', () => {
  test('a harness keeps its usage command, and asking reads what every command prints, failures included', async () => {
    const claude = await createHarness('Claude');
    const kiro = await createHarness('Kiro');
    const quiet = await createHarness('Quiet');
    const broken = await createHarness('Broken');
    const slow = await createHarness('Slow');
    expect(await setHarnessUsageCommand('no-such-harness', 'true')).toEqual({ success: false });
    await setHarnessUsageCommand(claude.id, `echo '{"used": 12000, "remaining": 188000, "label": "resets 14:00"}'`);
    await setHarnessUsageCommand(kiro.id, 'echo "credits: 3.5k of 10k used"');
    await setHarnessUsageCommand(quiet.id, '   ');
    await setHarnessUsageCommand(broken.id, 'echo nothing here; exit 3');
    await setHarnessUsageCommand(slow.id, 'sleep 5');

    const byName = Object.fromEntries((await getHarnesses()).map((h) => [h.name, h.usageCommand]));
    expect(byName.Claude).toContain('echo');
    expect(byName.Quiet).toBeUndefined();

    const usage = Object.fromEntries((await readHarnessUsage(300)).map((u) => [u.name, u]));
    expect(Object.keys(usage).sort()).toEqual(['Broken', 'Claude', 'Kiro', 'Slow']);
    expect(usage.Claude.reading).toEqual({ used: 12000, limit: 200000, unit: 'tokens', label: 'resets 14:00' });
    expect(usage.Kiro.reading).toEqual({ used: 3500, limit: 10000, unit: 'tokens' });
    expect(usage.Broken.reading).toBeUndefined();
    expect(usage.Broken.error).toContain('Exited with 3');
    expect(usage.Slow.error).toContain('Timed out');
    expect(Number.isNaN(Date.parse(usage.Claude.at))).toBe(false);

    expect(parseUsageOutput('{"percent": 38.4}')).toEqual({ used: 38.4, unit: 'percent', label: undefined });
    expect(parseUsageOutput('{"limit": 100, "remaining": 25}')).toEqual({
      used: 75,
      limit: 100,
      unit: 'tokens',
      label: undefined,
    });
    expect(parseUsageOutput('warming up\n{"used": "1.2M", "limit": "5M"}')).toMatchObject({
      used: 1_200_000,
      limit: 5_000_000,
    });
    expect(parseUsageOutput('Weekly window 62% used')).toEqual({ used: 62, unit: 'percent' });
    expect(parseUsageOutput('1,234 tokens')).toEqual({ used: 1234, unit: 'tokens' });
    expect(parseUsageOutput('no idea')).toBeNull();
  });
});
