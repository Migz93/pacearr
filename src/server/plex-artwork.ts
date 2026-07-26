import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { PlexArtworkRecord, RollingShowRecord, SonarrSeries } from "../shared/types.js";
import type { PacearrDatabase } from "./db/index.js";
import { PlexIntegration, type PlexEpisodeArtworkItem, type PlexSeasonArtworkItem } from "./integrations/plex.js";
import type { Logger } from "./logger.js";

type ArtworkItem = { ratingKey: string; seasonNumber: number; thumb: string };
type ArtworkKind = PlexArtworkRecord["itemType"];

const ARTWORK_RENDER_VERSION = 6;

const ARTWORK_TEXT: Record<ArtworkKind, string[]> = {
  show: ["WATCH TO DOWNLOAD"],
  season: ["WATCH EPISODE 1", "TO DOWNLOAD SEASON"],
  episode: ["WATCH EPISODE 1", "TO DOWNLOAD SEASON"],
};

function escapeXml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);
}

export class PlexArtworkService {
  private readonly artworkDir: string;

  constructor(private readonly db: PacearrDatabase, private readonly logger: Logger, dataDir: string) {
    this.artworkDir = path.join(dataDir, "plex-artwork");
    fs.mkdirSync(this.artworkDir, { recursive: true });
  }

  async syncShow(plex: PlexIntegration, rolling: RollingShowRecord, series: SonarrSeries, retainedSeasons: number[]): Promise<void> {
    const show = await plex.findShowForArtwork({ tvdbId: series.tvdbId ?? null, imdbId: series.imdbId ?? null });
    if (!show) {
      this.logger.warn("Plex artwork skipped; no exact TVDB or IMDb match", { seriesId: series.id, title: series.title, tvdbId: series.tvdbId ?? null, imdbId: series.imdbId ?? null });
      return;
    }
    if (show.thumb) await this.overlayItem(plex, rolling, show.ratingKey, { ratingKey: show.ratingKey, seasonNumber: 0, thumb: show.thumb }, "show");
    const retained = new Set(retainedSeasons);
    for (const season of show.seasons) {
      try {
        const pilot = await plex.getSeasonPilotArtwork(season);
        if (retained.has(season.seasonNumber)) {
          await this.restoreItem(plex, rolling.id, season, "season");
          if (pilot) await this.restoreItem(plex, rolling.id, pilot, "episode");
        } else {
          await this.overlayItem(plex, rolling, show.ratingKey, season, "season");
          if (pilot) await this.overlayItem(plex, rolling, show.ratingKey, pilot, "episode");
        }
      } catch (error) {
        this.logger.warn("Plex rolling artwork update failed", { seriesId: series.id, seasonNumber: season.seasonNumber, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  async restoreAll(plex: PlexIntegration, rollingShowId: number): Promise<void> {
    for (const record of this.db.listPlexArtwork(rollingShowId).filter((item) => item.overlayApplied)) {
      await plex.uploadPoster(record.plexItemRatingKey, fs.readFileSync(record.originalPosterPath));
      this.db.setPlexArtworkOverlayApplied(record.id, false);
      this.logger.info("Plex rolling artwork restored", { rollingShowId, itemType: record.itemType, seasonNumber: record.seasonNumber });
    }
  }

  removeBackups(records: PlexArtworkRecord[]): void {
    for (const record of records) for (const filePath of [record.originalPosterPath, record.overlayPosterPath]) {
      try { fs.unlinkSync(filePath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.logger.warn("Failed to remove Plex artwork backup", { filePath, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  private async overlayItem(plex: PlexIntegration, rolling: RollingShowRecord, plexShowRatingKey: string, item: ArtworkItem, itemType: ArtworkKind): Promise<void> {
    let record = this.db.getPlexArtwork(rolling.id, item.ratingKey, itemType);
    if (record?.overlayApplied && record.renderVersion >= ARTWORK_RENDER_VERSION) {
      if (record.overlayThumb === item.thumb) return;
      const current = await plex.downloadPoster(item.thumb);
      // Some Plex versions return a new thumbnail URL after an upload even
      // when they serve identical image bytes. Recognize our own asset before
      // treating the change as an administrator-selected replacement.
      if (this.sha256(current) === record.overlaySha256) {
        this.db.setPlexArtworkOverlayApplied(record.id, true, ARTWORK_RENDER_VERSION, item.thumb);
        return;
      }
      this.logger.info("Plex artwork changed outside Pacearr; refreshing overlay", { rollingShowId: rolling.id, itemType, seasonNumber: item.seasonNumber });
      fs.writeFileSync(record.originalPosterPath, current);
      await this.renderOverlay(current, record.overlayPosterPath, ARTWORK_TEXT[itemType], itemType);
      this.db.updatePlexArtworkSource(record.id, this.sha256(fs.readFileSync(record.overlayPosterPath)), ARTWORK_RENDER_VERSION);
    }
    if (!record) record = await this.backupAndRender(plex, rolling.id, plexShowRatingKey, item, itemType);
    else if (!record.overlayApplied) {
      // An expanded season can receive a manual poster before it returns to
      // pilot-only. Use that current Plex image as the next restoration source.
      const current = await plex.downloadPoster(item.thumb);
      fs.writeFileSync(record.originalPosterPath, current);
      await this.renderOverlay(current, record.overlayPosterPath, ARTWORK_TEXT[itemType], itemType);
      this.db.updatePlexArtworkSource(record.id, this.sha256(fs.readFileSync(record.overlayPosterPath)), ARTWORK_RENDER_VERSION);
    } else if (record.renderVersion < ARTWORK_RENDER_VERSION) {
      await this.renderOverlay(fs.readFileSync(record.originalPosterPath), record.overlayPosterPath, ARTWORK_TEXT[itemType], itemType);
      this.db.updatePlexArtworkSource(record.id, this.sha256(fs.readFileSync(record.overlayPosterPath)), ARTWORK_RENDER_VERSION);
    }
    await plex.uploadPoster(item.ratingKey, fs.readFileSync(record.overlayPosterPath));
    this.db.setPlexArtworkOverlayApplied(record.id, true, ARTWORK_RENDER_VERSION, await plex.getPosterThumb(item.ratingKey));
    this.logger.info("Plex rolling artwork applied", { rollingShowId: rolling.id, itemType, seasonNumber: item.seasonNumber });
  }

  private async restoreItem(plex: PlexIntegration, rollingShowId: number, item: ArtworkItem, itemType: ArtworkKind): Promise<void> {
    const record = this.db.getPlexArtwork(rollingShowId, item.ratingKey, itemType);
    if (!record?.overlayApplied) return;
    await plex.uploadPoster(item.ratingKey, fs.readFileSync(record.originalPosterPath));
    this.db.setPlexArtworkOverlayApplied(record.id, false);
    this.logger.info("Plex rolling artwork restored", { rollingShowId, itemType, seasonNumber: item.seasonNumber });
  }

  private async backupAndRender(plex: PlexIntegration, rollingShowId: number, plexShowRatingKey: string, item: ArtworkItem, itemType: ArtworkKind): Promise<PlexArtworkRecord> {
    const original = await plex.downloadPoster(item.thumb);
    const prefix = `${rollingShowId}-${itemType}-${item.ratingKey}-${crypto.createHash("sha256").update(item.thumb).digest("hex").slice(0, 12)}`;
    const originalPosterPath = path.join(this.artworkDir, `${prefix}-original.jpg`);
    const overlayPosterPath = path.join(this.artworkDir, `${prefix}-overlay.jpg`);
    fs.writeFileSync(originalPosterPath, original, { flag: "wx" });
    try {
      await this.renderOverlay(original, overlayPosterPath, ARTWORK_TEXT[itemType], itemType);
      return this.db.createPlexArtwork({ rollingShowId, plexShowRatingKey, plexItemRatingKey: item.ratingKey, itemType, seasonNumber: item.seasonNumber, originalPosterPath, overlayPosterPath, overlaySha256: this.sha256(fs.readFileSync(overlayPosterPath)) });
    } catch (error) {
      for (const filePath of [originalPosterPath, overlayPosterPath]) try { fs.unlinkSync(filePath); } catch { /* cleanup only */ }
      throw error;
    }
  }

  private async renderOverlay(original: Buffer, outputPath: string, lines: string[], itemType: ArtworkKind): Promise<void> {
    const image = sharp(original).rotate();
    const { width, height } = await image.metadata();
    if (!width || !height) throw new Error("Plex artwork does not report image dimensions.");
    const fontSize = Math.max(20, Math.round(width * (itemType === "season" ? 0.064 : lines.length > 1 ? 0.045 : 0.068)));
    const lineHeight = Math.round(fontSize * 1.2);
    const bannerHeight = itemType === "season"
      ? Math.max(90, Math.round(lines.length * lineHeight + height * 0.025))
      : Math.max(90, Math.round(height * (lines.length > 1 ? 0.2 : 0.13)));
    const firstY = height - bannerHeight / 2 - ((lines.length - 1) * lineHeight) / 2;
    const text = lines.map((line, index) => `<text x="${width / 2}" y="${firstY + index * lineHeight}" dominant-baseline="middle" text-anchor="middle" fill="white" font-family="DejaVu Sans" font-weight="bold" font-size="${fontSize}" letter-spacing="1">${escapeXml(line)}</text>`).join("");
    const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect y="${height - bannerHeight}" width="${width}" height="${bannerHeight}" fill="#111827" fill-opacity="0.9"/>${text}</svg>`;
    await image.composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).jpeg({ quality: 92, mozjpeg: true }).toFile(outputPath);
  }

  private sha256(image: Buffer): string {
    return crypto.createHash("sha256").update(image).digest("hex");
  }
}
