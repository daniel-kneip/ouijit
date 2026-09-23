import type { Command } from 'commander';
import { patch } from '../api';
import { printError, printJson } from '../output';
import { resolvePtyId } from '../ptyId';

export function registerTerminalCommands(parent: Command) {
  const terminal = parent
    .command('terminal')
    .description('This terminal session')
    .addHelpText(
      'after',
      `
Examples:
  ouijit terminal name "Auth middleware"
  ouijit terminal name --pty pty_abc123 "Deploy watch"`,
    );

  terminal
    .command('name')
    .description("Name this terminal; the header, the board's card and the map's site show it")
    .argument('<name...>', 'the name, a few words')
    .option('--pty <id>', 'terminal session id (defaults to OUIJIT_PTY_ID)')
    .action(async (parts: string[], opts: { pty?: string }) => {
      const label = parts.join(' ').trim();
      if (!label) return printError('Usage: ouijit terminal name <name>');
      const ptyId = resolvePtyId(opts.pty);
      printJson(await patch(`/api/sessions/${encodeURIComponent(ptyId)}/label`, { label }));
    });
}
