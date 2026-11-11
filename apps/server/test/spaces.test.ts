import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as tcpConnect } from 'node:net';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, TUNNEL_CLOSE } from '@cc-desk-tunnel/protocol';
import type { ServerMessage } from '@cc-desk-tunnel/protocol';
import { createProxyServer } from '../src/server.ts';
import type { ServerOptions } from '../src/server.ts';
import { SessionStore } from '../src/store.ts';
import { UsageLog } from '../src/usage.ts';

const a = `offline-a-${randomUUID()}`,
  b = `offline-b-${randomUUID()}`;
type Response = Extract<ServerMessage, { type: 'response' }>;
class Client {
  socket: WebSocket;
  messages: ServerMessage[] = [];
  constructor(url: string, headers?: Record<string, string>) {
    this.socket = new WebSocket(url, { headers });
    this.socket.on('message', (raw) => this.messages.push(JSON.parse(raw.toString())));
  }
  send(value: object) {
    this.socket.send(JSON.stringify(value));
  }
  async next<T extends ServerMessage['type']>(
    type: T,
    predicate: (value: Extract<ServerMessage, { type: T }>) => boolean = () => true,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    for (const deadline = Date.now() + 6000; Date.now() < deadline;) {
      const index = this.messages.findIndex(
        (value) => value.type === type && predicate(value as never),
      );
      if (index >= 0) return this.messages.splice(index, 1)[0] as never;
      await delay(5);
    }
    throw new Error(`Timed out waiting for ${type}`);
  }
  async request(command: object): Promise<Response> {
    const requestId = randomUUID();
    this.send({ ...command, requestId });
    return this.next('response', (value) => value.requestId === requestId);
  }
  async data<T extends ServerMessage['type']>(command: object, type: T) {
    assert.equal((await this.request(command)).ok, true);
    return this.next(type);
  }
}
async function fixture(t: TestContext, extra: Partial<ServerOptions> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'cc-spaces-'));
  const options = {
    token: '',
    accessKeys: [
      { id: 'A', token: a },
      { id: 'B', token: b },
    ],
    dataDir,
    stepMs: 1,
    webEnabled: true,
    ...extra,
  };
  let server = createProxyServer(options),
    url = await server.listen(0);
  const sockets: WebSocket[] = [];
  async function client(token: string, id = randomUUID(), tunnel = false) {
    const result = new Client(url.replace('http', 'ws') + '/ws');
    sockets.push(result.socket);
    await once(result.socket, 'open');
    result.send({ type: 'auth', token, deviceName: id, protocolVersion: PROTOCOL_VERSION, tunnel });
    result.send({ type: 'device', id, platform: 'darwin' });
    const ready = await result.next('ready');
    // Process identity before the caller inspects presence or asks for a session.
    const devices = await result.next('devices', (value) =>
      value.devices.some((value) => value.id === id),
    );
    return Object.assign(result, { ready, id, devices });
  }
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return {
    dataDir,
    sockets,
    client,
    get server() {
      return server;
    },
    get url() {
      return url;
    },
    async restart(keys = options.accessKeys) {
      for (const socket of sockets) socket.terminate();
      await server.close();
      server = createProxyServer({ ...options, accessKeys: keys });
      url = await server.listen(0);
    },
  };
}
async function create(client: Client, requestId = randomUUID()) {
  client.send({
    type: 'session.create',
    requestId,
    title: 'private project',
    projectPath: '/work/项目',
  });
  const result = await client.next('response', (value) => value.requestId === requestId);
  assert.equal(result.ok, true);
  return result.sessionId!;
}

test('shell preferences stay in the authenticated space and compaction settings require local maintenance', async (t) => {
  const f = await fixture(t);
  const a1 = await f.client(a),
    b1 = await f.client(b, a1.id);
  f.server.store.equip(a1.id, ['zsh', 'bash'], 'A');
  f.server.store.equip(b1.id, ['zsh', 'bash'], 'B');
  assert.equal((await a1.request({ type: 'device.shell', shell: 'zsh' })).ok, true);
  assert.equal((await b1.request({ type: 'device.shell', shell: 'bash' })).ok, true);
  assert.equal(f.server.store.execution(a1.id, 'darwin', 'A').shell, 'zsh');
  assert.equal(f.server.store.execution(b1.id, 'darwin', 'B').shell, 'bash');
  assert.equal(f.server.store.execution(a1.id, 'darwin').shell, undefined);
  const result = await b1.request({ type: 'compaction.update', values: { enabled: true } });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'local_admin_required');
});

test('A1/A2 share resources and controls; B1 cannot see or operate guessed IDs, events, images or usage', async (t) => {
  const f = await fixture(t);
  const a1 = await f.client(a),
    a2 = await f.client(a),
    b1 = await f.client(b, a1.id);
  const requestId = randomUUID(),
    id = await create(a1, requestId),
    bid = await create(b1, requestId);
  assert.notEqual(id, bid);
  assert.equal((await a2.next('session.updated')).session.id, id);
  assert.notEqual(
    f.server.store.get(id).session.nativeRoot,
    f.server.store.get(bid).session.nativeRoot,
  );
  assert.deepEqual(
    f.server.store.list('A').map((s) => s.id),
    [id],
  );
  assert.deepEqual(
    f.server.store.list('B').map((s) => s.id),
    [bid],
  );
  const snapshot = await a2.data({ type: 'session.subscribe', sessionId: id }, 'session.snapshot');
  assert.equal(snapshot.session.device?.id, a1.id);
  const commands: object[] = [
    { type: 'session.subscribe' },
    { type: 'session.history', beforeSequence: 1 },
    { type: 'session.stats' },
    { type: 'session.status' },
    { type: 'session.rename', title: 'stolen' },
    { type: 'session.delete' },
    { type: 'session.move', projectPath: '/stolen' },
    { type: 'session.fork', projectPath: '/stolen' },
    { type: 'message.send', text: 'stolen', scenario: 'chat' },
    { type: 'session.compact' },
    { type: 'run.continue' },
    { type: 'session.configure', permissionMode: 'auto' },
    { type: 'run.cancel', runId: randomUUID() },
    { type: 'approval.reply', runId: randomUUID(), approvalId: randomUUID(), allowed: true },
    { type: 'run.task.stop', runId: randomUUID(), taskId: 'task' },
    { type: 'run.task.background', runId: randomUUID(), toolId: 'tool' },
    { type: 'terminal.open', cols: 80, rows: 24 },
    { type: 'terminal.close', terminalId: randomUUID() },
  ];
  for (const command of commands) {
    const denied = await b1.request({ ...command, sessionId: id });
    assert.deepEqual([denied.ok, denied.code], [false, 'not_found'], JSON.stringify(command));
  }
  assert.equal((await a1.request({ type: 'session.subscribe', sessionId: bid })).code, 'not_found');
  assert.equal(
    (await b1.request({ type: 'project.move', from: '/work/项目', to: '/B-project' })).ok,
    true,
  );
  assert.equal(f.server.store.get(id).session.projectPath, '/work/项目');
  b1.send({ type: 'terminal.input', sessionId: id, terminalId: randomUUID(), data: 'secret' });
  assert.equal((await b1.next('connection.error')).code, 'terminal_inactive');
  assert.equal(
    (
      await a2.request({
        type: 'message.send',
        sessionId: id,
        text: 'image /work/private.png',
        scenario: 'question',
      })
    ).ok,
    true,
  );
  const approval = await a2.next(
    'session.event',
    (e) => e.event.payload.type === 'approval.requested',
  );
  assert.equal(approval.event.payload.type, 'approval.requested');
  if (approval.event.payload.type !== 'approval.requested') return;
  assert.equal(
    (
      await b1.request({
        type: 'approval.reply',
        sessionId: id,
        runId: approval.event.runId,
        approvalId: approval.event.payload.approvalId,
        allowed: true,
      })
    ).code,
    'not_found',
  );
  assert.equal(
    (
      await a1.request({
        type: 'approval.reply',
        sessionId: id,
        runId: approval.event.runId,
        approvalId: approval.event.payload.approvalId,
        allowed: true,
        answers: { scope: 'both' },
      })
    ).ok,
    true,
  );
  await a2.next(
    'session.event',
    (e) => e.event.payload.type === 'run.status' && e.event.payload.status === 'completed',
  );
  assert.equal(f.server.store.get(id).session.device?.id, a1.id);
  const history = await a2.data({ type: 'session.subscribe', sessionId: id }, 'session.snapshot');
  assert.ok(JSON.stringify(history).includes('private.png'));
  assert.equal(
    b1.messages.some(
      (value) =>
        ('event' in value && value.event.sessionId === id) ||
        ('session' in value && value.session.id === id),
    ),
    false,
  );
  const aDevices = await f.client(a),
    bDevices = await f.client(b);
  const visibleA = aDevices.devices.devices;
  assert.ok(visibleA.some((d) => d.id === a2.id));
  assert.equal(
    aDevices.ready.sessions.some((s) => s.id === bid),
    false,
  );
  assert.equal(
    bDevices.ready.sessions.some((s) => s.id === id),
    false,
  );
  const usage = new UsageLog(f.server.store.database);
  const now = Date.now();
  f.server.store.database
    .prepare(
      'INSERT INTO api_requests (at, session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, duration_ms) VALUES (?, ?, ?, 1, 2, 0, 0, 0, 1)',
    )
    .run(now, id, 'A-secret-model');
  const page = await b1.data(
    { type: 'usage.query', limit: 10, bucketMinutes: 60, offsetMinutes: 0 },
    'usage.page',
  );
  assert.deepEqual(page.rows, []);
  assert.deepEqual(page.models, []);
  assert.equal(page.totals.requests, 0);
  assert.equal(
    usage.query({ limit: 10, bucketMinutes: 60, offsetMinutes: 0 }, () => null, 'A').rows.length,
    1,
  );
  const fork = await a2.request({ type: 'session.fork', sessionId: id, projectPath: '/work/fork' });
  assert.equal(fork.ok, true);
  assert.equal(f.server.store.get(fork.sessionId!).session.device?.id, a2.id);
  assert.equal(
    (await a2.request({ type: 'session.move', sessionId: id, projectPath: '/work/moved' })).ok,
    true,
  );
  assert.equal(f.server.store.get(id).session.device?.id, a2.id);
  assert.equal(
    (await a1.request({ type: 'message.send', sessionId: id, text: 'cancel', scenario: 'tool' }))
      .ok,
    true,
  );
  const runId = f.server.store.get(id).session.activeRun!.id;
  const waiting = await a1.next(
    'session.event',
    (e) => e.event.runId === runId && e.event.payload.type === 'approval.requested',
  );
  assert.equal(
    (await a2.request({ type: 'run.cancel', sessionId: id, runId: waiting.event.runId })).ok,
    true,
  );
  assert.equal(
    (await a2.request({ type: 'session.rename', sessionId: id, title: 'renamed' })).ok,
    true,
  );
  assert.equal((await a2.request({ type: 'session.delete', sessionId: fork.sessionId })).ok, true);
  assert.equal(
    b1.messages.some((v) => v.type === 'session.deleted' && v.sessionId === fork.sessionId),
    false,
  );
  for (const type of [
    'account.login',
    'account.logout',
    'account.cancel',
    'settings.update',
    'instructions.update',
    'service.update.install',
    'web.settings.update',
  ] as const) {
    const values: Record<string, object> = {
      'settings.update': { values: {} },
      'instructions.update': { text: 'x', version: '0'.repeat(64) },
      'service.update.install': { version: '0.3.9' },
      'web.settings.update': { values: { enabled: false } },
    };
    assert.equal((await a1.request({ type, ...values[type] })).code, 'local_admin_required');
  }
});

test('legacy data is assigned once; rotation retains IDs and history, missing ownership stays quarantined', async (t) => {
  const f = await fixture(t);
  const a1 = await f.client(a),
    id = await create(a1);
  const unowned = await create(a1);
  f.server.store.database.prepare('DELETE FROM session_spaces WHERE session_id = ?').run(unowned);
  const rotated = `rotated-${randomUUID()}`;
  await f.restart([
    { id: 'A', token: rotated },
    { id: 'B', token: b },
  ]);
  assert.equal(
    (await f.client(rotated)).ready.sessions.some((s) => s.id === id),
    true,
  );
  assert.equal(
    (await f.client(rotated)).ready.sessions.some((s) => s.id === unowned),
    false,
  );
  const b1 = await f.client(b, a1.id);
  assert.equal(b1.ready.sessions.length, 0);
  assert.equal(
    (await b1.request({ type: 'session.move', sessionId: id, projectPath: '/claim' })).code,
    'not_found',
  );
  assert.equal(f.server.store.spaceOf(unowned), undefined);
  // A real pre-space JSON snapshot is imported and migrated into the named original space.
  const legacyDir = mkdtempSync(join(tmpdir(), 'cc-legacy-space-'));
  const legacyId = randomUUID(),
    now = new Date().toISOString();
  writeFileSync(
    join(legacyDir, `${legacyId}.json`),
    JSON.stringify({
      session: {
        id: legacyId,
        title: 'legacy',
        projectPath: 'D:\\old',
        permissionMode: 'auto',
        createdAt: now,
        updatedAt: now,
        activeRun: null,
      },
      events: [],
      createRequestId: randomUUID(),
    }),
  );
  const legacy = createProxyServer({
    token: '',
    accessKeys: [
      { id: 'A', token: rotated },
      { id: 'B', token: b },
    ],
    legacySpaceId: 'A',
    dataDir: legacyDir,
  });
  const legacyUrl = await legacy.listen(0);
  const client = new Client(legacyUrl.replace('http', 'ws') + '/ws');
  await once(client.socket, 'open');
  client.send({ type: 'auth', token: b, deviceName: 'B', protocolVersion: PROTOCOL_VERSION });
  assert.deepEqual((await client.next('ready')).sessions, []);
  client.socket.terminate();
  await legacy.close();
  const reopened = new SessionStore(legacyDir, 'B');
  assert.equal(reopened.spaceOf(legacyId), 'A');
  reopened.close();
  rmSync(legacyDir, { recursive: true, force: true });
});

test('official tunnel frames bind the secret to its control connection; device seats never cross keys', async (t) => {
  const f = await fixture(t, { tunnel: { probe: async () => {}, pairMs: 5000 } });
  const a1 = await f.client(a, randomUUID(), true),
    b1 = await f.client(b, a1.id, true);
  const offer = await a1.next('tunnel.offer');
  const otherOffer = await b1.next('tunnel.offer');
  for (const client of [a1, b1]) {
    client.send({
      type: 'tunnel.credentials',
      connectionId: client.ready.connectionId,
      username: 'user',
      privateKey: 'offline-unused',
      hostPublicKey: 'ssh-ed25519 AAAA',
      shells: ['zsh'],
    });
    await client.next('tunnel.ready');
  }
  assert.notEqual(
    readFileSync(join(f.dataDir, 'devices', `A.${a1.id}`, 'ssh_config'), 'utf8'),
    readFileSync(join(f.dataDir, 'devices', `B.${b1.id}`, 'ssh_config'), 'utf8'),
  );
  const config = readFileSync(
    join(f.dataDir, 'connections', a1.ready.connectionId, 'ssh_config'),
    'utf8',
  );
  const tcp = tcpConnect(Number(/Port (\d+)/.exec(config)![1]), '127.0.0.1');
  t.after(() => tcp.destroy());
  const open = await a1.next('tunnel.open');
  async function attach(secret = offer.secret, connectionId = a1.ready.connectionId) {
    const socket = new WebSocket(f.url.replace('http', 'ws') + '/ws');
    f.sockets.push(socket);
    await once(socket, 'open');
    socket.send(
      JSON.stringify({
        type: 'tunnel.attach',
        connectionId,
        channelId: open.channelId,
        secret,
      }),
    );
    return socket;
  }
  for (const [secret, connectionId] of [
    [otherOffer.secret, a1.ready.connectionId],
    [offer.secret, b1.ready.connectionId],
  ])
    assert.equal(
      (await once(await attach(secret, connectionId), 'close'))[0],
      TUNNEL_CLOSE.refused,
    );
  const received = once(tcp, 'data');
  (await attach()).send(Buffer.from('A route'));
  assert.equal((await received)[0].toString(), 'A route');
  a1.send({ type: 'device', id: randomUUID(), platform: 'darwin' });
  assert.equal((await once(a1.socket, 'close'))[0], 4003);
});

test('browser and phone cookies inherit space; changing login revokes the prior socket and never shares browser sessions', async (t) => {
  const f = await fixture(t);
  const a1 = await f.client(a),
    id = await create(a1),
    b1 = await f.client(b);
  async function login(token: string, cookie?: string) {
    const response = await fetch(f.url + '/api/login', {
      method: 'POST',
      headers: {
        Origin: f.url,
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify({ password: token }),
    });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie')!.split(';')[0];
  }
  async function browser(cookie: string) {
    const client = new Client(f.url.replace('http', 'ws') + '/api/ws', {
      Origin: f.url,
      Cookie: cookie,
    });
    f.sockets.push(client.socket);
    await once(client.socket, 'open');
    client.send({ type: 'web.auth', protocolVersion: PROTOCOL_VERSION });
    return { client, ready: await client.next('ready') };
  }
  const cookieA = await login(a),
    phone = await browser(cookieA),
    cookieB = await login(b),
    foreign = await browser(cookieB);
  assert.equal(phone.ready.version, '0.3.14');
  assert.equal(phone.ready.protocolVersion, 25);
  assert.equal(phone.ready.sessions[0].id, id);
  assert.equal(foreign.ready.sessions.length, 0);
  const mine = await a1.data({ type: 'web.settings.get' }, 'web.settings.state');
  const theirs = await b1.data({ type: 'web.settings.get' }, 'web.settings.state');
  assert.equal(mine.values.sessions.length, 1);
  assert.equal(theirs.values.sessions.length, 1);
  assert.notEqual(mine.values.sessions[0].id, theirs.values.sessions[0].id);
  assert.equal(
    (await b1.request({ type: 'web.sessions.revoke', sessionId: mine.values.sessions[0].id })).ok,
    false,
  );
  assert.equal(
    (await foreign.client.request({ type: 'session.history', sessionId: id, beforeSequence: 1 }))
      .code,
    'not_found',
  );
  assert.equal(
    (
      await phone.client.request({
        type: 'message.send',
        sessionId: id,
        text: 'phone',
        scenario: 'tool',
      })
    ).ok,
    true,
  );
  const approval = await a1.next(
    'session.event',
    (e) => e.event.payload.type === 'approval.requested',
  );
  assert.equal(
    (await phone.client.request({ type: 'run.cancel', sessionId: id, runId: approval.event.runId }))
      .ok,
    true,
  );
  assert.equal(f.server.store.get(id).session.device?.id, a1.id);
  const closed = once(phone.client.socket, 'close');
  const changedCookie = await login(b, cookieA);
  await closed;
  assert.deepEqual((await browser(changedCookie)).ready.sessions, []);
  assert.equal((await fetch(f.url + '/api/media/' + id + '/private.png')).status, 404);
});
