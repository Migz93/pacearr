import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { apiGet } from "../lib/api";
import { badgeClass, formatRelativeTime } from "../lib/utils";
import { SelectInput } from "../components/FormControls";
import { ErrorBanner, Page, PageHeader } from "../components/Page";
import { HISTORY_CATEGORIES, historyActionLabel, isDryRunAction, isHistoryCategory } from "../../shared/history";
import type { HistoryEvent, HistoryPageResponse } from "../../shared/types";

// "error" is intentionally absent: nothing in the app writes an error-level history
// event, so offering the filter only ever produced an empty list.
type LevelFilter = "all" | "info" | "warn";

const LEVELS: LevelFilter[] = ["all", "info", "warn"];
const PAGE_SIZES = [10, 25, 50, 100];

const LEVEL_BADGE: Record<HistoryEvent["level"], string> = {
  info: badgeClass("success"),
  warn: badgeClass("warning"),
  error: badgeClass("error"),
};

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
  const requestedCategory = searchParams.get("category");
  const category = isHistoryCategory(requestedCategory) ? requestedCategory : "all";
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
      category,
    });
    try {
      setData(await apiGet<HistoryPageResponse>(`/api/history?${params.toString()}`));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [category, level, page, pageSize]);

  useEffect(() => { void load(); }, [load]);

  const events = data?.results ?? [];
  const pageInfo = data?.pageInfo;

  return (
    <Page>
      <PageHeader title="History" />

      <div className="mb-3.5 flex flex-wrap items-center gap-2 max-[820px]:flex-col max-[820px]:items-stretch">
        <fieldset className="m-0 flex min-w-0 overflow-hidden rounded-lg border border-outline-variant/30 p-0">
          <legend className="sr-only">Logging level</legend>
          {LEVELS.map((item) => (
            <button
              type="button"
              key={item}
              className={`min-h-8 whitespace-nowrap border-r border-outline-variant/30 px-2.5 text-xs font-bold last:border-r-0 ${level === item ? "bg-primary-dim text-on-surface" : "bg-background-container text-on-surface-variant hover:bg-background-container-high hover:text-on-surface"}`}
              aria-pressed={level === item}
              onClick={() => setParam("level", item, true)}
            >
              {item === "all" ? "All levels" : item === "warn" ? "Warning" : item.charAt(0).toUpperCase() + item.slice(1)}
            </button>
          ))}
        </fieldset>
        <fieldset className="m-0 flex min-w-0 flex-wrap overflow-hidden rounded-lg border border-outline-variant/30 p-0">
          <legend className="sr-only">Event type</legend>
          {[{ id: "all", label: "All types" }, ...HISTORY_CATEGORIES].map((item) => (
            <button type="button" key={item.id} className={`min-h-8 whitespace-nowrap border-r border-outline-variant/30 px-2.5 text-xs font-bold last:border-r-0 ${category === item.id ? "bg-primary-dim text-on-surface" : "bg-background-container text-on-surface-variant hover:bg-background-container-high hover:text-on-surface"}`} aria-pressed={category === item.id} onClick={() => setParam("category", item.id, true)}>
              {item.label}
            </button>
          ))}
        </fieldset>
        <SelectInput className="ml-auto w-auto min-w-[120px] max-[820px]:ml-0 max-[820px]:w-full" aria-label="Rows per page" value={pageSize} onChange={(value) => setParam("pageSize", value, true)}>
          {PAGE_SIZES.map((size) => <option value={size} key={size}>{size} / page</option>)}
        </SelectInput>
      </div>

      {error && <ErrorBanner message={error} />}
      <div className="overflow-hidden rounded-xl border border-outline-variant/30 bg-background-container">
        {loading && !data ? (
          <div className="p-6 text-center text-on-surface-variant">Loading history...</div>
        ) : events.length === 0 ? (
          <div className="p-6 text-center text-on-surface-variant">No history entries match the current filters.</div>
        ) : events.map((event) => <HistoryRow event={event} key={event.id} />)}
      </div>

      {pageInfo && pageInfo.total > 0 && (
        <div className="mt-3.5 flex items-center justify-between gap-3 text-xs text-on-surface-variant max-[820px]:flex-col max-[820px]:items-stretch">
          <span>{(pageInfo.page - 1) * pageInfo.pageSize + 1}-{Math.min(pageInfo.page * pageInfo.pageSize, pageInfo.total)} of {pageInfo.total}</span>
          <div className="flex items-center gap-2">
            <button type="button" className="inline-flex size-10 items-center justify-center rounded-lg border border-outline-variant/30 bg-background-container-high text-on-surface" aria-label="Previous page" disabled={page <= 1} onClick={() => setParam("page", String(page - 1))}><ChevronLeft size={14} /></button>
            <span>Page {pageInfo.page} / {pageInfo.pages}</span>
            <button type="button" className="inline-flex size-10 items-center justify-center rounded-lg border border-outline-variant/30 bg-background-container-high text-on-surface" aria-label="Next page" disabled={page >= pageInfo.pages} onClick={() => setParam("page", String(page + 1))}><ChevronRight size={14} /></button>
          </div>
        </div>
      )}
    </Page>
  );
}

function HistoryRow({ event }: { event: HistoryEvent }) {
  const [expanded, setExpanded] = useState(false);
  const details = parseDetails(event.details);

  return (
    <article className="border-b border-outline-variant/30 last:border-b-0">
      <button type="button" className="grid w-full grid-cols-[58px_minmax(0,1fr)_auto_16px] items-center gap-3 border-0 bg-transparent p-3.5 text-left text-on-surface hover:bg-background-container-high max-[820px]:grid-cols-[58px_minmax(0,1fr)_16px]" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        <span className={LEVEL_BADGE[event.level]}>{event.level}</span>
        <span className="grid min-w-0 gap-1">
          <span className="flex min-w-0 items-baseline gap-2.5">
            <strong className="overflow-hidden text-ellipsis whitespace-nowrap">{event.title}</strong>
            <span className="shrink-0 text-[11px] font-extrabold uppercase text-primary">{historyActionLabel(event.action)}</span>
            {isDryRunAction(event.action) && <span className={`${badgeClass("warning")} shrink-0 self-center`}>Dry run</span>}
          </span>
          <span className="text-xs text-on-surface-variant">{compactDetails(details)}</span>
        </span>
        <span className="whitespace-nowrap text-xs text-on-surface-variant max-[820px]:col-start-2 max-[820px]:row-start-2" title={new Date(event.createdAt).toLocaleString()}>{formatRelativeTime(event.createdAt)}</span>
        {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>
      {expanded && (
        <div className="px-4 pb-4 pl-[86px] text-xs text-on-surface-variant max-[820px]:pl-4">
          <dl className="mb-3 flex flex-wrap gap-[18px]">
            <div className="flex gap-1.5"><dt className="font-extrabold text-on-surface">Logged</dt><dd>{new Date(event.createdAt).toLocaleString()}</dd></div>
            <div className="flex gap-1.5"><dt className="font-extrabold text-on-surface">Event type</dt><dd>{event.action}</dd></div>
          </dl>
          <div className="font-extrabold text-on-surface">Details</div>
          {typeof details === "string" ? <p className="mt-1.5 rounded-lg border border-outline-variant/30 bg-background p-3 text-on-surface">{details}</p> : <pre className="mt-1.5 overflow-x-auto rounded-lg border border-outline-variant/30 bg-background p-3 text-on-surface">{JSON.stringify(details, null, 2)}</pre>}
        </div>
      )}
    </article>
  );
}
