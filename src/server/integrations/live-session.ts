export interface LiveSessionIdentity {
  /** Plex's per-playback Session.id (Tautulli's `session_id`). */
  sessionId?: unknown;
  /** Plex's sessionKey (Tautulli's `session_key`). */
  sessionKey?: unknown;
  userId?: unknown;
  ratingKey?: unknown;
  observedAt: Date;
}

function part(value: unknown): string {
  return value === null || value === undefined || String(value).trim() === "" ? "unknown" : String(value).trim();
}

/**
 * Builds the source_event_id for a live playback seen through Plex /status/sessions or
 * Tautulli get_activity. Repeated polls of one playback must produce the same ID, and two
 * playbacks must never share one: insertWatchEvent ignores an ID it has already stored,
 * so a collision silently drops the newer playback.
 *
 * Session.id is generated per playback and is the primary identity. sessionKey is a small
 * counter that starts over when Plex Media Server restarts, so without Session.id it is
 * only trusted alongside the viewer, the episode and the UTC day it was observed on.
 * Plex and Tautulli both send Session.id today; the fallback accepts two known gaps
 * rather than keeping cross-poll state: a playback spanning UTC midnight gets a second
 * row, and a same-day replay of the same episode by the same viewer on a recycled key is
 * treated as the first playback. Neither moves the viewer's season/episode position or
 * triggers Sonarr work; at most last_watched_at shifts.
 */
export function liveSessionEventId(identity: LiveSessionIdentity): string {
  const ratingKey = part(identity.ratingKey);
  const sessionId = part(identity.sessionId);
  if (sessionId !== "unknown") return `session:${sessionId}:${ratingKey}`;
  const day = identity.observedAt.toISOString().slice(0, 10);
  return `key:${part(identity.sessionKey)}:${part(identity.userId)}:${ratingKey}:${day}`;
}
