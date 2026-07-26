import { Avatar } from "./Avatar";
import type { ShowListItem, ShowUserProgress } from "../../shared/types";

export type ViewerBadge = ShowUserProgress & { isHistory: boolean };

export function Poster({ show, className = "" }: { show: Pick<ShowListItem, "title" | "posterUrl">; className?: string }) {
  if (show.posterUrl) return <img className={`show-poster ${className}`} src={show.posterUrl} alt={`${show.title} poster`} loading="lazy" />;
  return (
    <div className={`show-poster poster-fallback ${className}`} aria-label={`${show.title} poster unavailable`}>
      <span>{show.title.slice(0, 1).toUpperCase()}</span>
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
    <div className="avatar-stack">
      {shown.map((viewer) => (
        <span className="avatar-stack-item" key={viewer.userId} title={viewerTooltip(viewer)}>
          <Avatar avatarUrl={viewer.avatarUrl} displayName={viewer.displayName} size={size} muted={viewer.isHistory || !viewer.enabled} />
        </span>
      ))}
      {hidden.length > 0 && (
        <span
          className="avatar-stack-item avatar-overflow"
          style={{ width: size, height: size }}
          title={hidden.map(viewerTooltip).join(", ")}
        >
          +{hidden.length}
        </span>
      )}
    </div>
  );
}
