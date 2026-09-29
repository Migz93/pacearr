/**
 * The connection a history cursor and its watch events belong to. Plex history keys and
 * Tautulli reference IDs are only unique within one server, so watch events are unique
 * per connection, and history import compares a cursor's connection to decide whether it
 * can be resumed. Migrations 23 and 27 use these to stamp data saved before connections
 * were recorded, so all of them must agree.
 *
 * Each prefers an ID the server keeps across address changes and falls back to its URL.
 * Data stamped with the fallback is moved to the ID once it is known (see
 * PacearrServices.adoptSourceConnection).
 */
export function plexHistoryConnection(settings: { serverUrl: string; machineIdentifier?: string }): string {
  return settings.machineIdentifier || settings.serverUrl;
}

/**
 * `installId` is Tautulli's `pms_uuid`. Despite the prefix it is not a Plex ID: Tautulli
 * generates it on first run and keeps it in its own config, so it survives a URL change
 * and differs between two Tautulli installs watching the same Plex server.
 */
export function tautulliHistoryConnection(settings: { baseUrl: string; installId?: string | null }): string {
  return settings.installId || settings.baseUrl;
}
