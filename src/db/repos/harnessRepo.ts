import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { HookType } from './hookRepo';

export interface HarnessRow {
  id: string;
  name: string;
  sort_order: number;
  created_at: string;
  usage_command: string | null;
}

export interface HarnessHookRow {
  harness_id: string;
  type: HookType;
  id: string;
  name: string;
  command: string;
  description: string | null;
  restart_if_running: number;
}

export class HarnessRepo {
  constructor(private db: Database.Database) {}

  getAll(): HarnessRow[] {
    return this.db.prepare('SELECT * FROM harnesses ORDER BY sort_order, created_at').all() as HarnessRow[];
  }

  get(id: string): HarnessRow | undefined {
    return this.db.prepare('SELECT * FROM harnesses WHERE id = ?').get(id) as HarnessRow | undefined;
  }

  create(name: string): HarnessRow {
    const id = randomUUID();
    const maxOrder = this.db.prepare('SELECT MAX(sort_order) AS max_order FROM harnesses').get() as {
      max_order: number | null;
    };
    this.db
      .prepare('INSERT INTO harnesses (id, name, sort_order) VALUES (?, ?, ?)')
      .run(id, name, (maxOrder.max_order ?? -1) + 1);
    return this.get(id)!;
  }

  rename(id: string, name: string): void {
    this.db.prepare('UPDATE harnesses SET name = ? WHERE id = ?').run(name, id);
  }

  setUsageCommand(id: string, command: string | null): void {
    this.db.prepare('UPDATE harnesses SET usage_command = ? WHERE id = ?').run(command, id);
  }

  /** Projects assigned to the harness fall back to their own hooks. */
  delete(id: string): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE projects SET harness_id = NULL WHERE harness_id = ?').run(id);
      this.db.prepare('DELETE FROM harnesses WHERE id = ?').run(id);
    })();
  }

  getHooks(harnessId: string): HarnessHookRow[] {
    return this.db
      .prepare('SELECT * FROM harness_hooks WHERE harness_id = ? ORDER BY type')
      .all(harnessId) as HarnessHookRow[];
  }

  saveHook(
    harnessId: string,
    type: HookType,
    name: string,
    command: string,
    id?: string,
    description?: string,
    restartIfRunning = false,
  ): void {
    this.db
      .prepare(
        `
      INSERT INTO harness_hooks (harness_id, type, id, name, command, description, restart_if_running)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(harness_id, type) DO UPDATE SET
        id = excluded.id,
        name = excluded.name,
        command = excluded.command,
        description = excluded.description,
        restart_if_running = excluded.restart_if_running
    `,
      )
      .run(harnessId, type, id ?? randomUUID(), name, command, description ?? null, restartIfRunning ? 1 : 0);
  }

  deleteHook(harnessId: string, type: HookType): void {
    this.db.prepare('DELETE FROM harness_hooks WHERE harness_id = ? AND type = ?').run(harnessId, type);
  }
}
