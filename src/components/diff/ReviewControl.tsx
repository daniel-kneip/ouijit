import { useState } from 'react';
import type { ReviewSession } from './useReview';
import { REVIEW_VERDICT, formatReviewForAgent } from '../../reviews';
import { diffSubject } from '../../diffSource';
import { MenuPopover } from '../ui/Menu';
import { Tooltip } from '../ui/Tooltip';
import { SegmentedGroup, segmentBase, segmentQuiet } from '../ui/SegmentedGroup';
import { Icon } from '../terminal/Icon';
import { pasteIntoTerminal } from '../terminal/pasteIntoTerminal';

interface ReviewControlProps {
  session: ReviewSession;
  /** Files in the comparison being read, for "3 of 8 read". */
  fileCount: number;
  /** The agent the review is of: the terminal this panel is split against. */
  ptyId: string;
  /** How the review is handed over, and what the agent fetches it with. */
  onHandedOver: (verdict: string) => void;
}

/**
 * Starting a review, and handing it over. While one is open the button says how
 * far through the files it is, so the pass has a visible end.
 */
export function ReviewControl({ session, fileCount, ptyId, onHandedOver }: ReviewControlProps) {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState('');
  const { review } = session;

  const send = async (id: string) => {
    const full = await window.api.reviews.get(id);
    if (full) pasteIntoTerminal(ptyId, formatReviewForAgent(full, diffSubject(full.base, full.branch)));
  };

  if (!review) {
    const [last] = session.past;
    return (
      <SegmentedGroup>
        <button
          type="button"
          className={`${segmentBase} ${segmentQuiet}`}
          data-testid="start-review"
          onClick={() => void session.start()}
          disabled={session.busy}
          title="Keep track of the files you have read and hand the comments over as one review"
        >
          <Icon name="list-checks" className="w-3.5 h-3.5" />
          Start review
        </button>
        {/* The agent fetches a review itself, but it is usually sitting right
            there, so the last one can also be put in front of it. */}
        {last && (
          <Tooltip text={`Send review ${last.seq} to the agent`} referenceClassName="inline-flex h-full">
            <button
              type="button"
              aria-label={`Send review ${last.seq} to the agent`}
              data-testid="send-review"
              className={`${segmentBase} ${segmentQuiet} [&>svg]:w-3.5 [&>svg]:h-3.5`}
              onClick={() => void send(last.id)}
            >
              <Icon name="terminal" />
            </button>
          </Tooltip>
        )}
      </SegmentedGroup>
    );
  }

  const read = session.viewed.size;
  const comments = review.comments.length;

  const hand = async (state: 'accepted' | 'changes_requested') => {
    const text = summary.trim() ? summary : null;
    if (!(await session.handOver(state, text))) return;
    setOpen(false);
    setSummary('');
    onHandedOver(REVIEW_VERDICT[state]);
  };

  return (
    <MenuPopover
      open={open}
      onOpenChange={setOpen}
      placement="bottom-start"
      className="w-80"
      trigger={(triggerRef) => (
        <SegmentedGroup>
          <button
            ref={triggerRef}
            type="button"
            data-testid="review-chip"
            className={`${segmentBase} ${open ? 'bg-background-tertiary text-text-primary' : segmentQuiet}`}
            onClick={() => setOpen(!open)}
          >
            <span className="truncate">
              Review {review.seq} · {read}/{fileCount} read
              {comments > 0 ? ` · ${comments} comment${comments === 1 ? '' : 's'}` : ''}
            </span>
            <Icon name="caret-down" className="w-3 h-3 shrink-0" />
          </button>
        </SegmentedGroup>
      )}
    >
      <div className="p-2.5 flex flex-col gap-2">
        <textarea
          rows={3}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="Anything to say with it…"
          className="field resize-y"
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn-primary btn-compact"
            data-testid="review-accept"
            disabled={session.busy}
            onClick={() => void hand('accepted')}
          >
            Accept
          </button>
          <button
            type="button"
            className="btn-secondary btn-compact"
            data-testid="review-request-changes"
            disabled={session.busy}
            onClick={() => void hand('changes_requested')}
          >
            Request changes
          </button>
          <button
            type="button"
            className="ml-auto text-[13px] text-text-tertiary hover:text-error transition-colors duration-100"
            onClick={() => {
              setOpen(false);
              void session.abandon();
            }}
          >
            Drop
          </button>
        </div>
        <p className="text-[11px] text-text-tertiary">
          {comments === 0 ? 'No comments yet. ' : `${comments} comment${comments === 1 ? '' : 's'} go with it. `}
          The agent reads it with <code>ouijit task review</code>, and the next diff can be taken against what you
          reviewed.
        </p>
      </div>
    </MenuPopover>
  );
}
