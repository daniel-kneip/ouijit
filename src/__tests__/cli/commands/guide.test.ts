import { describe, test, expect, vi } from 'vitest';
import { Command } from 'commander';
import { registerGuideCommand } from '../../../cli/commands/guide';
import { CLI_REFERENCE } from '../../../agentGuide';

describe('guide command', () => {
  test('prints the agent guide as text, needing no running app', async () => {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      chunks.push(String(data));
      return true;
    });
    const program = new Command();
    program.exitOverride();
    registerGuideCommand(program);
    await program.parseAsync(['guide'], { from: 'user' });
    spy.mockRestore();
    expect(chunks.join('')).toBe(CLI_REFERENCE);
    expect(CLI_REFERENCE.startsWith('# Working in Ouijit')).toBe(true);
  });
});
