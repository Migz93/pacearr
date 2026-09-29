import type { PacearrSonarrTag, SonarrSeries, SonarrTagImportPreview, SonarrTagImportShow } from "../shared/types.js";
import type { PacearrDatabase } from "./db/index.js";
import { isNotFoundError } from "./integrations/request.js";
import type { SonarrIntegration } from "./integrations/sonarr.js";
import type { Logger } from "./logger.js";

export const SONARR_TAG_LABELS: Record<PacearrSonarrTag, string> = {
  enrolled: "pacearr-enrolled",
  ignored: "pacearr-ignored",
};
const PACEARR_TAGS: PacearrSonarrTag[] = ["enrolled", "ignored"];

type TagIds = Partial<Record<PacearrSonarrTag, number>>;
type SeriesLookup = (seriesId: number) => Promise<SonarrSeries | null>;

/**
 * Mirrors Pacearr's enrolments and ignores onto Sonarr series as tags, so they can be
 * recovered after the database is lost. Pacearr's records stay the source of truth.
 *
 * - Only `pacearr-enrolled` and `pacearr-ignored` are ever sent, through Sonarr's bulk
 *   editor, so every other tag on a series is left alone.
 * - A missing tag is added by reconciling against Pacearr's records.
 * - A tag is removed only after a Pacearr action queued that removal. A series having
 *   no record never removes its tag: after a database loss every record is gone, and
 *   removing "unexpected" tags would destroy the only recovery data.
 * - Writing is opt-in (`sonarrTagsEnabled`), and dry run sends nothing. While either
 *   blocks writes, removals stay queued and the add reconcile catches up afterwards.
 * - Import only reads, so it works whatever the setting, as a fresh install needs.
 */
export class SonarrTagMirror {
  constructor(
    private readonly db: PacearrDatabase,
    private readonly logger: Logger,
    private readonly getSonarr: () => SonarrIntegration,
    /** A series with another operation running is left for the next reconcile. */
    private readonly isSeriesBusy: (seriesId: number) => boolean,
  ) {}

  /**
   * Applies the tag change a Pacearr action implies. Never throws: a failed add is made
   * good by the next reconcile, and a removal is queued before it is attempted.
   */
  async applyChange(seriesId: number, change: { add?: PacearrSonarrTag; remove?: PacearrSonarrTag }): Promise<void> {
    // Queued even while tag writing is off, so turning it on later cannot leave behind
    // a tag written before it was turned off.
    if (change.remove) this.db.queueSonarrTagRemoval(seriesId, change.remove);
    const blockedBy = this.writeBlocker();
    if (blockedBy) {
      this.logger.debug("Sonarr tag change deferred", { seriesId, add: change.add ?? null, remove: change.remove ?? null, reason: blockedBy });
      return;
    }
    try {
      const sonarr = this.getSonarr();
      const tagIds = await this.resolveTagIds(sonarr, Boolean(change.add));
      const series = await getSeriesOrNull(sonarr, seriesId);
      if (!series) {
        // The series is gone from Sonarr, and its tags with it.
        if (change.remove) this.db.clearSonarrTagRemoval(seriesId, change.remove);
        this.logger.debug("Skipped Sonarr tag change for a series Sonarr no longer has", { seriesId });
        return;
      }
      const addId = change.add ? tagIds[change.add] : undefined;
      if (change.add && addId !== undefined && !series.tags?.includes(addId)) {
        await sonarr.editSeriesTags([seriesId], [addId], "add");
        this.logger.info("Pacearr tag added in Sonarr", { seriesId, title: series.title, tag: SONARR_TAG_LABELS[change.add] });
      }
      if (change.remove) {
        await this.processRemovals(sonarr, tagIds, [{ sonarrSeriesId: seriesId, tag: change.remove }], async () => series, false);
      }
    } catch (error) {
      this.logger.warn("Sonarr tag change failed; it will be retried", { seriesId, add: change.add ?? null, remove: change.remove ?? null, error: errorMessage(error) });
    }
  }

  /**
   * Adds every missing Pacearr tag and retries queued removals. `series` is a full
   * Sonarr series list read in the same pass, so each series' current tags are known
   * without another request per show.
   */
  async reconcile(series: SonarrSeries[]): Promise<{ added: number; removed: number; pendingRemovals: number } | null> {
    const blockedBy = this.writeBlocker();
    if (blockedBy) {
      this.logger.debug("Skipped Sonarr tag reconcile", { reason: blockedBy, pendingRemovals: this.db.listSonarrTagRemovals().length });
      return null;
    }
    if (series.length === 0) {
      this.logger.debug("Skipped Sonarr tag reconcile because Sonarr returned no series");
      return null;
    }
    try {
      const sonarr = this.getSonarr();
      const tagIds = await this.resolveTagIds(sonarr, true);
      const byId = new Map(series.map((item) => [item.id, item]));
      const removed = await this.processRemovals(
        sonarr,
        tagIds,
        this.db.listSonarrTagRemovals(),
        async (seriesId) => byId.get(seriesId) ?? getSeriesOrNull(sonarr, seriesId),
        true,
      );

      const expected: Record<PacearrSonarrTag, number[]> = {
        enrolled: this.db.listRollingShows().map((show) => show.sonarrSeriesId),
        ignored: this.db.listIgnoredRecommendationIds(),
      };
      let added = 0;
      for (const tag of PACEARR_TAGS) {
        const tagId = tagIds[tag];
        if (tagId === undefined) continue;
        const missing = expected[tag].filter((seriesId) => {
          const item = byId.get(seriesId);
          return item && !item.tags?.includes(tagId) && !this.isSeriesBusy(seriesId);
        });
        if (missing.length === 0) continue;
        try {
          await sonarr.editSeriesTags(missing, [tagId], "add");
          added += missing.length;
          this.logger.info("Missing Pacearr tags added in Sonarr", { tag: SONARR_TAG_LABELS[tag], shows: missing.length });
        } catch (error) {
          this.logger.warn("Failed to add missing Pacearr tags in Sonarr; the next reconcile retries", { tag: SONARR_TAG_LABELS[tag], shows: missing.length, error: errorMessage(error) });
        }
      }
      const pendingRemovals = this.db.listSonarrTagRemovals().length;
      this.logger.info("Sonarr tag reconcile complete", { added, removed, pendingRemovals });
      return { added, removed, pendingRemovals };
    } catch (error) {
      this.logger.warn("Sonarr tag reconcile failed", { error: errorMessage(error) });
      return null;
    }
  }

  /**
   * Works out what an import from Sonarr tags would do. It only reads. A tag with a
   * queued removal counts as absent, because Pacearr has already decided it should go.
   */
  async planImport(): Promise<{ preview: SonarrTagImportPreview; seriesById: Map<number, SonarrSeries> }> {
    const sonarr = this.getSonarr();
    const [tags, series] = await Promise.all([sonarr.getTags(), sonarr.getSeries()]);
    const tagIds = tagIdsFromList(tags);
    const pending = new Set(this.db.listSonarrTagRemovals().map((entry) => `${entry.sonarrSeriesId}:${entry.tag}`));
    const known = new Set([...this.db.listRollingShows().map((show) => show.sonarrSeriesId), ...this.db.listIgnoredRecommendationIds()]);
    const hasTag = (item: SonarrSeries, tag: PacearrSonarrTag) => {
      const tagId = tagIds[tag];
      return tagId !== undefined && Boolean(item.tags?.includes(tagId)) && !pending.has(`${item.id}:${tag}`);
    };

    const preview: SonarrTagImportPreview = { toEnroll: [], toIgnore: [], alreadyKnown: [], conflicts: [] };
    for (const item of series) {
      const enrolled = hasTag(item, "enrolled");
      const ignored = hasTag(item, "ignored");
      if (!enrolled && !ignored) continue;
      const show: SonarrTagImportShow = { sonarrSeriesId: item.id, title: item.title };
      if (enrolled && ignored) preview.conflicts.push(show);
      else if (known.has(item.id)) preview.alreadyKnown.push(show);
      else if (enrolled) preview.toEnroll.push(show);
      else preview.toIgnore.push(show);
    }
    for (const list of [preview.toEnroll, preview.toIgnore, preview.alreadyKnown, preview.conflicts]) list.sort((a, b) => a.title.localeCompare(b.title));
    return { preview, seriesById: new Map(series.map((item) => [item.id, item])) };
  }

  /** Tag writing is opt-in, and dry run sends nothing to Sonarr. */
  private writeBlocker(): "disabled" | "dry-run" | null {
    const settings = this.db.getAppSettings();
    if (!settings.sonarrTagsEnabled) return "disabled";
    return settings.dryRun ? "dry-run" : null;
  }

  /** Looks up Pacearr's tag IDs, creating a missing tag only when something will be added. */
  private async resolveTagIds(sonarr: SonarrIntegration, createMissing: boolean): Promise<TagIds> {
    const tagIds = tagIdsFromList(await sonarr.getTags());
    if (!createMissing) return tagIds;
    for (const tag of PACEARR_TAGS) {
      if (tagIds[tag] !== undefined) continue;
      const created = await sonarr.createTag(SONARR_TAG_LABELS[tag]);
      if (!created) continue;
      tagIds[tag] = created.id;
      this.logger.info("Created Pacearr tag in Sonarr", { tag: created.label, tagId: created.id });
    }
    return tagIds;
  }

  /** Returns how many tags were removed. An entry that could not be settled stays queued. */
  private async processRemovals(
    sonarr: SonarrIntegration,
    tagIds: TagIds,
    entries: Array<{ sonarrSeriesId: number; tag: PacearrSonarrTag }>,
    lookup: SeriesLookup,
    skipBusy: boolean,
  ): Promise<number> {
    if (entries.length === 0) return 0;
    const enrolled = new Set(this.db.listRollingShows().map((show) => show.sonarrSeriesId));
    const ignored = new Set(this.db.listIgnoredRecommendationIds());
    const toRemove: Record<PacearrSonarrTag, number[]> = { enrolled: [], ignored: [] };

    for (const { sonarrSeriesId: seriesId, tag } of entries) {
      const current = enrolled.has(seriesId) ? "enrolled" : ignored.has(seriesId) ? "ignored" : null;
      if (current === tag) {
        // The show went back into that state before the removal was sent.
        this.db.clearSonarrTagRemoval(seriesId, tag);
        this.logger.debug("Dropped a queued Sonarr tag removal for a show back in that state", { seriesId, tag: SONARR_TAG_LABELS[tag] });
        continue;
      }
      const tagId = tagIds[tag];
      if (tagId === undefined) {
        // The tag does not exist in Sonarr, so no series can carry it.
        this.db.clearSonarrTagRemoval(seriesId, tag);
        continue;
      }
      if (skipBusy && this.isSeriesBusy(seriesId)) continue;
      let series: SonarrSeries | null;
      try {
        series = await lookup(seriesId);
      } catch (error) {
        this.logger.warn("Could not read a Sonarr series for a queued tag removal; it stays queued", { seriesId, tag: SONARR_TAG_LABELS[tag], error: errorMessage(error) });
        continue;
      }
      if (!series || !series.tags?.includes(tagId)) {
        this.db.clearSonarrTagRemoval(seriesId, tag);
        continue;
      }
      toRemove[tag].push(seriesId);
    }

    let removed = 0;
    for (const tag of PACEARR_TAGS) {
      const seriesIds = toRemove[tag];
      const tagId = tagIds[tag];
      if (seriesIds.length === 0 || tagId === undefined) continue;
      try {
        await sonarr.editSeriesTags(seriesIds, [tagId], "remove");
      } catch (error) {
        this.logger.warn("Pacearr tag removal failed in Sonarr; it stays queued", { tag: SONARR_TAG_LABELS[tag], seriesIds, error: errorMessage(error) });
        continue;
      }
      for (const seriesId of seriesIds) this.db.clearSonarrTagRemoval(seriesId, tag);
      removed += seriesIds.length;
      this.logger.info("Pacearr tag removed in Sonarr", { tag: SONARR_TAG_LABELS[tag], seriesIds });
    }
    return removed;
  }
}

function tagIdsFromList(tags: Array<{ id: number; label: string }>): TagIds {
  // Sonarr stores tag labels in lower case, but compare case-insensitively anyway.
  const byLabel = new Map(tags.map((tag) => [tag.label.toLowerCase(), tag.id]));
  const tagIds: TagIds = {};
  for (const tag of PACEARR_TAGS) {
    const id = byLabel.get(SONARR_TAG_LABELS[tag]);
    if (id !== undefined) tagIds[tag] = id;
  }
  return tagIds;
}

async function getSeriesOrNull(sonarr: SonarrIntegration, seriesId: number): Promise<SonarrSeries | null> {
  try {
    return await sonarr.getSeriesById(seriesId);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
