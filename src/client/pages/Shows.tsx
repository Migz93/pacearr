import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowLeft, ArrowRight, ArrowUpDown, ChevronDown, ChevronRight, Eye, EyeOff, LayoutGrid, List, Plus, RefreshCw, RotateCcw, Search, Trash2, X,
} from "lucide-react";
import { apiDelete, apiGet, apiPost } from "../lib/api";
import { formatBytes } from "../lib/utils";
import { AvatarStack, Poster, type ViewerBadge } from "../components/ShowVisuals";
import { ShowCard, ShowListRow, type ShowBrowserItem } from "../components/ShowCard";
import type {
  RecommendationsResponse, RunResult, ShowDetailResponse, ShowEpisodeSummary, ShowListItem, ShowSeasonSummary, ShowsResponse,
} from "../../shared/types";

type ShowsTab = "enrolled" | "recommendations" | "ignored" | "sonarr";
type ViewMode = "poster" | "list";
type SortMode = "title-asc" | "title-desc" | "size-desc" | "size-asc";

const TABS: { id: ShowsTab; label: string }[] = [
  { id: "enrolled", label: "Enrolled" },
  { id: "recommendations", label: "Recommendations" },
  { id: "ignored", label: "Ignored" },
  { id: "sonarr", label: "Sonarr" },
];

const SORT_MODES: SortMode[] = ["title-asc", "title-desc", "size-desc", "size-asc"];

// Recommendations/Ignored are led by projected savings (see TAB_SUBTITLES), not raw size on
// disk, so the "size" sort modes rank by that metric there — labeled "Savings" rather than
// "Size" so the control doesn't imply it matches the "Size on disk" column shown in-list.
const DEFAULT_SORT: Record<ShowsTab, SortMode> = {
  enrolled: "title-asc",
  sonarr: "title-asc",
  recommendations: "size-desc",
  ignored: "size-desc",
};

function sortOptionsFor(tab: ShowsTab): { id: SortMode; label: string }[] {
  const sizeLabel = tab === "recommendations" || tab === "ignored" ? "Savings" : "Size";
  return [
    { id: "title-asc", label: "Name (A → Z)" },
    { id: "title-desc", label: "Name (Z → A)" },
    { id: "size-desc", label: `${sizeLabel} (High → Low)` },
    { id: "size-asc", label: `${sizeLabel} (Low → High)` },
  ];
}

function isSortMode(value: string | null): value is SortMode {
  return SORT_MODES.includes(value as SortMode);
}

function sizeOf(item: ShowBrowserItem): number {
  return item.kind === "recommendation" ? item.data.projectedSavingsBytes : item.data.sizeOnDiskBytes;
}

function compareItems(a: ShowBrowserItem, b: ShowBrowserItem, sort: SortMode): number {
  if (sort === "title-asc" || sort === "title-desc") {
    const cmp = a.data.title.localeCompare(b.data.title);
    return sort === "title-asc" ? cmp : -cmp;
  }
  const cmp = sizeOf(a) - sizeOf(b);
  return sort === "size-asc" ? cmp : -cmp;
}

const TAB_SUBTITLES: Record<ShowsTab, string> = {
  enrolled: "Shows currently controlled by Pacearr.",
  recommendations: "Un-enrolled Sonarr shows, ranked by how much disk space enrolling would free up.",
  ignored: "Recommendations you've chosen to ignore.",
  sonarr: "Every show in your Sonarr library.",
};

const PAGE_SIZE = 24;

function isShowsTab(value: string | null): value is ShowsTab {
  return TABS.some((tab) => tab.id === value);
}

function viewStorageKey(tab: ShowsTab) {
  return `pacearr:shows-view:${tab}`;
}

function loadStoredView(tab: ShowsTab): ViewMode {
  // localStorage can throw (private browsing, blocked storage, sandboxed iframes) —
  // treat the remembered view as a nice-to-have, not something that can break the page.
  try {
    return window.localStorage.getItem(viewStorageKey(tab)) === "list" ? "list" : "poster";
  } catch {
    return "poster";
  }
}

function sortStorageKey(tab: ShowsTab) {
  return `pacearr:shows-sort:${tab}`;
}

function loadStoredSort(tab: ShowsTab): SortMode {
  try {
    const stored = window.localStorage.getItem(sortStorageKey(tab));
    return isSortMode(stored) ? stored : DEFAULT_SORT[tab];
  } catch {
    return DEFAULT_SORT[tab];
  }
}

function formatDate(value: string | null) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

function episodeLabel(seasonNumber: number, episodeNumber: number) {
  return `S${String(seasonNumber).padStart(2, "0")}E${String(episodeNumber).padStart(2, "0")}`;
}

export default function Shows() {
  const { seriesId } = useParams();
  if (seriesId) return <ShowDetail seriesId={Number(seriesId)} />;
  return <ShowsBrowser />;
}

function ShowsBrowser() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const tab: ShowsTab = isShowsTab(tabParam) ? tabParam : "enrolled";
  const page = Math.max(1, Math.floor(Number(searchParams.get("page")) || 1));

  const [items, setItems] = useState<ShowBrowserItem[]>([]);
  const [ignoredCount, setIgnoredCount] = useState(0);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [view, setView] = useState<ViewMode>(() => loadStoredView(tab));
  const [sort, setSort] = useState<SortMode>(() => loadStoredSort(tab));

  useEffect(() => { setView(loadStoredView(tab)); setSort(loadStoredSort(tab)); setQuery(""); }, [tab]);

  // Tracks the tab actually selected right now, independent of `load`'s closure, so a
  // slow response for a tab the user has since switched away from can't overwrite it.
  const activeTabRef = useRef(tab);
  useEffect(() => { activeTabRef.current = tab; }, [tab]);

  async function load(background = false) {
    const requestedTab = tab;
    if (!background) setLoading(true);
    try {
      if (requestedTab === "enrolled" || requestedTab === "sonarr") {
        const response = await apiGet<ShowsResponse>(requestedTab === "enrolled" ? "/api/shows?enrolled=true" : "/api/shows");
        if (activeTabRef.current !== requestedTab) return;
        setItems(response.shows.map((data): ShowBrowserItem => ({ kind: "library", data })));
        setRefreshing(response.refreshing);
      } else {
        const response = await apiGet<RecommendationsResponse>(`/api/recommendations?includeIgnored=${requestedTab === "ignored"}`);
        if (activeTabRef.current !== requestedTab) return;
        const candidates = requestedTab === "ignored" ? response.candidates.filter((candidate) => candidate.ignored) : response.candidates;
        setItems(candidates.map((data): ShowBrowserItem => ({ kind: "recommendation", data })));
        setIgnoredCount(response.ignoredCount);
        setRefreshing(response.refreshing);
      }
      setError(null);
    } catch (caught) {
      if (activeTabRef.current !== requestedTab) return;
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (activeTabRef.current === requestedTab) setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [tab]);
  useEffect(() => {
    if (!refreshing) return;
    const timer = setInterval(() => void load(true), 2000);
    return () => clearInterval(timer);
  }, [refreshing, tab]);

  async function refresh() {
    setError(null);
    try {
      await apiPost("/api/shows/refresh");
      await load(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function setTab(nextTab: ShowsTab) {
    const next = new URLSearchParams(searchParams);
    if (nextTab === "enrolled") next.delete("tab"); else next.set("tab", nextTab);
    next.delete("page");
    setSearchParams(next);
  }

  function setPage(nextPage: number) {
    const next = new URLSearchParams(searchParams);
    if (nextPage <= 1) next.delete("page"); else next.set("page", String(nextPage));
    setSearchParams(next);
  }

  function handleQueryChange(value: string) {
    setQuery(value);
    setPage(1);
  }

  function toggleView(nextView: ViewMode) {
    setView(nextView);
    try {
      window.localStorage.setItem(viewStorageKey(tab), nextView);
    } catch {
      // Storage is unavailable — the choice just won't persist across reloads.
    }
  }

  function changeSort(nextSort: SortMode) {
    setSort(nextSort);
    try {
      window.localStorage.setItem(sortStorageKey(tab), nextSort);
    } catch {
      // Storage is unavailable — the choice just won't persist across reloads.
    }
  }

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return items;
    return items.filter((item) => item.data.title.toLowerCase().includes(normalized));
  }, [items, query]);

  const sorted = useMemo(() => [...filtered].sort((a, b) => compareItems(a, b, sort)), [filtered, sort]);

  const totalSavingsBytes = useMemo(
    () => items.reduce((sum, item) => sum + (item.kind === "recommendation" ? item.data.projectedSavingsBytes : 0), 0),
    [items]
  );

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const visibleItems = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const currentTabUrl = `/shows${searchParams.size > 0 ? `?${searchParams.toString()}` : ""}`;
  const isRecommendationTab = tab === "recommendations" || tab === "ignored";

  function emptyMessage() {
    if (refreshing && items.length === 0) return "The Sonarr library is being prepared in the background. This page will update automatically.";
    if (tab === "enrolled") return "No controlled shows match that search. Use Enroll show to add one from Sonarr.";
    if (tab === "sonarr") return "No Sonarr shows match that search.";
    if (tab === "recommendations") return "No recommendations right now — every un-enrolled show would stay fully retained, or every show is already enrolled.";
    return "No ignored recommendations.";
  }

  return (
    <div className="page shows-page">
      <div className="page-header">
        <div>
          <h1>Shows</h1>
          <p className="muted">{TAB_SUBTITLES[tab]}</p>
        </div>
        <div className="button-row">
          <button type="button" className="primary-button" onClick={() => setAdding(true)}><Plus size={16} /> Enroll show</button>
          <button type="button" className="secondary-button" onClick={() => void refresh()} disabled={loading || refreshing}>
            <RefreshCw size={16} className={loading || refreshing ? "spin" : ""} /> {refreshing ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="tab-strip" role="tablist">
        {TABS.map((entry) => (
          <button
            type="button"
            key={entry.id}
            role="tab"
            aria-selected={tab === entry.id}
            className={tab === entry.id ? "active" : ""}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}{entry.id === "ignored" && ignoredCount > 0 ? ` (${ignoredCount})` : ""}
          </button>
        ))}
      </div>
      <div className="shows-toolbar-row">
        <div className="shows-toolbar">
          <Search size={17} />
          <input aria-label="Search shows" value={query} onChange={(event) => handleQueryChange(event.target.value)} placeholder="Search shows..." />
        </div>
        <div className="shows-sort-toolbar">
          <ArrowUpDown size={16} />
          <select aria-label="Sort shows" value={sort} onChange={(event) => changeSort(event.target.value as SortMode)}>
            {sortOptionsFor(tab).map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}
          </select>
        </div>
        <div className="view-toggle" role="group" aria-label="View mode">
          <button type="button" aria-pressed={view === "poster"} aria-label="Poster view" className={view === "poster" ? "active" : ""} onClick={() => toggleView("poster")} title="Poster view">
            <LayoutGrid size={16} />
          </button>
          <button type="button" aria-pressed={view === "list"} aria-label="List view" className={view === "list" ? "active" : ""} onClick={() => toggleView("list")} title="List view">
            <List size={16} />
          </button>
        </div>
      </div>
      {isRecommendationTab && !loading && items.length > 0 && (
        <div className="recommend-stat-row">
          <div className="recommend-stat"><span>Candidates</span><strong>{items.length}</strong></div>
          <div className="recommend-stat"><span>Potential Savings</span><strong>{formatBytes(totalSavingsBytes)}</strong></div>
        </div>
      )}
      {loading ? (
        <div className="centered-panel">Loading shows...</div>
      ) : view === "poster" ? (
        <div className="poster-grid">
          {visibleItems.map((item) => <ShowCard item={item} returnTo={currentTabUrl} key={item.data.sonarrSeriesId} />)}
          {filtered.length === 0 && <div className="empty">{emptyMessage()}</div>}
        </div>
      ) : (
        <div className="recommend-table">
          {isRecommendationTab ? (
            <div className="recommend-head">
              <span>Show</span><span>Size on disk</span><span>Seasons</span><span>Watchers</span><span>Projected savings</span>
            </div>
          ) : (
            <div className="library-head">
              <span>Show</span><span>Seasons</span><span>Watchers</span>
            </div>
          )}
          {visibleItems.map((item) => <ShowListRow item={item} returnTo={currentTabUrl} key={item.data.sonarrSeriesId} />)}
          {filtered.length === 0 && <div className="empty">{emptyMessage()}</div>}
        </div>
      )}
      {filtered.length > PAGE_SIZE && (
        <div className="recommend-pagination">
          <span className="muted small">
            Showing {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filtered.length)} of {filtered.length}
          </span>
          <div className="button-row">
            <button type="button" className="secondary-button compact" disabled={safePage === 1} onClick={() => setPage(safePage - 1)}>Previous</button>
            <span className="small">Page {safePage} of {pageCount}</span>
            <button type="button" className="secondary-button compact" disabled={safePage === pageCount} onClick={() => setPage(safePage + 1)}>Next</button>
          </div>
        </div>
      )}
      {adding && <AddShowModal onClose={() => setAdding(false)} onAdded={async () => { setAdding(false); await load(); }} />}
    </div>
  );
}

function AddShowModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => Promise<void> }) {
  const [query, setQuery] = useState("");
  const [shows, setShows] = useState<ShowListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [addingId, setAddingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) { setShows([]); return; }
    const timer = setTimeout(() => {
      setLoading(true);
      apiGet<{ shows: ShowListItem[] }>(`/api/shows?query=${encodeURIComponent(term)}`)
        .then((data) => setShows(data.shows.filter((show) => !show.enrolled)))
        .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  async function add(show: ShowListItem) {
    setAddingId(show.sonarrSeriesId);
    setError(null);
    try {
      await apiPost(`/api/shows/${show.sonarrSeriesId}/enroll`, { applyBaseline: true, importHistory: true });
      await onAdded();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setAddingId(null);
    }
  }

  return <div className="modal-backdrop" onClick={onClose}>
    <div className="modal" onClick={(event) => event.stopPropagation()}>
      <div className="modal-header"><div><h2>Enroll show</h2><p className="muted">Search existing Sonarr series to enroll in Pacearr control.</p></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button></div>
      <div className="shows-toolbar"><Search size={17} /><input aria-label="Search Sonarr shows" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Sonarr shows..." /></div>
      {error && <div className="error">{error}</div>}
      {query.trim().length < 2 ? <div className="empty">Enter at least two characters to search Sonarr.</div> : loading ? <div className="empty">Searching Sonarr...</div> : <div className="add-show-results">{shows.map((show) => <div className="add-show-row" key={show.sonarrSeriesId}><div><strong>{show.title}</strong><span>{show.year ?? "Unknown year"} · {show.seasonCount} seasons</span></div><button type="button" className="primary-button compact" disabled={addingId !== null} onClick={() => void add(show)}>{addingId === show.sonarrSeriesId ? "Adding..." : "Add"}</button></div>)}{shows.length === 0 && <div className="empty">No available Sonarr shows match this search.</div>}</div>}
    </div>
  </div>;
}

function ShowDetail({ seriesId }: { seriesId: number }) {
  const navigate = useNavigate();
  const location = useLocation();
  const returnPath = (location.state as { from?: string } | null)?.from ?? "/shows";
  const returnTabParam = (returnPath.includes("?") ? new URLSearchParams(returnPath.split("?")[1]).get("tab") : null) ?? "enrolled";
  const returnLabel = TABS.find((tab) => tab.id === returnTabParam)?.label ?? "Shows";
  const [detail, setDetail] = useState<ShowDetailResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHistoryViewers, setShowHistoryViewers] = useState(false);

  const { viewersBySeason, viewersByEpisode } = useMemo(() => {
    const bySeason = new Map<number, ViewerBadge[]>();
    const byEpisode = new Map<string, ViewerBadge[]>();
    if (!detail) return { viewersBySeason: bySeason, viewersByEpisode: byEpisode };
    const viewers: ViewerBadge[] = [
      ...detail.progress.map((item) => ({ ...item, isHistory: false })),
      ...(showHistoryViewers ? detail.historyProgress.map((item) => ({ ...item, isHistory: true })) : []),
    ];
    for (const viewer of viewers) {
      bySeason.set(viewer.seasonNumber, [...(bySeason.get(viewer.seasonNumber) ?? []), viewer]);
      const episodeKey = `${viewer.seasonNumber}:${viewer.episodeNumber}`;
      byEpisode.set(episodeKey, [...(byEpisode.get(episodeKey) ?? []), viewer]);
    }
    return { viewersBySeason: bySeason, viewersByEpisode: byEpisode };
  }, [detail, showHistoryViewers]);

  async function load() {
    try {
      setDetail(await apiGet<ShowDetailResponse>(`/api/shows/${seriesId}`));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  useEffect(() => { void load(); }, [seriesId]);

  async function runAction(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function enroll() {
    await runAction(() => apiPost<RunResult>(`/api/shows/${seriesId}/enroll`, { applyBaseline: true, importHistory: true }));
  }

  if (!detail) {
    return (
      <div className="page">
        <button type="button" className="secondary-button" onClick={() => navigate(returnPath)}><ArrowLeft size={16} /> {returnLabel}</button>
        {error ? <div className="error detail-loading-error">{error}</div> : <div className="centered-panel">Loading show...</div>}
      </div>
    );
  }

  const { show } = detail;

  return (
    <div className="page show-detail-page">
      <div className="show-detail-topbar">
        <button type="button" className="secondary-button" onClick={() => navigate(returnPath)}><ArrowLeft size={16} /> {returnLabel}</button>
        <button type="button" className="secondary-button" onClick={() => void load()}><RefreshCw size={16} /> Refresh</button>
      </div>
      {error && <div className="error">{error}</div>}
      <section className="show-detail-hero">
        <Poster show={show} className="detail-poster" />
        <div className="show-detail-copy">
          <div className="show-detail-badges">
            <div className={`show-state ${show.enrolled ? "enrolled" : ""}`}>{show.enrolled ? "Enrolled" : "Not enrolled"}</div>
            <span
              className={`badge ${detail.dryRunPreview.enabled ? "warn" : "good"}`}
              title={detail.dryRunPreview.enabled
                ? "Dry run: monitoring changes are calculated but not sent to Sonarr"
                : "Live: monitoring changes are sent to Sonarr automatically"}
            >
              {detail.dryRunPreview.enabled ? "Dry run" : "Live"}
            </span>
            {detail.recommendation?.ignored && <span className="badge warn">Ignored</span>}
          </div>
          <h1>{show.title}</h1>
          <p className="muted">{show.year ?? "Unknown year"} · {show.seasonCount} season{show.seasonCount === 1 ? "" : "s"} · {show.episodeCount} episodes · {show.status ?? "unknown status"}</p>
          {detail.recommendation && (
            <div className="recommend-stat-row detail-recommend-stats">
              <div className="recommend-stat"><span>Size on disk</span><strong>{formatBytes(detail.recommendation.sizeOnDiskBytes)}</strong></div>
              <div className="recommend-stat"><span>Projected savings if enrolled</span><strong>{formatBytes(detail.recommendation.projectedSavingsBytes)}</strong></div>
            </div>
          )}
          <div className="button-row">
            {show.enrolled && show.rollingShowId ? (
              <>
                <button
                  type="button"
                  className="secondary-button danger"
                  disabled={busy}
                  title={detail.dryRunPreview.enabled
                    ? "Dry run: previews resetting the show to first-episode-only monitoring for every season. No Sonarr changes or file deletions are made."
                    : "Resets the show to first-episode-only monitoring for every season and clears its expanded-season progress. Excess episode files may be deleted if deletion is enabled in Settings."}
                  onClick={() => runAction(() => apiPost(`/api/rolling-shows/${show.rollingShowId}/reset`))}
                >
                  <RotateCcw size={15} /> Reset
                </button>
                <button
                  type="button"
                  className="secondary-button danger"
                  disabled={busy}
                  title="Stops Pacearr from managing this show and removes its stored rolling progress. It does not delete media or undo the show's current Sonarr monitoring state."
                  onClick={() => runAction(() => apiDelete(`/api/rolling-shows/${show.rollingShowId}`))}
                >
                  <Trash2 size={15} /> Unenroll
                </button>
              </>
            ) : (
              <>
                <button type="button" className="primary-button" disabled={busy} onClick={() => void enroll()}>
                  Enroll in rolling episodes
                </button>
                {detail.recommendation && (detail.recommendation.eligible || detail.recommendation.ignored) && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => runAction(() => detail.recommendation!.ignored
                      ? apiDelete(`/api/recommendations/${seriesId}/ignore`)
                      : apiPost(`/api/recommendations/${seriesId}/ignore`, { title: show.title }))}
                  >
                    {detail.recommendation.ignored ? <RotateCcw size={15} /> : <EyeOff size={15} />}
                    {detail.recommendation.ignored ? "Restore" : "Ignore"}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </section>
      <section className="section season-browser">
        <div className="season-browser-head">
          <div>
            <h2>Seasons</h2>
            <p className="muted">Expand a season to review its episodes, who's watching, and current vs. intended Sonarr monitoring state.</p>
          </div>
          <label className="toggle-field">
            <input type="checkbox" checked={showHistoryViewers} onChange={(event) => setShowHistoryViewers(event.target.checked)} />
            <span className="toggle-track"><span /></span>
            <span><strong>Show inactive viewers</strong></span>
          </label>
        </div>
        <div className="season-list">
          {detail.seasons.map((season) => (
            <SeasonPanel
              season={season}
              episodes={detail.episodes.filter((episode) => episode.seasonNumber === season.seasonNumber)}
              viewers={viewersBySeason.get(season.seasonNumber) ?? []}
              viewersByEpisode={viewersByEpisode}
              dryRunEnabled={detail.dryRunPreview.enabled}
              key={season.seasonNumber}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function MonitorState({ current, target, dryRunEnabled }: { current: boolean; target: boolean; dryRunEnabled: boolean }) {
  const mismatch = current !== target;
  return (
    <div className="monitor-state">
      <span className={`badge ${current ? "good" : ""}`}>
        {current ? <Eye size={12} /> : <EyeOff size={12} />} {current ? "Monitored" : "Not monitored"}
      </span>
      {mismatch && (
        <span
          className="badge warn"
          title={dryRunEnabled
            ? `Dry run: would become ${target ? "monitored" : "not monitored"} once applied`
            : `Pending: will become ${target ? "monitored" : "not monitored"} on the next run`}
        >
          <ArrowRight size={12} /> {target ? "Monitored" : "Not monitored"}
        </span>
      )}
    </div>
  );
}

function SeasonPanel({ season, episodes, viewers, viewersByEpisode, dryRunEnabled }: {
  season: ShowSeasonSummary;
  episodes: ShowEpisodeSummary[];
  viewers: ViewerBadge[];
  viewersByEpisode: Map<string, ViewerBadge[]>;
  dryRunEnabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="season-panel">
      <button type="button" className="season-row" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        {open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
      <div>
        <strong>Season {season.seasonNumber}</strong>
        <span>
          {season.episodeCount || season.totalEpisodeCount} episodes
          {season.watchedUsers > 0 ? ` · ${season.watchedUsers} watched` : ""}
          {season.latestWatchedAt ? ` · last ${formatDate(season.latestWatchedAt)}` : ""}
        </span>
      </div>
      <AvatarStack viewers={viewers} />
      <div className="season-signals">
        {season.isExpanded && <span className="badge good">Expanded</span>}
        <MonitorState current={season.monitored} target={season.targetMonitored} dryRunEnabled={dryRunEnabled} />
      </div>
      </button>
      {open && <EpisodeTable episodes={episodes} viewersByEpisode={viewersByEpisode} dryRunEnabled={dryRunEnabled} />}
    </div>
  );
}

function EpisodeTable({ episodes, viewersByEpisode, dryRunEnabled }: {
  episodes: ShowEpisodeSummary[];
  viewersByEpisode: Map<string, ViewerBadge[]>;
  dryRunEnabled: boolean;
}) {
  return (
      <div className="episode-table">
        <div className="episode-head">
          <span>Episode</span>
          <span>Title</span>
          <span>State</span>
          <span>Air date</span>
        </div>
        {episodes.map((episode) => {
          const viewers = viewersByEpisode.get(`${episode.seasonNumber}:${episode.episodeNumber}`) ?? [];
          return (
            <div className="episode-row" key={episode.id}>
              <strong>{episodeLabel(episode.seasonNumber, episode.episodeNumber)}</strong>
              <div className="episode-title">
                <span>{episode.title ?? "Untitled"}</span>
                <AvatarStack viewers={viewers} size={22} />
              </div>
              <MonitorState current={episode.monitored} target={episode.targetMonitored} dryRunEnabled={dryRunEnabled} />
              <span>{formatDate(episode.airDate)}</span>
            </div>
          );
        })}
      </div>
  );
}
