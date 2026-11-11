import assert from 'node:assert/strict';
import { randomUUID, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { transferPaths, bashDoubleQuoted } from '../src/device-terms.ts';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, serverMessageSchema } from '@cc-desk-tunnel/protocol';
import { createProxyServer } from '../src/server.ts';
import { defaultCertificate } from './fixtures/web-certificates.ts';
import { openProxyBridge } from '../../desktop/electron/proxy-bridge.mjs';

test(
  'official 0.3.14 bridge + protocol 25 + offline SDK + real SSH: shared-space routing, isolation and reconnect',
  { skip: process.platform === 'win32', timeout: 60000 },
  async (t) => {
    const directory = mkdtempSync('/tmp/cc-native-spaces-');
    const dataDir = join(directory, 'state "引号\\ dollar$');
    const a = `offline-a-${randomUUID()}`,
      b = `offline-b-${randomUUID()}`;
    const server = createProxyServer({
      token: '',
      accessKeys: [
        { id: 'A', token: a },
        { id: 'B', token: b },
      ],
      dataDir,
      tls: { cert: Buffer.from(defaultCertificate.cert), key: Buffer.from(defaultCertificate.key) },
      tunnel: {},
      claude: {
        executable: fileURLToPath(new URL('./fixtures/offline-cli.mjs', import.meta.url)),
      },
      graceMs: 5000,
    });
    const url = (await server.listen(0)).replace('https', 'wss') + '/ws';
    const bridges = [],
      sockets = [];
    t.after(async () => {
      for (const socket of sockets) socket.terminate();
      for (const bridge of bridges) await bridge.close();
      await server.close();
      rmSync(directory, { recursive: true, force: true });
    });
    async function device(token, name, id = randomUUID()) {
      const project = join(directory, `${name} 项目 '单引号"双引号\\$`);
      mkdirSync(project, { recursive: true });
      const bridge = await openProxyBridge(
        { url, fingerprint: new X509Certificate(defaultCertificate.cert).fingerprint256 },
        { shellPath: '/bin/bash', cwd: directory, environment: { CC_TEST_DEVICE: name } },
      );
      bridges.push(bridge);
      const socket = new WebSocket(bridge.url);
      sockets.push(socket);
      const messages = [];
      socket.on('message', (raw) => {
        const message = serverMessageSchema.parse(JSON.parse(raw.toString()));
        messages.push(message);
      });
      await once(socket, 'open');
      socket.send(
        JSON.stringify({
          type: 'auth',
          token,
          deviceName: name,
          protocolVersion: PROTOCOL_VERSION,
        }),
      );
      socket.send(JSON.stringify({ type: 'device', id }));
      async function next(predicate) {
        for (const deadline = Date.now() + 20000; Date.now() < deadline;) {
          const index = messages.findIndex(predicate);
          if (index >= 0) return messages.splice(index, 1)[0];
          await delay(10);
        }
        throw new Error(`No response: ${JSON.stringify(messages)}`);
      }
      const ready = await next((m) => m.type === 'ready');
      assert.equal(ready.type, 'ready');
      assert.equal(PROTOCOL_VERSION, 25);
      assert.equal(ready.version, '0.3.14');
      async function request(command) {
        const requestId = randomUUID();
        socket.send(JSON.stringify({ ...command, requestId }));
        return next((m) => m.type === 'response' && m.requestId === requestId);
      }
      return { bridge, socket, next, request, id, project };
    }
    const a1 = await device(a, 'A1'),
      a2 = await device(a, 'A2'),
      b1 = await device(b, 'B1', a1.id);
    const made = await a1.request({
      type: 'session.create',
      title: 'offline route',
      projectPath: a1.project,
    });
    assert.equal(made.ok, true);
    const id = made.sessionId;
    assert.equal((await a2.request({ type: 'session.subscribe', sessionId: id })).ok, true);
    assert.equal(
      (await a2.request({ type: 'message.send', sessionId: id, text: 'first route' })).ok,
      true,
    );
    async function routed() {
      const event = await a2.next(
        (m) => m.type === 'session.fragment' && m.payload.type === 'text.delta',
      );
      assert.equal(event.type, 'session.fragment');
      if (event.type !== 'session.fragment' || event.payload.type !== 'text.delta') return;
      const result = JSON.parse(event.payload.text.replace(/^```text\n/, '').replace(/\n```$/, ''));
      assert.equal(result.status, 7, JSON.stringify(result));
      assert.equal(result.stdout, `A1\n${a1.project}\n`);
      assert.equal(result.stderr, 'offline stderr');
    }
    await routed();
    const picture = join(a1.project, 'required image.png'),
      temporary = join(directory, 'inspected.png');
    writeFileSync(picture, 'offline image fixture');
    const transfer = transferPaths(picture).source;
    const sshPath = join(dataDir, 'session-ssh', id, 'config');
    await promisify(execFile)(
      'bash',
      ['-c', `scp -q -F ${bashDoubleQuoted(sshPath)} ${transfer} ${bashDoubleQuoted(temporary)}`],
      { timeout: 15000 },
    );
    assert.equal(readFileSync(temporary, 'utf8'), 'offline image fixture');
    const uploaded = join(a1.project, 'uploaded.png');
    const destination = transferPaths(uploaded).path;
    await promisify(execFile)(
      'bash',
      [
        '-c',
        `scp -q -F ${bashDoubleQuoted(sshPath)} ${bashDoubleQuoted(temporary)} ${destination}`,
      ],
      { timeout: 15000 },
    );
    assert.equal(readFileSync(uploaded, 'utf8'), 'offline image fixture');
    rmSync(temporary);
    const config = readFileSync(join(dataDir, 'session-ssh', id, 'config'), 'utf8');
    assert.ok(config.includes(`A.${a1.id}`));
    assert.ok(!config.includes(`A.${a2.id}`));
    assert.equal(
      (await b1.request({ type: 'message.send', sessionId: id, text: 'steal' })).code,
      'not_found',
    );
    await a1.bridge.close(true);
    const returned = await device(a, 'A1', a1.id);
    assert.equal(
      (await a2.request({ type: 'message.send', sessionId: id, text: 'after reconnect' })).ok,
      true,
    );
    await routed();
    assert.equal(readFileSync(join(dataDir, 'session-ssh', id, 'config'), 'utf8'), config);
    assert.equal(
      (
        await returned.request({
          type: 'run.cancel',
          sessionId: id,
          runId: server.store.get(id).session.activeRun.id,
        })
      ).ok,
      true,
    );
  },
);
