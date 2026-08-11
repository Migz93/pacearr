export type HistoryCategory = "monitoring" | "cleanup" | "shows" | "sync";

export const HISTORY_CATEGORIES: { id: HistoryCategory; label: string }[] = [
  { id: "monitoring", label: "Monitoring" },
  { id: "cleanup", label: "Cleanup" },
  { id: "shows", label: "Shows" },
  { id: "sync", label: "Sync" },
];

const DRY_RUN_PREFIX = "dry_run.";

/**
 * Every action Pacearr writes to history_events, mapped to the four categories the
 * History page filters by. Keyed by the *live* action name — the `dry_run.` variant of an
 * action is the same event in preview mode, so it shares the category and the label and
 * is distinguished by a badge on the row instead of its own filter button.
 *
 * The filter used to be built from SELECT DISTINCT action, which grew a button for every
 * string ever written and split each one in two the moment dry run was enabled. Adding an
 * action here is what puts it in a filter now; an unmapped action still appears under
 * "All types", it just has no category of its own.
 */
const CATEGORY_BY_ACTION: Record<string, HistoryCategory> = {
  "sonarr.baseline": "monitoring",
  "sonarr.expand_season": "monitoring",
  "sonarr.early_prefetch": "monitoring",
  "cleanup.progressive": "cleanup",
  "cleanup.prefetch": "cleanup",
  "show.reset": "cleanup",
  "show.enrolled": "shows",
  "show.unenrolled": "shows",
  "show.auto_triaged": "shows",
  "show.auto_triage": "shows",
  "recommendation.ignored": "shows",
  "history.import": "sync",
  "history.full_reconcile": "sync",
  "sessions.check": "sync",
  "rolling.reconcile": "sync",
  // Not written any more — see the "only record what changed" note in
  // docs/jobs-and-history.md — but installs that ran an older version can already have
  // rows with this action, and they're genuinely sync activity. Mapped so the category
  // migration doesn't make existing history disappear from the Sync filter.
  "watch_events.reconciled": "sync",
};

const ACTION_LABELS: Record<string, string> = {
  "sonarr.baseline": "Baseline set",
  "sonarr.expand_season": "Season expanded",
  "sonarr.early_prefetch": "Next season prefetched",
  "cleanup.progressive": "Season trimmed",
  "cleanup.prefetch": "Prefetch trimmed",
  "show.reset": "Show reset",
  "show.enrolled": "Show enrolled",
  "show.unenrolled": "Show unenrolled",
  "show.auto_triaged": "New show triaged",
  "show.auto_triage": "New show triage",
  "recommendation.ignored": "Recommendation hidden",
  "history.import": "History imported",
  "history.full_reconcile": "History reconciled",
  "sessions.check": "Plex session",
  "rolling.reconcile": "Reconcile run",
  "watch_events.reconciled": "Watch events reconciled",
};

export function isDryRunAction(action: string): boolean {
  return action.startsWith(DRY_RUN_PREFIX);
}

export function baseAction(action: string): string {
  return isDryRunAction(action) ? action.slice(DRY_RUN_PREFIX.length) : action;
}

export function historyCategory(action: string): HistoryCategory | null {
  return CATEGORY_BY_ACTION[baseAction(action)] ?? null;
}

/** Both the live and dry-run action names in a category, for the server's IN (...) filter. */
export function actionsInCategory(category: HistoryCategory): string[] {
  return Object.entries(CATEGORY_BY_ACTION)
    .filter(([, value]) => value === category)
    .flatMap(([action]) => [action, `${DRY_RUN_PREFIX}${action}`]);
}

export function isHistoryCategory(value: unknown): value is HistoryCategory {
  return typeof value === "string" && HISTORY_CATEGORIES.some((category) => category.id === value);
}

/** Falls back to title-casing the raw action so an unmapped one is still readable. */
export function historyActionLabel(action: string): string {
  const base = baseAction(action);
  return ACTION_LABELS[base] ?? base
    .split(/[._-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
