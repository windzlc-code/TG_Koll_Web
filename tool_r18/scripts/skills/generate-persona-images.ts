import fs from "node:fs";
import {
  generatePersonaImage,
  generateReferenceSheet,
  type PersonaImageGenerationMode,
  type PersonaImageReferenceMode,
} from "@/lib/persona-image-production";
import { compressImage } from "@/lib/image-compress";
import { generateRunningHubNewPersonaStandardImage } from "@/runtime/node/runninghub-persona-image";
import { generateClosedModelImage } from "@/runtime/node/image-generator";
import { parseDataUrlMedia } from "@/lib/media-utils";
import { readRuntimeApiConfig } from "@/runtime/node/config";
import type { DramaSetup } from "@/types/drama";

export interface GeneratePersonaImagesInput {
  setup: DramaSetup;
  content: string;
  customPrompt?: string;
  model?: string;
  aspectRatio?: string;
  mode?: PersonaImageGenerationMode;
  referenceMode?: PersonaImageReferenceMode;
  referenceImageUrl?: string;
  referenceSheetUrl?: string;
  generateReferenceSheet?: boolean;
  dryRun?: boolean;
  configPath?: string;
  dataDir?: string;
}

function printJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

const CLOSED_IMAGE_TIMEOUT_MS = readPositiveIntEnv("PERSONA_IMAGE_CLOSED_TIMEOUT_MS", 180_000);
const GENERATED_DATA_URL_TARGET_BYTES = readPositiveIntEnv("PERSONA_IMAGE_DATA_URL_TARGET_BYTES", 512 * 1024);

function dataUrlBytes(url?: string): number | undefined {
  if (!url?.startsWith("data:")) return undefined;
  const parsed = parseDataUrlMedia(url);
  return parsed ? Buffer.byteLength(parsed.base64, "base64") : undefined;
}

function uniqueModels(models: Array<string | undefined>): string[] {
  return Array.from(new Set(models.map((model) => String(model || "").trim()).filter(Boolean)));
}

function parseModelList(value: unknown): string[] {
  if (Array.isArray(value)) return uniqueModels(value.map((item) => String(item || "")));
  return String(value || "")
    .replace(/\uFF0C/g, ",")
    .split(/[,\r\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function configuredImageModels(runtimeOptions?: { configPath?: string; dataDir?: string }): string[] {
  const config = readRuntimeApiConfig(runtimeOptions);
  return uniqueModels([
    ...parseModelList((config as any).imageModelPriorityOrder),
    ...parseModelList((config as any).image_model_priority_order),
    ...parseModelList((config as any).imageModelDefaultModelGemini),
    ...parseModelList((config as any).image_model_default_model_gemini),
    ...parseModelList((config as any).imageModelDefaultModel),
    ...parseModelList((config as any).image_model_default_model),
  ]);
}

function shouldTryNextClosedModel(result: any): boolean {
  if (result?.ok && result?.url) return false;
  const text = `${result?.reasonCode || ""} ${result?.error || ""}`;
  return /model_unavailable|auth_missing|network_error|timeout|upstream_error|NOT_FOUND|model_not_found|未返回圖片|未返回图片|未返回图|API 返回业务错误/i.test(text);
}

async function compressGeneratedDataUrl(url?: string): Promise<{ url?: string; bytesBefore?: number; bytesAfter?: number; compressed?: boolean }> {
  const bytesBefore = dataUrlBytes(url);
  if (!url?.startsWith("data:image/") || !bytesBefore) return { url, bytesBefore };
  const compressed = await compressImage(url, {
    targetBytes: GENERATED_DATA_URL_TARGET_BYTES,
    maxDim: 1280,
    minQuality: 0.4,
  });
  const bytesAfter = dataUrlBytes(compressed);
  return {
    url: bytesAfter && bytesAfter < bytesBefore ? compressed : url,
    bytesBefore,
    bytesAfter: bytesAfter || bytesBefore,
    compressed: Boolean(bytesAfter && bytesAfter < bytesBefore),
  };
}

const unsupportedImageApi = {
  generate: async (payload: any) => {
    const startedAt = Date.now();
    if (payload?.runningHubNewPersonaMode) {
      const attempts: Array<{ attempt: number; ok: boolean; reasonCode?: string; error?: string }> = [];
      let result: any;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        result = await generateRunningHubNewPersonaStandardImage({
          prompt: payload.prompt,
          mode: payload.runningHubNewPersonaMode,
          aspectRatio: payload.aspectRatio,
          referenceImage: payload.avatarSource || payload.avatarBase64,
          referenceImageMimeType: payload.avatarMimeType,
          timeoutMs: payload.timeoutMs,
        }, {
          configPath: payload.configPath,
          dataDir: payload.dataDir,
        });
        attempts.push({
          attempt,
          ok: Boolean(result?.ok && result?.url),
          reasonCode: result?.reasonCode,
          error: result?.error ? String(result.error).slice(0, 240) : undefined,
        });
        if (result?.ok || !result?.retryable || attempt >= 3) break;
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      }
      return {
        ...result,
        timings: {
          ...(result as any)?.timings,
          provider: "runninghub-standard-model",
          mode: payload.runningHubNewPersonaMode,
          attempts,
          elapsedMs: Date.now() - startedAt,
          timeoutMs: payload.timeoutMs || 300_000,
        },
      };
    }
    const models = uniqueModels([
      payload.model,
      ...configuredImageModels({ configPath: payload.configPath, dataDir: payload.dataDir }),
      process.env.PERSONA_IMAGE_MODEL,
      "gemini-3.1-flash-image-preview",
      "gpt-image-2",
    ]);
    let result: any;
    const fallbackAttempts: Array<{ model: string; ok: boolean; reasonCode?: string; error?: string }> = [];
    for (const model of models) {
      result = await generateClosedModelImage({
        prompt: payload.prompt,
        model,
        aspectRatio: payload.aspectRatio,
        avatarBase64: payload.avatarBase64,
        avatarMimeType: payload.avatarMimeType,
        timeoutMs: payload.timeoutMs || CLOSED_IMAGE_TIMEOUT_MS,
        configPath: payload.configPath,
        dataDir: payload.dataDir,
      });
      fallbackAttempts.push({
        model,
        ok: Boolean(result?.ok && result?.url),
        reasonCode: result?.reasonCode,
        error: result?.error ? String(result.error).slice(0, 240) : undefined,
      });
      if (!shouldTryNextClosedModel(result)) break;
    }
    const normalized = await compressGeneratedDataUrl(result.url);
    return {
      ...result,
      url: normalized.url,
      timings: {
        ...((result as any)?.timings || {}),
        provider: "closed-model-image",
        model: fallbackAttempts[fallbackAttempts.length - 1]?.model || payload.model || process.env.PERSONA_IMAGE_MODEL || "gpt-image-2",
        fallbackAttempts,
        elapsedMs: Date.now() - startedAt,
        timeoutMs: payload.timeoutMs || CLOSED_IMAGE_TIMEOUT_MS,
        dataUrlBytesBefore: normalized.bytesBefore,
        dataUrlBytesAfter: normalized.bytesAfter,
        dataUrlCompressed: normalized.compressed,
      },
    };
  },
};

async function main() {
  const startedAt = Date.now();
  const rawArg = process.argv[2];
  if (!rawArg) {
    printJson({ ok: false, error: "missing JSON input" });
    process.exitCode = 1;
    return;
  }
  const raw = rawArg.startsWith("@")
    ? fs.readFileSync(rawArg.slice(1), "utf8")
    : rawArg;

  const input = JSON.parse(raw) as GeneratePersonaImagesInput;
  const runtimeOptions = { configPath: input.configPath, dataDir: input.dataDir };
  const model = input.model
    || configuredImageModels(runtimeOptions)[0]
    || process.env.PERSONA_IMAGE_MODEL
    || "gpt-image-2";

  let referenceSheetMs: number | undefined;
  const referenceSheet = input.generateReferenceSheet
    ? await (async () => {
        const refStartedAt = Date.now();
        const result = await generateReferenceSheet(
        unsupportedImageApi,
        input.setup,
        input.content,
        model,
        runtimeOptions,
        );
        referenceSheetMs = Date.now() - refStartedAt;
        return result;
      })()
    : undefined;

  if (input.generateReferenceSheet) {
    printJson({
      ok: Boolean(referenceSheet?.ok && referenceSheet?.url),
      dryRun: input.dryRun !== false,
      referenceSheet,
      imageResult: {
        ok: Boolean(referenceSheet?.ok && referenceSheet?.url),
        url: referenceSheet?.url,
        mode: "closed-person",
        error: referenceSheet?.error,
      },
      timings: {
        totalMs: Date.now() - startedAt,
        referenceSheetMs,
        provider: (referenceSheet as any)?.timings?.provider,
        detail: (referenceSheet as any)?.timings,
      },
    });
    return;
  }

  const imageStartedAt = Date.now();
  const imageResult = await generatePersonaImage(
    unsupportedImageApi,
    input.setup,
    input.content,
    input.mode || "auto",
    model,
    input.aspectRatio || "1:1",
    input.referenceMode || "none",
    input.referenceImageUrl,
    input.referenceSheetUrl,
    runtimeOptions,
    input.customPrompt,
  );

  printJson({
    ok: Boolean(imageResult?.ok && imageResult?.url),
    dryRun: input.dryRun !== false,
    referenceSheet,
    imageResult,
    timings: {
      totalMs: Date.now() - startedAt,
      imageMs: Date.now() - imageStartedAt,
      provider: (imageResult as any)?.timings?.provider,
      detail: (imageResult as any)?.timings,
    },
  });
}

main().catch((error) => {
  printJson({ ok: false, error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
