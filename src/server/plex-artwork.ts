import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { PlexArtworkRecord, RollingShowRecord, SonarrSeries } from "../shared/types.js";
import type { PacearrDatabase } from "./db/index.js";
import { PlexIntegration, type PlexEpisodeArtworkItem, type PlexSeasonArtworkItem } from "./integrations/plex.js";
import type { Logger } from "./logger.js";

type ArtworkItem = { ratingKey: string; seasonNumber: number; thumb: string; episodeNumber?: number };
type ArtworkKind = PlexArtworkRecord["itemType"];

const ARTWORK_RENDER_VERSION = 12;

const ARTWORK_TEXT: Record<ArtworkKind, string[]> = {
  show: ["WATCH TO DOWNLOAD"],
  season: ["WATCH FIRST EPISODE TO", "DOWNLOAD FULL SEASON"],
  episode: ["WATCH FIRST EPISODE TO", "DOWNLOAD FULL SEASON"],
};

function escapeXml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);
}

// Filesystem-safe folder/file name: strips characters illegal on Windows or
// Linux and collapses whitespace, so the show's own title can be used
// directly instead of an opaque id.
function sanitizeForPath(value: string): string {
  const cleaned = value.replace(/[\\/:*?"<>|\x00-\x1f]/g, "").replace(/\s+/g, " ").trim();
  // Trailing spaces/dots are invalid on Windows-hosted volumes, and slicing
  // to the length limit can reintroduce one at the new end of the string.
  const truncated = cleaned.slice(0, 100).replace(/[ .]+$/, "");
  return truncated.length > 0 ? truncated : "untitled";
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
          await this.restoreItem(plex, rolling, season, "season");
          if (pilot) await this.restoreItem(plex, rolling, pilot, "episode");
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
    const showDirs = new Set<string>();
    for (const record of records) for (const filePath of [record.originalPosterPath, record.overlayPosterPath]) {
      try { fs.unlinkSync(filePath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.logger.warn("Failed to remove Plex artwork backup", { filePath, error: error instanceof Error ? error.message : String(error) });
      }
      const dir = path.dirname(filePath);
      // Records that predate the per-show folder migration still point at
      // legacy flat files directly under artworkDir; never treat the
      // storage root itself as a per-show folder to remove.
      if (path.resolve(dir) !== path.resolve(this.artworkDir)) showDirs.add(dir);
    }
    // Only removes the per-show folder once it's empty, so files from other
    // still-enrolled shows are never touched.
    for (const dir of showDirs) {
      try { fs.rmdirSync(dir); } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOTEMPTY" && code !== "ENOENT") this.logger.warn("Failed to remove Plex artwork show folder", { dir, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  // The show's own title/id names its folder, and each file is named after
  // what it actually is, instead of every show's posters sharing one flat
  // folder of opaque hash-suffixed filenames.
  private itemLabel(item: ArtworkItem, itemType: ArtworkKind): string {
    const pad = (value: number) => String(value).padStart(2, "0");
    if (itemType === "show") return "Show Poster";
    if (itemType === "season") return `S${pad(item.seasonNumber)} Poster`;
    return `S${pad(item.seasonNumber)}E${pad(item.episodeNumber ?? 1)} Poster`;
  }

  private itemPaths(rolling: RollingShowRecord, item: ArtworkItem, itemType: ArtworkKind): { dir: string; originalPosterPath: string; overlayPosterPath: string } {
    const dir = path.join(this.artworkDir, `${sanitizeForPath(rolling.title)} (${rolling.id})`);
    const label = this.itemLabel(item, itemType);
    return { dir, overlayPosterPath: path.join(dir, `${label}.jpg`), originalPosterPath: path.join(dir, `${label} (Original).jpg`) };
  }

  // Existing records still point at the old flat, hash-named files. Move
  // them into the new per-show folder the first time each item is synced
  // after this change, rather than requiring a separate migration step.
  private relocateToCanonicalPaths(rolling: RollingShowRecord, item: ArtworkItem, itemType: ArtworkKind, record: PlexArtworkRecord): PlexArtworkRecord {
    const { dir, originalPosterPath, overlayPosterPath } = this.itemPaths(rolling, item, itemType);
    if (record.originalPosterPath === originalPosterPath && record.overlayPosterPath === overlayPosterPath) return record;
    fs.mkdirSync(dir, { recursive: true });
    for (const [from, to] of [[record.originalPosterPath, originalPosterPath], [record.overlayPosterPath, overlayPosterPath]] as const) {
      // A prior attempt may have already moved this file (e.g. it moved one
      // of the pair, then failed on the other); skip so a retry can't clobber
      // or re-throw on a file that's already in place.
      if (fs.existsSync(to)) continue;
      try { fs.renameSync(from, to); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    // Only persist the new paths once both files are confirmed to actually
    // be there — a missing source (already moved elsewhere, or lost outside
    // Pacearr) must never leave the database pointing at a canonical path
    // with nothing behind it. Leaving the record untouched means the next
    // sync retries the move instead of silently losing track of the file.
    if (!fs.existsSync(originalPosterPath) || !fs.existsSync(overlayPosterPath)) {
      this.logger.warn("Plex artwork file missing during folder reorganization; leaving database path unchanged", { rollingShowId: rolling.id, itemType, seasonNumber: item.seasonNumber });
      return record;
    }
    this.db.updatePlexArtworkPaths(record.id, originalPosterPath, overlayPosterPath);
    this.logger.info("Plex artwork files reorganized into per-show folder", { rollingShowId: rolling.id, itemType, seasonNumber: item.seasonNumber });
    return { ...record, originalPosterPath, overlayPosterPath };
  }

  private async overlayItem(plex: PlexIntegration, rolling: RollingShowRecord, plexShowRatingKey: string, item: ArtworkItem, itemType: ArtworkKind): Promise<void> {
    let record = this.db.getPlexArtwork(rolling.id, item.ratingKey, itemType);
    if (record) record = this.relocateToCanonicalPaths(rolling, item, itemType, record);
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
    if (!record) record = await this.backupAndRender(plex, rolling, plexShowRatingKey, item, itemType);
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

  private async restoreItem(plex: PlexIntegration, rolling: RollingShowRecord, item: ArtworkItem, itemType: ArtworkKind): Promise<void> {
    let record = this.db.getPlexArtwork(rolling.id, item.ratingKey, itemType);
    if (!record) return;
    record = this.relocateToCanonicalPaths(rolling, item, itemType, record);
    if (!record.overlayApplied) return;
    await plex.uploadPoster(item.ratingKey, fs.readFileSync(record.originalPosterPath));
    this.db.setPlexArtworkOverlayApplied(record.id, false);
    this.logger.info("Plex rolling artwork restored", { rollingShowId: rolling.id, itemType, seasonNumber: item.seasonNumber });
  }

  private async backupAndRender(plex: PlexIntegration, rolling: RollingShowRecord, plexShowRatingKey: string, item: ArtworkItem, itemType: ArtworkKind): Promise<PlexArtworkRecord> {
    const original = await plex.downloadPoster(item.thumb);
    const { dir, originalPosterPath, overlayPosterPath } = this.itemPaths(rolling, item, itemType);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(originalPosterPath, original);
    try {
      await this.renderOverlay(original, overlayPosterPath, ARTWORK_TEXT[itemType], itemType);
      return this.db.createPlexArtwork({ rollingShowId: rolling.id, plexShowRatingKey, plexItemRatingKey: item.ratingKey, itemType, seasonNumber: item.seasonNumber, originalPosterPath, overlayPosterPath, overlaySha256: this.sha256(fs.readFileSync(overlayPosterPath)) });
    } catch (error) {
      for (const filePath of [originalPosterPath, overlayPosterPath]) try { fs.unlinkSync(filePath); } catch { /* cleanup only */ }
      throw error;
    }
  }

  private async renderOverlay(original: Buffer, outputPath: string, lines: string[], itemType: ArtworkKind): Promise<void> {
    const image = sharp(original).rotate();
    const { width, height } = await image.metadata();
    if (!width || !height) throw new Error("Plex artwork does not report image dimensions.");
    // Shrunk slightly versus the plain-text version to leave room for the
    // icon beside the text without widening the badge.
    let fontSize = Math.max(16, Math.round(width * (itemType === "season" ? 0.056 : lines.length > 1 ? 0.04 : 0.06)));

    // Ties the badge to Pacearr's own brand accent (--primary in styles.css)
    // with a download glyph sized to the full text block height, sitting to
    // the left of the text, the pair centered together within the badge.
    // Text width varies by font/glyphs, so it's measured with a probe
    // render rather than estimated, then the font is shrunk if it would
    // overflow the badge's max width.
    const accent = "#6fd3a6";
    const measureGroup = async (size: number) => {
      const lh = Math.round(size * 1.2);
      const widths = await Promise.all(lines.map((line) => this.measureTextWidth(line, size)));
      const textBlockWidth = Math.max(...widths);
      const iconSize = lines.length * lh;
      const iconGap = Math.round(size * 0.35);
      return { lineHeight: lh, textBlockWidth, iconSize, iconGap, groupWidth: iconSize + iconGap + textBlockWidth };
    };

    // Padding must track the *final* font size, so it's recomputed below if
    // the shrink branch fires.
    let horizontalPadding = Math.round(fontSize * 0.9);
    // The badge width hugs its content rather than a fixed fraction of the
    // poster width — episode thumbnails are 16:9 and much wider than show
    // and season posters, so a width tied to the image would dwarf the text.
    const maxRectWidth = width - Math.round(width * 0.08);
    const maxGroupWidth = maxRectWidth - horizontalPadding * 2;
    let metrics = await measureGroup(fontSize);
    if (metrics.groupWidth > maxGroupWidth) {
      fontSize = Math.max(12, Math.floor(fontSize * (maxGroupWidth / metrics.groupWidth)));
      horizontalPadding = Math.round(fontSize * 0.9);
      metrics = await measureGroup(fontSize);
    }
    const { lineHeight, iconSize, iconGap, groupWidth } = metrics;

    // The badge height hugs the icon/text block too, with padding
    // proportional to the poster height, instead of a fixed fraction of the
    // poster that left tall posters with an oversized box.
    const verticalPadding = Math.round(height * 0.025);
    const bannerHeight = Math.max(90, iconSize + verticalPadding * 2);
    const rectWidth = Math.min(maxRectWidth, groupWidth + horizontalPadding * 2);
    const rectX = width / 2 - rectWidth / 2;
    // Bottom margin lifts the badge off the poster edge so it reads as an
    // overlay rather than part of the original artwork.
    const bottomMargin = Math.round(height * 0.025);
    const rectY = height - bannerHeight - bottomMargin;
    const centerY = rectY + bannerHeight / 2;
    const cornerRadius = Math.round(Math.min(rectWidth, bannerHeight) * 0.15);

    const firstY = centerY - ((lines.length - 1) * lineHeight) / 2;
    const groupLeft = width / 2 - groupWidth / 2;
    const iconX = groupLeft;
    const iconY = centerY - iconSize / 2;
    const textX = groupLeft + iconSize + iconGap;

    const text = lines.map((line, index) => `<text x="${textX}" y="${firstY + index * lineHeight}" dominant-baseline="middle" text-anchor="start" fill="white" font-family="DejaVu Sans" font-weight="bold" font-size="${fontSize}" letter-spacing="1">${escapeXml(line)}</text>`).join("");
    const iconScale = iconSize / 24;
    const icon = `<g transform="translate(${iconX}, ${iconY}) scale(${iconScale})" fill="none" stroke="${accent}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v11"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/></g>`;
    const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="badgeFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#000000" stop-opacity="0.55"/><stop offset="100%" stop-color="#000000" stop-opacity="0.85"/></linearGradient></defs><rect x="${rectX}" y="${rectY}" width="${rectWidth}" height="${bannerHeight}" rx="${cornerRadius}" ry="${cornerRadius}" fill="url(#badgeFill)" stroke="${accent}" stroke-opacity="0.4" stroke-width="1.5"/>${icon}${text}</svg>`;
    await image.composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).jpeg({ quality: 92, mozjpeg: true }).toFile(outputPath);
  }

  // Probe renders are a pure function of (text, font size), and the text
  // comes from a small constant set (ARTWORK_TEXT), so results are cached
  // across items and syncs instead of re-rasterizing the same strings.
  private static readonly textWidthCache = new Map<string, number>();

  private async measureTextWidth(line: string, fontSize: number): Promise<number> {
    const cacheKey = `${fontSize}|${line}`;
    const cached = PlexArtworkService.textWidthCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const probeHeight = Math.max(Math.round(fontSize * 1.5), 32);
    const svg = `<svg width="4000" height="${probeHeight}" xmlns="http://www.w3.org/2000/svg"><text x="0" y="${probeHeight / 2}" dominant-baseline="middle" text-anchor="start" fill="white" font-family="DejaVu Sans" font-weight="bold" font-size="${fontSize}" letter-spacing="1">${escapeXml(line)}</text></svg>`;
    const { info } = await sharp(Buffer.from(svg)).trim().toBuffer({ resolveWithObject: true });
    PlexArtworkService.textWidthCache.set(cacheKey, info.width);
    return info.width;
  }

  private sha256(image: Buffer): string {
    return crypto.createHash("sha256").update(image).digest("hex");
  }
}
