import fs from "node:fs";
import path from "node:path";

export type ThreadsSampleDetector =
  | "home_feed"
  | "gallery_picker"
  | "composer"
  | "reply_composer"
  | "profile_page"
  | "share_sheet"
  | "post_action_sheet"
  | "fullscreen_media_viewer"
  | "side_drawer"
  | "search_overlay"
  | "android_camera"
  | "blocked_screen";

export interface ThreadsSampleAssertion {
  detector: ThreadsSampleDetector;
  expected: boolean | string;
}

export interface ThreadsPublishSampleRegistryEntry {
  id: string;
  jsonPath: string;
  scenario: string;
  mediaKind: string;
  page?: string;
  reason?: string;
  focus?: string;
  observedStateKey?: string;
  screenshotPath?: string | null;
  screenshotSize?: { width: number; height: number } | null;
  xmlPath?: string | null;
  createdAt?: string;
  status: "pending" | "promoted" | "ignored";
  promotedAt?: string;
  updatedAt: string;
  assertions?: ThreadsSampleAssertion[];
}

export interface ThreadsPublishSampleIndex {
  version: 1;
  updatedAt: string;
  samples: ThreadsPublishSampleRegistryEntry[];
}

export interface ThreadsPromotedSample {
  id: string;
  scenario: string;
  mediaKind: string;
  page?: string;
  reason?: string;
  sourceJsonPath?: string;
  screenshot?: string;
  screenshotSize?: { width: number; height: number };
  xml?: string;
  assertions: ThreadsSampleAssertion[];
  promotedAt: string;
}

export interface ThreadsPromotedSampleManifest {
  version: 1;
  updatedAt: string;
  samples: ThreadsPromotedSample[];
}

const RUNTIME_INDEX_PATH = path.join(
  process.cwd(),
  ".runtime",
  "automatic-script",
  "publish-samples",
  "threads",
  "sample-index.json",
);

export const THREADS_PROMOTED_SAMPLE_ROOT = path.join(
  process.cwd(),
  "src",
  "test",
  "fixtures",
  "threads-publish-samples",
);

export const THREADS_PROMOTED_SAMPLE_MANIFEST = path.join(
  THREADS_PROMOTED_SAMPLE_ROOT,
  "manifest.json",
);

export const THREADS_PROMOTED_SAMPLE_SCREEN = { width: 720, height: 1600 } as const;

export function isThreadsPromotedSampleScreenSize(size?: { width?: number; height?: number } | null): size is { width: number; height: number } {
  return Boolean(
    size
    && size.width === THREADS_PROMOTED_SAMPLE_SCREEN.width
    && size.height === THREADS_PROMOTED_SAMPLE_SCREEN.height,
  );
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeImageSize(value: unknown): { width: number; height: number } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const width = Number(record.width);
  const height = Number(record.height);
  return width > 0 && height > 0 ? { width, height } : null;
}

function sanitizeSampleText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed
    .replace(/[A-Z]:[\\/][^\s｜|]+\.runtime[\\/][^\s｜|]+/gi, ".runtime/automatic-script")
    .replace(/[A-Z]:[\\/][^\s｜|]+debug-shots[\\/]/gi, "debug-shots/");
}

function readImageSizeFromFileSync(filePath: string | null | undefined): { width: number; height: number } | null {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const buffer = fs.readFileSync(filePath);
    if (buffer.length >= 24 && buffer.toString("ascii", 1, 4) === "PNG") {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (buffer.length >= 10 && buffer[0] === 0xff && buffer[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = buffer[offset + 1];
        const length = buffer.readUInt16BE(offset + 2);
        if (length < 2) return null;
        if (
          (marker >= 0xc0 && marker <= 0xc3)
          || (marker >= 0xc5 && marker <= 0xc7)
          || (marker >= 0xc9 && marker <= 0xcb)
          || (marker >= 0xcd && marker <= 0xcf)
        ) {
          return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
        }
        offset += 2 + length;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function uniqueAssertions(assertions: ThreadsSampleAssertion[]): ThreadsSampleAssertion[] {
  const seen = new Set<string>();
  return assertions.filter((assertion) => {
    const key = `${assertion.detector}:${String(assertion.expected)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function inferThreadsSampleAssertions(input: {
  page?: string;
  reason?: string;
  focus?: string;
  xmlPath?: string | null;
}): ThreadsSampleAssertion[] {
  const page = input.page || "";
  const reason = input.reason || "";
  const focus = input.focus || "";
  const text = `${page} ${reason} ${focus}`;
  const assertions: ThreadsSampleAssertion[] = [];

  if (/LOCAL_HOME_FEED|home_feed/.test(text)) {
    assertions.push(
      { detector: "home_feed", expected: "LOCAL_HOME_FEED" },
      { detector: "profile_page", expected: false },
      { detector: "composer", expected: false },
      { detector: "gallery_picker", expected: false },
      { detector: "side_drawer", expected: false },
    );
  } else if (/LOCAL_GALLERY_PICKER|gallery_picker/.test(text)) {
    assertions.push(
      { detector: "gallery_picker", expected: "LOCAL_GALLERY_PICKER" },
      { detector: "composer", expected: false },
      { detector: "home_feed", expected: false },
    );
  } else if (/LOCAL_COMPOSER|compose_editor/.test(text)) {
    assertions.push(
      { detector: "composer", expected: "LOCAL_COMPOSER" },
      { detector: "post_action_sheet", expected: false },
      { detector: "gallery_picker", expected: false },
    );
  } else if (/LOCAL_REPLY_COMPOSER|reply_composer/.test(text)) {
    assertions.push(
      { detector: "reply_composer", expected: "LOCAL_REPLY_COMPOSER" },
      { detector: "profile_page", expected: false },
    );
  } else if (/LOCAL_PROFILE_PAGE|profile_page/.test(text)) {
    assertions.push(
      { detector: "profile_page", expected: true },
      { detector: "reply_composer", expected: false },
      { detector: "composer", expected: false },
    );
  } else if (/LOCAL_THREADS_SHARE_SHEET/.test(text)) {
    assertions.push(
      { detector: "share_sheet", expected: true },
      { detector: "home_feed", expected: false },
    );
  } else if (/LOCAL_THREADS_POST_ACTION_SHEET/.test(text)) {
    assertions.push(
      { detector: "post_action_sheet", expected: true },
      { detector: "composer", expected: false },
    );
  } else if (/LOCAL_FULLSCREEN_MEDIA_VIEWER|media_viewer/.test(text)) {
    assertions.push(
      { detector: "fullscreen_media_viewer", expected: true },
      { detector: "home_feed", expected: false },
    );
  } else if (/LOCAL_THREADS_SIDE_DRAWER/.test(text)) {
    assertions.push(
      { detector: "side_drawer", expected: true },
      { detector: "home_feed", expected: false },
    );
  } else if (/LOCAL_THREADS_SEARCH_OVERLAY/.test(text)) {
    assertions.push(
      { detector: "search_overlay", expected: true },
      { detector: "composer", expected: false },
    );
  } else if (/LOCAL_ANDROID_CAMERA|com\.android\.camera/i.test(text)) {
    assertions.push({ detector: "android_camera", expected: "LOCAL_ANDROID_CAMERA" });
  } else if (/LOCAL_PHONE_VERIFICATION_PAGE|login_required|challenge|system_dialog|驗證|验证|captcha|申訴|申诉/.test(text)) {
    assertions.push({ detector: "blocked_screen", expected: true });
  }

  return uniqueAssertions(assertions);
}

export function readThreadsPublishSampleIndex(): ThreadsPublishSampleIndex {
  return readJsonFile<ThreadsPublishSampleIndex>(RUNTIME_INDEX_PATH, {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    samples: [],
  });
}

export function writeThreadsPublishSampleIndex(index: ThreadsPublishSampleIndex): void {
  writeJsonFile(RUNTIME_INDEX_PATH, {
    ...index,
    updatedAt: new Date().toISOString(),
    samples: index.samples,
  });
}

export function registerThreadsPublishSample(jsonPath: string, sample: Record<string, any>): ThreadsPublishSampleRegistryEntry | null {
  const id = String(sample.id || path.basename(jsonPath, path.extname(jsonPath)));
  if (!id) return null;

  const entry: ThreadsPublishSampleRegistryEntry = {
    id,
    jsonPath: path.resolve(jsonPath),
    scenario: String(sample.scenario || "unknown"),
    mediaKind: String(sample.mediaKind || "media"),
    page: sanitizeSampleText(sample.page) || sanitizeSampleText(sample.snapshot?.page),
    reason: sanitizeSampleText(sample.reason) || sanitizeSampleText(sample.snapshot?.reason),
    focus: sanitizeSampleText(sample.focus) || sanitizeSampleText(sample.snapshot?.focus),
    observedStateKey: typeof sample.observedStateKey === "string" ? sample.observedStateKey : undefined,
    screenshotPath: normalizePath(sample.screenshotPath || sample.snapshot?.screenshotPath),
    screenshotSize: normalizeImageSize(sample.screenshotSize || sample.snapshot?.screenshotSize),
    xmlPath: normalizePath(sample.xmlPath || sample.snapshot?.xmlPath),
    createdAt: typeof sample.createdAt === "string" ? sample.createdAt : new Date().toISOString(),
    status: "pending",
    updatedAt: new Date().toISOString(),
  };
  entry.assertions = inferThreadsSampleAssertions(entry);

  const index = readThreadsPublishSampleIndex();
  const existing = index.samples.find((item) => item.id === id);
  if (existing) {
    Object.assign(existing, entry, {
      status: existing.status === "promoted" ? "promoted" : entry.status,
      promotedAt: existing.promotedAt,
    });
  } else {
    index.samples.push(entry);
  }
  index.samples.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  writeThreadsPublishSampleIndex(index);
  return entry;
}

function walkFiles(root: string, suffix: string, output: string[] = []): string[] {
  if (!fs.existsSync(root)) return output;
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, item.name);
    if (item.isDirectory()) walkFiles(fullPath, suffix, output);
    else if (item.isFile() && item.name.endsWith(suffix)) output.push(fullPath);
  }
  return output;
}

export function refreshThreadsPublishSampleIndexFromRuntime(): ThreadsPublishSampleIndex {
  const root = path.dirname(RUNTIME_INDEX_PATH);
  const jsonFiles = walkFiles(root, ".json")
    .filter((filePath) => path.basename(filePath) !== "sample-index.json");
  for (const jsonPath of jsonFiles) {
    const sample = readJsonFile<Record<string, any> | null>(jsonPath, null);
    if (sample?.platform === "threads" && sample.id) {
      registerThreadsPublishSample(jsonPath, sample);
    }
  }
  return readThreadsPublishSampleIndex();
}

export function readThreadsPromotedSampleManifest(): ThreadsPromotedSampleManifest {
  return readJsonFile<ThreadsPromotedSampleManifest>(THREADS_PROMOTED_SAMPLE_MANIFEST, {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    samples: [],
  });
}

function copyArtifact(sourcePath: string | null | undefined, targetName: string): string | undefined {
  if (!sourcePath || !fs.existsSync(sourcePath)) return undefined;
  const ext = path.extname(sourcePath) || path.extname(targetName) || ".bin";
  const relativePath = path.join("samples", `${targetName}${ext}`).replace(/\\/g, "/");
  const targetPath = path.join(THREADS_PROMOTED_SAMPLE_ROOT, relativePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
  return relativePath;
}

export function promoteThreadsPublishSamples(options: {
  limit?: number;
  scenario?: string;
  includePromoted?: boolean;
  dryRun?: boolean;
} = {}): { promoted: ThreadsPromotedSample[]; skipped: Array<{ id: string; reason: string }> } {
  const index = refreshThreadsPublishSampleIndexFromRuntime();
  const manifest = readThreadsPromotedSampleManifest();
  const existingIds = new Set(manifest.samples.map((sample) => sample.id));
  const promoted: ThreadsPromotedSample[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const limit = Math.max(1, options.limit ?? 20);

  for (const entry of index.samples) {
    if (promoted.length >= limit) break;
    if (options.scenario && entry.scenario !== options.scenario) continue;
    if (!options.includePromoted && (entry.status === "promoted" || existingIds.has(entry.id))) {
      skipped.push({ id: entry.id, reason: "already promoted" });
      continue;
    }
    const assertions = entry.assertions?.length ? entry.assertions : inferThreadsSampleAssertions(entry);
    if (!assertions.length) {
      skipped.push({ id: entry.id, reason: "no inferred assertions" });
      continue;
    }
    const needsScreenshot = assertions.some((assertion) => assertion.detector !== "android_camera" && assertion.detector !== "blocked_screen");
    let screenshotSize: { width: number; height: number } | null = null;
    if (needsScreenshot && (!entry.screenshotPath || !fs.existsSync(entry.screenshotPath))) {
      skipped.push({ id: entry.id, reason: "missing screenshot" });
      continue;
    }
    if (needsScreenshot) {
      screenshotSize = entry.screenshotSize || readImageSizeFromFileSync(entry.screenshotPath);
      if (!isThreadsPromotedSampleScreenSize(screenshotSize)) {
        const actual = screenshotSize ? `${screenshotSize.width}x${screenshotSize.height}` : "unknown";
        skipped.push({ id: entry.id, reason: `screenshot resolution ${actual}; need 720x1600` });
        continue;
      }
    }
    const needsXml = assertions.some((assertion) => assertion.detector === "android_camera" || assertion.detector === "blocked_screen");
    if (needsXml && (!entry.xmlPath || !fs.existsSync(entry.xmlPath))) {
      skipped.push({ id: entry.id, reason: "missing xml" });
      continue;
    }

    const sample: ThreadsPromotedSample = {
      id: entry.id,
      scenario: entry.scenario,
      mediaKind: entry.mediaKind,
      page: entry.page,
      reason: sanitizeSampleText(entry.reason),
      sourceJsonPath: entry.jsonPath,
      assertions,
      promotedAt: new Date().toISOString(),
    };
    if (screenshotSize) sample.screenshotSize = screenshotSize;

    if (!options.dryRun) {
      sample.screenshot = copyArtifact(entry.screenshotPath, `${entry.id}-screenshot`);
      sample.xml = copyArtifact(entry.xmlPath, `${entry.id}-ui`);
      manifest.samples = manifest.samples.filter((item) => item.id !== sample.id);
      manifest.samples.push(sample);
      const indexed = index.samples.find((item) => item.id === entry.id);
      if (indexed) {
        indexed.status = "promoted";
        indexed.promotedAt = sample.promotedAt;
        indexed.assertions = assertions;
        indexed.updatedAt = new Date().toISOString();
      }
    }
    promoted.push(sample);
  }

  if (!options.dryRun && promoted.length > 0) {
    manifest.samples.sort((a, b) => a.id.localeCompare(b.id));
    writeJsonFile(THREADS_PROMOTED_SAMPLE_MANIFEST, {
      ...manifest,
      updatedAt: new Date().toISOString(),
    });
    writeThreadsPublishSampleIndex(index);
  }

  return { promoted, skipped };
}
