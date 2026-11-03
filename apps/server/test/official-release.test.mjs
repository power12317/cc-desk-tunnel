import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fetchOfficialClients } from '../../../scripts/fetch-official-clients.mjs';
import { releaseFiles } from '../../../scripts/release-manifest.mjs';

test('official clients are copied unchanged; mismatched releases and corrupt downloads are rejected', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cc-official-release-'));
  const version = '0.3.9';
  const names = releaseFiles(version).filter((name) => !name.startsWith('cc-desk-tunnel-server-'));
  const files = names.map((name) => {
    const body = Buffer.from(`official fixture ${name}`);
    return { name, size: body.length, sha256: createHash('sha256').update(body).digest('hex') };
  });
  let protocol = 22;
  let corrupt = false;
  const server = createServer((request, response) => {
    if (request.url === '/latest/download/release.json') {
      response.end(JSON.stringify({ version, protocol, files }));
      return;
    }
    const name = request.url.replace(`/download/v${version}/`, '');
    if (!names.includes(name)) {
      response.writeHead(404).end();
      return;
    }
    response.end(corrupt ? 'corrupt download' : `official fixture ${name}`);
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const options = {
    version,
    protocol: 22,
    directory: join(directory, 'verified'),
    releases: `http://127.0.0.1:${server.address().port}`,
  };
  await fetchOfficialClients(options);
  assert.deepEqual((await readdir(options.directory)).sort(), [...names].sort());
  for (const name of names)
    assert.equal(await readFile(join(options.directory, name), 'utf8'), `official fixture ${name}`);
  protocol = 23;
  await assert.rejects(fetchOfficialClients(options), /must match the latest official release/);
  protocol = 22;
  await assert.rejects(fetchOfficialClients({ ...options, version: '0.3.10' }), /must match/);
  corrupt = true;
  const invalid = join(directory, 'invalid');
  await assert.rejects(fetchOfficialClients({ ...options, directory: invalid }), /SHA256/);
  assert.deepEqual(await readdir(invalid), []);
});
