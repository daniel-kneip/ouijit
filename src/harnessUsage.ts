import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { getHarnesses } from './db';
import type { HarnessUsage, UsageReading } from './types';

const TIMEOUT = 30_000;

const USED_KEYS = ['used', 'usedTokens', 'used_tokens', 'tokens', 'consumed', 'spent'];
const LIMIT_KEYS = ['limit', 'total', 'available', 'quota', 'max', 'budget'];
const REMAINING_KEYS = ['remaining', 'left'];
const PERCENT_KEYS = ['percent', 'percentage', 'usedPercent', 'used_percent'];

function number(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') return numberFromText(value.trim());
  return undefined;
}

function numberFromText(text: string): number | undefined {
  const m = /^-?[\d,]*\.?\d+\s*([kKmMbB])?$/.exec(text);
  if (!m) return undefined;
  const base = Number(text.replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(base)) return undefined;
  const scale = { k: 1e3, m: 1e6, b: 1e9 }[m[1]?.toLowerCase() ?? ''] ?? 1;
  return base * scale;
}

function pick(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) if (key in obj) return number(obj[key]);
  return undefined;
}

function fromJson(obj: Record<string, unknown>): UsageReading | null {
  const label = typeof obj.label === 'string' ? obj.label : undefined;
  const percent = pick(obj, PERCENT_KEYS);
  const used = pick(obj, USED_KEYS);
  const limit = pick(obj, LIMIT_KEYS);
  const remaining = pick(obj, REMAINING_KEYS);
  if (used != null) {
    const total = limit ?? (remaining != null ? used + remaining : undefined);
    return { used, limit: total, unit: 'tokens', label };
  }
  if (percent != null) return { used: percent, unit: 'percent', label };
  if (limit != null && remaining != null) return { used: limit - remaining, limit, unit: 'tokens', label };
  return null;
}

function jsonObjects(text: string): Record<string, unknown>[] {
  const candidates = [text.trim(), ...text.split('\n').map((line) => line.trim())];
  const found: Record<string, unknown>[] = [];
  for (const candidate of candidates) {
    if (!candidate.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) found.push(parsed as Record<string, unknown>);
    } catch {
      // Not JSON; the plain-text reading below takes over.
    }
  }
  return found;
}

/**
 * What a usage command printed, read as either JSON (`{"used": 12000, "limit":
 * 200000}`, `{"used": …, "remaining": …}`, or `{"percent": 38}`, each with an
 * optional `label`) or plain text, where the first two numbers are what was
 * used and what is available, a lone `38%` is a share, and `k`/`M` suffixes
 * count. Null when neither reading finds a number.
 */
export function parseUsageOutput(text: string): UsageReading | null {
  for (const obj of jsonObjects(text)) {
    const reading = fromJson(obj);
    if (reading) return reading;
  }
  const percent = /(\d+(?:\.\d+)?)\s*%/.exec(text);
  const numbers = Array.from(text.matchAll(/\d[\d,]*(?:\.\d+)?\s*[kKmMbB]?(?![\w%])/g))
    .map((m) => numberFromText(m[0].replace(/\s+/g, '')))
    .filter((n): n is number => n != null);
  if (numbers.length >= 2) return { used: numbers[0], limit: numbers[1], unit: 'tokens' };
  if (percent) return { used: Number(percent[1]), unit: 'percent' };
  if (numbers.length === 1) return { used: numbers[0], unit: 'tokens' };
  return null;
}

/** Runs the command in the user's shell from their home directory and returns what it printed. */
export function runUsageCommand(
  command: string,
  timeout = TIMEOUT,
): Promise<{ output: string; exitCode: number | null; error?: string }> {
  return new Promise((resolve) => {
    const chunks: string[] = [];
    let done = false;
    const finish = (result: { output: string; exitCode: number | null; error?: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(command, [], {
      cwd: homedir(),
      env: process.env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ output: chunks.join(''), exitCode: null, error: `Timed out after ${timeout / 1000} s` });
    }, timeout);
    child.stdout?.on('data', (data: Buffer) => chunks.push(data.toString()));
    child.stderr?.on('data', (data: Buffer) => chunks.push(data.toString()));
    child.on('close', (exitCode) => finish({ output: chunks.join(''), exitCode }));
    child.on('error', (err) => finish({ output: chunks.join(''), exitCode: null, error: err.message }));
  });
}

/** Runs every harness's usage command at once and reports each result, errors included. */
export async function readHarnessUsage(timeout = TIMEOUT): Promise<HarnessUsage[]> {
  const harnesses = (await getHarnesses()).filter((h) => h.usageCommand);
  return Promise.all(
    harnesses.map(async (harness): Promise<HarnessUsage> => {
      const at = new Date().toISOString();
      const result = await runUsageCommand(harness.usageCommand!, timeout);
      const base = { harnessId: harness.id, name: harness.name, at };
      if (result.error) return { ...base, error: result.error };
      const reading = parseUsageOutput(result.output);
      if (reading) return { ...base, reading };
      const tail = result.output.trim().split('\n').slice(-3).join('\n');
      return {
        ...base,
        error:
          result.exitCode !== 0
            ? `Exited with ${result.exitCode ?? 'no code'}${tail ? `: ${tail}` : ''}`
            : `No numbers in the output${tail ? `: ${tail}` : ''}`,
      };
    }),
  );
}
