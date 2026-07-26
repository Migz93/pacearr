import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, ChevronDown, ChevronRight, Eye, EyeOff, Plus, RefreshCw, RotateCcw, Search, Trash2, X } from "lucide-react";
import { apiDelete, apiGet, apiPost } from "../lib/api";
import { AvatarStack, Poster, type ViewerBadge } from "../components/ShowVisuals";
import type { ShowDetailResponse, ShowEpisodeSummary, ShowListItem, ShowSeasonSummary, ShowsResponse } from "../../shared/types";

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
  return <ShowGrid />;
}

function ShowGrid() {
  const [shows, setShows] = useState<ShowListItem[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [adding, setAdding] = useState(false);

  async function load(background = false) {
    if (!background) setLoading(true);
    try {
      const response = await apiGet<ShowsResponse>("/api/shows?enrolled=true");
      setShows(response.shows);
      setRefreshing(response.refreshing);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!refreshing) return;
    const timer = setInterval(() => void load(true), 2000);
    return () => clearInterval(timer);
  }, [refreshing]);

  async function refresh() {
    setError(null);
    try {
      await apiPost("/api/shows/refresh");
      await load(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return shows;
    return shows.filter((show) => show.title.toLowerCase().includes(normalized));
  }, [shows, query]);

  return (
    <div className="page shows-page">
      <div className="page-header">
        <div>
          <h1>Shows</h1>
          <p className="muted">Shows currently controlled by Pacearr.</p>
        </div>
        <div className="button-row">
          <button className="primary-button" onClick={() => setAdding(true)}><Plus size={16} /> Add show</button>
          <button className="secondary-button" onClick={() => void refresh()} disabled={loading || refreshing}>
            <RefreshCw size={16} className={loading || refreshing ? "spin" : ""} /> {refreshing ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="shows-toolbar">
        <Search size={17} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search controlled shows..." />
      </div>
      {loading ? (
        <div className="centered-panel">Loading shows...</div>
      ) : (
        <div className="poster-grid">
          {filtered.map((show) => (
            <Link className="poster-card" to={`/shows/${show.sonarrSeriesId}`} key={show.sonarrSeriesId}>
              <div className="poster-art">
                <Poster show={show} />
                <div className="poster-art-gradient" aria-hidden="true" />
                <div className={`show-state poster-state ${show.enrolled ? "enrolled" : ""}`}>
                  {show.enrolled ? "Enrolled" : "Review"}
                </div>
              </div>
              <div className="poster-card-copy">
                <strong>{show.title}</strong>
                <span>{show.year ?? "Unknown year"} · {show.seasonCount} season{show.seasonCount === 1 ? "" : "s"}</span>
              </div>
            </Link>
          ))}
          {filtered.length === 0 && refreshing
            ? <div className="empty">The Sonarr library is being prepared in the background. This page will update automatically.</div>
            : filtered.length === 0 && <div className="empty">No controlled shows match that search. Use Add show to enroll one from Sonarr.</div>}
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
      <div className="modal-header"><div><h2>Add show</h2><p className="muted">Search existing Sonarr series to enroll in Pacearr control.</p></div><button className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button></div>
      <div className="shows-toolbar"><Search size={17} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Sonarr shows..." /></div>
      {error && <div className="error">{error}</div>}
      {query.trim().length < 2 ? <div className="empty">Enter at least two characters to search Sonarr.</div> : loading ? <div className="empty">Searching Sonarr...</div> : <div className="add-show-results">{shows.map((show) => <div className="add-show-row" key={show.sonarrSeriesId}><div><strong>{show.title}</strong><span>{show.year ?? "Unknown year"} · {show.seasonCount} seasons</span></div><button className="primary-button compact" disabled={addingId !== null} onClick={() => void add(show)}>{addingId === show.sonarrSeriesId ? "Adding..." : "Add"}</button></div>)}{shows.length === 0 && <div className="empty">No available Sonarr shows match this search.</div>}</div>}
    </div>
  </div>;
}

function ShowDetail({ seriesId }: { seriesId: number }) {
  const navigate = useNavigate();
  const location = useLocation();
  const returnPath = (location.state as { from?: string } | null)?.from ?? "/shows";
  const returnLabel = returnPath.startsWith("/recommendations") ? "Recommendations" : "Shows";
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

  if (!detail) {
    return (
      <div className="page">
        <button className="secondary-button" onClick={() => navigate(returnPath)}><ArrowLeft size={16} /> {returnLabel}</button>
        {error ? <div className="error detail-loading-error">{error}</div> : <div className="centered-panel">Loading show...</div>}
      </div>
    );
  }

  const { show } = detail;

  return (
    <div className="page show-detail-page">
      <div className="show-detail-topbar">
        <button className="secondary-button" onClick={() => navigate(returnPath)}><ArrowLeft size={16} /> {returnLabel}</button>
        <button className="secondary-button" onClick={() => void load()}><RefreshCw size={16} /> Refresh</button>
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
          </div>
          <h1>{show.title}</h1>
          <p className="muted">{show.year ?? "Unknown year"} · {show.seasonCount} season{show.seasonCount === 1 ? "" : "s"} · {show.episodeCount} episodes · {show.status ?? "unknown status"}</p>
          <div className="button-row">
            {show.enrolled && show.rollingShowId ? (
              <>
                <button
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
                  className="secondary-button danger"
                  disabled={busy}
                  title="Stops Pacearr from managing this show and removes its stored rolling progress. It does not delete media or undo the show's current Sonarr monitoring state."
                  onClick={() => runAction(() => apiDelete(`/api/rolling-shows/${show.rollingShowId}`))}
                >
                  <Trash2 size={15} /> Unenroll
                </button>
              </>
            ) : (
              <button className="primary-button" disabled={busy} onClick={() => runAction(() => apiPost(`/api/shows/${show.sonarrSeriesId}/enroll`, { applyBaseline: true, importHistory: true }))}>
                Enroll in rolling episodes
              </button>
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
      <button className="season-row" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
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
