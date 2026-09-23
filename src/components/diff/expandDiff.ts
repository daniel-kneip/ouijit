import type { DiffHunk, DiffLine, FileDiff } from '../../types';

/**
 * A diff shows a few lines around each change. Unfolding the rest needs the
 * whole file, which is the same diff with unlimited context: one hunk that
 * runs from the first line to the last. The original hunks are spans of that
 * one, and what the user unfolds is more spans; the hunks on screen are the
 * runs the spans cover.
 */

/** Half-open index range into the full diff's lines. */
export type Span = [start: number, end: number];

/** Lines hidden between two hunks on screen, as a range into the full diff. */
export interface Gap {
  /** Index of the hunk on screen this gap sits above; `hunks.length` for the one below the last. */
  before: number;
  start: number;
  end: number;
}

export const EXPAND_STEP = 20;

/** Context lines to ask git for so a file comes back as one hunk. */
export const WHOLE_FILE_CONTEXT = 1_000_000;

export function fullLines(full: FileDiff): DiffLine[] {
  return full.hunks.flatMap((hunk) => hunk.lines);
}

function sameLine(a: DiffLine, b: DiffLine): boolean {
  return a.type === b.type && a.oldLineNo === b.oldLineNo && a.newLineNo === b.newLineNo;
}

/**
 * Where each of the diff's hunks sits in the full diff, or null when one of
 * them is not there: the two were read at different moments and the file has
 * changed between them.
 */
export function locateHunks(diff: FileDiff, lines: readonly DiffLine[]): Span[] | null {
  const spans: Span[] = [];
  let from = 0;
  for (const hunk of diff.hunks) {
    if (hunk.lines.length === 0) continue;
    let start = -1;
    for (let i = from; i + hunk.lines.length <= lines.length; i++) {
      if (sameLine(lines[i], hunk.lines[0]) && sameLine(lines[i + hunk.lines.length - 1], hunk.lines.at(-1)!)) {
        start = i;
        break;
      }
    }
    if (start === -1) return null;
    spans.push([start, start + hunk.lines.length]);
    from = start + hunk.lines.length;
  }
  return spans;
}

/** The union of spans as sorted, non-overlapping runs. */
export function mergeSpans(spans: readonly Span[]): Span[] {
  const sorted = spans
    .filter(([start, end]) => end > start)
    .map(([start, end]): Span => [start, end])
    .sort((a, b) => a[0] - b[0]);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push(span);
  }
  return merged;
}

function hunkHeader(lines: readonly DiffLine[]): string {
  const old = lines.filter((l) => l.oldLineNo != null);
  const fresh = lines.filter((l) => l.newLineNo != null);
  const oldStart = old[0]?.oldLineNo ?? (fresh[0]?.newLineNo ?? 1) - 1;
  const newStart = fresh[0]?.newLineNo ?? (old[0]?.oldLineNo ?? 1) - 1;
  return `@@ -${oldStart},${old.length} +${newStart},${fresh.length} @@`;
}

/**
 * The hunks to show: the runs `spans` cover, with the original header where a
 * run is exactly an original hunk, and the gaps left between them.
 */
export function composeDiff(
  diff: FileDiff,
  lines: readonly DiffLine[],
  located: readonly Span[],
  spans: readonly Span[],
): { diff: FileDiff; gaps: Gap[] } {
  const runs = mergeSpans(spans);
  const headers = new Map(located.map((span, i) => [`${span[0]}:${span[1]}`, diff.hunks[i].header]));
  const hunks: DiffHunk[] = runs.map(([start, end]) => ({
    header: headers.get(`${start}:${end}`) ?? hunkHeader(lines.slice(start, end)),
    lines: lines.slice(start, end),
  }));
  const gaps: Gap[] = [];
  let cursor = 0;
  runs.forEach(([start, end], i) => {
    if (start > cursor) gaps.push({ before: i, start: cursor, end: start });
    cursor = end;
  });
  if (cursor < lines.length) gaps.push({ before: runs.length, start: cursor, end: lines.length });
  return { diff: { ...diff, hunks }, gaps };
}

/**
 * The gaps a diff has before the full file is known: between its hunks the
 * count follows from the line numbers, above the first too, below the last
 * the file's length is needed.
 */
export function gapsFromNumbers(diff: FileDiff): { before: number; hidden: number | null }[] {
  const gaps: { before: number; hidden: number | null }[] = [];
  let lastNew = 0;
  diff.hunks.forEach((hunk, i) => {
    const first = hunk.lines.find((l) => l.newLineNo != null)?.newLineNo;
    if (first != null && first - lastNew - 1 > 0) gaps.push({ before: i, hidden: first - lastNew - 1 });
    const last = [...hunk.lines].reverse().find((l) => l.newLineNo != null)?.newLineNo;
    if (last != null) lastNew = last;
  });
  gaps.push({ before: diff.hunks.length, hidden: null });
  return gaps;
}
