import { useEffect, useRef, useState, type ReactNode } from "react";
import { HardDrive, Layers, ListVideo, UsersRound } from "lucide-react";
import { Link } from "react-router-dom";
import { apiGet } from "../lib/api";
import { badgeClass, formatBytes, formatRelativeTime, titleCaseJob } from "../lib/utils";
import { historyActionLabel } from "../../shared/history";
import { ExpandedSeasons, PosterTile } from "../components/ShowVisuals";
import { ErrorBanner, Page, PageHeader, PageLoading } from "../components/Page";
import type { DashboardResponse, DashboardShowActivity, HistoryEvent, JobInfo } from "../../shared/types";

// Two rows of six at the widest breakpoint. Everything on this page is sized so the whole
// dashboard fits a 1080p window without scrolling — adding a third row would break that.
const POSTER_COUNT = 12;

export default function Dashboard() {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);

  async function load() {
    const requestId = ++requestSequence.current;
    try {
      const response = await apiGet<DashboardResponse>("/api/dashboard");
      if (requestId !== requestSequence.current) return;
      setData(response);
      setError(null);
    } catch (caught) {
      if (requestId !== requestSequence.current) return;
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 15000);
    return () => {
      clearInterval(id);
      requestSequence.current++;
    };
  }, []);

  // A failed first load must not loop in "Loading..." forever with no way out — matches
  // the error-over-loading precedence Shows.tsx's detail view already uses.
  if (!data) return <Page>{error ? <ErrorBanner message={error} /> : <PageLoading label="Loading dashboard..." />}</Page>;

  const attentionJobs = data.jobs.filter((job) => job.running || job.lastRunStatus === "error");
  const shows = data.activeShows.slice(0, POSTER_COUNT);

  return (
    <Page>
      {/* Live is the normal state and needs no announcing — the badge is here to warn
          that nothing is actually being applied, so it only appears in dry run. */}
      <PageHeader
        title="Dashboard"
        badge={data.dryRun && (
          <span className={badgeClass("warning")} title="Dry run: Pacearr is previewing changes only, and won't touch Sonarr or delete files.">
            Dry run
          </span>
        )}
      />
      {error && <ErrorBanner message={error} />}

      <div className="grid gap-4">
        <div className="flex gap-3 max-[820px]:flex-col">
          <div className="grid flex-1 grid-cols-4 gap-2 max-[520px]:grid-cols-2">
            <Stat icon={<ListVideo size={15} />} label="Enrolled shows" value={data.stats.enrolledShows} to="/shows" />
            <Stat icon={<UsersRound size={15} />} label="Active viewers" value={data.stats.activeViewers} to="/users" />
            <Stat icon={<Layers size={15} />} label="Expanded seasons" value={data.stats.expandedSeasons} to="/shows" />
            <Stat icon={<HardDrive size={15} />} label="Space reclaimed" value={formatBytes(data.stats.reclaimedBytes)} to="/history?category=cleanup" />
          </div>
          <RecentActivity events={data.recentActivity} />
        </div>

        {attentionJobs.length > 0 && (
          <div className="grid gap-1.5">
            {attentionJobs.map((job) => <JobNotice job={job} key={job.id} />)}
          </div>
        )}

        <section>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="font-headline text-base font-semibold">Recently active shows</h2>
            <Link to="/shows" className="text-[13px] font-bold text-on-surface-variant hover:text-on-surface hover:underline">View all</Link>
          </div>
          {shows.length > 0 ? (
            <div className="grid grid-cols-6 gap-3 max-[520px]:grid-cols-3 min-[521px]:max-[1000px]:grid-cols-4">
              {shows.map((show) => <ShowTile show={show} key={show.id} />)}
            </div>
          ) : (
            <div className="grid place-items-center rounded-xl border border-outline-variant/30 bg-background-container py-10 text-on-surface-variant">
              No shows enrolled yet. Enrol one from the Shows page to get started.
            </div>
          )}
        </section>
      </div>
    </Page>
  );
}

function Stat({ icon, label, value, to }: { icon: ReactNode; label: string; value: string | number; to: string }) {
  return (
    <Link
      to={to}
      className="grid content-center justify-items-center gap-0.5 rounded-xl border border-outline-variant/30 bg-background-container px-3 py-2.5 text-center text-on-surface no-underline hover:bg-background-container-high"
    >
      <span className="flex items-center gap-1.5 text-on-surface">
        {icon}
        <strong className="font-headline text-lg leading-none text-on-surface">{value}</strong>
      </span>
      <span className="text-xs text-on-surface-variant">{label}</span>
    </Link>
  );
}

function RecentActivity({ events }: { events: HistoryEvent[] }) {
  return (
    <Link
      to="/history"
      className="group grid w-80 shrink-0 content-start gap-2 rounded-xl border border-outline-variant/30 bg-background-container px-3.5 py-2.5 text-on-surface no-underline hover:bg-background-container-high max-[820px]:w-full"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-bold uppercase tracking-wide text-on-surface-variant">Recent activity</span>
        <span className="text-xs text-on-surface-variant opacity-0 transition-opacity group-hover:text-on-surface group-hover:opacity-100">View all →</span>
      </div>
      {events.length > 0 ? (
        <div className="grid gap-1.5">
          {events.map((event) => (
            <div className="flex min-w-0 items-center gap-2 text-xs" key={event.id}>
              <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${event.level === "error" ? "bg-error" : event.level === "warn" ? "bg-warning" : "bg-primary"}`} />
              <span className="w-9 shrink-0 text-[10px] font-extrabold uppercase text-on-surface-variant">{event.level}</span>
              <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{historyActionLabel(event.action)}: {event.title}</span>
              <span className="shrink-0 text-on-surface-variant">{formatRelativeTime(event.createdAt)}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-on-surface-variant">Nothing has happened yet.</p>
      )}
    </Link>
  );
}

function JobNotice({ job }: { job: JobInfo }) {
  const name = job.name ?? titleCaseJob(job.id);
  return job.running
    ? <div className="rounded-lg border border-outline-variant/30 bg-background-container px-3 py-2 text-xs text-on-surface-variant">{name} is running.</div>
    : <div className="rounded-lg border border-error/35 bg-error/12 px-3 py-2 text-xs text-error">{name} failed on its last run. Check Settings → Logs.</div>;
}

function ShowTile({ show }: { show: DashboardShowActivity }) {
  return (
    // Expanded seasons used to sit in a pill over the artwork, where it was unreadable
    // against a busy poster. It lives in the hover overlay now, on the dimmed gradient.
    <PosterTile show={show} to={`/shows/${show.sonarrSeriesId}`} state={{ from: "/dashboard" }}>
      <strong className="line-clamp-2 text-sm font-extrabold leading-tight text-on-surface">{show.title}</strong>
      <ExpandedSeasons seasons={show.expandedSeasons} />
      {/* Truthiness would treat a watched special (season/episode 0, a legitimate value
          here — see the `number | null` field type) as absent and misreport no activity. */}
      {show.lastWatchedAt && show.lastWatchedSeason !== null && show.lastWatchedEpisode !== null ? (
        <>
          <span className="text-[11px] font-bold text-on-surface/75">{show.lastWatcherName ?? "Unknown viewer"} · S{show.lastWatchedSeason}E{show.lastWatchedEpisode}</span>
          <span className="text-[11px] text-on-surface/75">{formatRelativeTime(show.lastWatchedAt)}</span>
        </>
      ) : (
        <span className="text-[11px] text-on-surface/75">No matched watch activity yet</span>
      )}
    </PosterTile>
  );
}
