import { describe, test, expect } from 'vitest';
import { composeDiff, fullLines, gapsFromNumbers, locateHunks, mergeSpans } from '../components/diff/expandDiff';
import type { DiffLine, FileDiff } from '../types';

function ctx(n: number): DiffLine {
  return { type: 'context', content: `line ${n}`, oldLineNo: n, newLineNo: n };
}

// A 30-line file with one line changed at 10 and one at 25: two hunks, a gap above, between and below.
const full: FileDiff = {
  path: 'a.ts',
  hunks: [
    {
      header: '@@ -1,30 +1,30 @@',
      lines: Array.from({ length: 30 }, (_, i) => i + 1).flatMap((n): DiffLine[] =>
        n === 10 || n === 25
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
    { header: '@@ -7,7 +7,7 @@ first', lines: lines.slice(6, 14) },
    { header: '@@ -22,7 +22,7 @@ second', lines: lines.slice(22, 30) },
  ],
};

describe('unfolding a diff into its file', () => {
  test('hunks are found in the full file, gaps are counted, and revealed spans join the hunks', () => {
    expect(gapsFromNumbers(diff)).toEqual([
      { before: 0, hidden: 6 },
      { before: 1, hidden: 8 },
      { before: 2, hidden: null },
    ]);

    const located = locateHunks(diff, lines)!;
    expect(located).toEqual([
      [6, 14],
      [22, 30],
    ]);
    expect(locateHunks({ ...diff, hunks: [{ header: '', lines: [ctx(99)] }] }, lines)).toBeNull();

    const plain = composeDiff(diff, lines, located, located);
    expect(plain.diff.hunks.map((h) => h.header)).toEqual(['@@ -7,7 +7,7 @@ first', '@@ -22,7 +22,7 @@ second']);
    expect(plain.gaps).toEqual([
      { before: 0, start: 0, end: 6 },
      { before: 1, start: 14, end: 22 },
      { before: 2, start: 30, end: 32 },
    ]);

    // Revealing the whole middle gap fuses the two hunks into one with a computed header.
    const fused = composeDiff(diff, lines, located, [...located, [14, 22]]);
    expect(fused.diff.hunks).toHaveLength(1);
    expect(fused.diff.hunks[0].header).toBe('@@ -7,22 +7,22 @@');
    expect(fused.diff.hunks[0].lines).toHaveLength(24);
    expect(fused.gaps).toEqual([
      { before: 0, start: 0, end: 6 },
      { before: 1, start: 30, end: 32 },
    ]);

    // Part of a gap leaves the rest of it, and the top of the file opens to no gap at all.
    const part = composeDiff(diff, lines, located, [...located, [14, 17], [0, 6]]);
    expect(part.gaps).toEqual([
      { before: 1, start: 17, end: 22 },
      { before: 2, start: 30, end: 32 },
    ]);
    expect(part.diff.hunks[0].lines[0]).toEqual(ctx(1));

    expect(
      mergeSpans([
        [5, 9],
        [1, 3],
        [8, 12],
        [4, 4],
      ]),
    ).toEqual([
      [1, 3],
      [5, 12],
    ]);
  });
});
