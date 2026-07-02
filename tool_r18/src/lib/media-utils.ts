export type EpisodeMediaKind = "none" | "image" | "video";

export interface ParsedDataUrlMedia {
  mimeType: string;
  base64: string;
}

export function isVideoMediaUrl(url?: string): boolean {
  if (!url) return false;
  return /^data:video\//i.test(url) || /\.(mp4|webm|mov|m4v)(?:$|[?#])/i.test(url);
}

export function getEpisodeMediaKind(url?: string): EpisodeMediaKind {
  if (!url) return "none";
  return isVideoMediaUrl(url) ? "video" : "image";
}

export function parseDataUrlMedia(dataUrl: string): ParsedDataUrlMedia | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/i);
  if (!match) return null;
  return { mimeType: match[1], base64: match[2] };
}

export function getMediaExtension(url: string): string {
  const parsed = url.startsWith("data:") ? parseDataUrlMedia(url) : null;
  const mimeType = parsed?.mimeType.toLowerCase();
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "video/mp4") return "mp4";
  if (mimeType === "video/webm") return "webm";
  if (mimeType === "video/quicktime") return "mov";
  if (mimeType === "video/x-m4v") return "m4v";
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") return "jpg";

  const extMatch = url.match(/\.([a-z0-9]{2,5})(?:$|[?#])/i);
  if (extMatch) {
    const ext = extMatch[1].toLowerCase();
    return ext === "jpeg" ? "jpg" : ext;
  }

  return isVideoMediaUrl(url) ? "mp4" : "jpg";
}
