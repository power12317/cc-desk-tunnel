import type { DevicePlatform } from '@cc-desk-tunnel/protocol';

export const posixLiteral = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
// JSON quoting is not Bash quoting: $, backticks and backslashes must keep their literal values.
export const bashDoubleQuoted = (value: string) => `"${value.replace(/[\\"$`]/g, '\\$&')}"`;
const transfer = (value: string) =>
  /^[a-zA-Z0-9_/:.\-]+$/.test(value) ? value : posixLiteral(value);
// SFTP upload destinations are literal; scp download sources are globs. Keep both representations when they differ.
export function transferPaths(path: string) {
  const value = `device:${path}`;
  return { path: transfer(value), source: transfer(value.replace(/[\\*?\[\]]/g, '\\$&')) };
}
function transferDescription(path: string) {
  const values = transferPaths(path);
  return `${values.path}.${values.source === values.path ? '' : ` SCP download source is ${values.source}.`}`;
}

export function deviceTerms(platform: DevicePlatform, projectPath: string) {
  if (platform === 'win32')
    return {
      name: 'Windows',
      script: `carrying the complete UTF-8 PowerShell 7 script on stdin. Additional transport escaping, encoding and command arguments are prohibited; RemoteCommand selects the runner. Every script MUST begin with Set-Location -LiteralPath '${projectPath.replaceAll("'", "''")}'. Scripts MUST NOT request further stdin input. UTF-8 output, errors and exit status MUST be preserved.`,
      command: `Command lines follow cmd.exe syntax; transfer paths MUST use forward slashes: ${transferDescription(projectPath.replaceAll('\\', '/'))}`,
    };
  return {
    name: platform === 'darwin' ? 'macOS' : 'Linux',
    script: `carrying the complete UTF-8 script on stdin. Additional transport escaping, encoding and command arguments are prohibited; RemoteCommand selects the workspace zsh/bash with its terminal environment. Every script MUST begin with cd -- ${posixLiteral(projectPath)}. Scripts MUST NOT request further stdin input. UTF-8 output, errors and exit status MUST be preserved.`,
    command: `Command lines follow the same workspace shell syntax; the transfer path is ${transferDescription(projectPath)}`,
  };
}
