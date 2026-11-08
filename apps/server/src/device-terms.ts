import type { DevicePlatform, DeviceShell } from '@cc-desk-tunnel/protocol';

export type Execution = { platform: DevicePlatform; shells: DeviceShell[]; shell?: DeviceShell };
export const systemShell = (platform: DevicePlatform): DeviceShell =>
  platform === 'win32' ? 'pwsh' : platform === 'darwin' ? 'zsh' : 'bash';

export const posixLiteral = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
// JSON quoting is not Bash quoting: $, backticks and backslashes must keep their literal values.
export const bashDoubleQuoted = (value: string) => `"${value.replace(/[\\"$`]/g, '\\$&')}"`;
const transfer = (value: string) =>
  /^[a-zA-Z0-9_/:.\-]+$/.test(value) ? value : posixLiteral(value);
// SFTP upload destinations are literal; scp download sources are globs.
export function transferPaths(path: string) {
  const value = `device:${path}`;
  return { path: transfer(value), source: transfer(value.replace(/[\\*?\[\]]/g, '\\$&')) };
}
function transferDescription(path: string) {
  const values = transferPaths(path);
  return `${values.path}.${values.source === values.path ? '' : ` SCP download source is ${values.source}.`}`;
}
const msysPath = (path: string) =>
  path
    .replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`)
    .replaceAll('\\', '/');

export function deviceTerms({ platform, shells, shell }: Execution, projectPath: string) {
  if (platform === 'win32') {
    const begin = `Set-Location -LiteralPath '${projectPath.replaceAll("'", "''")}'`;
    const common =
      'Additional transport escaping, encoding and command arguments are prohibited; RemoteCommand selects the runner. Scripts MUST NOT request further stdin input. UTF-8 output, errors and exit status MUST be preserved.';
    const script = shells.includes('bash')
      ? `Scripts MUST use ssh device-pwsh for PowerShell 7 or ssh device-bash for Git Bash, with a quoted heredoc carrying the complete UTF-8 script on stdin. Every PowerShell script MUST begin with ${begin}; every Git Bash script MUST begin with cd -- ${posixLiteral(msysPath(projectPath))}. ${common} Git Bash is still Windows: there is no apt; its ps, kill and /proc see only its own processes. Other Windows processes MUST be found and stopped with PowerShell. Windows program arguments resembling Unix paths are converted by Git Bash; write a switch such as /c as //c.${shell ? ` The user prefers ${shell === 'bash' ? 'Git Bash' : 'PowerShell'}; use it unless the task is better handled by the other available shell.` : ''}`
      : `Scripts MUST use ssh device-pwsh with a quoted heredoc carrying the complete UTF-8 PowerShell 7 script on stdin. Every PowerShell script MUST begin with ${begin}. ${common}`;
    const remote = projectPath.replaceAll('\\', '/').replace(/^(?=[A-Za-z]:)/, '/');
    return {
      name: 'Windows',
      script,
      command: `Command lines follow cmd.exe syntax; transfer paths MUST use forward slashes and a slash before the drive: ${transferDescription(remote)}`,
    };
  }
  const own = shells[0] ?? systemShell(platform);
  return {
    name: platform === 'darwin' ? 'macOS' : 'Linux',
    script: `Scripts MUST use ssh device-${own} with a quoted heredoc carrying the complete UTF-8 script on stdin. Additional transport escaping, encoding and command arguments are prohibited; RemoteCommand selects the workspace ${own} with its terminal environment. Every script MUST begin with cd -- ${posixLiteral(projectPath)}. Scripts MUST NOT request further stdin input. UTF-8 output, errors and exit status MUST be preserved.`,
    command: `Command lines follow the same workspace shell syntax; the transfer path is ${transferDescription(projectPath)}`,
  };
}
