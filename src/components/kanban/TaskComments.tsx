import { useState, type KeyboardEvent } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { selectTaskComments, useTaskCommentStore } from '../../stores/taskCommentStore';
import { formatRelativeTime } from '../../utils/formatDate';
import { MOD_LABEL, isModKey } from '../../utils/modKey';
import { Icon } from '../terminal/Icon';
import type { TaskComment } from '../../types';

interface TaskCommentsProps {
  projectPath: string;
  taskNumber: number;
}

/** A task's comments, newest last, with a composer underneath. */
export function TaskComments({ projectPath, taskNumber }: TaskCommentsProps) {
  const comments = useTaskCommentStore(selectTaskComments(taskNumber));
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ id: number; body: string } | null>(null);

  const submit = async () => {
    const body = draft.trim();
    if (!body) return;
    const result = await useTaskCommentStore.getState().add(projectPath, taskNumber, body);
    if (result.success) setDraft('');
    else useProjectStore.getState().addToast(result.error ?? 'Could not add the comment', 'error');
  };
  const commitEdit = async () => {
    if (!editing) return;
    const body = editing.body.trim();
    if (body) await useTaskCommentStore.getState().update(projectPath, editing.id, body);
    setEditing(null);
  };
  const submitOn = (e: KeyboardEvent<HTMLTextAreaElement>, action: () => void) => {
    if (e.key === 'Enter' && isModKey(e)) {
      e.preventDefault();
      action();
    }
  };

  return (
    <div className="flex flex-col gap-2" data-testid={`task-comments-${taskNumber}`}>
      {comments.map((comment) =>
        editing?.id === comment.id ? (
          <textarea
            key={comment.id}
            className={TEXTAREA_CLASS}
            value={editing.body}
            aria-label="Edit comment"
            autoFocus
            rows={2}
            onChange={(e) => setEditing({ id: comment.id, body: e.target.value })}
            onBlur={() => void commitEdit()}
            onKeyDown={(e) => {
              submitOn(e, () => void commitEdit());
              if (e.key === 'Escape') setEditing(null);
            }}
          />
        ) : (
          <CommentRow
            key={comment.id}
            comment={comment}
            onEdit={() => setEditing({ id: comment.id, body: comment.body })}
            onDelete={() => void useTaskCommentStore.getState().remove(projectPath, comment.id)}
          />
        ),
      )}
      <div className="flex flex-col gap-1">
        <textarea
          className={TEXTAREA_CLASS}
          value={draft}
          aria-label="New comment"
          placeholder="Add a comment…"
          rows={draft ? 3 : 1}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => submitOn(e, () => void submit())}
        />
        {draft.trim() && (
          <div className="flex items-center justify-end gap-2 text-[11px] text-text-tertiary">
            <span>{MOD_LABEL}Enter</span>
            <button type="button" className="btn-primary text-xs" onClick={() => void submit()}>
              Comment
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const TEXTAREA_CLASS =
  'w-full text-xs leading-relaxed bg-transparent border border-border rounded-md px-2 py-1.5 text-text-primary outline-none focus:border-accent resize-none';

function CommentRow({ comment, onEdit, onDelete }: { comment: TaskComment; onEdit: () => void; onDelete: () => void }) {
  return (
    <div className="group/comment rounded-md px-2 py-1.5 bg-ink/[0.03]" data-testid={`comment-${comment.id}`}>
      <div className="flex items-center gap-2 text-[10px] text-text-tertiary">
        <span className="font-medium">{comment.author ?? 'You'}</span>
        <span>{formatRelativeTime(new Date(comment.createdAt))}</span>
        {comment.updatedAt && <span>· edited</span>}
        <span className="flex-1" />
        <button
          type="button"
          className="opacity-0 group-hover/comment:opacity-100 focus:opacity-100 hover:text-text-primary [&>svg]:w-3 [&>svg]:h-3"
          aria-label="Edit comment"
          onClick={onEdit}
        >
          <Icon name="pencil-simple" />
        </button>
        <button
          type="button"
          className="opacity-0 group-hover/comment:opacity-100 focus:opacity-100 hover:text-error [&>svg]:w-3 [&>svg]:h-3"
          aria-label="Delete comment"
          onClick={onDelete}
        >
          <Icon name="trash" />
        </button>
      </div>
      <p className="text-xs text-text-primary whitespace-pre-wrap leading-relaxed break-words">{comment.body}</p>
    </div>
  );
}
