import { useEffect, useMemo, useState } from "react";
import { EyeOff, HardDrive, Plus, RefreshCw, RotateCcw } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { apiDelete, apiGet, apiPost } from "../lib/api";
import { formatBytes } from "../lib/utils";
import { AvatarStack, Poster } from "../components/ShowVisuals";
import type { RecommendationsResponse, ShowRecommendation } from "../../shared/types";

export default function Recommendations() {
  const pageSize = 25;
  const [searchParams, setSearchParams] = useSearchParams();
  const [data, setData] = useState<RecommendationsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [enrollingId, setEnrollingId] = useState<number | null>(null);
  const [updatingIgnoreId, setUpdatingIgnoreId] = useState<number | null>(null);
  const [showIgnored, setShowIgnored] = useState(false);
  const page = Math.max(1, Math.floor(Number(searchParams.get("page")) || 1));

  async function load(background = false) {
    if (!background) setLoading(true);
    try {
      setData(await apiGet<RecommendationsResponse>(`/api/recommendations?includeIgnored=${showIgnored}`));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [showIgnored]);
  useEffect(() => {
    if (!data?.refreshing) return;
    const timer = setInterval(() => void load(true), 2000);
    return () => clearInterval(timer);
  }, [data?.refreshing, showIgnored]);

  const totalSavingsBytes = useMemo(
    () => data?.candidates.reduce((sum, candidate) => sum + candidate.projectedSavingsBytes, 0) ?? 0,
    [data]
  );
  const pageCount = Math.max(1, Math.ceil((data?.candidates.length ?? 0) / pageSize));
  const safePage = Math.min(page, pageCount);
  const visibleCandidates = (data?.candidates ?? []).slice((safePage - 1) * pageSize, safePage * pageSize);
  const recommendationsUrl = `/recommendations${searchParams.size > 0 ? `?${searchParams.toString()}` : ""}`;

  function setPage(nextPage: number) {
    const next = new URLSearchParams(searchParams);
    if (nextPage <= 1) next.delete("page");
    else next.set("page", String(nextPage));
    setSearchParams(next);
  }

  async function refresh() {
    setError(null);
    try {
      await apiPost("/api/recommendations/refresh");
      await load(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function enroll(show: ShowRecommendation) {
    setEnrollingId(show.sonarrSeriesId);
    setError(null);
    try {
      await apiPost(`/api/shows/${show.sonarrSeriesId}/enroll`, { applyBaseline: true, importHistory: true });
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setEnrollingId(null);
    }
  }

  async function setIgnored(show: ShowRecommendation, ignored: boolean) {
    setUpdatingIgnoreId(show.sonarrSeriesId);
    setError(null);
    try {
      if (ignored) {
        await apiPost(`/api/recommendations/${show.sonarrSeriesId}/ignore`, { title: show.title });
      } else {
        await apiDelete(`/api/recommendations/${show.sonarrSeriesId}/ignore`);
      }
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setUpdatingIgnoreId(null);
    }
  }

  return (
    <div className="page recommendations-page">
      <div className="page-header">
        <div>
          <h1>Recommendations</h1>
          <p className="muted">Un-enrolled Sonarr shows, ranked by how much disk space enrolling would free up.</p>
        </div>
        <div className="button-row">
          <button
            className={`secondary-button${showIgnored ? " active" : ""}`}
            aria-pressed={showIgnored}
            onClick={() => {
              setShowIgnored((value) => !value);
              setPage(1);
            }}
            disabled={loading}
          >
            <EyeOff size={16} />
            {showIgnored ? "Showing ignored" : "Show ignored"} {data && data.ignoredCount > 0 ? `(${data.ignoredCount})` : ""}
          </button>
          <button className="secondary-button" onClick={() => void refresh()} disabled={loading || data?.refreshing}>
            <RefreshCw size={16} className={loading || data?.refreshing ? "spin" : ""} /> {data?.refreshing ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      {data && (
        <div className="recommend-stat-row">
          <div className="recommend-stat"><span>Candidates</span><strong>{data.candidates.length}</strong></div>
          <div className="recommend-stat"><span>Potential Savings</span><strong>{formatBytes(totalSavingsBytes)}</strong></div>
        </div>
      )}
      {loading ? (
        <div className="centered-panel">Loading recommendations...</div>
      ) : (
        <div className="recommend-table">
          <div className="recommend-head">
            <span>Show</span>
            <span>Size on disk</span>
            <span>Seasons</span>
            <span>Watchers</span>
            <span>Projected savings</span>
            <span />
          </div>
          {visibleCandidates.map((show) => (
            <div className={`recommend-row${show.ignored ? " ignored" : ""}`} key={show.sonarrSeriesId}>
              <Link className="recommend-show recommend-show-link" to={`/shows/${show.sonarrSeriesId}`} state={{ from: recommendationsUrl }}>
                <Poster show={show} className="recommend-poster" />
                <div>
                  <strong>{show.title}</strong>
                  <span className="muted small">{show.year ?? "Unknown year"} · {show.status ?? "unknown status"}</span>
                </div>
              </Link>
              <span>{formatBytes(show.sizeOnDiskBytes)}</span>
              <span className="recommend-seasons">
                <span className="badge good">{show.retainedSeasons.length} kept</span>
                <span className="badge warn">{show.droppedSeasons.length} pilot-only</span>
              </span>
              <span className="recommend-watchers">
                <AvatarStack viewers={show.watchers.map((watcher) => ({ ...watcher, isHistory: false }))} size={22} />
                {show.watcherCount === 0 && <span className="muted small">No recent viewers</span>}
              </span>
              <strong className="recommend-savings"><HardDrive size={14} /> {formatBytes(show.projectedSavingsBytes)}</strong>
              <div className="recommend-actions">
                {!show.ignored && (
                  <button className="primary-button compact" disabled={enrollingId !== null || updatingIgnoreId !== null} onClick={() => void enroll(show)}>
                    <Plus size={14} /> {enrollingId === show.sonarrSeriesId ? "Enrolling..." : "Enroll"}
                  </button>
                )}
                <button className="secondary-button compact" disabled={updatingIgnoreId !== null || enrollingId !== null} onClick={() => void setIgnored(show, !show.ignored)}>
                  {show.ignored ? <RotateCcw size={14} /> : <EyeOff size={14} />}
                  {updatingIgnoreId === show.sonarrSeriesId ? "Saving..." : show.ignored ? "Restore" : "Ignore"}
                </button>
              </div>
            </div>
          ))}
          {data && data.candidates.length === 0 && data.refreshing && (
            <div className="empty">Recommendations are being prepared in the background. This page will update automatically.</div>
          )}
          {data && data.candidates.length === 0 && !data.refreshing && (
            <div className="empty">No recommendations right now — every un-enrolled show would stay fully retained, or every show is already enrolled.</div>
          )}
          {data && data.candidates.length > pageSize && (
            <div className="recommend-pagination">
              <span className="muted small">
                Showing {(safePage - 1) * pageSize + 1}–{Math.min(safePage * pageSize, data.candidates.length)} of {data.candidates.length}
              </span>
              <div className="button-row">
                <button className="secondary-button compact" disabled={safePage === 1} onClick={() => setPage(safePage - 1)}>Previous</button>
                <span className="small">Page {safePage} of {pageCount}</span>
                <button className="secondary-button compact" disabled={safePage === pageCount} onClick={() => setPage(safePage + 1)}>Next</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
