/**
 * A file section shows a few lines around each change; the folded lines
 * between hunks open in steps or all at once, the whole file on request, and
 * a line opened that way takes a comment like any other.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { DiffFileSection } from '../../components/diff/DiffFileSection';
import { fullLines } from '../../components/diff/expandDiff';
import type { DiffLine, FileDiff } from '../../types';

vi.mock('../../utils/syntaxHighlight', () => ({
  peekDiffTokens: (hunks: Array<{ lines: unknown[] }>) => hunks.map((hunk) => hunk.lines.map(() => null)),
  tokenizeDiffHunks: async (hunks: Array<{ lines: unknown[] }>) => hunks.map((hunk) => hunk.lines.map(() => null)),
}));

function ctx(n: number): DiffLine {
  return { type: 'context', content: `line ${n}`, oldLineNo: n, newLineNo: n };
}

// 60 lines, changes at 10 and 50: a 6-line gap above, 33 between, 7 below.
const full: FileDiff = {
  path: 'a.ts',
  hunks: [
    {
      header: '@@ -1,60 +1,60 @@',
      lines: Array.from({ length: 60 }, (_, i) => i + 1).flatMap((n): DiffLine[] =>
        n === 10 || n === 50
          ? [
              { type: 'deletion', content: `old ${n}`, oldLineNo: n },
              { type: 'addition', content: `new ${n}`, newLineNo: n },
            ]
          : [ctx(n)],
      ),
    },
  ],
};
const lines = fullLines(full);
const diff: FileDiff = {
  path: 'a.ts',
  hunks: [
    { header: '@@ -7,7 +7,7 @@', lines: lines.slice(6, 14) },
    { header: '@@ -47,7 +47,7 @@', lines: lines.slice(47, 55) },
  ],
};

function rows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('div.leading-normal'));
}

describe('unfolding a file section', () => {
  beforeEach(() => cleanup());

  test('gaps open in steps or whole, the full file toggles, and an opened line takes a comment', async () => {
    const loadFullDiff = vi.fn(async () => full);
    const onAddComment = vi.fn();
    const { container } = render(
      <DiffFileSection
        path="a.ts"
        status="M"
        additions={2}
        deletions={2}
        diff={diff}
        onAddComment={onAddComment}
        loadFullDiff={loadFullDiff}
      />,
    );
    expect(rows(container)).toHaveLength(16);
    // Counted from line numbers before the file is read; the tail is unknown until then.
    expect(screen.getByTestId('diff-gap-0').textContent).toContain('6 hidden lines');
    expect(screen.getByTestId('diff-gap-1').textContent).toContain('33 hidden lines');
    expect(screen.getByTestId('diff-gap-2').textContent).toContain('the rest of the file');
    expect(loadFullDiff).not.toHaveBeenCalled();

    // A small gap has one control; the first click reads the file.
    fireEvent.click(screen.getByLabelText('Show 6 hidden lines'));
    await waitFor(() => expect(rows(container)).toHaveLength(22));
    expect(loadFullDiff).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('diff-gap-0')).toBeNull();
    expect(rows(container)[0].textContent).toContain('line 1');

    // The big gap opens twenty lines at a time from either end, then the rest.
    fireEvent.click(screen.getByLabelText('Show 20 lines below'));
    await waitFor(() => expect(screen.getByTestId('diff-gap-1').textContent).toContain('13 hidden lines'));
    expect(rows(container)).toHaveLength(42);
    fireEvent.click(screen.getByLabelText('Show 13 hidden lines'));
    // The two hunks are one run now, so the only gap left is the tail, below run 1.
    await waitFor(() => expect(container.querySelectorAll('[data-testid^="diff-gap-"]')).toHaveLength(1));
    expect(screen.getByTestId('diff-gap-1').textContent).toContain('7 hidden lines');
    expect(loadFullDiff).toHaveBeenCalledTimes(1);

    // An unfolded context line is commentable, anchored on its own number.
    const opened = rows(container).find((row) => row.textContent?.includes('line 30'))!;
    fireEvent.mouseEnter(opened);
    fireEvent.mouseDown(screen.getByTitle('Comment here, or drag over the lines it is about'));
    fireEvent.mouseUp(window);
    expect(onAddComment).toHaveBeenCalledWith('a.ts', { line: 30, side: 'RIGHT' });

    // The whole file, and back to what was unfolded.
    fireEvent.click(screen.getByLabelText('Whole file'));
    await waitFor(() => expect(rows(container)).toHaveLength(62));
    expect(container.querySelectorAll('[data-testid^="diff-gap-"]')).toHaveLength(0);
    fireEvent.click(screen.getByLabelText('Whole file'));
    await waitFor(() => expect(rows(container)).toHaveLength(55));
  });

  test('without a way to read the file there is nothing to unfold', () => {
    const { container } = render(<DiffFileSection path="a.ts" status="M" additions={2} deletions={2} diff={diff} />);
    expect(rows(container)).toHaveLength(16);
    expect(container.querySelectorAll('[data-testid^="diff-gap-"]')).toHaveLength(0);
    expect(screen.queryByLabelText('Whole file')).toBeNull();
  });
});
