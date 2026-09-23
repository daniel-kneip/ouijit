import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { getProjectTasks, getTaskByNumber } from './db';
import { buildChainMap, getChainHex } from './utils/taskChain';
import { generateBranchName } from './worktree';
import { getLogger } from './logger';

const workspaceLog = getLogger().scope('taskWorkspace');

/**
 * A VS Code workspace file per task, kept outside the worktree so the repo
 * stays clean. It names the window after the ticket and paints its title and
 * status bars in the task colour, which is what tells four windows of the same
 * project apart.
 */

export function taskWorkspaceDir(projectName: string): string {
  return path.join(os.homedir(), 'Ouijit', 'workspaces', projectName);
}

export interface TaskWorkspaceInput {
  taskNumber: number;
  name: string;
  worktreePath: string;
  color: string;
}

export function buildTaskWorkspace({ taskNumber, name, worktreePath, color }: TaskWorkspaceInput): object {
  const title = `#${taskNumber} ${name}`;
  const foreground = readableOn(color);
  return {
    folders: [{ name: title, path: worktreePath }],
    settings: {
      'window.title': `${title}\${separator}\${dirty}\${activeEditorShort}`,
      'workbench.colorCustomizations': {
        'titleBar.activeBackground': color,
        'titleBar.activeForeground': foreground,
        'titleBar.inactiveBackground': color,
        'titleBar.inactiveForeground': foreground,
        'statusBar.background': color,
        'statusBar.foreground': foreground,
        'statusBarItem.hoverBackground': foreground === '#ffffff' ? '#ffffff33' : '#00000022',
        'activityBar.activeBorder': color,
        'tab.activeBorderTop': color,
      },
    },
  };
}

function readableOn(hex: string): string {
  const n = parseInt(hex.slice(1, 7), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#1f2a22' : '#ffffff';
}

/**
 * Writes the task's workspace file and returns its path, or null when the
 * task has no worktree yet. Rewritten on every call, so a rename or a new
 * parent shows up the next time the editor opens (VS Code also reloads the
 * file while it is open). `worktreePath` covers a worktree the renderer has
 * in hand that the task row does not carry.
 */
export async function writeTaskWorkspace(
  projectPath: string,
  taskNumber: number,
  worktreePath?: string,
): Promise<string | null> {
  try {
    const task = await getTaskByNumber(projectPath, taskNumber);
    const folder = task?.worktreePath ?? worktreePath;
    if (!task || !folder) {
      workspaceLog.warn('no worktree for workspace file', { projectPath, taskNumber });
      return null;
    }

    const tasks = await getProjectTasks(projectPath);
    const chain = buildChainMap(tasks).get(taskNumber);
    const color = chain ? getChainHex(chain.rootTaskNumber, chain.depth) : getChainHex(taskNumber, 0);

    const dir = taskWorkspaceDir(path.basename(projectPath));
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${generateBranchName(task.name, taskNumber)}.code-workspace`);
    const workspace = buildTaskWorkspace({ taskNumber, name: task.name, worktreePath: folder, color });
    await fs.writeFile(file, JSON.stringify(workspace, null, 2) + '\n');
    workspaceLog.info('wrote workspace file', { file });
    return file;
  } catch (error) {
    workspaceLog.error('failed to write workspace file', {
      projectPath,
      taskNumber,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
