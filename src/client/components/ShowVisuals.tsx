import type { ReactNode } from "react";
import { Layers } from "lucide-react";
import { Link } from "react-router-dom";
import { Avatar } from "./Avatar";
import type { ShowListItem, ShowUserProgress } from "../../shared/types";

export type ViewerBadge = ShowUserProgress & { isHistory: boolean };

/**
 * Expansion state for a poster overlay. A count rather than a season list: a show with
 * several expanded seasons would wrap the overlay and push the rest of it out of view.
 * Shared so the Dashboard strip and the Shows grid say it the same way.
 */
export function ExpandedSeasons({ seasons }: { seasons: number[] }) {
  if (seasons.length === 0) return <span className="text-[11px] text-on-surface/75">Pilot-only</span>;
  return (
    <span className="flex items-center gap-1 text-[11px] font-bold text-success">
      <Layers size={11} /> {seasons.length} expanded
    </span>
  );
}

/** The centred pill a PosterTile can show over the top of the artwork. */
export function PosterTileBadge({ children }: { children: ReactNode }) {
  return (
    <div className="absolute left-1/2 top-2 z-[1] inline-flex -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-md border border-success/40 bg-background/85 px-2 py-0.5 text-[11px] font-extrabold text-success shadow-lg backdrop-blur-md">
      {children}
    </div>
  );
}

/**
 * The poster tile used everywhere a show is shown as artwork — the Shows grid and the
 * Dashboard strip. Shared so the two can't drift: same aspect, border, hover lift, and
 * the same gradient-plus-detail overlay that fades in on hover (and is always visible on
 * touch, where there is no hover). `topBadge` stays visible without hovering, for the one
 * thing you need to compare across the whole grid at a glance.
 */
export function PosterTile({ show, to, state, topBadge, children }: {
  show: Pick<ShowListItem, "title" | "posterUrl">;
  to: string;
  state?: unknown;
  topBadge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Link
      className="group relative block rounded-xl text-on-surface no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      to={to}
      state={state}
    >
      <div className="relative aspect-[2/3] overflow-hidden rounded-xl border border-outline-variant/30 bg-background-container shadow-lg transition group-hover:scale-[1.035] group-hover:border-primary/55">
        <Poster show={show} className="h-full w-full rounded-none object-cover transition duration-500 group-hover:scale-[1.025]" />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent to-background opacity-0 transition-opacity group-hover:opacity-95 group-focus-visible:opacity-95 pointer-coarse:opacity-95" aria-hidden="true" />
        {topBadge}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex translate-y-1 flex-col items-start gap-0.5 p-2.5 opacity-0 transition group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100 pointer-coarse:translate-y-0 pointer-coarse:opacity-100">
          {children}
        </div>
      </div>
    </Link>
  );
}

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
