import { typedHandle } from '../helpers';
import { refreshHealth } from '../../healthCheck';
import { memoryReport } from '../../memoryReport';

export function registerHealthHandlers(): void {
  typedHandle('health:check', () => refreshHealth());
  typedHandle('health:memory', () => memoryReport());
}
