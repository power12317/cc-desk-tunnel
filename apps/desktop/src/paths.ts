import { isWindowsPath, pathKey } from '@cc-desk-tunnel/protocol';

export { pathKey };
export const folderName = (path: string) =>
  path
    .split(isWindowsPath(path) ? /[\\/]/ : '/')
    .filter(Boolean)
    .at(-1) || path;
// Whether a path lies under one of the folders that hold the sessions without a project.
export const isInside = (path: string, roots: string[]) =>
  roots.some((root) =>
    pathKey(path).startsWith(`${pathKey(root)}${isWindowsPath(root) ? '\\' : '/'}`),
  );
export { isNewerVersion as isNewer } from '@cc-desk-tunnel/protocol';
// How long ago, in the fewest words that still tell recent from old.
export function ago(time: number) {
  const minutes = Math.floor((Date.now() - time) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)} 小时`;
  if (minutes < 60 * 24 * 30) return `${Math.floor(minutes / 60 / 24)} 天`;
  return new Date(time).toLocaleDateString('zh-CN');
}
export const withProject = (projects: string[], path: string) =>
  projects.some((item) => pathKey(item) === pathKey(path)) ? projects : [...projects, path];
