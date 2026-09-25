/**
 * The connection a history cursor belongs to. History import compares it to decide
 * whether a cursor can be resumed, and migration 23 uses it to stamp cursors saved
 * before it was recorded, so both must agree.
 */
export function plexHistoryConnection(settings: { serverUrl: string; machineIdentifier?: string }): string {
  return settings.machineIdentifier || settings.serverUrl;
}

export function tautulliHistoryConnection(settings: { baseUrl: string }): string {
  return settings.baseUrl;
}
