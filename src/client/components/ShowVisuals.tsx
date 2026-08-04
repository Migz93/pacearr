import { Avatar } from "./Avatar";
import type { ShowListItem, ShowUserProgress } from "../../shared/types";

export type ViewerBadge = ShowUserProgress & { isHistory: boolean };

export function Poster({ show, className = "" }: { show: Pick<ShowListItem, "title" | "posterUrl">; className?: string }) {
  if (show.posterUrl) return <img className={`block aspect-[2/3] bg-background-container object-cover ${className}`} src={show.posterUrl} alt={`${show.title} poster`} loading="lazy" />;
  return (
    <div className={`grid aspect-[2/3] place-items-center bg-background-container text-on-surface-variant ${className}`} role="img" aria-label={`${show.title} poster unavailable`}>
      <span className="grid size-14 place-items-center rounded-full bg-background-container-high text-2xl font-black">{show.title.slice(0, 1).toUpperCase()}</span>
    </div>
  );
}

function viewerTooltip(viewer: ViewerBadge) {
  const status = !viewer.enabled ? "disabled" : viewer.isHistory ? "inactive" : null;
  const watchedAt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(viewer.watchedAt));
  return `${viewer.displayName}${status ? ` (${status})` : ""} · watched ${watchedAt}`;
}

export function AvatarStack({ viewers, size = 26 }: { viewers: ViewerBadge[]; size?: number }) {
  if (viewers.length === 0) return null;
  const shown = viewers.slice(0, 4);
  const hidden = viewers.slice(4);
  return (
    <span className="flex items-center">
      {shown.map((viewer) => (
        <span className="-ml-2 block rounded-full first:ml-0 [box-shadow:0_0_0_2px_var(--color-background-container-low)]" key={viewer.userId} title={viewerTooltip(viewer)}>
          <Avatar avatarUrl={viewer.avatarUrl} displayName={viewer.displayName} size={size} muted={viewer.isHistory || !viewer.enabled} />
        </span>
      ))}
      {hidden.length > 0 && (
        <span
          className="-ml-2 grid place-items-center rounded-full bg-background-container-high text-[11px] font-extrabold text-on-surface-variant [box-shadow:0_0_0_2px_var(--color-background-container-low)]"
          style={{ width: size, height: size }}
          title={hidden.map(viewerTooltip).join(", ")}
        >
          +{hidden.length}
        </span>
      )}
    </span>
  );
}
