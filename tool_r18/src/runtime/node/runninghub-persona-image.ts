import {
  createRunningHubAiAppTask,
  createRunningHubStandardModelTask,
  getRunningHubAiAppCallDemo,
  resolveRunningHubConfig,
  waitRunningHubOpenApiV2TaskOutputs,
  waitRunningHubTaskOutputs,
  type RunningHubNodeInfo,
} from "./runninghub-client";
import { readRuntimeApiConfig, type RuntimeConfigOptions } from "./config";
import { readFileSync } from "node:fs";

type RunningHubApiPrompt = Record<string, {
  class_type?: string;
  inputs?: Record<string, any>;
  _meta?: { title?: string };
}>;

type RunningHubImageResult = {
  ok: boolean;
  url?: string;
  outputs?: unknown;
  taskId?: string;
  error?: string;
  retryable?: boolean;
  reasonCode?: string;
};

const TEXT_INPUT_FIELDS = new Set(["text", "value", "prompt", "positive", "提示词文本", "user_prompt", "user_prompt_input"]);
const DEFAULT_IMAGE_WEBAPP_ID = "2034899011521482754";
const NEW_PERSONA_TEXT_TO_IMAGE_ENDPOINT = "/rhart-image-g-2/text-to-image";
const NEW_PERSONA_IMAGE_TO_IMAGE_ENDPOINT = "/rhart-image-g-2/image-to-image";

function parsePromptPayload(raw: any): RunningHubApiPrompt {
  const payload = raw?.data?.prompt ?? raw?.prompt ?? raw?.data ?? raw;
  if (typeof payload === "string") return JSON.parse(payload);
  if (payload && typeof payload === "object") return payload;
  return {};
}

function extractOutputUrl(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value) || /^data:image\//i.test(value)) return value;
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractOutputUrl(item);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value === "object") {
    const item: any = value;
    for (const key of ["fileUrl", "file_url", "url", "imageUrl", "image_url", "path"]) {
      const found = extractOutputUrl(item[key]);
      if (found) return found;
    }
    for (const child of Object.values(item)) {
      const found = extractOutputUrl(child);
      if (found) return found;
    }
  }
  return undefined;
}

function classifyRunningHubError(errorText: string): { retryable: boolean; reasonCode: string } {
  if (/API Key|TOKEN|auth|unauthor/i.test(errorText)) return { retryable: false, reasonCode: "auth_missing" };
  if (/1005|1017|service is upgrading|restarting|internal server error/i.test(errorText)) {
    return { retryable: true, reasonCode: "upstream_error" };
  }
  if (/timeout|超时|逾時/i.test(errorText)) return { retryable: true, reasonCode: "timeout" };
  if (/RunningHub 任务失败|fail|error/i.test(errorText)) return { retryable: true, reasonCode: "upstream_error" };
  return { retryable: false, reasonCode: "unknown" };
}

function directTextInputName(node: RunningHubApiPrompt[string]): string | null {
  const inputs = node.inputs || {};
  for (const field of TEXT_INPUT_FIELDS) {
    const value = inputs[field];
    if (typeof value === "string") return field;
  }
  return null;
}

function nodeTitle(node: RunningHubApiPrompt[string]): string {
  return `${node._meta?.title || ""} ${node.class_type || ""}`.trim();
}

function isNegativePromptText(value: unknown): boolean {
  return typeof value === "string" && /negative|worst|watermark|bad anatomy|extra digits|censor|ai-generated/i.test(value);
}

function buildRunningHubNodeInfoList(
  prompt: RunningHubApiPrompt,
  finalPrompt: string,
  aspectRatio?: string,
): RunningHubNodeInfo[] {
  const list: RunningHubNodeInfo[] = [];
  const directPromptNode = Object.entries(prompt).find(([, node]) => {
    const title = nodeTitle(node);
    if (/negative|負向|负向/i.test(title)) return false;
    const field = directTextInputName(node);
    if (!field || isNegativePromptText(node.inputs?.[field])) return false;
    return /PromptBatchQueue|PrimitiveString|Text Multiline|CR Prompt|promptLine/i.test(title)
      || (/CLIPTextEncode/i.test(title) && typeof node.inputs?.[field] === "string" && !isNegativePromptText(node.inputs[field]));
  });

  if (directPromptNode) {
    const [nodeId, node] = directPromptNode;
    const fieldName = directTextInputName(node);
    if (fieldName) {
      list.push({ nodeId, fieldName, fieldValue: finalPrompt, description: "persona prompt" });
    }
  }

  const latent = Object.entries(prompt).find(([, node]) => /Empty.*LatentImage/i.test(node.class_type || ""));
  if (latent) {
    const [nodeId] = latent;
    const size = imageSizeFromAspectRatio(aspectRatio);
    list.push(
      { nodeId, fieldName: "width", fieldValue: size.width, description: "image width" },
      { nodeId, fieldName: "height", fieldValue: size.height, description: "image height" },
      { nodeId, fieldName: "batch_size", fieldValue: 1, description: "batch size" },
    );
  }

  const sampler = Object.entries(prompt).find(([, node]) => /KSampler/i.test(node.class_type || ""));
  if (sampler) {
    list.push({
      nodeId: sampler[0],
      fieldName: "seed",
      fieldValue: Math.floor(Math.random() * 1_000_000_000_000_000),
      description: "random seed",
    });
  }

  return list;
}

function imageSizeFromAspectRatio(aspectRatio?: string): { width: number; height: number } {
  switch (aspectRatio) {
    case "8:15":
      return { width: 1024, height: 1920 };
    case "2:3":
      return { width: 1024, height: 1536 };
    case "4:5":
      return { width: 1024, height: 1280 };
    case "3:4":
      return { width: 1024, height: 1365 };
    case "9:16":
      return { width: 1024, height: 1820 };
    case "3:2":
      return { width: 1536, height: 1024 };
    case "4:3":
      return { width: 1365, height: 1024 };
    case "16:9":
      return { width: 1820, height: 1024 };
    case "5:4":
      return { width: 1280, height: 1024 };
    case "21:9":
      return { width: 1792, height: 768 };
    default:
      return { width: 1024, height: 1024 };
  }
}

function extractAiAppNodeInfoList(response: any): any[] {
  const list = response?.data?.nodeInfoList;
  return Array.isArray(list) ? list : [];
}

function isPromptLikeAiAppNode(node: any): boolean {
  const fieldName = String(node?.fieldName || "");
  const nodeName = String(node?.nodeName || "");
  const description = `${node?.description || ""} ${node?.descriptionEn || ""}`;
  if (!TEXT_INPUT_FIELDS.has(fieldName)) return false;
  if (/negative|負向|负向/i.test(`${nodeName} ${description}`)) return false;
  return /prompt|text|提示|文本|輸入|输入|CR Text/i.test(`${fieldName} ${nodeName} ${description}`);
}

function buildAiAppNodeInfoList(nodes: any[], prompt: string, aspectRatio?: string): RunningHubNodeInfo[] {
  const size = imageSizeFromAspectRatio(aspectRatio);
  let replacedPrompt = false;
  return nodes.map((node) => {
    const next: any = { ...node };
    if (String(next.fieldName) === "width") {
      next.fieldValue = size.width;
    } else if (String(next.fieldName) === "height") {
      next.fieldValue = size.height;
    } else if (!replacedPrompt && isPromptLikeAiAppNode(next)) {
      next.fieldValue = prompt;
      replacedPrompt = true;
    }
    return next;
  });
}

export async function generateRunningHubAiAppImage(
  params: {
    prompt: string;
    webappId?: string;
    aspectRatio?: string;
    timeoutMs?: number;
  },
  runtimeOptions: RuntimeConfigOptions = {},
): Promise<RunningHubImageResult> {
  const config = resolveRunningHubConfig(runtimeOptions);
  const webappId = params.webappId || config.imageWebappId || DEFAULT_IMAGE_WEBAPP_ID;
  try {
    const demo = await getRunningHubAiAppCallDemo(config, webappId);
    const nodes = extractAiAppNodeInfoList(demo);
    if (nodes.length === 0) {
      return { ok: false, error: `RunningHub AI 应用 ${webappId} 未返回 nodeInfoList`, retryable: false, reasonCode: "workflow_no_prompt_input" };
    }
    const nodeInfoList = buildAiAppNodeInfoList(nodes, params.prompt, params.aspectRatio);
    const hasPrompt = nodeInfoList.some((node: any) => isPromptLikeAiAppNode(node) && node.fieldValue === params.prompt);
    if (!hasPrompt) {
      return { ok: false, error: `RunningHub AI 应用 ${webappId} 未定位到可写入提示词的节点`, retryable: false, reasonCode: "workflow_no_prompt_input" };
    }
    const created = await createRunningHubAiAppTask(config, webappId, nodeInfoList);
    const taskId = String(created?.data?.taskId || created?.data?.task_id || created?.data || "");
    if (!taskId) throw new Error(`RunningHub AI 应用未返回 taskId：${JSON.stringify(created).slice(0, 500)}`);
    const outputs = await waitRunningHubTaskOutputs(config, taskId, params.timeoutMs || 300_000, 5000);
    const url = extractOutputUrl(outputs);
    if (!url) {
      return { ok: false, taskId, outputs, error: `RunningHub AI 应用任务完成但未返回图片 URL：${JSON.stringify(outputs).slice(0, 500)}`, retryable: true, reasonCode: "output_missing" };
    }
    return { ok: true, taskId, outputs, url };
  } catch (error: any) {
    const message = error?.message || String(error);
    return { ok: false, error: message, ...classifyRunningHubError(message) };
  }
}

const RUNNINGHUB_STANDARD_ASPECT_RATIOS = new Set(["1:1", "2:3", "3:2", "4:5", "5:4", "9:16", "16:9", "3:4", "4:3", "21:9"]);

function normalizeRunningHubAspectRatio(aspectRatio?: string): string {
  const value = String(aspectRatio || "").trim();
  if (!value) return "1:1";
  if (RUNNINGHUB_STANDARD_ASPECT_RATIOS.has(value)) {
    return value;
  }
  return "";
}

function buildImageUrlInput(source?: string, mimeType?: string): string | undefined {
  const value = String(source || "").trim();
  if (!value) return undefined;
  if (/^https?:\/\//i.test(value) || /^data:image\//i.test(value)) return value;
  const type = String(mimeType || "image/jpeg").trim() || "image/jpeg";
  try {
    return `data:${type};base64,${readFileSync(value).toString("base64")}`;
  } catch {
    // Keep accepting raw base64 for callers that already provide encoded data.
  }
  return `data:${type};base64,${value}`;
}

export async function generateRunningHubNewPersonaStandardImage(
  params: {
    prompt: string;
    mode: "text-to-image" | "image-to-image";
    aspectRatio?: string;
    referenceImage?: string;
    referenceImageMimeType?: string;
    timeoutMs?: number;
  },
  runtimeOptions: RuntimeConfigOptions = {},
): Promise<RunningHubImageResult> {
  const config = resolveRunningHubConfig(runtimeOptions);
  const runtime = readRuntimeApiConfig(runtimeOptions);
  const endpointPath = params.mode === "image-to-image"
    ? (runtime.newPersonaRunningHubTweetImageToImageEndpoint || NEW_PERSONA_IMAGE_TO_IMAGE_ENDPOINT)
    : (runtime.newPersonaRunningHubPersonaTextToImageEndpoint || NEW_PERSONA_TEXT_TO_IMAGE_ENDPOINT);
  const aspectRatio = normalizeRunningHubAspectRatio(params.aspectRatio);
  if (!aspectRatio) {
    return {
      ok: false,
      error: `RunningHub OpenAPI v2 不支持畫面比例：${String(params.aspectRatio || "").trim()}`,
      retryable: false,
      reasonCode: "aspect_ratio_unsupported",
    };
  }
  const size = imageSizeFromAspectRatio(aspectRatio);
  const payload: Record<string, unknown> = {
    prompt: params.prompt,
    aspectRatio,
    imageAspectRatio: aspectRatio,
    width: size.width,
    height: size.height,
    resolution: "1k",
  };
  if (params.mode === "image-to-image") {
    const imageUrl = buildImageUrlInput(params.referenceImage, params.referenceImageMimeType);
    if (!imageUrl) {
      return { ok: false, error: "缺少图生图参考图", retryable: false, reasonCode: "reference_missing" };
    }
    payload.imageUrls = [imageUrl];
  }

  try {
    const created = await createRunningHubStandardModelTask(config, endpointPath, payload);
    const taskId = String(created?.taskId || created?.data?.taskId || created?.data?.task_id || created?.data || "");
    if (!taskId) throw new Error(`RunningHub OpenAPI v2 未返回 taskId：${JSON.stringify(created).slice(0, 500)}`);
    const outputs = await waitRunningHubOpenApiV2TaskOutputs(config, taskId, params.timeoutMs || 300_000, 5000);
    const url = extractOutputUrl(outputs);
    if (!url) {
      return { ok: false, taskId, outputs, error: `RunningHub OpenAPI v2 任务完成但未返回图片 URL：${JSON.stringify(outputs).slice(0, 500)}`, retryable: true, reasonCode: "output_missing" };
    }
    return { ok: true, taskId, outputs, url };
  } catch (error: any) {
    const message = error?.message || String(error);
    return { ok: false, error: message, ...classifyRunningHubError(message) };
  }
}
