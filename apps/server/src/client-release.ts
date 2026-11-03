import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isNewerVersion } from '@cc-desk-tunnel/protocol';

export type ClientRelease = { version: string; size: number; sha256: string; path: string };
const installer = /^CC-Desk-Tunnel-Setup-(\d+\.\d+\.\d+(?:-mod)?)-x64\.exe$/;

// The Windows installers in the data directory, placed by an administrator or fetched with a release. Connected
// clients are told the newest one's version and hash, and may download it with the service token. Only the
// newest three are kept.
const KEPT = 3;
export class ClientReleases {
  current: ClientRelease | null = null;
  private directory: string;
  private key = '';
  private pending: Promise<void> | undefined;
  constructor(directory: string) {
    this.directory = directory;
  }
  // Cheap unless the newest installer changed; the hash of a large file is computed once.
  refresh() {
    this.pending ??= this.scan()
      .catch(() => {
        this.current = null;
        this.key = '';
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
  private async scan() {
    let names: string[];
    try {
      names = readdirSync(this.directory);
    } catch {
      names = [];
    }
    const installers = names
      .map((name) => ({ name, version: installer.exec(name)?.[1] }))
      .filter((item): item is { name: string; version: string } => !!item.version)
      .sort((a, b) =>
        isNewerVersion(a.version, b.version) ? -1 : isNewerVersion(b.version, a.version) ? 1 : 0,
      );
    for (const old of installers.slice(KEPT))
      rmSync(join(this.directory, old.name), { force: true });
    const newest = installers[0];
    if (!newest) {
      this.current = null;
      this.key = '';
      return;
    }
    const path = join(this.directory, newest.name);
    const stat = statSync(path);
    const key = `${path}:${stat.size}:${stat.mtimeMs}`;
    if (key === this.key) return;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    this.current = {
      version: newest.version,
      size: stat.size,
      sha256: hash.digest('hex'),
      path,
    };
    this.key = key;
  }
}
