import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FileDiff, DiffHunk } from '../../types';
import type { HunkTokens } from '../../utils/syntaxHighlight';
import { computeWordHighlights } from '../../utils/wordDiff';
import { useSyntaxHighlight } from './useSyntaxHighlight';
import { DiffLineView, anchorForLine, type DiffLineAnchor } from './DiffLineView';
import { anchorForRange } from '../../diffAnchor';
import { estimateHunkHeight } from './diffMetrics';
import { badgeColorClass, statusLabel, type DiffFileStatus } from './diffStatus';
import { Icon } from '../terminal/Icon';
import { EXPAND_STEP, composeDiff, fullLines, gapsFromNumbers, locateHunks, type Gap, type Span } from './expandDiff';

/**
 * One file's diff. The review slots — `renderBelowLine` and `onAddComment` —
 * are optional; without them it renders a plain diff.
 */

export interface DiffFileSectionProps {
  path: string;
  status: DiffFileStatus | string;
  additions: number;
  deletions: number;
  /** `undefined` while it loads, `null` when it could not be produced. */
  diff: FileDiff | null | undefined;
  /**
   * Content anchored under a specific line — review threads, drafts, notes.
   *
   * Takes the path so the caller can hold one callback for the whole diff;
   * binding per file would break memoization on every line below.
   */
  renderBelowLine?: (path: string, anchor: DiffLineAnchor) => ReactNode;
  onAddComment?: (path: string, anchor: DiffLineAnchor) => void;
  /**
   * Whether a comment covers this line without rendering on it. Takes the path
   * for the reason `renderBelowLine` does; leave it unset when nothing is
   * marked, since it is called once per line of the diff.
   */
  markLine?: (path: string, anchor: DiffLineAnchor) => boolean;
  /** Extra header content, right-aligned before the stats. */
  headerRight?: ReactNode;
  /** Shown in place of the hunks when git reports the file as binary. */
  binaryView?: ReactNode;
  loadingLabel?: string;
  emptyLabel?: string;
  failedLabel?: string;
  collapsed?: boolean;
  /**
   * Which copy of the file this is, where a lens has put it in more than one part:
   * fold one and the others must stay as they were.
   */
  sectionId?: string;
  /** Enables the fold control, on this copy of the file alone. */
  onCollapsedChange?: (sectionId: string, collapsed: boolean) => void;
  /** Wording for the fold control — "Viewed" in a review, "Collapse" outside one. */
  collapseLabel?: string;
  /**
   * The same diff with the whole file as context, read on demand. Enables
   * unfolding the lines between hunks and showing the file entire.
   */
  loadFullDiff?: (path: string) => Promise<FileDiff | null>;
}

export const DiffFileSection = memo(function DiffFileSection({
  path,
  status,
  additions,
  deletions,
  diff,
  renderBelowLine,
  onAddComment,
  markLine,
  headerRight,
  binaryView,
  loadingLabel = 'Loading...',
  emptyLabel = 'No diff available',
  failedLabel = 'Could not read this file',
  collapsed,
  sectionId,
  onCollapsedChange,
  collapseLabel = 'Collapse',
  loadFullDiff,
}: DiffFileSectionProps) {
  const { shown, gaps, wholeFile, setWholeFile, reveal } = useUnfolding(path, diff, loadFullDiff);
  // Skip tokenizing a folded file: nothing below the header renders.
  const tokens = useSyntaxHighlight(collapsed ? undefined : shown, path);

  // One closure per file, not one per line: a new function per line per render
  // stops every memoized line from bailing out.
  const addComment = useCallback((anchor: DiffLineAnchor) => onAddComment?.(path, anchor), [onAddComment, path]);
  const belowLine = useCallback((anchor: DiffLineAnchor) => renderBelowLine?.(path, anchor), [renderBelowLine, path]);
  const lineMarked = useCallback((anchor: DiffLineAnchor) => markLine?.(path, anchor) ?? false, [markLine, path]);
  const setCollapsed = useCallback(
    (next: boolean) => onCollapsedChange?.(sectionId ?? path, next),
    [onCollapsedChange, sectionId, path],
  );

  return (
    /* `clip`, not `hidden`: `hidden` makes a scroll container, which strands
       the sticky header inside this box instead of pinning it to the pane. */
    <div className="diff-card mx-6 rounded-[14px] border border-bezel bg-diff-card overflow-clip" data-path={path}>
      {/* Pins below whichever header claimed the top of the pane, which under a
          lens is the part's; `0px` when nothing has. */}
      <div
        className="pane-ledge sticky z-10 flex items-center gap-2 px-4 h-9 bg-terminal-surface"
        style={{ top: 'var(--diff-sticky-offset, 0px)' }}
      >
        {onCollapsedChange && (
          <button
            type="button"
            title={collapsed ? `${collapseLabel} — click to unfold` : collapseLabel}
            aria-label={collapseLabel}
            aria-pressed={Boolean(collapsed)}
            className={`shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors duration-150 [&>svg]:w-3 [&>svg]:h-3 ${
              collapsed
                ? 'bg-accent border-accent text-accent-ink'
                : 'border-ink/25 text-transparent hover:border-ink/50'
            }`}
            onClick={() => setCollapsed(!collapsed)}
          >
            <Icon name="check" />
          </button>
        )}
        <span className={`flex-1 min-w-0 truncate font-mono text-[13px] ${collapsed ? 'opacity-45' : ''}`} title={path}>
          <span className="text-ink/35">{dirname(path)}</span>
          <span className="text-ink/90">{basename(path)}</span>
        </span>
        {loadFullDiff && diff && !diff.binary && diff.hunks.length > 0 && (
          <button
            type="button"
            title={wholeFile ? 'Back to the changes' : 'Show the whole file'}
            aria-label="Whole file"
            aria-pressed={wholeFile}
            className={`shrink-0 w-5 h-5 rounded flex items-center justify-center transition-colors duration-150 [&>svg]:w-3.5 [&>svg]:h-3.5 ${
              wholeFile ? 'bg-accent/[0.18] text-accent' : 'text-ink/40 hover:text-ink/80 hover:bg-ink/[0.06]'
            }`}
            onClick={() => setWholeFile(!wholeFile)}
          >
            <Icon name={wholeFile ? 'arrows-in-line-vertical' : 'arrows-out-line-vertical'} />
          </button>
        )}
        {headerRight}
        <span className={`shrink-0 text-[10px] px-1 py-px rounded font-medium ${badgeColorClass(status)}`}>
          {statusLabel(status)}
        </span>
        {(additions > 0 || deletions > 0) && (
          <span className="shrink-0 font-mono text-[11px]">
            {additions > 0 && <span className="text-diff-added">+{additions}</span>}
            {additions > 0 && deletions > 0 && ' '}
            {deletions > 0 && <span className="text-diff-removed">-{deletions}</span>}
          </span>
        )}
      </div>
      <div>
        {collapsed ? null : diff === undefined ? (
          <div className="flex-1 flex flex-col items-center justify-center text-text-tertiary gap-2">
            {loadingLabel}
          </div>
        ) : diff === null ? (
          <div className="flex-1 flex flex-col items-center justify-center text-text-tertiary gap-2">{failedLabel}</div>
        ) : diff.binary ? (
          (binaryView ?? (
            <div className="px-4 py-6 text-center font-mono text-[11px] text-text-tertiary">Binary file</div>
          ))
        ) : diff.hunks.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-text-tertiary gap-2">{emptyLabel}</div>
        ) : (
          <div className="min-w-full">
            {shown.hunks.map((hunk, i) => (
              <div key={i}>
                {gaps
                  .filter((gap) => gap.before === i)
                  .map((gap) => (
                    <GapRow key="gap" gap={gap} onReveal={reveal} />
                  ))}
                <HunkHeader header={hunk.header} first={i === 0 && !gaps.some((gap) => gap.before === 0)} />
                <DiffHunkView
                  hunk={hunk}
                  hunkTokens={tokens?.[i] ?? null}
                  onAddComment={onAddComment ? addComment : undefined}
                  renderBelowLine={renderBelowLine ? belowLine : undefined}
                  markLine={markLine ? lineMarked : undefined}
                />
              </div>
            ))}
            {gaps
              .filter((gap) => gap.before === shown.hunks.length)
              .map((gap) => (
                <GapRow key="tail" gap={gap} onReveal={reveal} />
              ))}
          </div>
        )}
      </div>
    </div>
  );
});

type HiddenGap = Pick<Gap, 'before'> & { hidden: number | null };
type Reveal = 'up' | 'down' | 'all';

/**
 * What the section shows once the user unfolds something: the diff's hunks
 * plus the runs revealed out of the full file, and the gaps still hidden.
 * Until the full diff is read the gaps are counted from line numbers, so the
 * controls are there from the start and the read happens on the first click.
 */
function useUnfolding(
  path: string,
  diff: FileDiff | null | undefined,
  loadFullDiff?: (path: string) => Promise<FileDiff | null>,
): {
  shown: FileDiff | null | undefined;
  gaps: HiddenGap[];
  wholeFile: boolean;
  setWholeFile: (next: boolean) => void;
  reveal: (before: number, how: Reveal) => void;
} {
  const [full, setFull] = useState<FileDiff | null | undefined>(undefined);
  const [revealed, setRevealed] = useState<Span[]>([]);
  const [wholeFile, setWholeFile] = useState(false);
  const pending = useRef<Promise<FileDiff | null> | null>(null);

  // A fresh diff is a fresh file: what was unfolded no longer lines up with it.
  useEffect(() => {
    setFull(undefined);
    setRevealed([]);
    setWholeFile(false);
    pending.current = null;
  }, [diff]);

  const ensureFull = useCallback((): Promise<FileDiff | null> => {
    if (full !== undefined) return Promise.resolve(full);
    if (!loadFullDiff) return Promise.resolve(null);
    if (!pending.current) {
      const read: Promise<FileDiff | null> = loadFullDiff(path).catch((): null => null);
      pending.current = read.then((result) => {
        setFull(result);
        return result;
      });
    }
    return pending.current;
  }, [full, loadFullDiff, path]);

  useEffect(() => {
    if (wholeFile) void ensureFull();
  }, [wholeFile, ensureFull]);

  const composed = useMemo(() => {
    const unfolding = !!loadFullDiff && !!diff && !diff.binary && diff.hunks.length > 0;
    if (!unfolding) return { shown: diff, gaps: [] as HiddenGap[] };
    const lines = full ? fullLines(full) : null;
    const located = lines ? locateHunks(diff, lines) : null;
    if (!lines || (!wholeFile && revealed.length === 0)) {
      return {
        shown: diff,
        gaps: gapsFromNumbers(diff).map((gap) => ({ ...gap, hidden: lines && !located ? 0 : gap.hidden })),
      };
    }
    // The file moved between the two reads: the whole of it is the one thing still true.
    if (!located) return { shown: { ...diff, hunks: full!.hunks }, gaps: [] as HiddenGap[] };
    const spans: Span[] = wholeFile ? [[0, lines.length]] : [...located, ...revealed];
    const result = composeDiff(diff, lines, located, spans);
    return {
      shown: result.diff,
      gaps: result.gaps.map((gap) => ({ before: gap.before, hidden: gap.end - gap.start })),
    };
  }, [diff, full, revealed, wholeFile, loadFullDiff]);

  const reveal = useCallback(
    async (before: number, how: Reveal) => {
      const loaded = await ensureFull();
      if (!loaded || !diff) return;
      const lines = fullLines(loaded);
      const located = locateHunks(diff, lines);
      if (!located) return;
      setRevealed((current) => {
        const { gaps } = composeDiff(diff, lines, located, [...located, ...current]);
        const gap = gaps.find((g) => g.before === before);
        if (!gap) return current;
        const span: Span =
          how === 'all'
            ? [gap.start, gap.end]
            : how === 'down'
              ? [gap.start, Math.min(gap.end, gap.start + EXPAND_STEP)]
              : [Math.max(gap.start, gap.end - EXPAND_STEP), gap.end];
        return [...current, span];
      });
    },
    [diff, ensureFull],
  );

  return { shown: composed.shown, gaps: composed.gaps, wholeFile, setWholeFile, reveal };
}

/** The lines folded away between two hunks, and the controls to unfold them. */
function GapRow({ gap, onReveal }: { gap: HiddenGap; onReveal: (before: number, how: Reveal) => void }) {
  if (gap.hidden === 0) return null;
  const stepwise = gap.hidden === null || gap.hidden > EXPAND_STEP;
  const button = (how: Reveal, label: string, icon: string) => (
    <button
      type="button"
      title={label}
      aria-label={label}
      className="w-5 h-5 rounded flex items-center justify-center text-ink/40 hover:text-accent hover:bg-accent/10 [&>svg]:w-3 [&>svg]:h-3"
      onClick={() => onReveal(gap.before, how)}
    >
      <Icon name={icon} />
    </button>
  );
  const count =
    gap.hidden === null ? 'the rest of the file' : `${gap.hidden} hidden line${gap.hidden === 1 ? '' : 's'}`;
  return (
    <div
      className="flex items-stretch font-mono text-xs border-t border-separator"
      data-testid={`diff-gap-${gap.before}`}
    >
      <span className="flex shrink-0 items-center justify-center gap-0.5 w-[88px] py-0.5 sticky left-0 z-[1] bg-terminal-inset border-r border-ink/[0.07]">
        {stepwise && button('up', `Show ${EXPAND_STEP} lines above`, 'caret-up')}
        {stepwise && button('down', `Show ${EXPAND_STEP} lines below`, 'caret-down')}
        {button('all', `Show ${count}`, 'arrows-out-line-vertical')}
      </span>
      <span className="flex items-center pl-3 text-ink/35">{count}</span>
    </div>
  );
}

/** Splits `@@ -12,7 +12,10 @@ export function readToken()` into range and context. */
export function HunkHeader({ header, first = false }: { header: string; first?: boolean }) {
  const match = /^(@@[^@]*@@)\s*(.*)$/.exec(header);
  const range = match?.[1] ?? header;
  const context = match?.[2] ?? '';

  return (
    <div
      className={`flex items-center gap-3 py-1 pr-4 font-mono text-xs ${first ? '' : 'border-t border-separator'}`}
      style={{ paddingLeft: '100px' }}
    >
      <span className="shrink-0 text-ink/25">{range}</span>
      {context && <span className="truncate text-ink/45">{context}</span>}
    </div>
  );
}

function dirname(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut + 1);
}

function basename(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? path : path.slice(cut + 1);
}

export interface DiffHunkViewProps {
  hunk: DiffHunk;
  hunkTokens: HunkTokens | null;
  renderBelowLine?: (anchor: DiffLineAnchor) => ReactNode;
  /** Already bound to the file — one closure for the hunk, not one per line. */
  onAddComment?: (anchor: DiffLineAnchor) => void;
  markLine?: (anchor: DiffLineAnchor) => boolean;
}

export const DiffHunkView = memo(function DiffHunkView({
  hunk,
  hunkTokens,
  renderBelowLine,
  onAddComment,
  markLine,
}: DiffHunkViewProps) {
  const wordHighlights = useMemo(() => computeWordHighlights(hunk.lines), [hunk.lines]);
  const anchors = useMemo(() => hunk.lines.map(anchorForLine), [hunk.lines]);
  const [hovered, setHovered] = useState(-1);
  // Indices into this hunk only: a comment may span lines but not a gap
  // between hunks, whose neighbouring lines aren't adjacent in the file.
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);

  const onHover = useCallback((index: number) => {
    setHovered((current) => (current === index ? current : index));
    setDrag((current) => (current && current.to !== index ? { ...current, to: index } : current));
  }, []);

  const startSelect = useCallback((index: number) => setDrag({ from: index, to: index }), []);

  // On window, not the hunk: the pointer may be released outside it.
  useEffect(() => {
    if (!drag) return;
    const finish = () => {
      setDrag(null);
      const anchor = anchorForRange(hunk.lines, drag.from, drag.to);
      if (anchor) onAddComment?.(anchor);
    };
    window.addEventListener('mouseup', finish);
    return () => window.removeEventListener('mouseup', finish);
  }, [drag, hunk.lines, onAddComment]);

  const selection = drag && { lo: Math.min(drag.from, drag.to), hi: Math.max(drag.from, drag.to) };

  return (
    <div
      onMouseLeave={onAddComment ? () => setHovered(-1) : undefined}
      // Skip layout for off-screen hunks, or every line in the pull request is
      // laid out on each scroll; `auto` drops the estimate once measured.
      // `userSelect` while dragging stops the browser painting a text selection
      // over the range being picked.
      style={{
        contentVisibility: 'auto',
        containIntrinsicSize: `auto ${estimateHunkHeight(hunk)}px`,
        ...(drag ? { userSelect: 'none' as const } : {}),
      }}
    >
      {hunk.lines.map((line, i) => {
        const anchor = anchors[i];
        const below = anchor && renderBelowLine ? renderBelowLine(anchor) : null;
        return (
          <div key={i}>
            <DiffLineView
              line={line}
              tokens={hunkTokens?.[i] ?? null}
              wordHighlight={wordHighlights.get(i)}
              anchor={anchor}
              onStartSelect={onAddComment ? startSelect : undefined}
              showComment={onAddComment ? hovered === i && !drag : false}
              selected={selection ? i >= selection.lo && i <= selection.hi : false}
              marked={anchor && markLine ? markLine(anchor) : false}
              index={i}
              onHover={onAddComment ? onHover : undefined}
            />
            {below}
          </div>
        );
      })}
    </div>
  );
});
