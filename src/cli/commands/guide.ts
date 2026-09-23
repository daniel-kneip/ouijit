import type { Command } from 'commander';
import { CLI_REFERENCE } from '../../agentGuide';

export function registerGuideCommand(parent: Command) {
  parent
    .command('guide')
    .description('Print the guide an agent gets on how to work in Ouijit, with the CLI reference')
    .action(() => {
      process.stdout.write(CLI_REFERENCE);
    });
}
