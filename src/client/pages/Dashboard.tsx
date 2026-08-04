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

  if (!data) return <div className="grid min-h-screen place-items-center p-6 text-on-surface-variant">Loading dashboard...</div>;

  const historyJob = data.jobs.find((job) => job.id === "history-import");
  const reconcileJob = data.jobs.find((job) => job.id === "rolling-reconcile");
  const attentionJobs = data.jobs.filter((job) => job.running || job.lastRunStatus === "error");

  return (
    <div className="mx-auto max-w-[1440px] p-7">
      <div className="mb-6 flex items-start justify-between gap-5 max-[820px]:flex-col max-[820px]:items-stretch">
        <div>
          <h1 className="font-headline text-[28px] font-bold tracking-normal">Dashboard</h1>
          <p className="text-on-surface-variant">What Pacearr is managing, what changed, and what needs attention.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-outline-variant/30 bg-background-container-high px-3.5 text-on-surface" disabled={busy !== null} onClick={() => run("/api/jobs/session-check/run", "sessions")}><PlayCircle size={16} /> Check sessions</button>
          <button type="button" className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-transparent bg-primary-dim px-3.5 text-on-surface" disabled={busy !== null} onClick={() => run("/api/jobs/history-import/run", "history")}><Download size={16} /> Import history</button>
        </div>
      </div>
      {error && <div className="mb-4 rounded-lg border border-error/35 bg-error/12 px-3.5 py-3 text-error">{error}</div>}

      <div className="mb-[18px] grid grid-cols-4 gap-3 max-[820px]:grid-cols-1">
        <Stat label="Enrolled shows" value={data.stats.enrolledShows} detail={`${data.stats.enabledUsers} enabled users`} />
        <Stat label="Active viewers" value={data.stats.activeViewers} detail="Within your activity window" icon={<UsersRound size={17} />} />
        <Stat label="Expanded seasons" value={data.stats.expandedSeasons} detail="Currently retained" />
        <Stat label="Space reclaimed" value={formatBytes(data.stats.reclaimedBytes)} detail={`${data.stats.reclaimedFiles} deleted file${data.stats.reclaimedFiles === 1 ? "" : "s"}`} icon={<HardDrive size={17} />} />
      </div>

      <div className="grid grid-cols-[minmax(0,1.35fr)_minmax(330px,.85fr)] items-start gap-[18px] max-[820px]:grid-cols-1">
        <section className="rounded-xl border border-outline-variant/30 bg-background-container p-[18px]">
          <div className="mb-3.5 flex items-start justify-between gap-3.5">
            <div><h2 className="font-headline mb-1 text-lg font-semibold">Active shows</h2><p className="text-xs text-on-surface-variant">Enrolled shows, ordered by their latest watch activity.</p></div>
            <Link to="/shows" className="whitespace-nowrap text-[13px] font-bold text-primary hover:underline">View all shows</Link>
          </div>
          <div className="overflow-hidden rounded-xl border border-outline-variant/30">
            {data.activeShows.slice(0, 6).map((show) => (
              <Link className="grid grid-cols-[42px_minmax(130px,1fr)_minmax(180px,1.05fr)] items-center gap-3 border-b border-outline-variant/30 px-3 py-2.5 text-on-surface transition-colors last:border-b-0 hover:bg-background-container-high max-[820px]:grid-cols-[42px_minmax(0,1fr)]" to={`/shows/${show.sonarrSeriesId}`} key={show.id}>
                <Poster show={show} className="h-[60px] w-[42px] rounded-md object-cover" />
                <div className="grid min-w-0 gap-1">
                  <strong className="overflow-hidden text-ellipsis whitespace-nowrap text-sm">{show.title}</strong>
                  <span className="text-xs text-on-surface-variant">{show.expandedSeasons.length > 0 ? `S${show.expandedSeasons.join(", S")} expanded` : "Pilot-only monitoring"}</span>
                </div>
                <div className="grid min-w-0 gap-1 max-[820px]:col-start-2">
                  {show.lastWatchedAt && show.lastWatchedSeason && show.lastWatchedEpisode ? <>
                    <strong className="overflow-hidden text-ellipsis whitespace-nowrap text-sm">{show.lastWatcherName ?? "Unknown viewer"} · S{show.lastWatchedSeason} E{show.lastWatchedEpisode}</strong>
                    <span className="text-xs text-on-surface-variant">{formatRelativeTime(show.lastWatchedAt)} · {show.activeViewerCount} active viewer{show.activeViewerCount === 1 ? "" : "s"}</span>
                  </> : <span className="text-xs text-on-surface-variant">No matched watch activity yet</span>}
                </div>
              </Link>
            ))}
            {data.activeShows.length === 0 && <div className="p-6 text-center text-on-surface-variant">No shows enrolled yet.</div>}
          </div>
        </section>

        <aside className="grid gap-[18px]">
          <section className="rounded-xl border border-outline-variant/30 bg-background-container p-[18px]">
            <div className="mb-3.5"><div><h2 className="font-headline mb-1 text-lg font-semibold">System status</h2><p className="text-xs text-on-surface-variant">Only exceptions and the next useful operational signals.</p></div></div>
            <div className={`mb-2 flex items-start gap-2.5 rounded-lg border p-3 ${data.dryRun ? "border-warning/30 bg-warning/10 text-warning" : "border-success/30 bg-success/10 text-success"}`}>
              <ShieldAlert size={17} />
              <div className="grid gap-1 text-on-surface"><strong>{data.dryRun ? "Dry-run enabled" : "Live changes enabled"}</strong><span className="text-xs leading-snug text-on-surface-variant">{data.dryRun ? "Monitoring and cleanup changes are previewed only." : "Sonarr changes and file cleanup can be applied."}</span></div>
            </div>
            <div className="flex justify-between gap-3 border-b border-outline-variant/30 px-0.5 py-2.5 text-[13px] text-on-surface-variant"><span>History import</span><strong className={historyJob?.lastRunStatus === "error" ? "text-error" : "text-on-surface"}>{jobLabel(historyJob)}</strong></div>
            <div className="flex justify-between gap-3 border-b border-outline-variant/30 px-0.5 py-2.5 text-[13px] text-on-surface-variant"><span>Rolling reconcile</span><strong className={reconcileJob?.lastRunStatus === "error" ? "text-error" : "text-on-surface"}>{jobLabel(reconcileJob)}</strong></div>
            {attentionJobs.map((job) => <div className="mt-2 rounded-md bg-error/12 px-2.5 py-2 text-xs text-error" key={job.id}>{job.running ? `${job.id} is running` : `${job.id} needs attention`}</div>)}
          </section>

          <section className="rounded-xl border border-outline-variant/30 bg-background-container p-[18px]">
            <div className="mb-3.5 flex items-start justify-between gap-3.5"><div><h2 className="font-headline mb-1 text-lg font-semibold">Recent changes</h2><p className="text-xs text-on-surface-variant">Expansions, cleanup, enrollment, and errors.</p></div><Link to="/history" className="whitespace-nowrap text-[13px] font-bold text-primary hover:underline">History</Link></div>
            {data.recentChanges.map((event) => <Change event={event} key={event.id} />)}
            {data.recentChanges.length === 0 && <div className="p-6 text-center text-on-surface-variant">No managed changes recorded yet.</div>}
          </section>
        </aside>
      </div>
    </div>
  );
}

function Stat({ label, value, detail, icon }: { label: string; value: string | number; detail: string; icon?: ReactNode }) {
  return <div className="grid min-h-[130px] content-start gap-2 rounded-xl border border-outline-variant/30 bg-background-container p-4"><div className="flex items-center justify-between gap-2 text-on-surface-variant"><span className="text-[13px]">{label}</span>{icon}</div><strong className="text-[27px] leading-tight">{value}</strong><small className="text-xs text-on-surface-variant">{detail}</small></div>;
}

function Change({ event }: { event: HistoryEvent }) {
  const season = detailValue(event.details, "seasonNumber");
  const reclaimedBytes = detailValue(event.details, "reclaimedBytes");
  const title = actionLabels[event.action] ?? (event.level === "error" ? "Error" : event.title);
  const detail = reclaimedBytes && Number(reclaimedBytes) > 0 ? `${formatBytes(Number(reclaimedBytes))} reclaimed` : season ? `Season ${season}` : event.level === "error" ? "Review in History" : null;
  return <Link className="grid grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-outline-variant/30 py-2.5 text-on-surface last:border-b-0 hover:[&>div>strong]:text-primary" to="/history"><span className={`size-[7px] rounded-full ${event.level === "error" ? "bg-error" : event.level === "warn" ? "bg-warning" : "bg-primary"}`} /><div className="grid min-w-0 gap-1"><strong className="overflow-hidden text-ellipsis whitespace-nowrap text-[13px]">{title} · {event.title}</strong>{detail && <span className="text-xs text-on-surface-variant">{detail}</span>}</div><time className="text-xs text-on-surface-variant">{formatRelativeTime(event.createdAt)}</time></Link>;
}
