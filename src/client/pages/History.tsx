import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { apiGet } from "../lib/api";
import { formatRelativeTime } from "../lib/utils";
import type { HistoryEvent, HistoryPageResponse } from "../../shared/types";

type LevelFilter = "all" | HistoryEvent["level"];

const LEVELS: LevelFilter[] = ["all", "info", "warn", "error"];
const PAGE_SIZES = [10, 25, 50, 100];

const ACTION_LABELS: Record<string, string> = {
  "history.import": "History import",
  "history.full_reconcile": "Full history reconciliation",
  "sessions.check": "Plex session check",
  "cleanup.inactive_reset": "Inactive show reset",
  "cleanup.progressive": "Progressive cleanup",
  "show.enrolled": "Show enrolled",
  "show.removed": "Show removed",
  "show.unenrolled": "Show unenrolled",
  "show.reset": "Show reset",
  "sonarr.baseline": "Sonarr baseline",
  "sonarr.expand_season": "Season expansion",
  "watch_events.reconciled": "Watch events reconciled",
  "dry_run.show.reset": "Show reset (dry run)",
  "dry_run.sonarr.baseline": "Sonarr baseline (dry run)",
  "dry_run.sonarr.expand_season": "Season expansion (dry run)",
};

function actionLabel(action: string) {
  return ACTION_LABELS[action] ?? action
    .split(/[._-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function parseDetails(details: string): unknown {
  try {
    return JSON.parse(details);
  } catch {
    return details;
  }
}

function compactDetails(details: unknown): string {
  if (typeof details === "string") return details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return String(details ?? "");

  const entries = Object.entries(details as Record<string, unknown>);
  return entries.slice(0, 3).map(([key, value]) => {
    const label = key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
    if (Array.isArray(value)) return `${label}: ${value.length}`;
    if (value && typeof value === "object") return `${label}: …`;
    return `${label}: ${String(value)}`;
  }).join(" · ");
}

export default function History() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedLevel = searchParams.get("level") as LevelFilter;
  const level = LEVELS.includes(requestedLevel) ? requestedLevel : "all";
  const action = searchParams.get("action") ?? "all";
  const requestedPage = Number(searchParams.get("page") ?? 1);
  const page = Number.isFinite(requestedPage) ? Math.max(1, requestedPage) : 1;
  const requestedPageSize = Number(searchParams.get("pageSize") ?? 10);
  const pageSize = PAGE_SIZES.includes(requestedPageSize) ? requestedPageSize : 10;

  const [data, setData] = useState<HistoryPageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function setParam(key: string, value: string, resetPage = false) {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      if (value === "all") next.delete(key);
      else next.set(key, value);
      if (resetPage) next.delete("page");
      return next;
    }, { replace: true });
  }

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
      level,
      action,
    });
    try {
      setData(await apiGet<HistoryPageResponse>(`/api/history?${params.toString()}`));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [action, level, page, pageSize]);

  useEffect(() => { void load(); }, [load]);

  const events = data?.results ?? [];
  const pageInfo = data?.pageInfo;

  return (
    <div className="page history-page">
      <div className="page-header">
        <div>
          <h1>History</h1>
          <p className="muted">Audit log for imports, Sonarr mutations, and cleanup.</p>
        </div>
      </div>

      <div className="history-toolbar">
        <div className="history-filter-group" aria-label="Logging level">
          {LEVELS.map((item) => (
            <button
              key={item}
              className={level === item ? "active" : ""}
              onClick={() => setParam("level", item, true)}
            >
              {item === "all" ? "All levels" : item === "warn" ? "Warning" : item.charAt(0).toUpperCase() + item.slice(1)}
            </button>
          ))}
        </div>
        <div className="history-filter-group history-action-filter" aria-label="Job type">
          <button className={action === "all" ? "active" : ""} onClick={() => setParam("action", "all", true)}>All types</button>
          {(data?.actions ?? []).map((item) => (
            <button key={item} className={action === item ? "active" : ""} onClick={() => setParam("action", item, true)}>
              {actionLabel(item)}
            </button>
          ))}
        </div>
        <select aria-label="Rows per page" value={pageSize} onChange={(event) => setParam("pageSize", event.target.value, true)}>
          {PAGE_SIZES.map((size) => <option value={size} key={size}>{size} / page</option>)}
        </select>
      </div>

      {error && <div className="error">{error}</div>}
      <div className="history-list">
        {loading && !data ? (
          <div className="empty">Loading history...</div>
        ) : events.length === 0 ? (
          <div className="empty">No history entries match the current filters.</div>
        ) : events.map((event) => <HistoryRow event={event} key={event.id} />)}
      </div>

      {pageInfo && pageInfo.total > 0 && (
        <div className="history-pagination">
          <span>{(pageInfo.page - 1) * pageInfo.pageSize + 1}-{Math.min(pageInfo.page * pageInfo.pageSize, pageInfo.total)} of {pageInfo.total}</span>
          <div className="button-row">
            <button className="icon-button" aria-label="Previous page" disabled={page <= 1} onClick={() => setParam("page", String(page - 1))}><ChevronLeft size={14} /></button>
            <span>Page {pageInfo.page} / {pageInfo.pages}</span>
            <button className="icon-button" aria-label="Next page" disabled={page >= pageInfo.pages} onClick={() => setParam("page", String(page + 1))}><ChevronRight size={14} /></button>
          </div>
        </div>
      )}
    </div>
  );
}

function HistoryRow({ event }: { event: HistoryEvent }) {
  const [expanded, setExpanded] = useState(false);
  const details = parseDetails(event.details);

  return (
    <article className={`history-entry level-${event.level}`}>
      <button className="history-summary" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        <span className={`badge ${event.level === "info" ? "good" : event.level === "warn" ? "warn" : "danger"}`}>{event.level}</span>
        <span className="history-summary-copy">
          <span className="history-title-line">
            <strong>{event.title}</strong>
            <span className="history-action">{actionLabel(event.action)}</span>
          </span>
          <span className="muted small">{compactDetails(details)}</span>
        </span>
        <span className="history-time" title={new Date(event.createdAt).toLocaleString()}>{formatRelativeTime(event.createdAt)}</span>
        {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>
      {expanded && (
        <div className="history-details">
          <dl>
            <div><dt>Logged</dt><dd>{new Date(event.createdAt).toLocaleString()}</dd></div>
            <div><dt>Job type</dt><dd>{event.action}</dd></div>
          </dl>
          <div className="history-details-label">Details</div>
          {typeof details === "string" ? <p>{details}</p> : <pre>{JSON.stringify(details, null, 2)}</pre>}
        </div>
      )}
    </article>
  );
}
