import { HardDrive } from "lucide-react";
import { Link } from "react-router-dom";
import type { ShowListItem, ShowRecommendation } from "../../shared/types";
import { formatBytes } from "../lib/utils";
import { AvatarStack, Poster } from "./ShowVisuals";

export type ShowBrowserItem =
  | { kind: "library"; data: ShowListItem }
  | { kind: "recommendation"; data: ShowRecommendation };

function seasonLabel(count: number) {
  return `${count} season${count === 1 ? "" : "s"}`;
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
    <Link className="poster-card" to={`/shows/${common.sonarrSeriesId}`} state={{ from: returnTo }}>
      <div className="poster-art">
        <Poster show={item.data} />
        <div className="poster-art-gradient" aria-hidden="true" />
        {item.kind === "recommendation" && (
          <div className="poster-savings-badge"><HardDrive size={12} /> {formatBytes(item.data.projectedSavingsBytes)}</div>
        )}
        <div className="poster-hover-info">
          <span className="poster-hover-year">{common.year ?? "Unknown year"}</span>
          <strong className="poster-hover-title">{common.title}</strong>
          <span className="poster-hover-meta">{seasonLabel(common.seasonCount)}</span>
          {common.watchers.length > 0 && <AvatarStack viewers={common.watchers} size={18} />}
        </div>
      </div>
    </Link>
  );
}

export function ShowListRow({ item, returnTo }: { item: ShowBrowserItem; returnTo: string }) {
  const common = commonFields(item);
  const rowClass = item.kind === "recommendation" ? "recommend-row" : "library-row";
  const ignored = item.kind === "recommendation" && item.data.ignored;
  return (
    <Link className={`${rowClass}${ignored ? " ignored" : ""}`} to={`/shows/${common.sonarrSeriesId}`} state={{ from: returnTo }}>
      <span className="recommend-show">
        <Poster show={item.data} className="recommend-poster" />
        <div>
          <strong>{common.title}</strong>
          <span className="muted small">
            {common.year ?? "Unknown year"} · {common.status ?? "unknown status"}
            {item.kind === "library" && item.data.enrolled && <span className="badge good inline-badge">Enrolled</span>}
            {ignored && <span className="badge warn inline-badge">Ignored</span>}
          </span>
        </div>
      </span>
      {item.kind === "recommendation" && <span>{formatBytes(item.data.sizeOnDiskBytes)}</span>}
      {item.kind === "recommendation" ? (
        <span className="recommend-seasons">
          <span className="badge good">{item.data.retainedSeasons.length} kept</span>
          <span className="badge warn">{item.data.droppedSeasons.length} pilot-only</span>
        </span>
      ) : (
        <span>{seasonLabel(common.seasonCount)}</span>
      )}
      <span className="recommend-watchers">
        <AvatarStack viewers={common.watchers} size={22} />
        {common.watcherCount === 0 && <span className="muted small">No recent viewers</span>}
      </span>
      {item.kind === "recommendation" && (
        <strong className="recommend-savings"><HardDrive size={14} /> {formatBytes(item.data.projectedSavingsBytes)}</strong>
      )}
    </Link>
  );
}
