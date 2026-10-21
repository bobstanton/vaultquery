export const pathName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
export const pathParent = (path: string): string => path.substring(0, path.lastIndexOf('/'));

export function pathBasename(path: string): string {
  const name = pathName(path), dot = name.lastIndexOf('.');

  return dot === -1 ? name : name.slice(0, dot);
}

export function pathExtension(path: string): string {
  const name = pathName(path), dot = name.lastIndexOf('.');

  return dot === -1 ? '' : name.slice(dot + 1);
}
