export function getPlexImageSrc(path: string | null | undefined): string | null {
  if (!path) return null;
  if (path.startsWith("/images/")) return path;
  return null;
}
