import { describe, test, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';

import { DiffPanel } from '../../components/diff/DiffPanel';
import { useTerminalStore } from '../../stores/terminalStore';
import { DEFAULT_DISPLAY_STATE } from '../../stores/terminalDisplay';
import type { Review, ReviewWithComments } from '../../reviews';

// terminalReact pulls xterm in, which hangs under jsdom.
vi.mock('../../components/terminal/terminalReact', () => ({
  terminalInstances: new Map([['pty-1', { worktreePath: '/w', mergeTarget: 'main' }]]),
  refreshTerminalGitStatus: vi.fn().mockResolvedValue(undefined),
}));

const PROPS = {
  ptyId: 'pty-1',
  projectPath: '/w',
  fullWidth: true,
  onToggleFullWidth: vi.fn(),
  onClose: vi.fn(),
};

const REVIEW: ReviewWithComments = {
  id: 'rev-1',
  worktreePath: '/w',
  projectPath: '/w',
  seq: 1,
  base: 'main',
  branch: 'feat/x',
  state: 'open',
  summary: null,
  snapshotRef: 'refs/ouijit/review/1/abcdef',
  createdAt: '2026-09-22T09:00:00.000Z',
  submittedAt: null,
  comments: [],
};

/** What the main process holds, as the panel's calls change it. */
let current: ReviewWithComments | null;
let past: Review[];
let viewed: string[];

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  current = null;
  past = [];
  viewed = [];

  vi.mocked(window.api.globalSettings.get).mockResolvedValue(undefined as never);
  vi.mocked(window.api.reviews.current).mockImplementation(async () => current);
  vi.mocked(window.api.reviews.list).mockImplementation(async () => (current ? [current, ...past] : past));
  vi.mocked(window.api.reviews.viewed).mockImplementation(async () => viewed);
  vi.mocked(window.api.reviews.start).mockImplementation(async () => {
    current = { ...REVIEW };
    return current;
  });
  vi.mocked(window.api.reviews.markViewed).mockImplementation(async (_id, path, next) => {
    viewed = next ? [...viewed, path] : viewed.filter((p) => p !== path);
  });
  vi.mocked(window.api.reviews.handOver).mockImplementation(async (_id, state, summary) => {
    const handed = { ...REVIEW, state, summary, submittedAt: '2026-09-22T10:00:00.000Z' };
    past = [handed];
    current = null;
    return handed;
  });

  useTerminalStore.setState({
    displayStates: {
      'pty-1': {
        ...DEFAULT_DISPLAY_STATE,
        ptyId: 'pty-1',
        projectPath: '/w',
        gitFileStatus: {
          branch: 'feat/x',
          base: 'main',
          mainBranch: 'main',
          commitsAheadOfMain: 1,
          changedFiles: [
            { path: 'src/a.ts', status: 'M', additions: 2, deletions: 1 },
            { path: 'src/b.ts', status: 'M', additions: 1, deletions: 0 },
          ],
          untrackedFiles: [],
        },
      },
    },
  });
});

describe('reviewing a worktree diff', () => {
  test('keeps the files read, hands the verdict over and offers what was reviewed as a base', async () => {
    const panel = render(<DiffPanel {...PROPS} />);

    fireEvent.click(await screen.findByTestId('start-review'));
    const chip = await screen.findByTestId('review-chip');
    expect(chip.textContent).toContain('Review 1 · 0/2 read');

    // Folding a file is what marks it read, and the mark is the review's.
    fireEvent.click((await screen.findAllByLabelText('Read'))[0]);
    await waitFor(() => expect(screen.getByTestId('review-chip').textContent).toContain('1/2 read'));

    // The one thing local state could not do: survive the panel going away.
    panel.unmount();
    render(<DiffPanel {...PROPS} />);
    await waitFor(() => expect(screen.getByTestId('review-chip').textContent).toContain('1/2 read'));

    fireEvent.click(screen.getByTestId('review-chip'));
    fireEvent.change(screen.getByPlaceholderText('Anything to say with it…'), {
      target: { value: 'two things to fix' },
    });
    fireEvent.click(screen.getByTestId('review-request-changes'));

    await waitFor(() =>
      expect(window.api.reviews.handOver).toHaveBeenCalledWith('rev-1', 'changes_requested', 'two things to fix'),
    );
    // Handed over, so the panel is back to offering a fresh pass.
    await screen.findByTestId('start-review');

    // And the next pass can be read against what the last one was of.
    fireEvent.click(screen.getByRole('button', { name: /Uncommitted changes|vs main/ }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('Since review 1')).toBeTruthy();
  });
});
