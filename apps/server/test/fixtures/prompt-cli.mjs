#!/usr/bin/env node
// Deterministic SDK transport fixture. Never starts Claude, connects to an account or calls a model.
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
if (process.argv.includes('--help')) {
  console.log('--system-prompt-snapshot <on|off>');
  process.exit(0);
}
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
let init;
let pending;
let hookRequest;
function answer(context) {
  const message = pending;
  pending = undefined;
  const failed = message.message.content === 'FAIL';
  const text = JSON.stringify({
    append: init.appendSystemPrompt,
    snapshot: init.systemPromptSnapshot,
    context,
  });
  send({
    type: 'system',
    subtype: 'init',
    session_id: message.session_id,
    model: 'offline',
    claude_code_version: 'offline',
    permissionMode: 'auto',
  });
  send(message);
  send({
    type: 'assistant',
    uuid: randomUUID(),
    session_id: message.session_id,
    parent_tool_use_id: null,
    user_message_uuid: message.uuid,
    message: {
      id: randomUUID(),
      role: 'assistant',
      model: 'offline',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  send({
    type: 'result',
    subtype: failed ? 'error_during_execution' : 'success',
    is_error: failed,
    errors: failed ? ['offline failure'] : [],
    session_id: message.session_id,
    uuid: randomUUID(),
    user_message_uuid: message.uuid,
    duration_ms: 1,
    duration_api_ms: 0,
    num_turns: 1,
    total_cost_usd: 0,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    modelUsage: {},
    result: text,
  });
}
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    if (message.request.subtype === 'initialize') init = message.request;
    send({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: message.request_id,
        response: {
          commands: [],
          models: [],
          agents: [],
          account: {},
          output_style: 'default',
          available_output_styles: [],
        },
      },
    });
  } else if (message.type === 'user') {
    pending = message;
    const callback = init.hooks?.UserPromptSubmit?.[0]?.hookCallbackIds?.[0];
    if (!callback) answer({});
    else {
      hookRequest = randomUUID();
      send({
        type: 'control_request',
        request_id: hookRequest,
        request: {
          subtype: 'hook_callback',
          callback_id: callback,
          input: {
            hook_event_name: 'UserPromptSubmit',
            session_id: message.session_id,
            cwd: process.cwd(),
            prompt: message.message.content,
            prompt_id: message.uuid,
          },
        },
      });
    }
  } else if (message.type === 'control_response' && message.response.request_id === hookRequest) {
    answer(message.response.response);
  }
}
