import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { deviceTerms } from './device-terms.ts';
import type { Execution } from './device-terms.ts';

export function upgradeNotice(projectPath: string, execution: Execution) {
  const terms = deviceTerms(execution, projectPath);
  return `[CC Desk Tunnel: The workspace access instructions for this conversation have been updated. The current instructions supersede earlier SSH access details in messages, tool calls, and summaries. For this workspace, use the session-provided ssh, scp, and sftp commands with the current device aliases; do not reuse device-script, an explicit historical -F configuration, or a hard-coded loopback port. ${terms.script} ${terms.command} If the endpoint is unavailable, report it without falling back to local project operations. Verify interrupted operations before repeating side effects.]`;
}

type State = {
  revision: string;
  append: string;
  upgrade: string;
  acknowledged: string;
  pending: string;
};

function save(path: string, state: unknown) {
  const next = `${path}.${randomBytes(8).toString('hex')}`;
  writeFileSync(next, JSON.stringify(state), { mode: 0o600 });
  renameSync(next, path);
}

function read(path: string): State {
  const state = JSON.parse(readFileSync(path, 'utf8'));
  for (const key of ['revision', 'append', 'upgrade', 'acknowledged', 'pending'])
    if (typeof state[key] !== 'string') throw new Error('Invalid workspace prompt state');
  return state;
}

// Service-owned state, separate from Claude's private transcript and the official client protocol. The content
// hash never enters the system prompt. Opening a conversation cannot consume its pending upgrade notice.
export class WorkspacePromptPolicy {
  readonly append: string;
  readonly revision: string;
  readonly path: string;
  readonly offerPath: string;
  readonly sessionId: string;

  constructor(
    dataDir: string,
    sessionId: string,
    append: string,
    upgrade: string,
    resume: boolean,
  ) {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('Invalid prompt session ID');
    this.sessionId = sessionId;
    this.append = append;
    this.revision = createHash('sha256').update(append).digest('hex');
    const directory = join(dataDir, 'prompt-policy', sessionId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, 'state.json');
    this.offerPath = join(directory, `offered-${randomBytes(12).toString('hex')}`);
    const previous = existsSync(this.path) ? read(this.path) : undefined;
    if (!previous || previous.revision !== this.revision)
      save(this.path, {
        revision: this.revision,
        append,
        upgrade,
        acknowledged: resume ? '' : this.revision,
        pending: previous?.pending ?? '',
      } satisfies State);
  }

  queue(notice: string) {
    if (!notice) return;
    const state = read(this.path);
    if (state.revision !== this.revision) throw new Error('Workspace prompt changed');
    if (state.pending !== notice) save(this.path, { ...state, pending: notice });
  }

  // The SDK hook and the terminal command hook return precisely the same additionalContext structure.
  offer(sessionId: string) {
    if (sessionId !== this.sessionId) return {};
    const state = read(this.path);
    if (state.revision !== this.revision) throw new Error('Workspace prompt changed');
    const context = [state.acknowledged === this.revision ? '' : state.upgrade, state.pending]
      .filter(Boolean)
      .join('\n\n');
    if (!context) return {};
    save(this.offerPath, this.revision);
    return {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit' as const,
        additionalContext: context,
      },
    };
  }

  // Called only after a successful SDK result or a new persisted terminal answer. A failed launch or an
  // interrupted submission stays pending; an old process cannot acknowledge a newer revision.
  acknowledge() {
    if (!existsSync(this.offerPath)) return false;
    const state = read(this.path);
    if (
      state.revision !== this.revision ||
      JSON.parse(readFileSync(this.offerPath, 'utf8')) !== this.revision
    )
      return false;
    save(this.path, { ...state, acknowledged: this.revision, pending: '' });
    rmSync(this.offerPath, { force: true });
    return true;
  }

  close() {
    rmSync(this.offerPath, { force: true });
  }

  terminalHook() {
    const scriptPath = join(this.path, '..', 'submit-hook.cjs');
    writeFileSync(scriptPath, TERMINAL_HOOK, { mode: 0o600 });
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    return [process.execPath, scriptPath, this.path, this.offerPath, this.sessionId, this.revision]
      .map(quote)
      .join(' ');
  }
}

// No CLI/account calls and no shell environment changes. The hook validates the native session ID so /clear
// and /resume cannot apply this workspace's rules to another conversation. It never logs the user's input.
const TERMINAL_HOOK = `const { readFileSync, writeFileSync, renameSync } = require('node:fs');
(async () => {
const [statePath, offerPath, sessionId, revision] = process.argv.slice(2);
let input = '';
for await (const chunk of process.stdin) input += chunk;
const event = JSON.parse(input);
if (event.hook_event_name === 'UserPromptSubmit' && event.session_id === sessionId) {
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  if (state.revision !== revision) throw new Error('Workspace prompt changed; reopen this terminal.');
  const context = [state.acknowledged === revision ? '' : state.upgrade, state.pending].filter(Boolean).join('\\n\\n');
  if (context) {
    const next = offerPath + '.' + process.pid;
    writeFileSync(next, JSON.stringify(revision), { mode: 0o600 });
    renameSync(next, offerPath);
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }));
  }
}
})();
`;

const capabilities = new Map<string, Promise<void>>();
export async function requirePromptSnapshotControl(executable: string) {
  let key = executable;
  try {
    const info = statSync(executable);
    key += `:${info.size}:${info.mtimeMs}`;
  } catch {
    // A command name can be resolved by execFile through the inherited PATH.
  }
  let check = capabilities.get(key);
  if (!check) {
    check = new Promise<void>((resolve, reject) => {
      const child = execFile(
        executable,
        ['--help'],
        { timeout: 10000, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          if (error || !stdout.includes('--system-prompt-snapshot'))
            reject(
              new Error(
                'Claude CLI does not advertise --system-prompt-snapshot; workspace prompt refresh is unavailable.',
              ),
            );
          else resolve();
        },
      );
      child.stdin?.on('error', () => {});
      child.stdin?.end();
    });
    capabilities.set(key, check);
    check.catch(() => capabilities.delete(key));
  }
  await check;
}
