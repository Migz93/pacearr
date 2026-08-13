import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Logger } from "./logger.js";

const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export class ImageCacheService {
  private readonly cacheDir: string;
  // Refreshing a full library's posters checks this cache for every show. Reading the
  // directory listing once up front and tracking writes in memory avoids up to 4
  // synchronous fs.existsSync calls (one per known extension) per lookup.
  private readonly knownFiles: Set<string>;

  constructor(dataDir: string, private readonly logger: Logger) {
    this.cacheDir = path.join(dataDir, "image-cache");
    fs.mkdirSync(this.cacheDir, { recursive: true });
    this.knownFiles = new Set(fs.readdirSync(this.cacheDir));
  }

  get publicDir() {
    return this.cacheDir;
  }

  async ensureAvatarCached(plexUserId: string, avatarUrl: string | null): Promise<string | null> {
    if (!avatarUrl) return null;
    if (avatarUrl.startsWith("/images/")) return avatarUrl;

    return this.ensureRemoteImageCached({
      kind: "avatar",
      cacheParts: [plexUserId, avatarUrl],
      sourceUrl: avatarUrl,
      logMeta: { plexUserId },
    });
  }

  async ensureSonarrPosterCached(seriesId: number, posterUrl: string | null, headers: Record<string, string> = {}): Promise<string | null> {
    if (!posterUrl) return null;
    if (posterUrl.startsWith("/images/")) return posterUrl;

    return this.ensureRemoteImageCached({
      kind: "poster",
      cacheParts: [String(seriesId), posterUrl],
      sourceUrl: posterUrl,
      headers,
      logMeta: { sonarrSeriesId: seriesId },
    });
  }

  private async ensureRemoteImageCached(input: {
    kind: "avatar" | "poster";
    cacheParts: string[];
    sourceUrl: string;
    headers?: Record<string, string>;
    logMeta: Record<string, unknown>;
  }): Promise<string | null> {
    const parsed = this.parseImageUrl(input.sourceUrl);
    if (!parsed) {
      this.logger.warn("Image cache skipped invalid URL", { kind: input.kind, ...input.logMeta });
      return null;
    }

    const cacheKey = crypto.createHash("sha256").update(input.cacheParts.join(":")).digest("hex").slice(0, 24);
    const existing = this.findExistingImage(input.kind, cacheKey);
    if (existing) return existing;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(parsed, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Pacearr",
          Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/*",
          ...(input.headers ?? {}),
        },
      });
      if (!response.ok) {
        this.logger.warn("Image cache fetch failed", { kind: input.kind, status: response.status, ...input.logMeta });
        return null;
      }

      const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
      const extension = CONTENT_TYPE_EXTENSIONS[contentType];
      if (!extension) {
        this.logger.warn("Image cache rejected non-image response", { kind: input.kind, contentType, ...input.logMeta });
        return null;
      }

      const data = Buffer.from(await response.arrayBuffer());
      if (data.byteLength > IMAGE_MAX_BYTES) {
        this.logger.warn("Image cache rejected oversized response", { kind: input.kind, bytes: data.byteLength, ...input.logMeta });
        return null;
      }

      const fileName = `${input.kind}-${cacheKey}.${extension}`;
      const filePath = path.join(this.cacheDir, fileName);
      fs.writeFileSync(filePath, data, { flag: "wx" });
      this.knownFiles.add(fileName);
      this.logger.info("Image cached", { kind: input.kind, fileName, bytes: data.byteLength, ...input.logMeta });
      return `/images/${fileName}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        // A concurrent request already wrote this file after our in-memory check missed
        // it. The in-memory set doesn't know about that write yet, so confirm on disk
        // rather than wrongly report a still-missing cache entry.
        return this.findExistingImage(input.kind, cacheKey, { forceDiskCheck: true });
      }
      this.logger.warn("Image cache failed", { kind: input.kind, error: error instanceof Error ? error.message : String(error), ...input.logMeta });
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseImageUrl(imageUrl: string): URL | null {
    try {
      const parsed = new URL(imageUrl);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private findExistingImage(kind: "avatar" | "poster", cacheKey: string, options: { forceDiskCheck?: boolean } = {}): string | null {
    for (const extension of Object.values(CONTENT_TYPE_EXTENSIONS)) {
      const fileName = `${kind}-${cacheKey}.${extension}`;
      if (this.knownFiles.has(fileName)) {
        if (fs.existsSync(path.join(this.cacheDir, fileName))) return `/images/${fileName}`;
        this.knownFiles.delete(fileName);
      }
      if (options.forceDiskCheck && fs.existsSync(path.join(this.cacheDir, fileName))) {
        this.knownFiles.add(fileName);
        return `/images/${fileName}`;
      }
    }
    return null;
  }
}
