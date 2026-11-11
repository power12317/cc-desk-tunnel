import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  WorkspacePromptPolicy,
  upgradeNotice,
  requirePromptSnapshotControl,
} from '../src/prompt-policy.ts';
import { remotePrompt, runClaude } from '../src/claude.ts';
import { NativeInput } from '../src/native-input.ts';
import { fileURLToPath } from 'node:url';
import type { EventPayload } from '@cc-desk-tunnel/protocol';
import { terminalArguments } from '../src/native-terminal.ts';
import { terminalSettings } from '../src/terminal-transcript.ts';
import { SessionStore } from '../src/store.ts';
import { randomUUID } from 'node:crypto';
import type { Session } from '@cc-desk-tunnel/protocol';

const execution = { platform: 'win32' as const, shells: ['pwsh' as const] };
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'cc-prompt-policy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sessionId = randomUUID();
  const project = "E:\\项目 '$\\evidence";
  const append = remotePrompt(project, sessionId, execution);
  const notice = upgradeNotice(project, execution);
  return {
    directory,
    sessionId,
    project,
    append,
    notice,
    policy: (resume = true, text = append, id: string = sessionId) =>
      new WorkspacePromptPolicy(directory, id, text, notice, resume),
  };
}

test('legacy sessions retain a pending notice across opening, failed delivery and restart; only an offered answer acknowledges it', (t) => {
  const f = fixture(t);
  const first = f.policy();
  assert.equal(first.acknowledge(), false);
  assert.deepEqual(first.offer(randomUUID()), {});
  const context = first.offer(f.sessionId);
  assert.match(
    context.hookSpecificOutput!.additionalContext,
    /supersede earlier SSH access details/,
  );
  first.close(); // The CLI was interrupted before an answer was persisted.
  const retry = f.policy();
  assert.deepEqual(retry.offer(f.sessionId), context);
  assert.equal(retry.acknowledge(), true);
  assert.deepEqual(f.policy().offer(f.sessionId), {});
  assert.equal(f.policy().append, f.append);
  assert.ok(
    !f.append.includes(retry.revision),
    'internal revision is absent from the model prompt',
  );
});

test('new sessions need no upgrade notice; actual content changes notify once and a stale process cannot acknowledge a newer revision', (t) => {
  const f = fixture(t);
  const initial = f.policy(false);
  assert.deepEqual(initial.offer(f.sessionId), {});
  const changed = f.policy(true, f.append + '\nChanged rule.');
  assert.ok(changed.offer(f.sessionId).hookSpecificOutput);
  const newer = f.policy(true, f.append + '\nNewer rule.');
  assert.equal(changed.acknowledge(), false);
  assert.ok(newer.offer(f.sessionId).hookSpecificOutput);
  assert.equal(newer.acknowledge(), true);
  assert.deepEqual(f.policy(true, newer.append).offer(f.sessionId), {});
  assert.equal(initial.append, f.append);
});

test('devices, spaces and entry points do not share notification receipts; stable session prompts remain byte-identical', (t) => {
  const f = fixture(t);
  const first = f.policy();
  first.offer(f.sessionId);
  first.acknowledge();
  const otherId = randomUUID();
  assert.ok(f.policy(true, f.append, otherId).offer(otherId).hookSpecificOutput);
  const terminal = f.policy();
  const args = terminalArguments(
    { executable: 'claude' },
    {
      id: f.sessionId,
      projectPath: 'elsewhere',
      permissionMode: 'auto',
      model: null,
      effort: null,
    } as Session,
    { configPath: 'current-config' },
    {
      resume: true,
      settingsPath: 'terminal-settings',
      execution,
      prompt: terminal.append,
    },
  );
  assert.equal(args[args.indexOf('--append-system-prompt') + 1], first.append);
  assert.equal(args[args.indexOf('--system-prompt-snapshot') + 1], 'off');
  assert.equal(f.policy().revision, terminal.revision);
  assert.throws(() => f.policy(true, f.append, '../another'), /Invalid prompt session/);
});

test(
  'a real terminal hook returns the same context as the SDK and ignores /resume into another session',
  { skip: process.platform === 'win32' },
  (t) => {
    const f = fixture(t);
    // Exercise quotes, backslashes and shell substitutions as literal filenames.
    const policy = new WorkspacePromptPolicy(
      join(f.directory, 'data \' " $() \\'),
      f.sessionId,
      f.append,
      f.notice,
      true,
    );
    const hook = policy.terminalHook();
    const input = (sessionId: string) =>
      JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        session_id: sessionId,
        prompt: 'private input is not logged',
      });
    assert.equal(
      execFileSync('/bin/sh', ['-c', hook], { input: input(randomUUID()), encoding: 'utf8' }),
      '',
    );
    assert.equal(policy.acknowledge(), false);
    const result = JSON.parse(
      execFileSync('/bin/sh', ['-c', hook], { input: input(f.sessionId), encoding: 'utf8' }),
    );
    assert.deepEqual(result, policy.offer(f.sessionId));
    const settings = join(f.directory, 'terminal.json');
    terminalSettings(
      settings,
      join(f.directory, 'events'),
      undefined,
      undefined,
      undefined,
      undefined,
      hook,
    );
    const written = JSON.parse(readFileSync(settings, 'utf8'));
    assert.equal(written.hooks.UserPromptSubmit.at(-1).hooks[0].command, hook);
    assert.equal(policy.acknowledge(), true);
    assert.equal(
      execFileSync('/bin/sh', ['-c', hook], { input: input(f.sessionId), encoding: 'utf8' }),
      '',
    );
    assert.equal(statSync(policy.path).mode & 0o777, 0o600);
  },
);

test('a moved workspace notice is previewed without consuming it and survives an aborted terminal start', (t) => {
  const f = fixture(t);
  const store = new SessionStore(f.directory);
  t.after(() => store.close());
  const device = { id: randomUUID(), name: 'Windows' };
  const session = store.create(randomUUID(), 'old conversation', 'D:\\old', device);
  store.promptValues(session.id);
  store.move(session.id, 'D:\\new', device);
  const preview = store.notice(session.id, false);
  assert.match(preview, /directory changed/);
  assert.equal(store.notice(session.id, false), preview);
  const policy = f.policy(false);
  policy.queue(preview);
  policy.close();
  const retry = f.policy(false);
  assert.match(retry.offer(f.sessionId).hookSpecificOutput!.additionalContext, /D:\\\\new/);
  retry.acknowledge();
  assert.deepEqual(f.policy(false).offer(f.sessionId), {});
  assert.equal(store.notice(session.id), preview);
  assert.equal(store.notice(session.id), '');
});

test(
  'snapshot capability detection is offline, reports unsupported CLIs, and caches only successful checks',
  { skip: process.platform === 'win32' },
  async (t) => {
    const f = fixture(t);
    const executable = join(f.directory, 'cli');
    writeFileSync(executable, '#!/bin/sh\nprintf "%s\\n" "--some-other-option"\n', { mode: 0o700 });
    await assert.rejects(requirePromptSnapshotControl(executable), /does not advertise/);
    writeFileSync(executable, '#!/bin/sh\nprintf "%s\\n" "--system-prompt-snapshot <on|off>"\n');
    await requirePromptSnapshotControl(executable);
    await requirePromptSnapshotControl(executable);
  },
);

test(
  'the actual SDK transport delivers the legacy notice as hook context and acknowledges it only after a successful turn',
  { skip: process.platform === 'win32', timeout: 15000 },
  async (t) => {
    const f = fixture(t);
    for (const fail of [true, false]) {
      const events: EventPayload[] = [];
      const input = new NativeInput(f.sessionId, (event) => events.push(event));
      input.submit(randomUUID(), fail ? 'FAIL' : 'continue the old conversation');
      const policy = f.policy();
      const result = await runClaude(
        { executable: fileURLToPath(new URL('./fixtures/prompt-cli.mjs', import.meta.url)) },
        {
          dataDir: f.directory,
          sessionId: f.sessionId,
          nativeRoot: f.sessionId,
          projectPath: f.project,
          execution,
          resume: false,
          permissionMode: 'auto',
          input,
          controls: {},
          signal: new AbortController().signal,
          ssh: { configPath: 'unused-by-offline-fixture' },
          promptPolicy: policy,
          emit: (event) => events.push(event),
          approve: async () => ({ allowed: false }),
          waiting: () => {},
          turnEnded: () => {},
        },
      );
      assert.equal(result, fail ? 'failed' : 'completed', JSON.stringify(events));
      const answer = events.find((event) => event.type === 'text.delta');
      assert.ok(answer?.type === 'text.delta');
      const observed = JSON.parse(answer.text.replace(/^```text\n/, '').replace(/\n```$/, ''));
      assert.equal(observed.append, f.append);
      assert.equal(observed.snapshot, false);
      assert.equal(observed.context.hookSpecificOutput.additionalContext, f.notice);
      const after = f.policy();
      if (fail) assert.ok(after.offer(f.sessionId).hookSpecificOutput);
      else assert.deepEqual(after.offer(f.sessionId), {});
      after.close();
    }
  },
);
