/**
 * Build the shell command that opens a worktree in the configured editor.
 *
 * The path is single-quoted so spaces and other shell metacharacters survive
 * intact. VS Code and its forks take a `.code-workspace` file where a folder
 * would go and apply the window title and colours inside it; any other editor
 * would open that file as a text document, so they get the worktree.
 */
const WORKSPACE_FILE_EDITORS = new Set(['code', 'code-insiders', 'codium', 'cursor', 'windsurf']);

export function buildEditorCommand(editorCommand: string, worktreePath: string, workspaceFile?: string): string {
  const executable = editorCommand.trim().split(/\s+/)[0]?.split('/').pop() ?? '';
  const target = workspaceFile && WORKSPACE_FILE_EDITORS.has(executable) ? workspaceFile : worktreePath;
  const quotedPath = `'${target.replace(/'/g, "'\\''")}'`;
  return `${editorCommand} ${quotedPath}`;
}
