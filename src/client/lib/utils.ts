export function formatRelativeTime(value: string | null | undefined) {
  if (!value) return "never";
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(value).toLocaleDateString();
}

export function titleCaseJob(id: string) {
  return id.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

const BADGE_BASE = "inline-flex min-w-12 items-center justify-center gap-1 rounded-[5px] px-1.5 py-0.5 text-[10px] font-black uppercase";

// Tint opacities differ per variant (18/16/15) to keep each variant's text
// contrast above WCAG AA across every surface a badge renders on — see the
// status-badge rows in docs/colour-scheme.md.
export function badgeClass(variant?: "success" | "warning" | "error"): string {
  switch (variant) {
    case "success":
      return `${BADGE_BASE} bg-success/18 text-success`;
    case "warning":
      return `${BADGE_BASE} bg-warning/16 text-warning`;
    case "error":
      return `${BADGE_BASE} bg-error/15 text-error`;
    default:
      return `${BADGE_BASE} bg-background-container-high text-on-surface-variant`;
  }
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 GB";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}
