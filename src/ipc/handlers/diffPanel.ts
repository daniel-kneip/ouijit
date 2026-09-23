import type { BrowserWindow } from 'electron';
import { typedHandle, typedPush } from '../helpers';
import { liveNotes, saveNote, discardNote, clearNotes } from '../../diffNotesService';
import {
  abandonReview,
  currentReview,
  handOverReview,
  listReviews,
  markFileViewed,
  retargetReview,
  reviewWithComments,
  startReview,
  viewedFiles,
} from '../../reviewService';
import { readDiffLens, writeDiffLens } from '../../lens/worktreeSubject';
import { listLenses, saveLens, deleteLens, getLensAgentChoice, setLensAgentChoice } from '../../lens/config';

export function registerDiffPanelHandlers(mainWindow: BrowserWindow): void {
  typedHandle('diff-notes:list', (worktreePath, keep) => liveNotes(worktreePath, keep));
  typedHandle('diff-notes:save', (input) => saveNote(input));
  typedHandle('diff-notes:discard', (id) => discardNote(id));
  typedHandle('diff-notes:clear', (worktreePath) => clearNotes(worktreePath));

  typedHandle('review:current', (worktreePath) => currentReview(worktreePath));
  typedHandle('review:list', (worktreePath) => listReviews(worktreePath));
  typedHandle('review:get', (id) => reviewWithComments(id));
  typedHandle('review:start', (input) => startReview(input));
  typedHandle('review:retarget', (id, base) => retargetReview(id, base));
  typedHandle('review:viewed', (id) => viewedFiles(id));
  typedHandle('review:mark-viewed', (id, path, viewed) => markFileViewed(id, path, viewed));
  typedHandle('review:hand-over', (id, state, summary) => handOverReview(id, state, summary));
  typedHandle('review:abandon', (id) => abandonReview(id));

  typedHandle('diff-lens:get', (target) => readDiffLens(target));
  typedHandle('diff-lens:run', (target, lensId) => writeDiffLens(target, lensId));

  // Not among the GitHub handlers: those all require a repo identity, and a
  // worktree diff reads these lenses without one.
  typedHandle('lens:list', (projectPath) => listLenses(projectPath));
  typedHandle('lens:save', async (projectPath, input) => {
    const lens = await saveLens(projectPath, input);
    typedPush(mainWindow, 'lens:list-changed', projectPath);
    return lens;
  });
  typedHandle('lens:delete', async (projectPath, lensId) => {
    const result = await deleteLens(projectPath, lensId);
    typedPush(mainWindow, 'lens:list-changed', projectPath);
    return result;
  });
  typedHandle('lens:agent', (projectPath) => getLensAgentChoice(projectPath));
  typedHandle('lens:set-agent', (projectPath, chosenId) => setLensAgentChoice(projectPath, chosenId));
}
