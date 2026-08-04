import { HardDrive } from "lucide-react";
import { Link } from "react-router-dom";
import type { ShowListItem, ShowRecommendation } from "../../shared/types";
import { badgeClass, formatBytes } from "../lib/utils";
import { AvatarStack, Poster } from "./ShowVisuals";

export type ShowBrowserItem =
  | { kind: "library"; data: ShowListItem }
  | { kind: "recommendation"; data: ShowRecommendation };

function seasonLabel(count: number) {
  return `${count} season${count === 1 ? "" : "s"}`;
}

// Column header text is hidden below the list breakpoints (see the header
// rows in Shows.tsx), so stacked mobile values need their own inline label
// to stay identifiable — otherwise a mobile user sees bare numbers/badges
// with no indication of what each one means.
export function RowLabel({ children, className }: { children: React.ReactNode; className: string }) {
  return <span className={`mr-1.5 shrink-0 text-[10px] font-black uppercase tracking-wide text-on-surface-variant ${className}`}>{children}</span>;
}

function commonFields(item: ShowBrowserItem) {
  const { data } = item;
  return {
    sonarrSeriesId: data.sonarrSeriesId,
    title: data.title,
    year: data.year,
    status: data.status,
    seasonCount: data.seasonCount,
    watcherCount: data.watcherCount,
    watchers: data.watchers.map((watcher) => ({ ...watcher, isHistory: false })),
  };
}

export function ShowCard({ item, returnTo }: { item: ShowBrowserItem; returnTo: string }) {
  const common = commonFields(item);
  return (
    <Link className="group relative block rounded-xl text-on-surface no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background" to={`/shows/${common.sonarrSeriesId}`} state={{ from: returnTo }}>
      <div className="relative aspect-[2/3] overflow-hidden rounded-xl border border-outline-variant/30 bg-background-container shadow-lg transition group-hover:scale-[1.035] group-hover:border-primary/55">
        <Poster show={item.data} className="h-full w-full rounded-none object-cover transition duration-500 group-hover:scale-[1.025]" />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent to-background opacity-0 transition-opacity group-hover:opacity-95 group-focus-visible:opacity-95 pointer-coarse:opacity-95" aria-hidden="true" />
        {item.kind === "recommendation" && (
          <div className="absolute left-1/2 top-2 z-[1] inline-flex -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-md border border-success/45 bg-success/20 px-2 py-0.5 text-[11px] font-extrabold text-on-surface shadow-lg backdrop-blur-sm"><HardDrive size={12} /> {formatBytes(item.data.projectedSavingsBytes)}</div>
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex translate-y-1 flex-col items-start gap-0.5 p-2.5 opacity-0 transition group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100 pointer-coarse:translate-y-0 pointer-coarse:opacity-100">
          <span className="text-[11px] font-bold text-on-surface/75">{common.year ?? "Unknown year"}</span>
          <strong className="line-clamp-2 text-sm font-extrabold leading-tight text-on-surface">{common.title}</strong>
          <span className="text-[11px] text-on-surface/75">{seasonLabel(common.seasonCount)}</span>
          {common.watchers.length > 0 && <AvatarStack viewers={common.watchers} size={18} />}
        </div>
      </div>
    </Link>
  );
}

export function ShowListRow({ item, returnTo }: { item: ShowBrowserItem; returnTo: string }) {
  const common = commonFields(item);
  const ignored = item.kind === "recommendation" && item.data.ignored;
  return (
    <Link className={`${ignored ? "opacity-60" : ""} grid items-center gap-3.5 border-b border-outline-variant/30 px-4 py-3 text-on-surface no-underline last:border-b-0 hover:[&>div:first-child>div>strong]:text-primary ${item.kind === "recommendation" ? "grid-cols-[minmax(220px,1.6fr)_110px_170px_140px_140px] max-[1170px]:grid-cols-1" : "grid-cols-[minmax(220px,1.6fr)_170px_220px] max-[970px]:grid-cols-1"}`} to={`/shows/${common.sonarrSeriesId}`} state={{ from: returnTo }}>
      <div className="flex min-w-0 items-center gap-3">
        <Poster show={item.data} className="w-10 shrink-0 rounded object-cover" />
        <div className="min-w-0">
          <strong className="block overflow-hidden text-ellipsis whitespace-nowrap">{common.title}</strong>
          <span className="block overflow-hidden text-ellipsis whitespace-nowrap text-xs text-on-surface-variant">
            {common.year ?? "Unknown year"} · {common.status ?? "unknown status"}
            {item.kind === "library" && item.data.enrolled && <span className={`${badgeClass("success")} ml-1.5`}>Enrolled</span>}
            {ignored && <span className={`${badgeClass("warning")} ml-1.5`}>Ignored</span>}
          </span>
        </div>
      </div>
      {item.kind === "recommendation" && <span><RowLabel className="hidden max-[1170px]:inline">Size on disk</RowLabel>{formatBytes(item.data.sizeOnDiskBytes)}</span>}
      {item.kind === "recommendation" ? (
      <span className="flex flex-wrap items-center gap-1.5">
          <RowLabel className="hidden max-[1170px]:inline">Seasons</RowLabel>
          <span className={badgeClass("success")}>{item.data.retainedSeasons.length} kept</span>
          <span className={badgeClass("warning")}>{item.data.droppedSeasons.length} pilot-only</span>
        </span>
      ) : (
        <span>{seasonLabel(common.seasonCount)}</span>
      )}
      <span className="flex items-center gap-2">
        <RowLabel className={item.kind === "recommendation" ? "hidden max-[1170px]:inline" : "hidden max-[970px]:inline"}>Watchers</RowLabel>
        <AvatarStack viewers={common.watchers} size={22} />
        {common.watcherCount === 0 && <span className="text-xs text-on-surface-variant">No recent viewers</span>}
      </span>
      {item.kind === "recommendation" && (
        <strong className="flex items-center gap-1.5 text-success"><RowLabel className="hidden max-[1170px]:inline">Projected savings</RowLabel><HardDrive size={14} /> {formatBytes(item.data.projectedSavingsBytes)}</strong>
      )}
    </Link>
  );
}
