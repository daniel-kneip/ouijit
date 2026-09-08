import type Database from 'better-sqlite3';

export interface TaskCommentRow {
  id: number;
  project_path: string;
  task_number: number;
  body: string;
  author: string | null;
  created_at: string;
  updated_at: string | null;
}

export class TaskCommentRepo {
  constructor(private db: Database.Database) {}

  getAllForProject(projectPath: string): TaskCommentRow[] {
    return this.db
      .prepare('SELECT * FROM task_comments WHERE project_path = ? ORDER BY created_at, id')
      .all(projectPath) as TaskCommentRow[];
  }

  get(projectPath: string, id: number): TaskCommentRow | undefined {
    return this.db.prepare('SELECT * FROM task_comments WHERE project_path = ? AND id = ?').get(projectPath, id) as
      | TaskCommentRow
      | undefined;
  }

  add(projectPath: string, taskNumber: number, body: string, author: string | null): TaskCommentRow {
    const result = this.db
      .prepare('INSERT INTO task_comments (project_path, task_number, body, author, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(projectPath, taskNumber, body, author, new Date().toISOString());
    return this.get(projectPath, Number(result.lastInsertRowid))!;
  }

  update(projectPath: string, id: number, body: string): boolean {
    const result = this.db
      .prepare('UPDATE task_comments SET body = ?, updated_at = ? WHERE project_path = ? AND id = ?')
      .run(body, new Date().toISOString(), projectPath, id);
    return result.changes > 0;
  }

  remove(projectPath: string, id: number): boolean {
    return (
      this.db.prepare('DELETE FROM task_comments WHERE project_path = ? AND id = ?').run(projectPath, id).changes > 0
    );
  }

  removeForTask(projectPath: string, taskNumber: number): void {
    this.db
      .prepare('DELETE FROM task_comments WHERE project_path = ? AND task_number = ?')
      .run(projectPath, taskNumber);
  }
}
