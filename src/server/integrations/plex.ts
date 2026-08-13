import crypto from "node:crypto";
import { parseStringPromise } from "xml2js";
import type { ConnectionTestResult, PlexSettingsInput } from "../../shared/types.js";
import type { Logger } from "../logger.js";
import { PLEX_USER_AGENT } from "../version.js";
import { buildIntegrationUrl, fetchIntegration } from "./request.js";

const PLEX_TV_ACCOUNT_URL = "https://plex.tv/users/account.json";
const PLEX_TV_RESOURCES_URL = "https://plex.tv/api/v2/resources";
const PLEX_TV_USERS_URL = "https://plex.tv/api/users";
const PLEX_TV_PING_URL = "https://plex.tv/api/v2/ping";

export interface PlexUserInput {
  plexUserId: string;
  plexAccountId: string | null;
  tautulliUserId: string | null;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface PlexEpisodeActivity {
  sourceEventId: string;
  plexAccountId: string | null;
  username: string | null;
  showTitle: string;
  seasonNumber: number;
  episodeNumber: number;
  watchedAt: string;
  ratingKey: string | null;
  grandparentRatingKey: string | null;
  grandparentGuid?: string | null;
  raw: unknown;
}

export interface PlexSeasonArtworkItem {
  ratingKey: string;
  seasonNumber: number;
  thumb: string;
}

export interface PlexEpisodeArtworkItem {
  ratingKey: string;
  seasonNumber: number;
  episodeNumber: number;
  thumb: string;
}

export interface PlexShowArtworkItem {
  ratingKey: string;
  thumb: string;
  seasons: PlexSeasonArtworkItem[];
}

function first<T>(value: T | T[] | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function attr(node: any) {
  return node?.$ ?? node ?? {};
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function unixToIso(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? new Date(parsed * 1000).toISOString() : new Date().toISOString();
}

export function buildPlexServerUrl(serverUrl: string, pathname: string): URL {
  return buildIntegrationUrl(serverUrl, pathname);
}

function normalizeHistoryVideo(video: any): PlexEpisodeActivity | null {
  const v = attr(video);
  if (v.type !== "episode") return null;
  const seasonNumber = Number(v.parentIndex ?? 0);
  const episodeNumber = Number(v.index ?? 0);
  if (!seasonNumber || !episodeNumber || !v.grandparentTitle) return null;
  const watchedAt = unixToIso(v.viewedAt);
  return {
    sourceEventId: String(v.historyKey ?? `${v.accountID ?? v.User?.id ?? "unknown"}:${v.ratingKey}:${v.viewedAt}`),
    plexAccountId: v.accountID ? String(v.accountID) : null,
    username: v.user ?? v.username ?? null,
    showTitle: String(v.grandparentTitle),
    seasonNumber,
    episodeNumber,
    watchedAt,
    ratingKey: v.ratingKey ? String(v.ratingKey) : null,
    grandparentRatingKey: v.grandparentRatingKey ? String(v.grandparentRatingKey) : v.grandparentKey ? String(v.grandparentKey).split("/").pop() ?? null : null,
    raw: v,
  };
}

function normalizeSessionVideo(video: any): PlexEpisodeActivity | null {
  const v = attr(video);
  if (v.type !== "episode") return null;
  const seasonNumber = Number(v.parentIndex ?? 0);
  const episodeNumber = Number(v.index ?? 0);
  const user = attr(first(video.User));
  if (!seasonNumber || !episodeNumber || !v.grandparentTitle) return null;
  return {
    sourceEventId: String(v.sessionKey ?? `${user.id ?? user.title ?? "unknown"}:${v.ratingKey}:${Date.now()}`),
    plexAccountId: user.id ? String(user.id) : null,
    username: user.title ?? null,
    showTitle: String(v.grandparentTitle),
    seasonNumber,
    episodeNumber,
    watchedAt: new Date().toISOString(),
    ratingKey: v.ratingKey ? String(v.ratingKey) : null,
    grandparentRatingKey: v.grandparentRatingKey ? String(v.grandparentRatingKey) : null,
    raw: { ...v, user },
  };
}

export class PlexIntegration {
  constructor(private readonly settings: PlexSettingsInput, private readonly logger: Logger) {}

  private buildServerUrl(pathname: string) {
    return buildPlexServerUrl(this.settings.serverUrl, pathname);
  }

  private async requestServerXml(pathname: string, timeoutMs?: number) {
    const url = this.buildServerUrl(pathname);
    url.searchParams.set("X-Plex-Token", this.settings.token);
    const response = await fetchIntegration(url, { headers: { "User-Agent": PLEX_USER_AGENT, Accept: "application/xml" } }, timeoutMs);
    if (!response.ok) throw new Error(`Plex ${response.status} ${response.statusText}`);
    return parseStringPromise(await response.text(), { explicitArray: false, mergeAttrs: false });
  }

  private async requestServer(pathname: string, options: RequestInit = {}): Promise<Response> {
    const url = this.buildServerUrl(pathname);
    url.searchParams.set("X-Plex-Token", this.settings.token);
    const response = await fetchIntegration(url, {
      ...options,
      headers: { "User-Agent": PLEX_USER_AGENT, ...(options.headers ?? {}) },
    });
    if (!response.ok) throw new Error(`Plex ${response.status} ${response.statusText}`);
    return response;
  }

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const identity = await this.requestServerXml("/identity");
      const machineIdentifier = identity?.MediaContainer?.$?.machineIdentifier;
      this.logger.info("Plex connection test succeeded", { machineIdentifier: machineIdentifier ?? null });
      return { ok: true, message: `Connected to Plex${machineIdentifier ? ` (${machineIdentifier})` : ""}.` };
    } catch (error) {
      this.logger.warn("Plex connection test failed", { error: error instanceof Error ? error.message : String(error) });
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async getFriendsAndOwner(owner: { plexId: string; username: string; displayName: string; avatarUrl: string | null }): Promise<PlexUserInput[]> {
    const users: PlexUserInput[] = [{
      plexUserId: owner.plexId,
      plexAccountId: owner.plexId,
      tautulliUserId: null,
      username: owner.username,
      displayName: owner.displayName,
      avatarUrl: owner.avatarUrl,
    }];
    try {
      const response = await fetchIntegration(new URL(PLEX_TV_USERS_URL), {
        headers: {
          "X-Plex-Token": this.settings.token,
          "User-Agent": PLEX_USER_AGENT,
          Accept: "application/xml",
        },
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const parsed = await parseStringPromise(await response.text(), { explicitArray: false });
      for (const userNode of toArray(parsed?.MediaContainer?.User)) {
        const u = attr(userNode);
        const id = String(u.id ?? u.uuid ?? u.username);
        if (!id) continue;
        users.push({
          plexUserId: id,
          plexAccountId: u.id ? String(u.id) : null,
          tautulliUserId: null,
          username: String(u.username ?? u.title ?? id),
          displayName: String(u.title ?? u.username ?? id),
          avatarUrl: u.thumb ?? null,
        });
      }
    } catch (error) {
      this.logger.warn("Failed to fetch Plex friends; continuing with owner", { error: error instanceof Error ? error.message : String(error) });
    }
    return users;
  }

  async getPlaybackHistory(since?: string): Promise<PlexEpisodeActivity[]> {
    const events: PlexEpisodeActivity[] = [];
    const cutoff = since ? new Date(since).getTime() : null;
    let start = 0;
    const size = 1000;
    for (;;) {
      const data = await this.requestServerXml(`/status/sessions/history/all?sort=viewedAt%3Adesc&X-Plex-Container-Start=${start}&X-Plex-Container-Size=${size}`, 60_000);
      const videos = toArray(data?.MediaContainer?.Video);
      const pageEvents: PlexEpisodeActivity[] = [];
      for (const video of videos) {
        const normalized = normalizeHistoryVideo(video);
        if (normalized) pageEvents.push(normalized);
      }
      events.push(...pageEvents.filter((event) => cutoff === null || new Date(event.watchedAt).getTime() >= cutoff));
      if (videos.length < size) break;
      if (cutoff !== null && pageEvents.some((event) => new Date(event.watchedAt).getTime() < cutoff)) break;
      start += size;
    }
    this.logger.info("Plex playback history fetched", { events: events.length, since: since ?? null });
    return events;
  }

  async getActiveSessions(): Promise<PlexEpisodeActivity[]> {
    const data = await this.requestServerXml("/status/sessions");
    const sessions = toArray(data?.MediaContainer?.Video)
      .map(normalizeSessionVideo)
      .filter((event): event is PlexEpisodeActivity => Boolean(event));
    this.logger.debug("Plex active sessions fetched", { sessions: sessions.length });
    return sessions;
  }

  async getShowGuids(ratingKey: string): Promise<{ tvdbId: number | null; imdbId: string | null }> {
    const data = await this.requestServerXml(`/library/metadata/${encodeURIComponent(ratingKey)}`);
    const item = first(data?.MediaContainer?.Metadata);
    const guids = toArray(item?.Guid).map((guid) => String(attr(guid).id ?? ""));
    const directGuid = attr(item).guid ? [String(attr(item).guid)] : [];
    const all = [...directGuid, ...guids];
    let tvdbId: number | null = null;
    let imdbId: string | null = null;
    for (const guid of all) {
      const tvdbMatch = guid.match(/(?:tvdb|thetvdb):\/\/(\d+)|tvdb:(\d+)/i);
      if (!tvdbId && tvdbMatch) tvdbId = Number(tvdbMatch[1] ?? tvdbMatch[2]);
      const imdbMatch = guid.match(/(?:imdb):\/\/(tt\d+)|imdb:(tt\d+)/i);
      if (!imdbId && imdbMatch) imdbId = imdbMatch[1] ?? imdbMatch[2];
    }
    return { tvdbId, imdbId };
  }

  /** Finds a show only by immutable external IDs. Artwork changes must never use a title match. */
  async findShowForArtwork(ids: { tvdbId: number | null; imdbId: string | null }): Promise<PlexShowArtworkItem | null> {
    if (!ids.tvdbId && !ids.imdbId) return null;
    const sections = await this.requestServerXml("/library/sections");
    const tvSections = toArray(sections?.MediaContainer?.Directory)
      .map((section) => attr(section))
      .filter((section) => section.type === "show" && section.key && section.agent)
      .map((section) => ({ key: String(section.key), agent: String(section.agent), title: String(section.title ?? section.key) }));
    const identifiers = [
      ...(ids.tvdbId ? [`tvdb://${ids.tvdbId}`] : []),
      ...(ids.imdbId ? [`imdb://${ids.imdbId}`] : []),
    ];
    const matchesByIdentifier = await Promise.all(identifiers.map(async (identifier) => ({
      identifier,
      matches: (await Promise.all(tvSections.map((section) => this.findArtworkGuidInSection(section, identifier)))).flat(),
    })));
    const nonEmpty = matchesByIdentifier.filter((result) => result.matches.length > 0);
    if (nonEmpty.length === 0) return null;

    // All supplied identifiers must resolve to the same Plex show. A bad
    // upstream match must never change an unrelated library item's poster.
    const canonicalGuids = new Set(nonEmpty[0]!.matches.map((match) => match.guid));
    for (const result of nonEmpty.slice(1)) {
      for (const guid of [...canonicalGuids]) if (!result.matches.some((match) => match.guid === guid)) canonicalGuids.delete(guid);
    }
    const candidates = nonEmpty.flatMap((result) => result.matches).filter((match, index, matches) =>
      canonicalGuids.has(match.guid) && matches.findIndex((other) => other.sectionKey === match.sectionKey && other.ratingKey === match.ratingKey) === index
    );
    if (candidates.length !== 1) {
      this.logger.warn("Plex artwork lookup is missing or ambiguous", {
        identifiers,
        matches: candidates.map((candidate) => ({ section: candidate.sectionTitle, ratingKey: candidate.ratingKey, guid: candidate.guid })),
      });
      return null;
    }
    const item = candidates[0]!;
    const children = await this.requestServerXml(`/library/metadata/${encodeURIComponent(item.ratingKey)}/children`);
    const seasons = toArray(children?.MediaContainer?.Directory)
      .map((season) => attr(season))
      .filter((season) => season.type === "season" && Number(season.index) > 0 && season.ratingKey && season.thumb)
      .map((season) => ({ ratingKey: String(season.ratingKey), seasonNumber: Number(season.index), thumb: String(season.thumb) }));
    return { ratingKey: item.ratingKey, thumb: String(item.thumb ?? ""), seasons };
  }

  async getSeasonPilotArtwork(season: PlexSeasonArtworkItem): Promise<PlexEpisodeArtworkItem | null> {
    const children = await this.requestServerXml(`/library/metadata/${encodeURIComponent(season.ratingKey)}/children`);
    const pilot = toArray(children?.MediaContainer?.Video)
      .map((episode) => attr(episode))
      .find((episode) => Number(episode.index) === 1 && episode.ratingKey && episode.thumb);
    return pilot ? { ratingKey: String(pilot.ratingKey), seasonNumber: season.seasonNumber, episodeNumber: 1, thumb: String(pilot.thumb) } : null;
  }

  private async findArtworkGuidInSection(section: { key: string; agent: string; title: string }, externalGuid: string): Promise<Array<{ sectionKey: string; sectionTitle: string; ratingKey: string; guid: string; thumb: string }>> {
    // Plex's native TV agent resolves an external ID through an item's matches
    // endpoint. The resulting Plex GUID is then filtered directly in this
    // library section, avoiding both title matching and full-library scans.
    const firstPage = await this.requestServerXml(`/library/sections/${encodeURIComponent(section.key)}/all?type=2&X-Plex-Container-Size=1`);
    const seed = toArray(firstPage?.MediaContainer?.Directory).map((item) => attr(item)).find((item) => item.ratingKey);
    if (!seed?.ratingKey) return [];
    const matches = await this.requestServerXml(`/library/metadata/${encodeURIComponent(String(seed.ratingKey))}/matches?manual=1&agent=${encodeURIComponent(section.agent)}&title=${encodeURIComponent(externalGuid.replace("://", "-"))}`);
    const plexGuids = toArray(matches?.MediaContainer?.SearchResult)
      .map((match) => attr(match))
      .filter((match) => match.type === "show" && typeof match.guid === "string" && match.guid.startsWith("plex://show/"))
      .map((match) => String(match.guid));
    const found = await Promise.all(plexGuids.map(async (guid) => {
      const items = await this.requestServerXml(`/library/sections/${encodeURIComponent(section.key)}/all?type=2&guid=${encodeURIComponent(guid)}`);
      return toArray(items?.MediaContainer?.Directory).map((item) => attr(item))
        .filter((item) => item.type === "show" && item.guid === guid && item.ratingKey)
        .map((item) => ({ sectionKey: section.key, sectionTitle: section.title, ratingKey: String(item.ratingKey), guid, thumb: String(item.thumb ?? "") }));
    }));
    return found.flat();
  }

  async downloadPoster(thumb: string): Promise<Buffer> {
    const response = await this.requestServer(thumb, { headers: { Accept: "image/jpeg,image/png,image/webp,image/*" } });
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) throw new Error("Plex poster download returned a non-image response.");
    return Buffer.from(await response.arrayBuffer());
  }

  async uploadPoster(ratingKey: string, image: Buffer): Promise<void> {
    await this.requestServer(`/library/metadata/${encodeURIComponent(ratingKey)}/posters`, {
      method: "POST",
      headers: { "Content-Type": "image/jpeg", Accept: "application/xml" },
      body: image as unknown as BodyInit,
    });
  }

  async getPosterThumb(ratingKey: string): Promise<string> {
    const data = await this.requestServerXml(`/library/metadata/${encodeURIComponent(ratingKey)}`);
    const item = attr(first(data?.MediaContainer?.Metadata) ?? first(data?.MediaContainer?.Directory) ?? first(data?.MediaContainer?.Video));
    if (!item.thumb) throw new Error("Plex metadata response did not include the selected poster thumbnail.");
    return String(item.thumb);
  }

  static async fetchAccountByToken(token: string) {
    const response = await fetchIntegration(new URL(PLEX_TV_ACCOUNT_URL), {
      headers: { "User-Agent": PLEX_USER_AGENT, "X-Plex-Token": token, Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Plex account fetch failed: ${response.status} ${response.statusText}`);
    const json = await response.json() as { user?: { id?: number | string; username?: string; email?: string; title?: string; thumb?: string } };
    const user = json.user;
    if (!user?.id) throw new Error("Plex account response did not include a user ID.");
    return {
      plexId: String(user.id),
      plexToken: token,
      username: user.username ?? String(user.id),
      displayName: user.title ?? user.username ?? String(user.id),
      email: user.email ?? null,
      avatarUrl: user.thumb ?? null,
    };
  }

  static async pingToken(token: string): Promise<void> {
    const response = await fetchIntegration(new URL(PLEX_TV_PING_URL), {
      headers: {
        "User-Agent": PLEX_USER_AGENT,
        "X-Plex-Token": token,
        Accept: "application/json",
        "X-Plex-Client-Identifier": crypto.randomUUID(),
        "X-Plex-Product": "Pacearr",
      },
    });
    if (!response.ok) throw new Error(`Plex token ping failed: ${response.status} ${response.statusText}`);
  }

  static async discoverServers(token: string): Promise<Array<{ name: string; machineIdentifier: string; connections: Array<{ uri: string; local: boolean }> }>> {
    const url = new URL(PLEX_TV_RESOURCES_URL);
    url.searchParams.set("includeHttps", "1");
    url.searchParams.set("includeRelay", "1");
    const response = await fetchIntegration(url, {
      headers: {
        "User-Agent": PLEX_USER_AGENT,
        "X-Plex-Token": token,
        Accept: "application/json",
        "X-Plex-Client-Identifier": "pacearr-server",
        "X-Plex-Product": "Pacearr",
      },
    });
    if (!response.ok) throw new Error(`Failed to discover Plex servers: ${response.status} ${response.statusText}`);
    const resources = await response.json() as Array<{ name: string; clientIdentifier: string; provides: string; owned: boolean; connections: Array<{ uri: string; local: boolean }> }>;
    return resources
      .filter((resource) => resource.owned && resource.provides.includes("server"))
      .map((resource) => ({
        name: resource.name,
        machineIdentifier: resource.clientIdentifier,
        connections: resource.connections.map((connection) => ({ uri: connection.uri, local: connection.local })),
      }));
  }
}
