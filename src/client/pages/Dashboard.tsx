import { useEffect, useState, type ReactNode } from "react";
import { Download, HardDrive, PlayCircle, ShieldAlert, UsersRound } from "lucide-react";
import { Link } from "react-router-dom";
import { apiGet, apiPost } from "../lib/api";
import { formatBytes, formatRelativeTime } from "../lib/utils";
import { Poster } from "../components/ShowVisuals";
import type { DashboardResponse, HistoryEvent, JobInfo } from "../../shared/types";

const actionLabels: Record<string, string> = {
  "sonarr.expand_season": "Expanded",
  "cleanup.progressive": "Cleaned",
  "show.enrolled": "Enrolled",
  "show.unenrolled": "Unenrolled",
  "show.reset": "Reset",
  "dry_run.show.reset": "Would reset",
};

function detailValue(details: string, key: string): string | number | null {
  try {
    const value = JSON.parse(details) as Record<string, unknown>;
    const found = value[key];
    return typeof found === "string" || typeof found === "number" ? found : null;
  } catch {
    return null;
  }
}

function jobLabel(job: JobInfo | undefined) {
  if (!job?.lastRunAt) return "Not run yet";
  return job.lastRunStatus === "error" ? "Failed" : `Ran ${formatRelativeTime(job.lastRunAt)}`;
}

export default function Dashboard() {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setData(await apiGet<DashboardResponse>("/api/dashboard"));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function run(path: string, key: string) {
    setBusy(key);
    try {
      await apiPost(path);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 15000);
    return () => clearInterval(id);
  }, []);

  if (!data) return <div className="centered">Loading dashboard...</div>;

  const historyJob = data.jobs.find((job) => job.id === "history-import");
  const reconcileJob = data.jobs.find((job) => job.id === "rolling-reconcile");
  const attentionJobs = data.jobs.filter((job) => job.running || job.lastRunStatus === "error");

  return (
    <div className="page dashboard-page">
      <div className="page-header">
        <div>
          <h1>Dashboard</h1>
          <p className="muted">What Pacearr is managing, what changed, and what needs attention.</p>
        </div>
        <div className="button-row">
          <button className="secondary-button" disabled={busy !== null} onClick={() => run("/api/jobs/session-check/run", "sessions")}><PlayCircle size={16} /> Check sessions</button>
          <button className="primary-button" disabled={busy !== null} onClick={() => run("/api/jobs/history-import/run", "history")}><Download size={16} /> Import history</button>
        </div>
      </div>
      {error && <div className="error">{error}</div>}

      <div className="dashboard-stats">
        <Stat label="Enrolled shows" value={data.stats.enrolledShows} detail={`${data.stats.enabledUsers} enabled users`} />
        <Stat label="Active viewers" value={data.stats.activeViewers} detail="Within your activity window" icon={<UsersRound size={17} />} />
        <Stat label="Expanded seasons" value={data.stats.expandedSeasons} detail="Currently retained" />
        <Stat label="Space reclaimed" value={formatBytes(data.stats.reclaimedBytes)} detail={`${data.stats.reclaimedFiles} deleted file${data.stats.reclaimedFiles === 1 ? "" : "s"}`} icon={<HardDrive size={17} />} />
      </div>

      <div className="dashboard-main-grid">
        <section className="section dashboard-active-shows">
          <div className="dashboard-section-heading">
            <div><h2>Active shows</h2><p className="muted small">Enrolled shows, ordered by their latest watch activity.</p></div>
            <Link to="/shows" className="text-link">View all shows</Link>
          </div>
          <div className="dashboard-show-list">
            {data.activeShows.slice(0, 6).map((show) => (
              <Link className="dashboard-show-row" to={`/shows/${show.sonarrSeriesId}`} key={show.id}>
                <Poster show={show} className="dashboard-show-poster" />
                <div className="dashboard-show-copy">
                  <strong>{show.title}</strong>
                  <span>{show.expandedSeasons.length > 0 ? `S${show.expandedSeasons.join(", S")} expanded` : "Pilot-only monitoring"}</span>
                </div>
                <div className="dashboard-show-watch">
                  {show.lastWatchedAt && show.lastWatchedSeason && show.lastWatchedEpisode ? <>
                    <strong>{show.lastWatcherName ?? "Unknown viewer"} · S{show.lastWatchedSeason} E{show.lastWatchedEpisode}</strong>
                    <span>{formatRelativeTime(show.lastWatchedAt)} · {show.activeViewerCount} active viewer{show.activeViewerCount === 1 ? "" : "s"}</span>
                  </> : <span>No matched watch activity yet</span>}
                </div>
              </Link>
            ))}
            {data.activeShows.length === 0 && <div className="empty">No shows enrolled yet.</div>}
          </div>
        </section>

        <aside className="dashboard-side-stack">
          <section className="section dashboard-health">
            <div className="dashboard-section-heading"><div><h2>System status</h2><p className="muted small">Only exceptions and the next useful operational signals.</p></div></div>
            <div className={`dashboard-status ${data.dryRun ? "warning" : "healthy"}`}>
              <ShieldAlert size={17} />
              <div><strong>{data.dryRun ? "Dry-run enabled" : "Live changes enabled"}</strong><span>{data.dryRun ? "Monitoring and cleanup changes are previewed only." : "Sonarr changes and file cleanup can be applied."}</span></div>
            </div>
            <div className="dashboard-health-row"><span>History import</span><strong className={historyJob?.lastRunStatus === "error" ? "danger" : ""}>{jobLabel(historyJob)}</strong></div>
            <div className="dashboard-health-row"><span>Rolling reconcile</span><strong className={reconcileJob?.lastRunStatus === "error" ? "danger" : ""}>{jobLabel(reconcileJob)}</strong></div>
            {attentionJobs.map((job) => <div className="dashboard-attention" key={job.id}>{job.running ? `${job.id} is running` : `${job.id} needs attention`}</div>)}
          </section>

          <section className="section dashboard-changes">
            <div className="dashboard-section-heading"><div><h2>Recent changes</h2><p className="muted small">Expansions, cleanup, enrollment, and errors.</p></div><Link to="/history" className="text-link">History</Link></div>
            {data.recentChanges.map((event) => <Change event={event} key={event.id} />)}
            {data.recentChanges.length === 0 && <div className="empty">No managed changes recorded yet.</div>}
          </section>
        </aside>
      </div>
    </div>
  );
}

function Stat({ label, value, detail, icon }: { label: string; value: string | number; detail: string; icon?: ReactNode }) {
  return <div className="stat-card dashboard-stat-card"><div><span>{label}</span>{icon}</div><strong>{value}</strong><small>{detail}</small></div>;
}

function Change({ event }: { event: HistoryEvent }) {
  const season = detailValue(event.details, "seasonNumber");
  const reclaimedBytes = detailValue(event.details, "reclaimedBytes");
  const title = actionLabels[event.action] ?? (event.level === "error" ? "Error" : event.title);
  const detail = reclaimedBytes && Number(reclaimedBytes) > 0 ? `${formatBytes(Number(reclaimedBytes))} reclaimed` : season ? `Season ${season}` : event.level === "error" ? "Review in History" : null;
  return <Link className={`dashboard-change level-${event.level}`} to="/history"><span className="status-dot" /><div><strong>{title} · {event.title}</strong>{detail && <span>{detail}</span>}</div><time>{formatRelativeTime(event.createdAt)}</time></Link>;
}
