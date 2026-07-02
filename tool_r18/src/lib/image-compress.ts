import sharp from "sharp";
import { parseDataUrlMedia } from "./media-utils";

export interface CompressImageOptions {
  targetBytes?: number;
  maxDim?: number;
  maxWidth?: number;
  maxHeight?: number;
  quality?: number;
  minQuality?: number;
}

function clampQuality(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  if (value <= 1) return Math.round(value * 100);
  return Math.round(value);
}

function resolveOptions(
  targetBytesOrOptions?: number | CompressImageOptions,
  maybeOptions?: CompressImageOptions,
): { targetBytes?: number; options: CompressImageOptions } {
  if (typeof targetBytesOrOptions === "number") {
    return { targetBytes: targetBytesOrOptions, options: maybeOptions ?? {} };
  }
  return { targetBytes: targetBytesOrOptions?.targetBytes, options: targetBytesOrOptions ?? {} };
}

function dataUrlFromJpeg(buffer: Buffer): string {
  return `data:image/jpeg;base64,${buffer.toString("base64")}`;
}

export async function compressImage(
  dataUrl: string,
  targetBytesOrOptions?: number | CompressImageOptions,
  maybeOptions?: CompressImageOptions,
): Promise<string> {
  const parsed = parseDataUrlMedia(dataUrl);
  if (!parsed || !parsed.mimeType.toLowerCase().startsWith("image/")) return dataUrl;
  if (/svg/i.test(parsed.mimeType)) return dataUrl;

  const input = Buffer.from(parsed.base64, "base64");
  const { targetBytes, options } = resolveOptions(targetBytesOrOptions, maybeOptions);
  const requestedMaxDim = options.maxDim ?? (Math.max(options.maxWidth ?? 0, options.maxHeight ?? 0) || 1280);
  const minDim = 512;
  const initialQuality = clampQuality(options.quality ?? 82, 82);
  const minQuality = clampQuality(options.minQuality ?? 45, 45);

  if (targetBytes && input.length <= targetBytes && parsed.mimeType.toLowerCase().includes("jpeg")) {
    return dataUrl;
  }

  let maxDim = Math.max(minDim, Math.round(requestedMaxDim));
  let best: Buffer | null = null;

  try {
    while (maxDim >= minDim) {
      for (let quality = initialQuality; quality >= minQuality; quality -= 8) {
        const candidate = await sharp(input)
          .rotate()
          .resize({ width: maxDim, height: maxDim, fit: "inside", withoutEnlargement: true })
          .flatten({ background: "#ffffff" })
          .jpeg({ quality, mozjpeg: true })
          .toBuffer();

        if (!best || candidate.length < best.length) best = candidate;
        if (!targetBytes || candidate.length <= targetBytes) return dataUrlFromJpeg(candidate);
      }
      maxDim = Math.floor(maxDim * 0.82);
    }
  } catch {
    return dataUrl;
  }

  return best ? dataUrlFromJpeg(best) : dataUrl;
}
