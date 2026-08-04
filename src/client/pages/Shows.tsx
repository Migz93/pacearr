import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowLeft, ArrowRight, ArrowUpDown, ChevronDown, ChevronRight, Eye, EyeOff, LayoutGrid, List, Plus, RefreshCw, RotateCcw, Search, Trash2, X,
} from "lucide-react";
import { apiDelete, apiGet, apiPost } from "../lib/api";
import { badgeClass, formatBytes } from "../lib/utils";
import { AvatarStack, Poster, type ViewerBadge } from "../components/ShowVisuals";
import { RowLabel, ShowCard, ShowListRow, type ShowBrowserItem } from "../components/ShowCard";
import { ToggleField } from "../components/FormControls";
import { useDialogA11y } from "../hooks/useDialogA11y";
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

const primaryButton = "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-transparent bg-primary-dim px-3.5 text-on-surface";
const secondaryButton = "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-outline-variant/30 bg-background-container-high px-3.5 text-on-surface";
const dangerButton = "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-outline-variant/30 bg-background-container-high px-3.5 text-error";
const compactSecondaryButton = "inline-flex min-h-8 items-center justify-center gap-2 rounded-lg border border-outline-variant/30 bg-background-container-high px-2.5 text-xs text-on-surface";

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
  const addTriggerRef = useRef<HTMLElement | null>(null);
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
    <div className="mx-auto max-w-[1440px] p-7">
      <div className="mb-6 flex items-start justify-between gap-5 max-[820px]:flex-col max-[820px]:items-stretch">
        <div>
          <h1 className="font-headline text-[28px] font-bold">Shows</h1>
          <p className="text-on-surface-variant">{TAB_SUBTITLES[tab]}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={primaryButton} onClick={(event) => { addTriggerRef.current = event.currentTarget; setAdding(true); }}><Plus size={16} /> Enroll show</button>
          <button type="button" className={secondaryButton} onClick={() => void refresh()} disabled={loading || refreshing}>
            <RefreshCw size={16} className={loading || refreshing ? "animate-spin" : ""} /> {refreshing ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>
      {error && <div className="mb-4 rounded-lg border border-error/35 bg-error/12 px-3.5 py-3 text-error">{error}</div>}
      <fieldset className="m-0 mb-[18px] flex min-w-0 gap-1 overflow-x-auto rounded-xl border border-outline-variant/30 bg-background-container-high p-1">
        <legend className="sr-only">Show category</legend>
        {TABS.map((entry) => (
          <button
            type="button"
            key={entry.id}
            aria-pressed={tab === entry.id}
            className={`min-h-10 flex-1 whitespace-nowrap rounded-lg px-3.5 font-bold ${tab === entry.id ? "bg-primary-dim text-on-surface" : "bg-transparent text-on-surface-variant hover:bg-background-container-highest hover:text-on-surface"}`}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}{entry.id === "ignored" && ignoredCount > 0 ? ` (${ignoredCount})` : ""}
          </button>
        ))}
      </fieldset>
      <div className="mb-[18px] flex items-center gap-3 max-[820px]:flex-col max-[820px]:items-stretch">
        <div className="flex h-10 flex-1 items-center gap-2.5 rounded-lg border border-outline-variant/30 bg-background px-3 text-on-surface-variant">
          <Search size={17} />
          <input className="h-full w-full border-0 bg-transparent p-0 text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none" aria-label="Search shows" value={query} onChange={(event) => handleQueryChange(event.target.value)} placeholder="Search shows..." />
        </div>
        <div className="flex h-10 shrink-0 items-center gap-2.5 rounded-lg border border-outline-variant/30 bg-background px-3 text-on-surface-variant">
          <ArrowUpDown size={16} />
          <select className="mt-0 min-w-[150px] border-0 bg-transparent p-0 text-on-surface max-[820px]:w-full" aria-label="Sort shows" value={sort} onChange={(event) => changeSort(event.target.value as SortMode)}>
            {sortOptionsFor(tab).map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}
          </select>
        </div>
        <div className="flex h-10 shrink-0 gap-0.5 rounded-lg border border-outline-variant/30 bg-background-container-high p-[3px]" role="group" aria-label="View mode">
          <button type="button" aria-pressed={view === "poster"} aria-label="Poster view" className={`grid size-8 place-items-center rounded-md border-0 ${view === "poster" ? "bg-background-container" : "bg-transparent hover:bg-background-container"}`} onClick={() => toggleView("poster")} title="Poster view">
            <LayoutGrid size={16} className={view === "poster" ? "text-on-surface" : "text-on-surface-variant"} />
          </button>
          <button type="button" aria-pressed={view === "list"} aria-label="List view" className={`grid size-8 place-items-center rounded-md border-0 ${view === "list" ? "bg-background-container" : "bg-transparent hover:bg-background-container"}`} onClick={() => toggleView("list")} title="List view">
            <List size={16} className={view === "list" ? "text-on-surface" : "text-on-surface-variant"} />
          </button>
        </div>
      </div>
      {isRecommendationTab && !loading && items.length > 0 && (
        <div className="mb-4 flex gap-2.5 max-[820px]:flex-col">
          <div className="flex min-w-[210px] items-center justify-between gap-6 rounded-xl border border-outline-variant/30 bg-background-container px-3.5 py-2.5"><span className="text-xs font-bold text-on-surface-variant">Candidates</span><strong>{items.length}</strong></div>
          <div className="flex min-w-[210px] items-center justify-between gap-6 rounded-xl border border-outline-variant/30 bg-background-container px-3.5 py-2.5"><span className="text-xs font-bold text-on-surface-variant">Potential Savings</span><strong>{formatBytes(totalSavingsBytes)}</strong></div>
        </div>
      )}
      {loading ? (
        <div className="grid min-h-[220px] place-items-center text-on-surface-variant">Loading shows...</div>
      ) : view === "poster" ? (
        <div className="grid items-start gap-4 [grid-template-columns:repeat(auto-fill,minmax(158px,1fr))]">
          {visibleItems.map((item) => <ShowCard item={item} returnTo={currentTabUrl} key={item.data.sonarrSeriesId} />)}
          {filtered.length === 0 && <div className="p-6 text-center text-on-surface-variant">{emptyMessage()}</div>}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-outline-variant/30 bg-background-container">
          {isRecommendationTab ? (
            <div className="grid grid-cols-[minmax(220px,1.6fr)_110px_170px_140px_140px] items-center gap-3.5 border-b border-outline-variant/30 px-4 py-3 text-[11px] font-black uppercase text-on-surface-variant max-[1170px]:hidden">
              <span>Show</span><span>Size on disk</span><span>Seasons</span><span>Watchers</span><span>Projected savings</span>
            </div>
          ) : (
            <div className="grid grid-cols-[minmax(220px,1.6fr)_170px_220px] items-center gap-3.5 border-b border-outline-variant/30 px-4 py-3 text-[11px] font-black uppercase text-on-surface-variant max-[970px]:hidden">
              <span>Show</span><span>Seasons</span><span>Watchers</span>
            </div>
          )}
          {visibleItems.map((item) => <ShowListRow item={item} returnTo={currentTabUrl} key={item.data.sonarrSeriesId} />)}
          {filtered.length === 0 && <div className="p-6 text-center text-on-surface-variant">{emptyMessage()}</div>}
        </div>
      )}
      {filtered.length > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <span className="text-xs text-on-surface-variant">
            Showing {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filtered.length)} of {filtered.length}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={compactSecondaryButton} disabled={safePage === 1} onClick={() => setPage(safePage - 1)}>Previous</button>
            <span className="text-xs">Page {safePage} of {pageCount}</span>
            <button type="button" className={compactSecondaryButton} disabled={safePage === pageCount} onClick={() => setPage(safePage + 1)}>Next</button>
          </div>
        </div>
      )}
      {adding && <AddShowModal onClose={() => setAdding(false)} onAdded={async () => { setAdding(false); await load(); }} trigger={addTriggerRef.current} />}
    </div>
  );
}

function AddShowModal({ onClose, onAdded, trigger }: { onClose: () => void; onAdded: () => Promise<void>; trigger: HTMLElement | null }) {
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

  const dialogRef = useDialogA11y<HTMLDivElement>(true, onClose, trigger);

  return <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-[18px]">
    <button type="button" tabIndex={-1} className="absolute inset-0 cursor-default border-0 bg-transparent p-0" aria-label="Close enroll show dialog" onClick={onClose} />
    <div ref={dialogRef} className="relative z-10 max-h-[82vh] w-full max-w-[680px] overflow-auto rounded-xl border border-outline-variant/30 bg-background-container p-5 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="enroll-show-title" tabIndex={-1}>
      <div className="mb-4 flex items-center justify-between gap-3.5"><div><h2 id="enroll-show-title" className="font-headline mb-1 text-lg font-semibold">Enroll show</h2><p className="text-on-surface-variant">Search existing Sonarr series to enroll in Pacearr control.</p></div><button type="button" className="inline-flex size-10 items-center justify-center rounded-lg border border-outline-variant/30 bg-background-container-high text-on-surface" onClick={onClose} aria-label="Close"><X size={18} /></button></div>
      <div className="mb-[18px] flex h-10 items-center gap-2.5 rounded-lg border border-outline-variant/30 bg-background px-3 text-on-surface-variant"><Search size={17} /><input className="m-0 h-full border-0 bg-transparent p-0" aria-label="Search Sonarr shows" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Sonarr shows..." /></div>
      {error && <div className="mb-4 rounded-lg border border-error/35 bg-error/12 px-3.5 py-3 text-error">{error}</div>}
      {query.trim().length < 2 ? <div className="p-6 text-center text-on-surface-variant">Enter at least two characters to search Sonarr.</div> : loading ? <div className="p-6 text-center text-on-surface-variant">Searching Sonarr...</div> : <div className="grid gap-2">{shows.map((show) => <div className="flex items-center justify-between gap-3 rounded-lg border border-outline-variant/30 bg-background-container-low p-3" key={show.sonarrSeriesId}><div><strong className="block">{show.title}</strong><span className="mt-1 block text-xs text-on-surface-variant">{show.year ?? "Unknown year"} · {show.seasonCount} seasons</span></div><button type="button" className="inline-flex min-h-8 items-center justify-center rounded-lg border border-transparent bg-primary-dim px-2.5 text-xs text-on-surface" disabled={addingId !== null} onClick={() => void add(show)}>{addingId === show.sonarrSeriesId ? "Adding..." : "Add"}</button></div>)}{shows.length === 0 && <div className="p-6 text-center text-on-surface-variant">No available Sonarr shows match this search.</div>}</div>}
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
      <div className="mx-auto max-w-[1280px] p-7">
        <button type="button" className={secondaryButton} onClick={() => navigate(returnPath)}><ArrowLeft size={16} /> {returnLabel}</button>
        {error ? <div className="mt-4 rounded-lg border border-error/35 bg-error/12 px-3.5 py-3 text-error">{error}</div> : <div className="grid min-h-[220px] place-items-center text-on-surface-variant">Loading show...</div>}
      </div>
    );
  }

  const { show } = detail;

  return (
    <div className="mx-auto max-w-[1360px] p-7">
      <div className="mb-[18px] flex justify-between gap-3 max-[820px]:flex-col max-[820px]:items-stretch">
        <button type="button" className={secondaryButton} onClick={() => navigate(returnPath)}><ArrowLeft size={16} /> {returnLabel}</button>
        <button type="button" className={secondaryButton} onClick={() => void load()}><RefreshCw size={16} /> Refresh</button>
      </div>
      {error && <div className="mb-4 rounded-lg border border-error/35 bg-error/12 px-3.5 py-3 text-error">{error}</div>}
      <section className="mb-[22px] grid grid-cols-[220px_minmax(0,1fr)] items-end gap-6 max-[820px]:grid-cols-1">
        <Poster show={show} className="max-w-[220px] rounded-lg object-cover max-[820px]:max-w-[180px]" />
        <div className="grid justify-items-start gap-3 pb-1">
          <div className="flex items-center gap-2">
            <span className={badgeClass(show.enrolled ? "success" : undefined)}>{show.enrolled ? "Enrolled" : "Not enrolled"}</span>
            <span
              className={badgeClass(detail.dryRunPreview.enabled ? "warning" : "success")}
              title={detail.dryRunPreview.enabled
                ? "Dry run: monitoring changes are calculated but not sent to Sonarr"
                : "Live: monitoring changes are sent to Sonarr automatically"}
            >
              {detail.dryRunPreview.enabled ? "Dry run" : "Live"}
            </span>
            {detail.recommendation?.ignored && <span className={badgeClass("warning")}>Ignored</span>}
          </div>
          <h1 className="font-headline text-[34px] font-bold">{show.title}</h1>
          <p className="text-on-surface-variant">{show.year ?? "Unknown year"} · {show.seasonCount} season{show.seasonCount === 1 ? "" : "s"} · {show.episodeCount} episodes · {show.status ?? "unknown status"}</p>
          {detail.recommendation && (
            <div className="mt-0.5 flex gap-2.5 max-[820px]:flex-col">
              <div className="flex min-w-[210px] items-center justify-between gap-6 rounded-xl border border-outline-variant/30 bg-background-container px-3.5 py-2.5"><span className="text-xs font-bold text-on-surface-variant">Size on disk</span><strong>{formatBytes(detail.recommendation.sizeOnDiskBytes)}</strong></div>
              <div className="flex min-w-[210px] items-center justify-between gap-6 rounded-xl border border-outline-variant/30 bg-background-container px-3.5 py-2.5"><span className="text-xs font-bold text-on-surface-variant">Projected savings if enrolled</span><strong>{formatBytes(detail.recommendation.projectedSavingsBytes)}</strong></div>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {show.enrolled && show.rollingShowId ? (
              <>
                <button
                  type="button"
                  className={dangerButton}
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
                  className={dangerButton}
                  disabled={busy}
                  title="Stops Pacearr from managing this show and removes its stored rolling progress. It does not delete media or undo the show's current Sonarr monitoring state."
                  onClick={() => runAction(() => apiDelete(`/api/rolling-shows/${show.rollingShowId}`))}
                >
                  <Trash2 size={15} /> Unenroll
                </button>
              </>
            ) : (
              <>
                <button type="button" className={primaryButton} disabled={busy} onClick={() => void enroll()}>
                  Enroll in rolling episodes
                </button>
                {detail.recommendation && (detail.recommendation.eligible || detail.recommendation.ignored) && (
                  <button
                    type="button"
                    className={secondaryButton}
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
      <section className="rounded-xl border border-outline-variant/30 bg-background-container p-[18px]">
        <div className="mb-1 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="font-headline mb-1 text-lg font-semibold">Seasons</h2>
            <p className="text-on-surface-variant">Expand a season to review its episodes, who's watching, and current vs. intended Sonarr monitoring state.</p>
          </div>
          <ToggleField label="Show inactive viewers" checked={showHistoryViewers} onChange={setShowHistoryViewers} />
        </div>
        <div className="grid gap-2">
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
    <span className="flex flex-wrap items-center gap-1.5">
      <span className={badgeClass(current ? "success" : undefined)}>
        {current ? <Eye size={12} /> : <EyeOff size={12} />} {current ? "Monitored" : "Not monitored"}
      </span>
      {mismatch && (
        <span
          className={badgeClass("warning")}
          title={dryRunEnabled
            ? `Dry run: would become ${target ? "monitored" : "not monitored"} once applied`
            : `Pending: will become ${target ? "monitored" : "not monitored"} on the next run`}
        >
          <ArrowRight size={12} /> {target ? "Monitored" : "Not monitored"}
        </span>
      )}
    </span>
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
  const episodeTableId = `season-${season.seasonNumber}-episodes`;
  return (
    <div className="overflow-hidden rounded-xl border border-outline-variant/30 bg-background-container-low">
      <button type="button" className="flex w-full items-center justify-between gap-3 border-0 bg-transparent p-3 text-left hover:bg-background-container-highest" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-controls={episodeTableId}>
        {open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
      <span className="flex-1">
        <strong className="block">Season {season.seasonNumber}</strong>
        <span className="mt-1 block text-xs text-on-surface-variant">
          {season.episodeCount || season.totalEpisodeCount} episodes
          {season.watchedUsers > 0 ? ` · ${season.watchedUsers} watched` : ""}
          {season.latestWatchedAt ? ` · last ${formatDate(season.latestWatchedAt)}` : ""}
        </span>
      </span>
      <AvatarStack viewers={viewers} />
      <span className="flex flex-wrap items-center justify-end gap-1.5 text-right">
        {season.isExpanded && <span className={badgeClass("success")}>Expanded</span>}
        {season.prefetchedEpisodes.length > 0 && <span className={badgeClass("warning")} title={season.prefetchedEpisodes.map((episode) => `${episodeLabel(episode.seasonNumber, episode.episodeNumber)} triggered by ${episode.displayName} on ${formatDate(episode.triggeredAt)}`).join("\n")}>Prefetched {season.prefetchedEpisodes.length}</span>}
        <MonitorState current={season.monitored} target={season.targetMonitored} dryRunEnabled={dryRunEnabled} />
      </span>
      </button>
      {open && <EpisodeTable id={episodeTableId} episodes={episodes} prefetchedEpisodes={season.prefetchedEpisodes} viewersByEpisode={viewersByEpisode} dryRunEnabled={dryRunEnabled} />}
    </div>
  );
}

function EpisodeTable({ id, episodes, prefetchedEpisodes, viewersByEpisode, dryRunEnabled }: {
  id: string;
  episodes: ShowEpisodeSummary[];
  prefetchedEpisodes: ShowSeasonSummary["prefetchedEpisodes"];
  viewersByEpisode: Map<string, ViewerBadge[]>;
  dryRunEnabled: boolean;
}) {
  const prefetchedByEpisode = new Map(prefetchedEpisodes.map((episode) => [`${episode.seasonNumber}:${episode.episodeNumber}`, episode]));
  return (
      <div id={id} className="overflow-hidden border-t border-outline-variant/30">
        <div className="grid grid-cols-[90px_minmax(180px,1fr)_120px_120px] items-center gap-3.5 border-b border-outline-variant/30 px-3 py-2.5 text-[11px] font-black uppercase text-on-surface-variant max-[820px]:hidden">
          <span>Episode</span>
          <span>Title</span>
          <span>State</span>
          <span>Air date</span>
        </div>
        {episodes.map((episode) => {
          const viewers = viewersByEpisode.get(`${episode.seasonNumber}:${episode.episodeNumber}`) ?? [];
          return (
            <div className="grid grid-cols-[90px_minmax(180px,1fr)_120px_120px] items-center gap-3.5 border-b border-outline-variant/30 px-3 py-2.5 last:border-b-0 max-[820px]:grid-cols-1 max-[820px]:gap-1" key={episode.id}>
              <strong>{episodeLabel(episode.seasonNumber, episode.episodeNumber)}</strong>
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-on-surface-variant">{episode.title ?? "Untitled"}</span>
                <AvatarStack viewers={viewers} size={22} />
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <RowLabel className="hidden max-[820px]:inline">State</RowLabel>
                <MonitorState current={episode.monitored} target={episode.targetMonitored} dryRunEnabled={dryRunEnabled} />
                {prefetchedByEpisode.has(`${episode.seasonNumber}:${episode.episodeNumber}`) && (() => {
                  const prefetch = prefetchedByEpisode.get(`${episode.seasonNumber}:${episode.episodeNumber}`)!;
                  return <span className={badgeClass("warning")} title={`Triggered by ${prefetch.displayName} on ${formatDate(prefetch.triggeredAt)}`}>Prefetched · {prefetch.displayName}</span>;
                })()}
              </div>
              <span className="text-on-surface-variant"><RowLabel className="hidden max-[820px]:inline">Air date</RowLabel>{formatDate(episode.airDate)}</span>
            </div>
          );
        })}
      </div>
  );
}
