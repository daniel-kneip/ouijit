/**
 * HTTP API server for Claude Code hook communication + hook installer.
 *
 * Hooks fire lifecycle events (Stop, UserPromptSubmit, Notification) which
 * hit this server via curl. The server forwards status updates to the
 * renderer so terminal cards show the correct busy/idle indicator.
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { BrowserWindow } from 'electron';
import { isPtyActive } from './ptyManager';
import { getShellIntegrationDir, installShellIntegration } from './shellIntegration';
import { getLogger } from './logger';
import { handleApiRequest } from './api/router';
import { authenticateRequest, type AuthContext } from './apiAuth';
import { getCliReferencePath, getWrapperBinDir } from './paths';
import { CLI_REFERENCE } from './agentGuide';

export { CLI_REFERENCE, getCliReferencePath };

const hookServerLog = getLogger().scope('hookServer');

let server: http.Server | null = null;
let apiPort = 0;
let mainWindow: BrowserWindow | null = null;

export function getApiPort(): number {
  return apiPort;
}

// ── Hook status state (main-process, survives renderer reloads) ──────

export type HookStatus = 'thinking' | 'ready';

export interface HookStatusEntry {
  status: HookStatus;
  thinkingCount: number;
}

const hookStatusMap = new Map<string, HookStatusEntry>();

export function getHookStatus(ptyId: string): HookStatusEntry | null {
  return hookStatusMap.get(ptyId) ?? null;
}

export function clearHookStatus(ptyId: string): void {
  hookStatusMap.delete(ptyId);
}

export function clearAllHookStatuses(): void {
  hookStatusMap.clear();
}

// ── Action handlers ──────────────────────────────────────────────────

type ActionHandler = (body: Record<string, unknown>, auth: AuthContext) => void;

const VALID_STATUSES = new Set<HookStatus>(['thinking', 'ready']);

const actionHandlers: Record<string, ActionHandler> = {
  status(body, _auth) {
    const { ptyId, status } = body;
    if (typeof ptyId !== 'string' || typeof status !== 'string') return;
    if (!VALID_STATUSES.has(status as HookStatus)) return;
    if (!isPtyActive(ptyId)) return;
    hookServerLog.info('status update', { ptyId, status });

    // Update main-process state map
    const entry = hookStatusMap.get(ptyId);
    if (status === 'thinking') {
      hookStatusMap.set(ptyId, {
        status: 'thinking',
        thinkingCount: (entry?.thinkingCount ?? 0) + 1,
      });
    } else {
      hookStatusMap.set(ptyId, {
        status: 'ready',
        thinkingCount: entry?.thinkingCount ?? 0,
      });
    }

    // Forward to renderer for real-time UI updates
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent-hook-status', ptyId, status);
    }
  },
};

// ── Server lifecycle ─────────────────────────────────────────────────

/** Call once at app init; resolves once the server is listening. */
export function startHookServer(window: BrowserWindow): Promise<void> {
  if (server) return Promise.resolve();
  mainWindow = window;

  return new Promise((resolve, reject) => {
    const s = http.createServer((req, res) => {
      // REST API for CLI
      if (req.url?.startsWith('/api/')) {
        handleApiRequest(req, res, window);
        return;
      }

      // Hook endpoint for Claude Code lifecycle events
      if (req.method !== 'POST' || req.url !== '/hook') {
        res.writeHead(404);
        res.end();
        return;
      }

      // Any process on the host loopback (and every sandboxed VM via
      // host.lima.internal) can reach this endpoint. Require a valid
      // per-PTY bearer token so only legitimate hook scripts succeed.
      const auth = authenticateRequest(req.headers['authorization']);
      if (!auth) {
        res.writeHead(401);
        res.end();
        return;
      }

      let rawBody = '';
      req.on('data', (chunk: Buffer) => {
        rawBody += chunk.toString();
        // Limit body size (4KB is plenty)
        if (rawBody.length > 4096) {
          req.destroy();
        }
      });
      req.on('end', () => {
        try {
          const body = JSON.parse(rawBody) as Record<string, unknown>;
          const action = body.action;
          if (typeof action !== 'string') {
            // Unknown / missing action is a valid no-op so older hook
            // scripts don't fail against a newer server. Matches the
            // 200-on-unknown-action contract.
            res.writeHead(200);
            res.end();
            return;
          }
          const handler = actionHandlers[action];
          if (!handler) {
            res.writeHead(200);
            res.end();
            return;
          }
          // All registered actions require a ptyId. Reject a missing
          // or non-string value with 400 so misconfigured callers
          // notice rather than silently no-oping inside the handler.
          if (typeof body.ptyId !== 'string') {
            res.writeHead(400);
            res.end();
            return;
          }
          // Every hook action is scoped to the caller's own PTY. A
          // sandbox-scoped token for pty A must not be able to set
          // status on pty B — reject loudly with 403.
          if (body.ptyId !== auth.ptyId) {
            res.writeHead(403);
            res.end();
            return;
          }
          handler(body, auth);
          res.writeHead(200);
          res.end();
        } catch {
          res.writeHead(400);
          res.end();
        }
      });
    });

    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      if (addr && typeof addr === 'object') {
        apiPort = addr.port;
      }
      server = s;
      resolve();
    });
  });
}

/** Destroys active connections so in-flight requests don't delay shutdown. */
export function stopHookServer(): Promise<void> {
  if (!server) return Promise.resolve();
  const s = server;
  server = null;
  return new Promise((resolve) => {
    // Close the server and destroy any lingering sockets
    s.close(() => resolve());
    s.closeAllConnections();
  });
}

// ── Hook definitions ─────────────────────────────────────────────────

interface HookEntry {
  type: 'command';
  command: string;
}
interface HookMatcher {
  matcher?: string;
  hooks: HookEntry[];
}

function buildHookSettings(hookCmd: string): { hooks: Record<string, HookMatcher[]> } {
  return {
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${hookCmd} status status=thinking` }] }],
      PostToolUse: [{ hooks: [{ type: 'command', command: `${hookCmd} status status=thinking` }] }],
      Stop: [{ hooks: [{ type: 'command', command: `${hookCmd} status status=ready` }] }],
      Notification: [
        {
          matcher: 'permission_prompt|idle_prompt',
          hooks: [{ type: 'command', command: `${hookCmd} status status=ready` }],
        },
      ],
    },
  };
}

// ── Hook installer ───────────────────────────────────────────────────

// Safe pattern: alphanumeric, hyphens, dots, underscores
const SAFE_VALUE = '[a-zA-Z0-9._-]+';

export const HELPER_SCRIPT = [
  '#!/bin/bash',
  '# Ouijit API client for Claude Code hooks',
  '# Usage: ouijit-hook <action> [key=value ...]',
  '[ -z "$OUIJIT_API_URL" ] && exit 0',
  '[ -z "$OUIJIT_API_TOKEN" ] && exit 0',
  '',
  '# Validate inputs to prevent malformed JSON',
  `[[ "$OUIJIT_PTY_ID" =~ ^${SAFE_VALUE}$ ]] || exit 0`,
  'action="$1"; shift',
  `[[ "$action" =~ ^${SAFE_VALUE}$ ]] || exit 0`,
  '',
  'json="\\"ptyId\\":\\"$OUIJIT_PTY_ID\\",\\"action\\":\\"$action\\""',
  'for arg in "$@"; do',
  '  key="${arg%%=*}"; val="${arg#*=}"',
  `  [[ "$key" =~ ^${SAFE_VALUE}$ ]] || continue`,
  `  [[ "$val" =~ ^${SAFE_VALUE}$ ]] || continue`,
  '  json="$json,\\"$key\\":\\"$val\\""',
  'done',
  '',
  'curl -sf -o /dev/null -X POST "$OUIJIT_API_URL/hook" \\',
  '  -H "Content-Type: application/json" \\',
  '  -H "Authorization: Bearer $OUIJIT_API_TOKEN" \\',
  '  -d "{$json}" 2>/dev/null &',
  '',
].join('\n');

/**
 * Bash snippet that resolves the real `${binaryName}` binary on PATH while
 * defending against exec'ing back into this wrapper. Shared by the claude,
 * codex, and pi wrappers (all of which install into `~/.config/Ouijit/bin`
 * and shadow a tool of the same name on PATH).
 *
 * Defines (on success): `WRAPPER_DIR`, `WRAPPER_SELF`, `CLEAN_PATH`, `REAL_BIN`,
 * and re-exports `PATH` with the wrapper dir kept in front so the ouijit CLI
 * stays reachable inside the agent's subshells.
 *
 * The string `:$WRAPPER_DIR:` substitution alone isn't enough — if PATH spells
 * the wrapper dir twice with even a slight difference (trailing slash, symlink
 * target, normalised vs raw) the strip silently misses one copy and we exec
 * ourselves. Each recursion appends a few KB of injected `-c` / `--settings`
 * overrides to argv until execve hits ARG_MAX and fails with E2BIG.
 * Comparing candidates by inode (`-ef`) collapses every spelling onto the same
 * identity check.
 */
function buildWrapperResolver(binaryName: string): string {
  return [
    'WRAPPER_DIR="$(cd "$(dirname "$0")" && pwd)"',
    'WRAPPER_SELF="$WRAPPER_DIR/$(basename "$0")"',
    'CLEAN_PATH=":$PATH:"',
    'CLEAN_PATH="${CLEAN_PATH//:$WRAPPER_DIR:/:}"',
    'CLEAN_PATH="${CLEAN_PATH#:}"',
    'CLEAN_PATH="${CLEAN_PATH%:}"',
    '',
    `REAL_BIN="$(PATH="$CLEAN_PATH" command -v ${binaryName} 2>/dev/null)"`,
    'if [ -n "$REAL_BIN" ] && [ "$REAL_BIN" -ef "$WRAPPER_SELF" ]; then',
    '  REAL_BIN=""',
    'fi',
    'if [ -z "$REAL_BIN" ]; then',
    '  _IFS="$IFS"; IFS=":"',
    '  for _dir in $CLEAN_PATH; do',
    '    [ -z "$_dir" ] && continue',
    `    if [ -x "$_dir/${binaryName}" ] && [ ! "$_dir/${binaryName}" -ef "$WRAPPER_SELF" ]; then`,
    `      REAL_BIN="$_dir/${binaryName}"`,
    '      break',
    '    fi',
    '  done',
    '  IFS="$_IFS"; unset _IFS _dir',
    'fi',
    'if [ -z "$REAL_BIN" ]; then',
    `  echo "ouijit: ${binaryName} not found on PATH (or only the Ouijit wrapper was found)" >&2`,
    '  exit 1',
    'fi',
    '',
    '# Re-export PATH so the ouijit CLI is reachable from inside the agent.',
    'export PATH="$WRAPPER_DIR:$CLEAN_PATH"',
  ].join('\n');
}

/** Bash wrapper that shadows `claude` and injects hook settings via --settings. */
export const CLAUDE_WRAPPER = [
  '#!/bin/bash',
  '# Ouijit claude wrapper — injects hook settings at invocation time.',
  buildWrapperResolver('claude'),
  '',
  '# Claude subcommands (mcp, update, doctor, config, install, plugin, ...)',
  '# do not accept top-level flags like --settings / --append-system-prompt-file.',
  '# Injecting them either errors out or reroutes the subcommand name into an',
  '# interactive prompt (same shape as the Pi bug in issue #177). Detect the',
  '# first non-flag arg and, if it names a known subcommand, exec the real',
  '# claude without injection.',
  'for arg in "$@"; do',
  '  case "$arg" in',
  '    -*) continue ;;',
  '    mcp|update|doctor|config|install|plugin|project|agents|setup-token|migrate-installer|ultrareview|auth)',
  '      exec "$REAL_BIN" "$@"',
  '      ;;',
  '    *) break ;;',
  '  esac',
  'done',
  '',
  '# CLI reference file for Claude Code agents',
  'REFERENCE_FILE="$HOME/.config/Ouijit/ouijit-cli-reference.md"',
  '',
  '# If ouijit is not running, just exec the real claude with CLI awareness',
  'if [ -z "$OUIJIT_API_URL" ]; then',
  '  exec "$REAL_BIN" --append-system-prompt-file "$REFERENCE_FILE" "$@"',
  'fi',
  '',
  '# Inject ouijit hooks via --settings (merges with user settings at runtime)',
  `exec "$REAL_BIN" --settings '${JSON.stringify(buildHookSettings('$HOME/.config/Ouijit/bin/ouijit-hook'))}' --append-system-prompt-file "$REFERENCE_FILE" "$@"`,
  '',
].join('\n');

// ── Codex wrapper ────────────────────────────────────────────────────
// Codex has no `--settings` / `--append-system-prompt-file` flags, so the
// wrapper injects everything via `codex -c key=value` config overrides
// (where the value is parsed as TOML, falling back to a raw string):
//   • developer_instructions — the Ouijit CLI reference, surfaced as a
//     `developer` role message (appends; does NOT replace base instructions
//     like model_instructions_file would). The markdown isn't valid TOML, so
//     it's kept as a string — exactly the type this key wants.
//   • hooks.{UserPromptSubmit,PostToolUse,Stop} — Codex's lifecycle-hook
//     engine (stable, on by default). UserPromptSubmit / PostToolUse →
//     thinking; Stop → ready, and codex-rs runs Stop only once a turn has no
//     follow-up left. PermissionRequest is deliberately absent: it reads like
//     the counterpart to claude's `Notification` permission prompt, but
//     codex-rs runs it for every approval check, ahead of the guardian and of
//     any user prompt, so it fires mid-turn on work the user is never asked
//     about. Codex has no event for "the user is being asked".
//     The values are TOML arrays of inline tables; commands run via the user's
//     shell, so $HOME stays literal. (We can't mark these `async = true` —
//     Codex skips async hooks with a warning today. ouijit-hook itself
//     backgrounds its `curl` and exits in milliseconds, so sync is fine.)
//   • notify — Codex's older, always-on turn-complete notifier; also mapped
//     to status=ready (a harmless fallback if the hooks engine is disabled).
//     Codex runs `notify[0] notify[1..] <json>` with no shell, so we wrap it
//     as ["bash","-c","<cmd>"] — bash expands $HOME and the trailing JSON
//     payload becomes $0 (ignored).
//   • hooks.state."<key>".trusted_hash — pre-trust each hook so Codex doesn't
//     gate it behind the `/hooks` review prompt on every fresh session. The
//     hash mirrors codex-rs/hooks/src/engine/discovery.rs:command_hook_hash:
//     sha256 of canonical JSON of the normalized hook identity. If a future
//     Codex changes the normalization our hash mismatches → trust_status is
//     `Modified` → hook is skipped just like an untrusted hook, and the user
//     falls back to the same one-time `/hooks` approval as before. Graceful.

/** Path to ouijit-hook with literal $HOME (expanded by whatever shell runs it). */
const CODEX_OUIJIT_HOOK = '$HOME/.config/Ouijit/bin/ouijit-hook';

/** SessionFlags layer source path Codex synthesizes for `-c` overrides (see discovery.rs). */
const CODEX_SESSION_FLAGS_PATH = '/<session-flags>/config.toml';

/**
 * Lifecycle hook events Codex exposes that we map to a status. Each entry is
 * `[event_name, status, event_snake]`. `event_snake` matches `hook_event_key_label`
 * in codex-rs and is what Codex uses inside the persisted hook key.
 */
const CODEX_STATUS_HOOKS: ReadonlyArray<readonly [event: string, status: 'thinking' | 'ready', eventSnake: string]> = [
  ['UserPromptSubmit', 'thinking', 'user_prompt_submit'],
  ['PostToolUse', 'thinking', 'post_tool_use'],
  ['Stop', 'ready', 'stop'],
];

function codexHookCommand(hookPath: string, status: 'thinking' | 'ready'): string {
  return `${hookPath} status status=${status}`;
}

/** TOML array-of-one-inline-table value for a single Codex `hooks.<Event>` entry (one command hook). */
function codexHookEventValue(hookPath: string, status: 'thinking' | 'ready'): string {
  return `[{hooks=[{type="command",command="${codexHookCommand(hookPath, status)}"}]}]`;
}

/** TOML/JSON array value for Codex's `notify` config — a shell wrapper that ignores the trailing payload arg. */
function codexNotifyValue(hookPath: string): string {
  return JSON.stringify(['bash', '-c', codexHookCommand(hookPath, 'ready')]);
}

/**
 * Build the persisted hook key Codex uses for a single command hook in our
 * single-group/single-handler layout: `<source>:<event_snake>:0:0`.
 */
function codexHookStateKey(source: string, eventSnake: string): string {
  return `${source}:${eventSnake}:0:0`;
}

/**
 * Canonical JSON: recursively sort object keys, no whitespace. Mirrors
 * codex-rs/config/src/fingerprint.rs:canonical_json + serde_json::to_vec.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

/**
 * Compute the `current_hash` Codex expects in `hooks.state.<key>.trusted_hash`
 * for one of our command hooks. Mirrors `command_hook_hash` in
 * codex-rs/hooks/src/engine/discovery.rs:
 *
 *   identity = { event_name, matcher (skipped when None), hooks: [normalized] }
 *   normalized = { type:"command", command, commandWindows (skipped when None),
 *                  timeout (default 600), async:false, statusMessage (skipped) }
 *   hash = sha256(canonical_json(identity))
 *
 * None-valued Options are skipped by toml::Serializer (TOML has no null) and so
 * don't appear in the JSON Codex hashes.
 */
function codexHookTrustHash(eventSnake: string, command: string): string {
  const identity = {
    event_name: eventSnake,
    hooks: [{ type: 'command', command, timeout: 600, async: false }],
  };
  const hex = createHash('sha256').update(canonicalJson(identity)).digest('hex');
  return `sha256:${hex}`;
}

/** Bash wrapper that shadows `codex` and injects the CLI reference + status hooks via `-c` overrides. */
export const CODEX_WRAPPER = [
  '#!/bin/bash',
  '# Ouijit codex wrapper — injects the Ouijit CLI reference and status',
  '# hooks via `-c` config overrides (Codex has no --settings flag).',
  buildWrapperResolver('codex'),
  '',
  '# Ouijit CLI reference file — surfaced via developer_instructions',
  'REFERENCE_FILE="$HOME/.config/Ouijit/ouijit-cli-reference.md"',
  '',
  '# If ouijit is not running, just exec the real codex with CLI awareness',
  'if [ -z "$OUIJIT_API_URL" ]; then',
  '  exec "$REAL_BIN" -c "developer_instructions=$(cat "$REFERENCE_FILE" 2>/dev/null)" "$@"',
  'fi',
  '',
  'exec "$REAL_BIN" \\',
  '  -c "developer_instructions=$(cat "$REFERENCE_FILE" 2>/dev/null)" \\',
  ...CODEX_STATUS_HOOKS.flatMap(([event, status, eventSnake]) => {
    const cmd = codexHookCommand(CODEX_OUIJIT_HOOK, status);
    const stateKey = codexHookStateKey(CODEX_SESSION_FLAGS_PATH, eventSnake);
    const hash = codexHookTrustHash(eventSnake, cmd);
    return [
      `  -c 'hooks.${event}=${codexHookEventValue(CODEX_OUIJIT_HOOK, status)}' \\`,
      `  -c 'hooks.state."${stateKey}".trusted_hash="${hash}"' \\`,
    ];
  }),
  `  -c 'notify=${codexNotifyValue(CODEX_OUIJIT_HOOK)}' \\`,
  '  "$@"',
  '',
].join('\n');

// ── Pi wrapper ───────────────────────────────────────────────────────
// Pi exposes lifecycle events only to TypeScript extensions, not as
// shell-command hooks. We ship a tiny extension and load it via
// `pi --extension <path>`; the same source auto-discovers in the sandbox
// VM. OUIJIT_HOOK_BIN (set by the wrapper / VM init) carries the path to
// ouijit-hook so the extension source is identical in both contexts.

export function getPiExtensionPath(): string {
  return path.join(os.homedir(), '.config', 'Ouijit', 'pi', 'ouijit-extension.ts');
}

export const PI_EXTENSION = `// Ouijit Pi extension — bridges Pi turn events to the per-terminal
// status indicator. Auto-installed; safe to delete (Ouijit recreates it).
// No-ops when OUIJIT_HOOK_BIN is unset, so it's harmless outside Ouijit.

type OuijitStatus = 'thinking' | 'ready';

interface OuijitPiApi {
  on(event: string, handler: () => void): void;
  exec(command: string, args: string[], options?: { timeout?: number }): Promise<unknown>;
}

export default async (pi: OuijitPiApi) => {
  const hookBin = process.env.OUIJIT_HOOK_BIN;
  if (!hookBin) return;

  const ping = (status: OuijitStatus) => {
    pi.exec(hookBin, ['status', \`status=\${status}\`], { timeout: 2000 }).catch(() => {});
  };

  pi.on('agent_start', () => ping('thinking'));
  pi.on('agent_end', () => ping('ready'));
};
`;

export const PI_WRAPPER = [
  '#!/bin/bash',
  '# Ouijit pi wrapper — loads the ouijit-extension Pi extension so',
  '# turn-complete events surface as terminal status updates.',
  buildWrapperResolver('pi'),
  '',
  '# Pi subcommands run in their own non-interactive mode. Injecting',
  '# --append-system-prompt / --extension forces Pi back into an interactive',
  '# session, swallowing the subcommand (see issue #177). Detect the first',
  '# non-flag arg and, if it names a known subcommand, exec the real pi',
  '# without injection.',
  'for arg in "$@"; do',
  '  case "$arg" in',
  '    -*) continue ;;',
  '    install|remove|uninstall|update|list|config)',
  '      exec "$REAL_BIN" "$@"',
  '      ;;',
  '    *) break ;;',
  '  esac',
  'done',
  '',
  'REFERENCE_FILE="$HOME/.config/Ouijit/ouijit-cli-reference.md"',
  'EXTENSION_FILE="$HOME/.config/Ouijit/pi/ouijit-extension.ts"',
  'HOOK_BIN="$HOME/.config/Ouijit/bin/ouijit-hook"',
  '',
  'if [ -z "$OUIJIT_API_URL" ]; then',
  '  exec "$REAL_BIN" --append-system-prompt "$(cat "$REFERENCE_FILE" 2>/dev/null)" "$@"',
  'fi',
  '',
  '# OUIJIT_HOOK_BIN is read by the extension to shell out to ouijit-hook.',
  'OUIJIT_HOOK_BIN="$HOOK_BIN" exec "$REAL_BIN" \\',
  '  --append-system-prompt "$(cat "$REFERENCE_FILE" 2>/dev/null)" \\',
  '  --extension "$EXTENSION_FILE" \\',
  '  "$@"',
  '',
].join('\n');

// ── opencode plugin + wrapper ────────────────────────────────────────
// opencode exposes lifecycle events only to JS/TS plugins, and it has no
// --append-system-prompt / hook CLI flag. Status and the CLI reference are
// injected two different ways:
//   • Status plugin: written into opencode's auto-load dir
//     (~/.config/opencode/plugins), which opencode imports directly at
//     startup. This is the only mechanism that works on released opencode:
//     a `plugin` entry in config (even an absolute path) is instead treated
//     as an npm package and `bun add`-ed, which fails for a local file. The
//     plugin loads for every opencode session but is a no-op unless
//     OUIJIT_HOOK_BIN is set (only the wrapper sets it), so a plain
//     `opencode` run is unaffected.
//   • CLI reference: rides on OPENCODE_CONFIG_CONTENT, an env var opencode
//     parses as JSON and merges additively into the resolved config. Its
//     `instructions` array concatenates onto the user's (never replaces).

/** opencode's global plugin auto-load directory. */
export function getOpencodePluginDir(): string {
  return path.join(os.homedir(), '.config', 'opencode', 'plugins');
}

export function getOpencodePluginPath(): string {
  return path.join(getOpencodePluginDir(), 'ouijit.ts');
}

export const OPENCODE_PLUGIN = `// Ouijit opencode plugin - bridges opencode session status to the
// per-terminal status indicator. Auto-installed; safe to delete (Ouijit
// recreates it). No-ops when OUIJIT_HOOK_BIN is unset, so it is harmless if
// it ever loads outside Ouijit.

type OuijitStatus = 'thinking' | 'ready';

interface OuijitShellResult {
  quiet(): { nothrow(): Promise<unknown> };
}

interface OuijitOpencodeContext {
  $: (strings: TemplateStringsArray, ...values: unknown[]) => OuijitShellResult;
}

interface OuijitSessionEvent {
  type: string;
  properties?: { status?: { type?: string } };
}

export const OuijitStatusPlugin = async ({ $ }: OuijitOpencodeContext) => {
  const hookBin = process.env.OUIJIT_HOOK_BIN;
  if (!hookBin) return {};

  // Only report real transitions so we don't spawn a hook process per event.
  let last: OuijitStatus | null = null;
  const ping = (status: OuijitStatus) => {
    if (status === last) return;
    last = status;
    try {
      $\`\${hookBin} status status=\${status}\`.quiet().nothrow().catch(() => {});
    } catch {
      // best-effort: never let status reporting break the session
    }
  };

  return {
    // session.status carries opencode's busy/idle state (session.idle is
    // deprecated). status.type is 'busy' | 'retry' | 'idle'; anything that is
    // not idle means the agent is still working.
    event: async ({ event }: { event: OuijitSessionEvent }) => {
      if (event?.type !== 'session.status') return;
      ping(event.properties?.status?.type === 'idle' ? 'ready' : 'thinking');
    },
  };
};
`;

export const OPENCODE_WRAPPER = [
  '#!/bin/bash',
  '# Ouijit opencode wrapper - injects the Ouijit CLI reference via',
  '# OPENCODE_CONFIG_CONTENT (opencode parses it as JSON and merges it into',
  '# the resolved config; `instructions` concatenates onto the user config).',
  '# The status plugin is loaded separately from opencode auto-load dir; this',
  '# wrapper only flips it on by exporting OUIJIT_HOOK_BIN. opencode has no',
  '# system-prompt or hook CLI flags, so everything rides on env + config.',
  buildWrapperResolver('opencode'),
  '',
  '# opencode utility subcommands do not start an agent session. Run them',
  '# untouched so config injection never interferes (mirrors the claude and',
  '# pi subcommand guards).',
  'for arg in "$@"; do',
  '  case "$arg" in',
  '    -*) continue ;;',
  '    auth|models|upgrade|uninstall|stats|mcp|serve|github|export|import|debug|agent|session|db|plugin)',
  '      exec "$REAL_BIN" "$@"',
  '      ;;',
  '    *) break ;;',
  '  esac',
  'done',
  '',
  'REFERENCE_FILE="$HOME/.config/Ouijit/ouijit-cli-reference.md"',
  'HOOK_BIN="$HOME/.config/Ouijit/bin/ouijit-hook"',
  '',
  '# Add the CLI reference to opencode instructions for this invocation only.',
  'OUIJIT_OPENCODE_CONFIG="{\\"instructions\\":[\\"$REFERENCE_FILE\\"]}"',
  '',
  '# If ouijit is not running, still surface the CLI reference but leave the',
  '# status plugin inert (OUIJIT_HOOK_BIN unset).',
  'if [ -z "$OUIJIT_API_URL" ]; then',
  '  OPENCODE_CONFIG_CONTENT="$OUIJIT_OPENCODE_CONFIG" exec "$REAL_BIN" "$@"',
  'fi',
  '',
  '# OUIJIT_HOOK_BIN activates the ouijit status plugin (loaded from opencode',
  '# auto-load dir); it shells out to ouijit-hook on session.status busy/idle.',
  'OPENCODE_CONFIG_CONTENT="$OUIJIT_OPENCODE_CONFIG" OUIJIT_HOOK_BIN="$HOOK_BIN" exec "$REAL_BIN" "$@"',
  '',
].join('\n');

// ── Kiro CLI agent config + hooks + wrapper ──────────────────────────
// Kiro CLI (`kiro-cli`, formerly Amazon Q Developer CLI) ships two engines:
//   • v2 (default): lifecycle hooks and the system prompt both live in an
//     agent config JSON (~/.kiro/agents/<name>.json). There is no CLI flag
//     to inject either directly, so Ouijit maintains an `ouijit` agent that
//     mirrors the default agent (all tools, global MCP config) plus the
//     status hooks and the CLI reference, and the wrapper selects it via
//     `--agent ouijit` unless the user picked their own agent.
//   • v3 (early access, `kiro-cli --v3`): agent configs move to a Markdown
//     format and hooks move to standalone files. Global hook files in
//     ~/.kiro/hooks/*.json fire in every workspace, so Ouijit installs its
//     status hooks there. They are harmless outside Ouijit terminals:
//     ouijit-hook exits immediately when OUIJIT_API_URL is unset.

/** Kiro CLI's global agent directory (v2 agent configs). */
export function getKiroAgentDir(): string {
  return path.join(os.homedir(), '.kiro', 'agents');
}

/** Path to the ouijit Kiro v2 agent config. */
export function getKiroAgentPath(): string {
  return path.join(getKiroAgentDir(), 'ouijit.json');
}

/** Kiro CLI's global hooks directory (v3 standalone hook files). */
export function getKiroHooksDir(): string {
  return path.join(os.homedir(), '.kiro', 'hooks');
}

/** Path to the ouijit Kiro v3 global hooks file. */
export function getKiroHooksPath(): string {
  return path.join(getKiroHooksDir(), 'ouijit.json');
}

/**
 * Status mapping for Kiro's lifecycle events, shared by the v2 agent config
 * (camelCase event keys) and the v3 hooks file (PascalCase triggers).
 * userPromptSubmit / postToolUse → thinking, stop → ready — the same mapping
 * the claude and codex wrappers use.
 */
const KIRO_STATUS_HOOKS: ReadonlyArray<readonly [v2Event: string, v3Trigger: string, status: 'thinking' | 'ready']> = [
  ['userPromptSubmit', 'UserPromptSubmit', 'thinking'],
  ['postToolUse', 'PostToolUse', 'thinking'],
  ['stop', 'Stop', 'ready'],
];

/**
 * Build the ouijit Kiro v2 agent config. The agent mirrors the built-in
 * default (`tools: ["*"]`, global MCP servers included) so selecting it does
 * not narrow what the user can do, and layers on the Ouijit status hooks.
 * `promptFileUri` (a file:// URI, resolved by Kiro itself — no shell
 * expansion) points the agent's prompt at the Ouijit CLI reference; the
 * sandbox VM omits it because the ouijit CLI is not installed there.
 */
export function buildKiroAgentConfig(hookCmd: string, promptFileUri?: string): string {
  const hooks: Record<string, Array<{ command: string }>> = {};
  for (const [v2Event, , status] of KIRO_STATUS_HOOKS) {
    hooks[v2Event] = [{ command: `${hookCmd} status status=${status}` }];
  }
  const agent: Record<string, unknown> = {
    name: 'ouijit',
    description:
      'Default Kiro agent plus Ouijit status hooks and CLI awareness. Auto-installed by Ouijit; safe to delete (Ouijit recreates it).',
    ...(promptFileUri ? { prompt: promptFileUri } : {}),
    tools: ['*'],
    includeMcpJson: true,
    hooks,
  };
  return JSON.stringify(agent, null, 2) + '\n';
}

/**
 * Build the ouijit Kiro v3 global hooks file (~/.kiro/hooks/ouijit.json).
 * v3 loads every global hook file automatically, so no wrapper flag is
 * needed; the hooks no-op outside Ouijit terminals via ouijit-hook's env
 * guard. The short timeout keeps a wedged curl from stalling the agent.
 */
export function buildKiroHooksFile(hookCmd: string): string {
  return (
    JSON.stringify(
      {
        version: 'v1',
        hooks: KIRO_STATUS_HOOKS.map(([, v3Trigger, status]) => ({
          name: `ouijit-status-${v3Trigger.toLowerCase()}`,
          description: 'Reports agent status to the Ouijit terminal card. Auto-installed by Ouijit; safe to delete.',
          trigger: v3Trigger,
          action: { type: 'command', command: `${hookCmd} status status=${status}` },
          timeout: 5,
        })),
      },
      null,
      2,
    ) + '\n'
  );
}

/**
 * Bash wrapper that shadows `kiro-cli`. For v2 sessions it appends
 * `--agent ouijit` so the auto-installed agent (status hooks + CLI
 * reference) is active; for v3 sessions (`--v3`, or OUIJIT_KIRO_V3=1 to opt
 * a terminal in without editing hook commands) it passes through untouched —
 * the v3 global hooks file is loaded automatically and the v2 agent format
 * does not apply.
 */
export const KIRO_WRAPPER = [
  '#!/bin/bash',
  '# Ouijit kiro-cli wrapper — selects the auto-installed `ouijit` agent so',
  '# Kiro CLI picks up the Ouijit status hooks and CLI reference. Kiro has no',
  '# flag to inject hooks or extra system prompt directly; both live in the',
  '# agent config (~/.kiro/agents/ouijit.json) written by Ouijit.',
  buildWrapperResolver('kiro-cli'),
  '',
  '# v3 opt-in: `kiro-cli --v3` runs the CLI 3.0 early-access engine. Honor',
  '# an explicit --v3 anywhere in the args, and let OUIJIT_KIRO_V3=1 opt a',
  '# whole terminal in without editing every hook command.',
  'KIRO_V3=""',
  'for arg in "$@"; do',
  '  case "$arg" in',
  '    --v3) KIRO_V3=1; break ;;',
  '  esac',
  'done',
  'if [ -z "$KIRO_V3" ] && [ -n "$OUIJIT_KIRO_V3" ]; then',
  '  set -- --v3 "$@"',
  '  KIRO_V3=1',
  'fi',
  '',
  '# Utility subcommands do not start an agent session; injecting --agent',
  '# would error or change their behavior. Run them untouched (mirrors the',
  '# claude / pi / opencode subcommand guards).',
  'for arg in "$@"; do',
  '  case "$arg" in',
  '    -*) continue ;;',
  '    login|logout|whoami|profile|user|settings|agent|mcp|translate|doctor|update|diagnostic|issue|version|help)',
  '      exec "$REAL_BIN" "$@"',
  '      ;;',
  '    *) break ;;',
  '  esac',
  'done',
  '',
  'if [ -n "$KIRO_V3" ]; then',
  '  # v3 sessions load the Ouijit global hooks file (~/.kiro/hooks/*.json)',
  '  # automatically; the v2 ouijit agent (and its CLI-reference prompt) does',
  '  # not apply to the v3 Markdown agent format.',
  '  exec "$REAL_BIN" "$@"',
  'fi',
  '',
  '# If the user picked their own agent, respect it — swapping in the ouijit',
  '# agent would replace their tools and prompt.',
  'for arg in "$@"; do',
  '  case "$arg" in',
  '    --agent|--agent=*) exec "$REAL_BIN" "$@" ;;',
  '  esac',
  'done',
  '',
  '# Appended (not prepended): --agent is accepted after the subcommand and',
  '# after positionals, so a bare `kiro-cli "prompt"` stays intact. When',
  '# Ouijit is not running the hooks no-op (ouijit-hook exits without',
  '# OUIJIT_API_URL) and the agent still carries the CLI reference.',
  'exec "$REAL_BIN" "$@" --agent ouijit',
  '',
].join('\n');

// ── nono shim ────────────────────────────────────────────────────────

/**
 * Bash shim that makes `nono` resolvable in Ouijit terminals. The vendored
 * binary lives inside the app bundle — not on PATH — so without this shim
 * agents inside the sandbox could not run `nono why` to diagnose denials, and
 * users in regular task terminals could not run `nono profile promote` to
 * apply a profile draft. The PTY manager injects OUIJIT_NONO_PATH into every
 * task terminal (the nono provider re-sets the same value and grants it read
 * for sandboxed spawns); when nono is user-installed the env var is unset and
 * the shim falls through to the real nono on PATH.
 */
export const NONO_SHIM = [
  '#!/bin/bash',
  '# Ouijit nono shim — resolves the vendored nono binary in Ouijit terminals.',
  '# OUIJIT_NONO_PATH is set by Ouijit task terminals; in a nono-sandboxed',
  '# session it points at the same binary that supervises the session, so',
  '# `nono why` answers with the version that actually enforced the denial.',
  'if [ -n "$OUIJIT_NONO_PATH" ] && [ -x "$OUIJIT_NONO_PATH" ]; then',
  '  exec "$OUIJIT_NONO_PATH" "$@"',
  'fi',
  '',
  buildWrapperResolver('nono'),
  '',
  'exec "$REAL_BIN" "$@"',
  '',
].join('\n');

/**
 * Install the ouijit-hook helper script and claude wrapper into
 * ~/.config/Ouijit/bin/. The wrapper injects hooks via --settings
 * at invocation time so we never touch ~/.claude/settings.json.
 */
export function installWrapper(): void {
  try {
    const binDir = getWrapperBinDir();
    fs.mkdirSync(binDir, { recursive: true });

    // Write CLI reference file (loaded by claude via --append-system-prompt-file)
    fs.writeFileSync(getCliReferencePath(), CLI_REFERENCE, { mode: 0o644 });

    // Write ouijit-hook helper script (curl client invoked by hooks)
    fs.writeFileSync(path.join(binDir, 'ouijit-hook'), HELPER_SCRIPT, { mode: 0o755 });

    // Drop the plan-detection hook installed by older versions — markdown
    // panels are opened by the user now, never pushed by an agent's writes.
    fs.rmSync(path.join(binDir, 'ouijit-plan-hook'), { force: true });

    // Write claude wrapper script (shadows `claude` to inject --settings)
    fs.writeFileSync(path.join(binDir, 'claude'), CLAUDE_WRAPPER, { mode: 0o755 });

    // Write codex wrapper script (shadows `codex` to inject -c config overrides)
    fs.writeFileSync(path.join(binDir, 'codex'), CODEX_WRAPPER, { mode: 0o755 });

    // Write pi wrapper and the extension it loads via --extension. The
    // extension lives outside bin/ (not on PATH) and outside Pi's
    // auto-discovery roots (no effect on un-wrapped `pi` invocations).
    fs.writeFileSync(path.join(binDir, 'pi'), PI_WRAPPER, { mode: 0o755 });
    const piExtPath = getPiExtensionPath();
    fs.mkdirSync(path.dirname(piExtPath), { recursive: true });
    fs.writeFileSync(piExtPath, PI_EXTENSION, { mode: 0o644 });

    // Write opencode wrapper (shadows `opencode`) and the status plugin into
    // opencode's auto-load dir. opencode imports auto-load files directly,
    // whereas a `plugin` config entry is `bun add`-ed (fails for a local
    // file), so the auto-load dir is the only working host mechanism. The
    // plugin is inert until the wrapper exports OUIJIT_HOOK_BIN, so a plain
    // `opencode` run is unaffected.
    fs.writeFileSync(path.join(binDir, 'opencode'), OPENCODE_WRAPPER, { mode: 0o755 });

    // Write nono shim (resolves the vendored nono binary via OUIJIT_NONO_PATH,
    // set by every Ouijit task terminal; falls through to PATH everywhere else)
    fs.writeFileSync(path.join(binDir, 'nono'), NONO_SHIM, { mode: 0o755 });
    const opencodePluginPath = getOpencodePluginPath();
    fs.mkdirSync(path.dirname(opencodePluginPath), { recursive: true });
    fs.writeFileSync(opencodePluginPath, OPENCODE_PLUGIN, { mode: 0o644 });

    // Write kiro-cli wrapper (shadows `kiro-cli` to select the ouijit agent),
    // the ouijit v2 agent config, and the v3 global hooks file. Hook command
    // and prompt paths are resolved absolute at install time — Kiro reads the
    // prompt's file:// URI itself (no shell expansion), so $HOME is not safe
    // there, and using absolute paths for the hook commands keeps both files
    // shell-independent.
    fs.writeFileSync(path.join(binDir, 'kiro-cli'), KIRO_WRAPPER, { mode: 0o755 });
    const kiroHookCmd = path.join(binDir, 'ouijit-hook');
    const kiroAgentPath = getKiroAgentPath();
    fs.mkdirSync(path.dirname(kiroAgentPath), { recursive: true });
    // pathToFileURL percent-encodes spaces/unicode so the prompt URI stays
    // valid on any homedir path.
    fs.writeFileSync(kiroAgentPath, buildKiroAgentConfig(kiroHookCmd, pathToFileURL(getCliReferencePath()).href), {
      mode: 0o644,
    });
    const kiroHooksPath = getKiroHooksPath();
    fs.mkdirSync(path.dirname(kiroHooksPath), { recursive: true });
    fs.writeFileSync(kiroHooksPath, buildKiroHooksFile(kiroHookCmd), { mode: 0o644 });

    // Write ouijit CLI wrapper (delegates to the bundled CLI JS via env vars set by PTY manager)
    fs.writeFileSync(
      path.join(binDir, 'ouijit'),
      [
        '#!/bin/bash',
        '# Ouijit CLI — auto-installed by the Ouijit app',
        'if [ -z "$OUIJIT_CLI_PATH" ] || [ ! -f "$OUIJIT_CLI_PATH" ]; then',
        '  echo "ouijit: CLI not available (run from an Ouijit terminal)" >&2',
        '  exit 1',
        'fi',
        'exec node "$OUIJIT_CLI_PATH" "$@"',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );

    // Write per-shell integration scripts (re-fix PATH after shell init,
    // emit OSC 133 exit codes). Each provider owns its own files.
    installShellIntegration(getShellIntegrationDir());
  } catch (err) {
    hookServerLog.warn('failed to install wrapper', { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * One-time migration: remove Ouijit hook entries from ~/.claude/settings.json
 * left by the old installHooks() approach. Guarded by a sentinel file so it
 * only runs once per user.
 */
export function migrateFromSettingsHooks(): void {
  try {
    const configDir = path.join(os.homedir(), '.config', 'Ouijit');
    const sentinelPath = path.join(configDir, '.migrated-to-wrapper');

    // Already migrated — skip
    if (fs.existsSync(sentinelPath)) return;

    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    try {
      const raw = fs.readFileSync(settingsPath, 'utf-8');
      const settings = JSON.parse(raw) as Record<string, unknown>;
      const hooks = settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>> | undefined;
      if (hooks) {
        let changed = false;
        for (const event of Object.keys(hooks)) {
          const filtered = hooks[event].filter(
            (entry) => !entry.hooks?.some((h) => h.command?.includes('ouijit-hook')),
          );
          if (filtered.length !== hooks[event].length) {
            changed = true;
            if (filtered.length === 0) {
              delete hooks[event];
            } else {
              hooks[event] = filtered;
            }
          }
        }
        if (Object.keys(hooks).length === 0) {
          delete settings.hooks;
        }
        if (changed) {
          const tmpPath = settingsPath + '.tmp';
          fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
          fs.renameSync(tmpPath, settingsPath);
          hookServerLog.info('migrated: removed old ouijit hooks from ~/.claude/settings.json');
        }
      }
    } catch {
      // settings.json doesn't exist or is invalid — nothing to clean up
    }

    // Also remove stale version marker from old approach
    try {
      fs.unlinkSync(path.join(configDir, 'hooks-version'));
    } catch {
      /* already gone */
    }

    // Write sentinel so we don't run this again
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(sentinelPath, '', 'utf-8');
  } catch (err) {
    hookServerLog.warn('migration failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

// ── VM hook injection ────────────────────────────────────────────────
// Sandboxed Lima VMs only mount the project directory. Instead of writing
// hook files into the project (which pollutes git), we inject the hook
// script and settings into the VM's ephemeral home directory at spawn time.

/**
 * Build the JSON content for the VM's ~/.claude/settings.json.
 * Uses $HOME/ouijit-hook as the command path (script lives in the VM's home dir).
 */
export function buildVmHookSettings(): string {
  return JSON.stringify(buildHookSettings('$HOME/ouijit-hook'), null, 2);
}

/**
 * Build the TOML content for the VM's ~/.codex/config.toml. There is no `codex`
 * wrapper inside the sandbox, so the lifecycle hooks + turn-complete notifier
 * are wired via the config file instead. The CLI reference is deliberately
 * omitted — the ouijit CLI is not installed in the sandbox. $HOME stays
 * literal so the in-VM shell expands it.
 *
 * Written into the VM via a *quoted* heredoc (no expansion) so that `$HOME` in
 * hook commands reaches Codex unchanged and gets expanded by the agent's shell.
 */
export function buildVmCodexConfig(): string {
  const hookPath = '$HOME/ouijit-hook';
  const lines = [`notify = ["bash", "-c", "${codexHookCommand(hookPath, 'ready')}"]`];
  for (const [event, status] of CODEX_STATUS_HOOKS) {
    lines.push(`hooks.${event} = ${codexHookEventValue(hookPath, status)}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Build the `[hooks.state]` trust-state lines for the VM's ~/.codex/config.toml.
 * The key prefix is the absolute path of the config file, which we can only
 * resolve at write time inside the VM — so this is meant to be appended via an
 * *unquoted* heredoc so the VM's bash expands `$HOME` in the key.
 */
export function buildVmCodexTrustState(): string {
  const hookPath = '$HOME/ouijit-hook';
  const source = '$HOME/.codex/config.toml';
  const lines = CODEX_STATUS_HOOKS.map(([, status, eventSnake]) => {
    const cmd = codexHookCommand(hookPath, status);
    const stateKey = codexHookStateKey(source, eventSnake);
    const hash = codexHookTrustHash(eventSnake, cmd);
    return `hooks.state."${stateKey}".trusted_hash = "${hash}"`;
  });
  lines.push('');
  return lines.join('\n');
}

/** Pi extension for the sandbox VM. Identical to the host-side source. */
export function buildVmPiExtension(): string {
  return PI_EXTENSION;
}

/** opencode status plugin for the sandbox VM. Identical to the host-side source. */
export function buildVmOpencodePlugin(): string {
  return OPENCODE_PLUGIN;
}

/**
 * Kiro v2 agent config for the sandbox VM. Hook commands keep `$HOME` literal
 * (expanded by the shell Kiro runs them with); the CLI-reference prompt is
 * deliberately omitted — the ouijit CLI is not installed in the sandbox.
 * There is no `kiro-cli` wrapper inside the VM, so a v2 session picks the
 * agent up via `kiro-cli chat --agent ouijit`.
 */
export function buildVmKiroAgentConfig(): string {
  return buildKiroAgentConfig('$HOME/ouijit-hook');
}

/** Kiro v3 global hooks file for the sandbox VM (auto-loaded, no wrapper needed). */
export function buildVmKiroHooksFile(): string {
  return buildKiroHooksFile('$HOME/ouijit-hook');
}
