/**
 * The comment list under a task: the composer sends on Cmd/Ctrl+Enter, a
 * comment can be edited in place or removed, and the store reloads after each
 * write so every card and city shows the same list.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, screen, waitFor } from '@testing-library/react';
import { TaskComments } from '../../components/kanban/TaskComments';
import { useTaskCommentStore } from '../../stores/taskCommentStore';
import type { TaskComment } from '../../types';

const PROJECT = '/project';

describe('task comments', () => {
  beforeEach(() => {
    useTaskCommentStore.setState({ projectPath: null, byTask: {} });
    vi.clearAllMocks();
  });

  test('comments are written, edited and removed through the api and reloaded after each write', async () => {
    const api = window.api.task;
    let stored: TaskComment[] = [];
    vi.mocked(api.comments).mockImplementation(async () => stored);
    vi.mocked(api.addComment).mockImplementation(async (_p, taskNumber, body) => {
      const comment = { id: stored.length + 1, taskNumber, body, createdAt: new Date().toISOString() };
      stored = [...stored, comment];
      return { success: true, comment };
    });
    vi.mocked(api.updateComment).mockImplementation(async (_p, id, body) => {
      stored = stored.map((c) => (c.id === id ? { ...c, body, updatedAt: new Date().toISOString() } : c));
      return { success: true };
    });
    vi.mocked(api.deleteComment).mockImplementation(async (_p, id) => {
      stored = stored.filter((c) => c.id !== id);
      return { success: true };
    });

    render(<TaskComments projectPath={PROJECT} taskNumber={4} />);
    const composer = screen.getByLabelText('New comment') as HTMLTextAreaElement;

    // Enter alone is a newline; the modifier sends. Whitespace never sends.
    fireEvent.change(composer, { target: { value: '   ' } });
    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true, ctrlKey: true });
    expect(api.addComment).not.toHaveBeenCalled();
    fireEvent.change(composer, { target: { value: 'Blocked on the ops ticket' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(api.addComment).not.toHaveBeenCalled();
    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true, ctrlKey: true });
    await waitFor(() => expect(api.addComment).toHaveBeenCalledWith(PROJECT, 4, 'Blocked on the ops ticket'));
    await screen.findByTestId('comment-1');
    expect(composer.value).toBe('');
    expect(useTaskCommentStore.getState().byTask[4]).toHaveLength(1);

    fireEvent.click(screen.getByLabelText('Edit comment'));
    const editor = screen.getByLabelText('Edit comment') as HTMLTextAreaElement;
    expect(editor.value).toBe('Blocked on the ops ticket');
    fireEvent.change(editor, { target: { value: 'Unblocked, ops answered' } });
    fireEvent.keyDown(editor, { key: 'Enter', metaKey: true, ctrlKey: true });
    await waitFor(() => expect(screen.getByTestId('comment-1').textContent).toContain('Unblocked, ops answered'));
    expect(screen.getByTestId('comment-1').textContent).toContain('edited');

    fireEvent.click(screen.getByLabelText('Delete comment'));
    await waitFor(() => expect(screen.queryByTestId('comment-1')).toBeNull());
    expect(api.deleteComment).toHaveBeenCalledWith(PROJECT, 1);
  });
});
