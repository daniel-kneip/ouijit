import { typedHandle } from '../helpers';
import {
  getHooks,
  saveHook,
  deleteHook,
  getHarnesses,
  createHarness,
  renameHarness,
  deleteHarness,
  saveHarnessHook,
  deleteHarnessHook,
  setProjectHarness,
} from '../../db';
import { getHookStatus } from '../../hookServer';

export function registerHookHandlers(): void {
  typedHandle('hooks:get', (projectPath) => getHooks(projectPath));
  typedHandle('hooks:save', (projectPath, hook) => saveHook(projectPath, hook));
  typedHandle('hooks:delete', (projectPath, hookType) => deleteHook(projectPath, hookType));
  typedHandle('hooks:get-status', (ptyId) => getHookStatus(ptyId));

  typedHandle('harness:list', () => getHarnesses());
  typedHandle('harness:create', (name) => createHarness(name));
  typedHandle('harness:rename', (id, name) => renameHarness(id, name));
  typedHandle('harness:delete', (id) => deleteHarness(id));
  typedHandle('harness:save-hook', (id, hook) => saveHarnessHook(id, hook));
  typedHandle('harness:delete-hook', (id, hookType) => deleteHarnessHook(id, hookType));
  typedHandle('harness:set-for-project', (projectPath, harnessId) => setProjectHarness(projectPath, harnessId));
}
