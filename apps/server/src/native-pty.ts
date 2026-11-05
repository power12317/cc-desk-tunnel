import { chmodSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);

// node-pty 1.1.0 ships macOS spawn-helper without its executable bit. Match the binding it actually
// loads (local builds take precedence over prebuilds), rather than changing every architecture's files.
export function prepareNativePty(
  platform: NodeJS.Platform = process.platform,
  helperPath?: string,
) {
  if (platform !== 'darwin') return;
  if (!helperPath) {
    const utilsPath = require.resolve('node-pty/lib/utils.js');
    const { dir } = require(utilsPath).loadNativeModule('pty') as { dir: string };
    helperPath = resolve(dirname(utilsPath), dir, 'spawn-helper');
  }
  try {
    const status = statSync(helperPath);
    if (!status.isFile()) throw new Error('spawn-helper is not a file');
    if (!(status.mode & 0o100)) chmodSync(helperPath, (status.mode & 0o7777) | 0o100);
  } catch (cause) {
    throw new Error(`Unable to prepare macOS PTY helper: ${helperPath}`, { cause });
  }
}
