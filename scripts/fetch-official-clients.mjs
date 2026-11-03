import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { releaseFiles } from './release-manifest.mjs';

// The server follows the official release number. Clients are copied byte for byte, never rebuilt here.
export async function fetchOfficialClients({
  version,
  protocol,
  directory,
  releases = 'https://github.com/sun168567/cc-desk-tunnel/releases',
}) {
  const response = await fetch(`${releases}/latest/download/release.json`, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Official manifest: HTTP ${response.status}`);
  const manifest = await response.json();
  if (manifest.version !== version || manifest.protocol !== protocol)
    throw new Error('The server version and protocol must match the latest official release.');
  const names = releaseFiles(version).filter((name) => !name.startsWith('cc-desk-tunnel-server-'));
  await mkdir(directory, { recursive: true });
  for (const name of names) {
    const file = manifest.files.find((item) => item.name === name);
    if (
      !file ||
      !/^[0-9a-f]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.size) ||
      file.size <= 0
    )
      throw new Error(`Invalid official manifest entry: ${name}`);
    const target = join(directory, name);
    const temporary = `${target}.part`;
    for (let attempt = 1; ; attempt++) {
      try {
        const download = await fetch(`${releases}/download/v${version}/${name}`, {
          signal: AbortSignal.timeout(180_000),
        });
        if (!download.ok) throw new Error(`HTTP ${download.status}`);
        let size = 0;
        const hash = createHash('sha256');
        const verify = new Transform({
          transform(chunk, _encoding, callback) {
            size += chunk.length;
            hash.update(chunk);
            callback(null, chunk);
          },
        });
        await pipeline(Readable.fromWeb(download.body), verify, createWriteStream(temporary));
        if (size !== file.size || hash.digest('hex') !== file.sha256)
          throw new Error('Size or SHA256 does not match the official release.');
        await rename(temporary, target);
        console.log(`Verified official client: ${name}`);
        break;
      } catch (error) {
        await rm(temporary, { force: true });
        if (attempt === 3) throw new Error(`Cannot verify ${name}: ${error.message}`);
      }
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const { version } = JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8'));
  const source = await readFile(join(root, 'packages/protocol/src/index.ts'), 'utf8');
  const protocol = Number(/PROTOCOL_VERSION = (\d+)/.exec(source)[1]);
  await fetchOfficialClients({
    version,
    protocol,
    directory: resolve('artifacts/official-clients'),
  });
}
