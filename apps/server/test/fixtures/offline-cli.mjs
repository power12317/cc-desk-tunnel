#!/usr/bin/env node
// Offline SDK peer: deterministic stream-json only. No account, provider or model calls.
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
let sessionId;
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
let prompt = '';
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    if (message.request.subtype === 'initialize') prompt = message.request.appendSystemPrompt;
    send({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: message.request_id,
        response: {
          commands: [],
          agents: [],
          models: [],
          account: {},
          output_style: 'default',
          available_output_styles: [],
        },
      },
    });
  } else if (message.type === 'user') {
    sessionId = message.session_id;
    const config = /Scripts MUST use ssh -F ("(?:\\.|[^"\\])*") device-script/.exec(prompt)?.[1];
    const directory = /Every script MUST begin with (cd -- [\s\S]+?)\. Scripts MUST NOT/.exec(
      prompt,
    )?.[1];
    if (!config || !directory) throw new Error('Expected workspace prompt');
    send({
      type: 'system',
      subtype: 'init',
      session_id: sessionId,
      model: 'offline-fixture',
      claude_code_version: 'fixture',
      permissionMode: 'auto',
    });
    send(message);
    const result = spawnSync('bash', ['-c', `ssh -F ${config} device-script`], {
      input: `${directory}\nprintf '%s\\n' "$CC_TEST_DEVICE" "$PWD"\nprintf 'offline stderr' >&2\nexit 7\n`,
      encoding: 'utf8',
      timeout: 15000,
    });
    send({
      type: 'system',
      subtype: 'local_command_output',
      session_id: sessionId,
      uuid: randomUUID(),
      content: JSON.stringify({
        stdout: result.stdout,
        stderr: result.stderr,
        status: result.status,
      }),
    });
  }
}
