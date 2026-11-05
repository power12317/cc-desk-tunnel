import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { prepareNativePty } from '../src/native-pty.ts';

test(
  'macOS PTY preparation adds only owner execute permission and can be repeated',
  {
    skip: process.platform === 'win32',
  },
  (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'cc-pty-mode-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const helper = join(directory, 'spawn-helper');
    writeFileSync(helper, 'fixture');
    chmodSync(helper, 0o640);
    prepareNativePty('darwin', helper);
    assert.equal(statSync(helper).mode & 0o777, 0o740);
    const changed = statSync(helper).ctimeMs;
    prepareNativePty('darwin', helper);
    assert.equal(statSync(helper).ctimeMs, changed);
    chmodSync(helper, 0o644);
    for (const platform of ['linux', 'win32'] as const) prepareNativePty(platform, helper);
    assert.equal(statSync(helper).mode & 0o777, 0o644);
    assert.throws(() => prepareNativePty('darwin', join(directory, 'missing')), /macOS PTY helper/);
  },
);

test(
  'a fresh macOS node-pty copy with a non-executable helper can spawn after preparation',
  {
    skip: process.platform !== 'darwin',
    timeout: 10000,
  },
  async (t) => {
    const require = createRequire(import.meta.url);
    const packageRoot = dirname(require.resolve('node-pty/package.json'));
    const utilsPath = require.resolve('node-pty/lib/utils.js');
    const { dir } = require(utilsPath).loadNativeModule('pty') as { dir: string };
    const bindingDirectory = resolve(dirname(utilsPath), dir);
    const directory = mkdtempSync(join(tmpdir(), 'cc-pty-install-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    cpSync(join(packageRoot, 'lib'), join(directory, 'lib'), { recursive: true });
    copyFileSync(join(packageRoot, 'package.json'), join(directory, 'package.json'));
    const build = join(directory, 'build', 'Release');
    mkdirSync(build, { recursive: true });
    for (const name of ['pty.node', 'spawn-helper'])
      copyFileSync(join(bindingDirectory, name), join(build, name));
    const helper = join(build, 'spawn-helper');
    chmodSync(helper, 0o644);
    const pty = require(join(directory, 'lib', 'index.js')) as typeof import('node-pty');
    const spawn = () =>
      pty.spawn('/bin/sh', ['-c', 'printf PTY_OK'], {
        cwd: directory,
        cols: 80,
        rows: 24,
      });
    assert.throws(spawn, /posix_spawnp failed/);
    prepareNativePty('darwin', helper);
    const terminal = spawn();
    t.after(() => {
      try {
        terminal.kill();
      } catch {}
    });
    let output = '';
    terminal.onData((data) => {
      output += data;
    });
    const exitCode = await new Promise<number>((done) =>
      terminal.onExit(({ exitCode }) => done(exitCode)),
    );
    assert.equal(exitCode, 0);
    assert.equal(output, 'PTY_OK');
  },
);
