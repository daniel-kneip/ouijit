import { useCallback, type KeyboardEvent, type MouseEvent } from 'react';

interface ResizeHandleProps {
  /** Current size of the pane this handle bounds: its width on the x axis, its height on the y axis. */
  width: number;
  onWidth: (width: number) => void;
  min?: number;
  max?: number;
  /** Double-clicking the handle returns to this. Omitted, it does nothing. */
  defaultWidth?: number;
  label?: string;
  /** Which edge of the sized pane the handle sits on; a pane to the right of its handle grows leftwards. */
  edge?: 'end' | 'start';
  /** A y-axis handle is a horizontal seam dragged up and down. */
  axis?: 'x' | 'y';
}

const STEP = 16;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * The seam between a sidebar and what it opens, dragged to set the width.
 *
 * The seam is one pixel; the grab target is not. An invisible strip either
 * side takes the drag, and the pixel is what lights up.
 *
 * The strip alone is lifted, not the seam. A pane laid flush against the seam
 * is positioned and comes later in the document, so at the same level it takes
 * the half of the strip that overlaps it and the drag works from one side
 * only. Lifting the seam too would raise its catch over that pane as well,
 * which is paint, not target.
 */
export function ResizeHandle({
  width,
  onWidth,
  min = 120,
  max = 500,
  defaultWidth,
  label = 'Resize',
  edge = 'end',
  axis = 'x',
}: ResizeHandleProps) {
  const sign = edge === 'end' ? 1 : -1;
  const cursor = axis === 'x' ? 'col-resize' : 'row-resize';
  const onMouseDown = useCallback(
    (event: MouseEvent) => {
      event.preventDefault();
      const start = axis === 'x' ? event.clientX : event.clientY;
      const startWidth = width;

      const body = document.body;
      const previousCursor = body.style.cursor;
      const previousSelect = body.style.userSelect;
      body.style.cursor = cursor;
      body.style.userSelect = 'none';

      const onMove = (move: globalThis.MouseEvent) =>
        onWidth(clamp(startWidth + sign * ((axis === 'x' ? move.clientX : move.clientY) - start), min, max));
      const onUp = () => {
        body.style.cursor = previousCursor;
        body.style.userSelect = previousSelect;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [width, onWidth, min, max, sign, axis, cursor],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const [back, forward] = axis === 'x' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
      if (event.key === back) onWidth(clamp(width - sign * STEP, min, max));
      else if (event.key === forward) onWidth(clamp(width + sign * STEP, min, max));
      else if (event.key === 'Home') onWidth(min);
      else if (event.key === 'End') onWidth(max);
      else return;
      event.preventDefault();
    },
    [width, onWidth, min, max, sign, axis],
  );

  return (
    <div className={`pane-seam relative shrink-0 ${axis === 'x' ? 'w-px' : 'h-px w-full'}`}>
      <div
        role="separator"
        aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
        aria-label={label}
        aria-valuenow={Math.round(width)}
        aria-valuemin={min}
        aria-valuemax={max}
        tabIndex={0}
        title={defaultWidth != null ? `${label} — double-click to reset` : label}
        className={`absolute z-[1] focus:outline-none ${axis === 'x' ? 'inset-y-0 -left-1 -right-1' : 'inset-x-0 -top-1 -bottom-1'}`}
        style={{ cursor }}
        onMouseDown={onMouseDown}
        onKeyDown={onKeyDown}
        onDoubleClick={defaultWidth != null ? () => onWidth(defaultWidth) : undefined}
      />
    </div>
  );
}
