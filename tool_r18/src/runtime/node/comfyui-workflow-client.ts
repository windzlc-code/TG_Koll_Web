import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  createRunningHubTask,
  getRunningHubWorkflowJson,
  resolveRunningHubConfig,
  waitRunningHubTaskOutputs,
  type RunningHubNodeInfo,
} from "@/runtime/node/runninghub-client";
import { readRuntimeApiConfig, type RuntimeConfigOptions } from "@/runtime/node/config";
import { resolveRuntimeFile } from "@/runtime/node/data-dir";

export type PersonaWorkflowImageConfig = {
  provider?: "comfyui";
  executionProvider?: "runninghub" | "comfyui";
  workflowFile: string;
  workflowId?: string;
  workflowGroup?: string;
  personaKey?: string;
  promptSuffix?: string;
  originalPromptMode?: "dynamic" | "filtered-original";
  visualAnchorNodeId?: number;
  visualAnchorAddendum?: string;
};

type ComfyWorkflowNode = {
  id: number;
  type: string;
  title?: string;
  widgets_values?: any[];
  inputs?: any[];
  outputs?: any[];
  pos?: [number, number];
  size?: [number, number];
};

type ComfyWorkflowSubgraphDefinition = {
  id?: string;
  name?: string;
  nodes?: ComfyWorkflowNode[];
};

type ComfyWorkflowGroup = {
  title?: string;
  bounding?: [number, number, number, number];
};

type ComfyWorkflow = {
  nodes?: ComfyWorkflowNode[];
  links?: any[];
  groups?: ComfyWorkflowGroup[];
  definitions?: {
    subgraphs?: ComfyWorkflowSubgraphDefinition[];
  };
};

export interface WorkflowRuntimeConfig extends RuntimeConfigOptions {
  jupyterBase?: string;
  comfyBase?: string;
  workflowToken?: string;
  workflowLocalDir?: string;
  workflowAuthHeader?: string;
  workflowAuthValue?: string;
  workflowGatewayToken?: string;
}

const WORKFLOW_JUPYTER_BASE = process.env.PERSONA_WORKFLOW_JUPYTER_BASE || "https://ahzx2c9qlzkosi-8888.proxy.runpod.net";
const WORKFLOW_COMFY_BASE = process.env.PERSONA_WORKFLOW_COMFY_BASE || "https://ahzx2c9qlzkosi-8188.proxy.runpod.net";
const WORKFLOW_JUPYTER_TOKEN = process.env.PERSONA_WORKFLOW_TOKEN || "";
const WORKFLOW_LOCAL_DIR = process.env.PERSONA_WORKFLOW_LOCAL_DIR || (process.platform === "win32" ? "C:\\Users\\14471\\Downloads\\数字人" : "");
const WORKFLOW_NEGATIVE_PROMPT = "ai-generated, worst detail, sketch, monochrome, extra digits, watermark, logo, text, readable text, bad anatomy, malformed hands, cropped face, cut off head, face out of frame, hidden eyes, hidden mouth, phone covering face, book covering face, cup covering face, hand covering face, ((hands covering mouth:1.8)), ((hands touching lips:1.8)), ((hands touching cheek:2.0)), ((hand on cheek:2.0)), ((palm on cheek:2.0)), ((hand near cheek:1.9)), ((hands near mouth:1.8)), ((hands near face:1.9)), ((raised hand near face:1.8)), ((prayer hands near face:1.7)), shushing gesture, blowing kiss gesture, face-touching pose, prop covering face, mouth-only crop, extreme close-up, tight bust portrait, face-filling selfie, see-through clothing, transparent top, wet clothing, pulling shirt, pulling neckline, cleavage focus, nsfw";
const WORKFLOW_IMAGE_OUTPUT_PATTERN = /SaveImage|SaveImagePlus|ImageBatchSave|PreviewImage/i;
const WORKFLOW_TEXT_OUTPUT_PATTERN = /Text File/i;

type ImageGenerateResult = {
  ok: boolean;
  url?: string;
  error?: string;
  retryable?: boolean;
  reasonCode?: string;
  attempts?: number;
  timings?: unknown;
};

type ImageAspectRatio = "1:1" | "4:5" | "3:4" | "9:16" | "4:3" | "16:9";
type RunningHubApiPrompt = Record<string, { class_type?: string; inputs?: Record<string, any> }>;

const IMAGE_ASPECT_RATIOS = new Set<ImageAspectRatio>(["1:1", "4:5", "3:4", "9:16", "4:3", "16:9"]);
const DEFAULT_IMAGE_ASPECT_RATIO: ImageAspectRatio = "1:1";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createAbortTimeout(timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  };
}

function normalizeImageAspectRatio(value: unknown): ImageAspectRatio {
  return typeof value === "string" && IMAGE_ASPECT_RATIOS.has(value as ImageAspectRatio)
    ? (value as ImageAspectRatio)
    : DEFAULT_IMAGE_ASPECT_RATIO;
}

function getWorkflowImageSize(aspectRatio: ImageAspectRatio): { width: number; height: number } {
  switch (aspectRatio) {
    case "4:5":
      return { width: 1024, height: 1280 };
    case "3:4":
      return { width: 960, height: 1280 };
    case "9:16":
      return { width: 832, height: 1472 };
    case "4:3":
      return { width: 1280, height: 960 };
    case "16:9":
      return { width: 1472, height: 832 };
    default:
      return { width: 1024, height: 1024 };
  }
}

function parseRunningHubApiPrompt(response: any): RunningHubApiPrompt {
  const raw = response?.data?.prompt ?? response?.prompt ?? response?.data ?? response;
  if (typeof raw === "string") return JSON.parse(raw);
  if (raw?.prompt && typeof raw.prompt === "string") return JSON.parse(raw.prompt);
  return raw || {};
}

function getRunningHubImageOutputNodes(apiPrompt: RunningHubApiPrompt): string[] {
  return Object.entries(apiPrompt)
    .filter(([, node]) => /SaveImage|SaveImagePlus|ImageBatchSave|PreviewImage/i.test(String(node?.class_type || "")))
    .map(([nodeId]) => nodeId);
}

function findRunningHubPositivePromptNode(apiPrompt: RunningHubApiPrompt): { nodeId: string; fieldName: string } | null {
  for (const [, node] of Object.entries(apiPrompt)) {
    if (!/KSampler/i.test(String(node?.class_type || ""))) continue;
    const positive = node.inputs?.positive;
    const positiveNodeId = Array.isArray(positive) ? String(positive[0] || "") : "";
    const positiveNode = positiveNodeId ? apiPrompt[positiveNodeId] : undefined;
    if (positiveNode?.class_type === "CLIPTextEncode") {
      return { nodeId: positiveNodeId, fieldName: "text" };
    }
  }

  for (const [nodeId, node] of Object.entries(apiPrompt)) {
    if (node?.class_type === "PromptBatchQueue" && "提示词文本" in (node.inputs || {})) {
      return { nodeId, fieldName: "提示词文本" };
    }
  }

  for (const [nodeId, node] of Object.entries(apiPrompt)) {
    if (node?.class_type !== "CLIPTextEncode") continue;
    const text = node.inputs?.text;
    if (typeof text === "string" && /negative|watermark|bad anatomy|worst detail|sketch/i.test(text)) continue;
    return { nodeId, fieldName: "text" };
  }

  for (const [nodeId, node] of Object.entries(apiPrompt)) {
    const inputs = node.inputs || {};
    if ("prompt" in inputs) return { nodeId, fieldName: "prompt" };
    if ("text" in inputs) return { nodeId, fieldName: "text" };
    if ("value" in inputs && /String|Text|Prompt/i.test(String(node.class_type || ""))) return { nodeId, fieldName: "value" };
  }

  return null;
}

function buildRunningHubNodeInfoList(apiPrompt: RunningHubApiPrompt, prompt: string, aspectRatio?: string): RunningHubNodeInfo[] {
  const nodeInfoList: RunningHubNodeInfo[] = [];
  const promptNode = findRunningHubPositivePromptNode(apiPrompt);
  if (promptNode) {
    nodeInfoList.push({
      nodeId: promptNode.nodeId,
      fieldName: promptNode.fieldName,
      fieldValue: prompt,
      description: "自动化推文人设生图提示词",
    });
  }

  for (const [nodeId, node] of Object.entries(apiPrompt)) {
    if (/KSampler/i.test(String(node.class_type || "")) && "seed" in (node.inputs || {})) {
      nodeInfoList.push({
        nodeId,
        fieldName: "seed",
        fieldValue: randomWorkflowSeed(),
        description: "随机种子",
      });
    }
    if (/Empty.*LatentImage/i.test(String(node.class_type || ""))) {
      const size = getWorkflowImageSize(normalizeImageAspectRatio(aspectRatio));
      nodeInfoList.push({ nodeId, fieldName: "width", fieldValue: size.width, description: "输出宽度" });
      nodeInfoList.push({ nodeId, fieldName: "height", fieldValue: size.height, description: "输出高度" });
      if ("batch_size" in (node.inputs || {})) {
        nodeInfoList.push({ nodeId, fieldName: "batch_size", fieldValue: 1, description: "输出张数" });
      }
    }
  }

  return nodeInfoList;
}

function findFirstRunningHubImageUrl(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") {
    const dataUrl = value.match(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/);
    if (dataUrl) return dataUrl[0];
    const url = value.match(/https?:\/\/[^\s"'<>]+?\.(?:png|jpe?g|webp|gif)(?:\?[^\s"'<>]*)?/i);
    if (url) return url[0];
    if (/^https?:\/\//i.test(value) && /image|output|file|rh-images|xiaoyaoyou/i.test(value)) return value;
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstRunningHubImageUrl(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of ["fileUrl", "url", "imageUrl", "file", "path", "value"]) {
      const found = findFirstRunningHubImageUrl(obj[key]);
      if (found) return found;
    }
    for (const item of Object.values(obj)) {
      const found = findFirstRunningHubImageUrl(item);
      if (found) return found;
    }
  }
  return null;
}

async function generateRunningHubPersonaImage(params: {
  prompt: string;
  workflowImage: PersonaWorkflowImageConfig;
  aspectRatio?: string;
  timeoutMs?: number;
}): Promise<ImageGenerateResult> {
  const startedAt = Date.now();
  const workflowId = params.workflowImage.workflowId;
  if (!workflowId) return { ok: false, error: "缺少 RunningHub workflowId", retryable: false, reasonCode: "auth_missing" };
  const config = resolveRunningHubConfig();
  const timings: Record<string, unknown> = { provider: "runninghub-workflow" };
  try {
    const promptStartedAt = Date.now();
    const localWorkflow = loadLocalPersonaWorkflow(params.workflowImage, undefined, { includeRunningHubMapped: true });
    const apiPrompt = localWorkflow
      ? buildWorkflowPrompt(localWorkflow, params.workflowImage, params.prompt, params.aspectRatio)
      : parseRunningHubApiPrompt(await getRunningHubWorkflowJson(config, workflowId));
    timings.workflowSource = localWorkflow ? "local" : "runninghub";
    timings.preparePromptMs = Date.now() - promptStartedAt;
    const malformedNodes = Object.entries(apiPrompt)
      .filter(([, node]) => !node?.class_type)
      .map(([nodeId]) => nodeId);
    if (malformedNodes.length > 0) {
      return {
        ok: false,
        error: `RunningHub 工作流 ${workflowId} 的 API prompt 存在缺失 class_type 的节点：${malformedNodes.slice(0, 8).join(", ")}`,
        retryable: false,
        reasonCode: "workflow_malformed_api_prompt",
      };
    }

    const outputNodeIds = getRunningHubImageOutputNodes(apiPrompt);
    if (outputNodeIds.length === 0) {
      return {
        ok: false,
        error: `RunningHub 工作流 ${workflowId} 未检测到图片输出节点，请确认该工作流导出的 API prompt 包含 SaveImage/PreviewImage 节点`,
        retryable: false,
        reasonCode: "workflow_no_image_output",
      };
    }

    const hasPromptInput = Object.values(apiPrompt).some((node) => {
      const inputs = node.inputs || {};
      return typeof inputs.text === "string"
        || typeof inputs.prompt === "string"
        || typeof inputs["提示词文本"] === "string"
        || typeof inputs.value === "string";
    });
    if (!hasPromptInput) {
      return {
        ok: false,
        error: `RunningHub 工作流 ${workflowId} 未定位到可写入提示词的节点`,
        retryable: false,
        reasonCode: "workflow_no_prompt_input",
      };
    }

    const createStartedAt = Date.now();
    const created = localWorkflow
      ? await createRunningHubTask(config, [], workflowId, JSON.stringify(apiPrompt))
      : await createRunningHubTask(config, buildRunningHubNodeInfoList(apiPrompt, params.prompt, params.aspectRatio), workflowId);
    timings.createTaskMs = Date.now() - createStartedAt;
    const taskId = created?.data?.taskId || created?.taskId;
    if (!taskId) {
      return {
        ok: false,
        error: `RunningHub 未返回 taskId：${JSON.stringify(created).slice(0, 500)}`,
        retryable: true,
        reasonCode: "upstream_error",
      };
    }

    const waitStartedAt = Date.now();
    const outputs = await waitRunningHubTaskOutputs(config, String(taskId), params.timeoutMs || 300_000, 5000);
    timings.waitOutputsMs = Date.now() - waitStartedAt;
    const imageUrl = findFirstRunningHubImageUrl(outputs);
    if (!imageUrl) {
      return {
        ok: false,
        error: `RunningHub 任务完成但未找到图片输出：${JSON.stringify(outputs).slice(0, 500)}`,
        retryable: true,
        reasonCode: "upstream_error",
      };
    }
    timings.elapsedMs = Date.now() - startedAt;
    return { ok: true, url: imageUrl, timings } as ImageGenerateResult;
  } catch (error: any) {
    const message = error?.message || String(error);
    const classified = classifyImageGenerateError(message);
    timings.elapsedMs = Date.now() - startedAt;
    return { ok: false, error: message, ...classified, timings } as ImageGenerateResult;
  }
}

function classifyImageGenerateError(errorText: string): { retryable: boolean; reasonCode: string } {
  const text = String(errorText || "");
  if (/model_not_found|無可用渠道|无可用渠道|no available distributor/i.test(text)) {
    return { retryable: false, reasonCode: "model_unavailable" };
  }
  if (/未設定 API Key|API Key/i.test(text)) {
    return { retryable: false, reasonCode: "auth_missing" };
  }
  if (/安全策略攔截|版權引用限制|SAFETY|RECITATION/i.test(text)) {
    return { retryable: false, reasonCode: "policy_blocked" };
  }
  if (/API 返回 4\d\d/i.test(text) && !/429/.test(text)) {
    return { retryable: false, reasonCode: "client_error" };
  }
  if (/timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|fetch failed|network/i.test(text)) {
    return { retryable: true, reasonCode: "network_error" };
  }
  if (/API 返回 5\d\d|API 返回 429|未返回圖片|未返回图片|響應結構未識別|响应结构未识别|MAX_TOKENS|OTHER/i.test(text)) {
    return { retryable: true, reasonCode: "upstream_error" };
  }
  return { retryable: false, reasonCode: "unknown" };
}

function normalizeWorkflowInputs(node: ComfyWorkflowNode | undefined): any[] {
  return Array.isArray(node?.inputs) ? node.inputs : [];
}

function normalizeWorkflowWidgets(node: ComfyWorkflowNode): any[] {
  return Array.isArray(node.widgets_values) ? node.widgets_values : [];
}

function normalizeWorkflowGroupName(name: string): string {
  return String(name || "").trim().toLowerCase();
}

function workflowNodeInGroup(node: ComfyWorkflowNode, group: ComfyWorkflowGroup): boolean {
  if (!Array.isArray(node.pos) || !Array.isArray(group.bounding)) return false;
  const [x, y] = node.pos;
  const [gx, gy, gw, gh] = group.bounding;
  return x >= gx && x <= gx + gw && y >= gy && y <= gy + gh;
}

function chooseWorkflowImageGroup(workflow: ComfyWorkflow, preferred?: string): ComfyWorkflowGroup | null {
  const groups = Array.isArray(workflow.groups) ? workflow.groups : [];
  if (groups.length === 0) return null;
  const wanted = normalizeWorkflowGroupName(preferred || "");
  if (wanted) {
    const exact = groups.find((group) => normalizeWorkflowGroupName(group.title || "") === wanted);
    if (exact) return exact;
    const fuzzy = groups.find((group) => normalizeWorkflowGroupName(group.title || "").includes(wanted));
    if (fuzzy) return fuzzy;
  }
  return groups.find((group) => /批量文生图|文生图|texttoimage|txt2img/i.test(normalizeWorkflowGroupName(group.title || "")))
    || groups.find((group) => /图片推帖子|圖文|image/i.test(normalizeWorkflowGroupName(group.title || "")))
    || groups[0];
}

function findWorkflowLink(workflow: ComfyWorkflow, linkId: number): any[] | undefined {
  return (workflow.links || []).find((link) => Array.isArray(link) && link[0] === linkId);
}

function getWorkflowInputByLink(workflow: ComfyWorkflow, node: ComfyWorkflowNode | undefined, linkId: number): any | undefined {
  return normalizeWorkflowInputs(node).find((input) => input?.link === linkId);
}

function shouldIgnoreWorkflowEdge(target: ComfyWorkflowNode, input: any): boolean {
  const name = String(input?.name || "");
  if (/SaveImagePlus|ImageBatchSave/i.test(target.type) && /filename|custom_path|path|prefix/i.test(name)) return true;
  if (target.type === "CLIPTextEncode" && name === "text") return true;
  if (target.type === "PromptBatchQueue" && /提示词|prompt|text/i.test(name)) return true;
  return false;
}

function findWorkflowOutputNodes(nodes: ComfyWorkflowNode[]): ComfyWorkflowNode[] {
  const outputs = nodes.filter((node) => WORKFLOW_IMAGE_OUTPUT_PATTERN.test(node.type) && !WORKFLOW_TEXT_OUTPUT_PATTERN.test(node.type));
  const preferred = outputs.filter((node) => /SaveImagePlus|PreviewImage|^SaveImage$/i.test(node.type) && !/ImageBatchSave/i.test(node.type));
  return preferred.length > 0 ? preferred : outputs;
}

function collectWorkflowAncestors(workflow: ComfyWorkflow, startIds: number[], allowedIds: Set<number>): Set<number> {
  const selected = new Set<number>();
  const nodes = workflow.nodes || [];
  const visit = (id: number) => {
    if (selected.has(id) || !allowedIds.has(id)) return;
    const node = nodes.find((item) => item.id === id);
    if (!node) return;
    selected.add(id);
    for (const input of normalizeWorkflowInputs(node)) {
      if (!input?.link || shouldIgnoreWorkflowEdge(node, input)) continue;
      const link = findWorkflowLink(workflow, input.link);
      if (link) visit(Number(link[1]));
    }
  };
  for (const id of startIds) visit(id);
  return selected;
}

function isPositiveClipTextNode(workflow: ComfyWorkflow, node: ComfyWorkflowNode): boolean {
  if (node.type !== "CLIPTextEncode") return false;
  const nodes = workflow.nodes || [];
  return (workflow.links || []).some((link) => {
    if (!Array.isArray(link) || link[1] !== node.id) return false;
    const target = nodes.find((item) => item.id === link[3]);
    return target?.type === "KSampler" && getWorkflowInputByLink(workflow, target, link[0])?.name === "positive";
  });
}

function getWorkflowWidgetValue(node: ComfyWorkflowNode, inputName: string, fallbackIndex: number): any {
  const values = normalizeWorkflowWidgets(node);
  if (node.type === "KSampler") {
    const map: Record<string, any> = {
      seed: values[0],
      steps: values[2],
      cfg: values[3],
      sampler_name: values[4],
      scheduler: values[5],
      denoise: values[6],
    };
    if (Object.prototype.hasOwnProperty.call(map, inputName)) return map[inputName];
  }
  return values[fallbackIndex];
}

function sanitizeWorkflowInputValue(value: any): any {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    const sanitized = value.map((item) => sanitizeWorkflowInputValue(item));
    return sanitized.some((item) => item === undefined) ? undefined : sanitized;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value)
      .map(([key, item]) => [key, sanitizeWorkflowInputValue(item)] as const)
      .filter(([, item]) => item !== undefined);
    return Object.fromEntries(entries);
  }
  return value;
}

function sanitizeWorkflowInputs(inputs: Record<string, any>): Record<string, any> {
  return Object.fromEntries(
    Object.entries(inputs)
      .map(([key, value]) => [key, sanitizeWorkflowInputValue(value)] as const)
      .filter(([, value]) => value !== undefined),
  );
}

function normalizeComfyModelSelectorValue(inputName: string, value: any): any {
  if (typeof value !== "string") return value;
  if (!/lora_name|ckpt_name|vae_name|control_net_name|model_name/i.test(inputName)) return value;
  return mapRunningHubLoraNameToLocalComfy(value).replace(/\//g, "\\");
}

let _runningHubLoraReverseMap: Map<string, string> | null = null;

function loadRunningHubLoraReverseMap(): Map<string, string> {
  if (_runningHubLoraReverseMap) return _runningHubLoraReverseMap;
  const map = new Map<string, string>();
  const candidates = [
    resolveRuntimeFile("runninghub-lora-map.json"),
    path.resolve(process.cwd(), ".runtime", "automatic-script", "runninghub-lora-map.json"),
  ];
  for (const filePath of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const entries = Object.values<any>(parsed?.byPersonaKey || {});
      for (const entry of entries) {
        const runningHubFile = String(entry?.fileName || "").trim();
        const localName = String(entry?.name || "").trim();
        if (!runningHubFile || !localName) continue;
        const personaKey = String(entry?.personaKey || "").trim();
        let localComfyName = localName;
        if (personaKey === "hip_slider" || personaKey === "breast_slider" || personaKey === "detail_daemon") {
          localComfyName = `ZIT\\${localName}`;
        } else if (!["cute_jp", "yoga", "aunt50"].includes(personaKey)) {
          localComfyName = `人设\\${localName}`;
        }
        map.set(runningHubFile.replace(/\//g, "\\").toLowerCase(), localComfyName);
      }
      break;
    } catch {
      // Best effort only. If the map is absent, keep the original selector value.
    }
  }
  _runningHubLoraReverseMap = map;
  return map;
}

function mapRunningHubLoraNameToLocalComfy(value: string): string {
  const normalized = value.replace(/\//g, "\\");
  if (!/^api-lora-cn\\/i.test(normalized)) return value;
  return loadRunningHubLoraReverseMap().get(normalized.toLowerCase()) || value;
}

function isWorkflowNegativeConditioningPlaceholder(node: ComfyWorkflowNode): boolean {
  return node.type === "e7b9c3fe-fcf5-4674-8984-5b474e4716d0";
}

function getWorkflowSubgraphDefinition(workflow: ComfyWorkflow, nodeType: string): ComfyWorkflowSubgraphDefinition | undefined {
  const definitions = workflow.definitions?.subgraphs;
  if (!Array.isArray(definitions)) return undefined;
  return definitions.find((definition) => definition?.id === nodeType);
}

function getWorkflowSingleNodeSubgraph(workflow: ComfyWorkflow, node: ComfyWorkflowNode): ComfyWorkflowNode | null {
  const definition = getWorkflowSubgraphDefinition(workflow, node.type);
  if (!definition || !Array.isArray(definition.nodes) || definition.nodes.length !== 1) return null;
  return definition.nodes[0];
}

function isWorkflowNegativeSubgraph(workflow: ComfyWorkflow, node: ComfyWorkflowNode, innerNode?: ComfyWorkflowNode | null): boolean {
  const definition = getWorkflowSubgraphDefinition(workflow, node.type);
  const joined = [node.title, definition?.name, innerNode?.title, innerNode?.type].filter(Boolean).join(" ");
  return /负向|負向|negative/i.test(joined);
}

const WORKFLOW_FIXED_SCENE_ANCHOR_PATTERN = /圣诞|聖誕|红色围巾|紅色圍巾|红围巾|紅圍巾|围巾|圍巾|户外街景|戶外街景|店铺|店鋪|木质外立面|木質外立面|玻璃橱窗|玻璃櫥窗|花环|花環|蝴蝶结|蝴蝶結|装饰球|裝飾球|圣诞树|聖誕樹|背景是|背景略|整体色调|整體色調|冬日|节日|節日/i;
const WORKFLOW_OPTIONAL_STYLE_ANCHOR_PATTERNS: RegExp[] = [
  /wearing a fluffy white bunny-ear headband[,]?/gi,
  /white fluffy bunny-ear headband(?: as a top accessory only)?[,]?/gi,
  /bunny ears visible at the top of the frame[,]?/gi,
  /not tied twin ponytails[,]?/gi,
  /plain(?:,?\s*softly lit)? wall[,]?/gi,
  /plain indoor curtain or wall background[,]?/gi,
  /harsh direct flash selfie[,]?/gi,
  /harsh direct flash[,]?/gi,
  /harsh flash[,]?/gi,
  /direct flash[,]?/gi,
  /flash source[,]?/gi,
  /with a faint glow from a flash source\.?/gi,
];
const WORKFLOW_FIXED_POSE_ANCHOR_PATTERNS: RegExp[] = [
  /偏近景的人物照片[^。.!！\n]*(?:。|\.|!|！)?/gi,
  /偏近景的人物照[^。.!！\n]*(?:。|\.|!|！)?/gi,
  /close[- ]?up (?:portrait|photo|shot)[^。.!！\n]*(?:。|\.|!|！)?/gi,
  /near[- ]?field (?:portrait|photo|shot)[^。.!！\n]*(?:。|\.|!|！)?/gi,
  /人物上半身入镜[^。.!！\n]*(?:。|\.|!|！)?/gi,
  /人物上半身入鏡[^。.!！\n]*(?:。|\.|!|！)?/gi,
  /主体位于画面[^。.!！\n]*(?:。|\.|!|！)?/gi,
  /主體位於畫面[^。.!！\n]*(?:。|\.|!|！)?/gi,
  /身体微微向前倾斜[^。.!！\n]*(?:。|\.|!|！)?/gi,
  /身體微微向前傾斜[^。.!！\n]*(?:。|\.|!|！)?/gi,
  /头部轻轻歪向一侧[^。.!！\n]*(?:。|\.|!|！)?/gi,
  /頭部輕輕歪向一側[^。.!！\n]*(?:。|\.|!|！)?/gi,
  /双手同时举到脸旁[^。.!！\n]*(?:。|\.|!|！)?/gi,
  /雙手同時舉到臉旁[^。.!！\n]*(?:。|\.|!|！)?/gi,
  /一只手贴近脸颊[^。.!！\n]*(?:。|\.|!|！)?/gi,
  /一隻手貼近臉頰[^。.!！\n]*(?:。|\.|!|！)?/gi,
  /另一只手托在下巴下方[^。.!！\n]*(?:。|\.|!|！)?/gi,
  /另一隻手托在下巴下方[^。.!！\n]*(?:。|\.|!|！)?/gi,
  /托脸\+比心式展开[^。.!！\n]*(?:。|\.|!|！)?/gi,
  /托臉\+比心式展開[^。.!！\n]*(?:。|\.|!|！)?/gi,
  /hands? (?:near|beside|touching) (?:the )?(?:face|mouth|cheeks?)[^。.!！\n]*(?:。|\.|!|！)?/gi,
];
const WORKFLOW_TRIGGER_WORD_PATTERN = /\boh[wm]x\s*,\s*/gi;

function isMediumLongCompositionPrompt(prompt: string): boolean {
  return /medium[- ]?long|full[- ]?body|head to knees|3 to 5 meters|中遠景|中远景|遠景|远景|路人視角|路人视角|第三人稱|第三人称|street photography/i.test(prompt);
}

function applyMediumLongLoraRelaxation(inputs: Record<string, any>, enabled: boolean) {
  if (!enabled) return;
  const loraName = String(inputs.lora_name || "");
  const currentModelStrength = Number(inputs.strength_model);
  if (!Number.isFinite(currentModelStrength) || currentModelStrength <= 0) return;

  if (/hip|breast|slider|臀|胸|Z-Hip|Z-Breast/i.test(loraName)) {
    inputs.strength_model = Math.min(currentModelStrength, 0.2);
    const currentClipStrength = Number(inputs.strength_clip);
    if (Number.isFinite(currentClipStrength) && currentClipStrength > 0) {
      inputs.strength_clip = Math.min(currentClipStrength, 0.5);
    }
    return;
  }

  if (!/lightning|multiangles|control|fdpo/i.test(loraName)) {
    inputs.strength_model = Math.min(currentModelStrength, 0.65);
  }
}

function normalizeWorkflowPromptText(text: string): string {
  return text.replace(/\r/g, "").replace(/[ \t]+/g, " ").trim();
}

function stripWorkflowFixedSceneAnchor(defaultText: string): string {
  let normalized = normalizeWorkflowPromptText(defaultText);
  for (const pattern of WORKFLOW_OPTIONAL_STYLE_ANCHOR_PATTERNS) {
    normalized = normalized.replace(pattern, "");
  }
  for (const pattern of WORKFLOW_FIXED_POSE_ANCHOR_PATTERNS) {
    normalized = normalized.replace(pattern, "");
  }
  normalized = normalized.replace(/[ \t]*,[ \t]*,+/g, ", ").replace(/[ \t]{2,}/g, " ").trim();
  if (!normalized) return "";
  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => !WORKFLOW_FIXED_SCENE_ANCHOR_PATTERN.test(item));
  const anchored = paragraphs.join("\n\n").trim();
  return anchored.length > 1000 ? `${anchored.slice(0, 1000).trim()}...` : anchored;
}

function hasWorkflowTriggerWord(text: string): boolean {
  return /\boh[wm]x\s*,/i.test(text);
}

export function mergeWorkflowPositivePromptWithVisualAnchor(defaultText: string, dynamicPrompt: string): string {
  const visualAnchor = stripWorkflowFixedSceneAnchor(defaultText);
  if (!visualAnchor) return dynamicPrompt;
  const dynamic = hasWorkflowTriggerWord(visualAnchor)
    ? dynamicPrompt.replace(WORKFLOW_TRIGGER_WORD_PATTERN, "").trim()
    : dynamicPrompt.trim();
  return [
    visualAnchor,
    dynamic ? `在不改变上述人物身份、脸部轮廓、拍摄质感和原工作流风格的前提下，本次发文场景参考：${dynamic}` : "",
  ].filter(Boolean).join("\n\n");
}

export function buildFilteredOriginalWorkflowPrompt(defaultText: string, dynamicPrompt: string): string {
  const visualAnchor = stripWorkflowFixedSceneAnchor(normalizeWorkflowVisualAnchorText(defaultText));
  if (!visualAnchor) return dynamicPrompt;
  const dynamic = dynamicPrompt
    .replace(WORKFLOW_TRIGGER_WORD_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim();
  const sceneHint = dynamic
    .replace(/persona-card visual direction:[^,，。]+[,，。]?/gi, "")
    .replace(/A realistic daily social media photo of [^,，。]+[,，。]?/gi, "")
    .replace(/clear same-person identity[,，。]?/gi, "")
    .replace(/composition aspect ratio [^,，。]+[,，。]?/gi, "")
    .replace(/no watermark[^,，。]*[,，。]?/gi, "")
    .trim()
    .slice(0, 220);
  const compositionOverride = extractWorkflowCompositionGuidance(dynamicPrompt);
  const optionalStyleOverride = extractWorkflowOptionalStyleGuidance(dynamicPrompt);
  return [
    visualAnchor,
    compositionOverride ? `构图硬约束：${compositionOverride}。如果原工作流提示词里有 close-up、selfie、headshot 或贴脸自拍构图，以这里的构图硬约束为准。` : "",
    optionalStyleOverride ? `本次文案明确要求的可选风格：${optionalStyleOverride}。该风格本次需要出现；未要求时不要默认出现。` : "",
    sceneHint ? `本次只轻微替换固定场景为：${sceneHint}` : "",
  ].filter(Boolean).join("\n\n");
}

function extractWorkflowCompositionGuidance(prompt: string): string {
  const match = String(prompt || "").match(/composition guidance:\s*([^。]+?)(?=,\s*(?:oh[wm]x\b|keep the original|persona-card|no watermark|$))/i);
  if (!match?.[1]) return "";
  return match[1]
    .replace(/\s+/g, " ")
    .replace(/,\s*/g, "；")
    .trim()
    .slice(0, 360);
}

function extractWorkflowOptionalStyleGuidance(prompt: string): string {
  const matches = [...String(prompt || "").matchAll(/optional style requested by post:\s*([^,，。]+)/gi)]
    .map((match) => match[1]?.trim())
    .filter(Boolean);
  return matches.join("; ").slice(0, 240);
}

function getWorkflowNodeDefaultText(node: ComfyWorkflowNode, subgraphNode?: ComfyWorkflowNode | null): string {
  const nodeWidgets = normalizeWorkflowWidgets(node);
  const ownText = typeof nodeWidgets[0] === "string" ? nodeWidgets[0] : "";
  if (ownText.trim()) return ownText;
  const subgraphWidgets = subgraphNode ? normalizeWorkflowWidgets(subgraphNode) : [];
  return typeof subgraphWidgets[0] === "string" ? subgraphWidgets[0] : "";
}

function normalizeWorkflowVisualAnchorText(text: string, fallbackTrigger?: string): string {
  let value = String(text || "").trim();
  if (!value) return "";
  if (/^\s*\[/.test(value)) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed) && typeof parsed[0] === "string") value = parsed[0];
    } catch {
      // keep raw value when showAnything text is not strict JSON
    }
  }
  if (fallbackTrigger && hasWorkflowTriggerWord(value)) {
    value = value.replace(WORKFLOW_TRIGGER_WORD_PATTERN, `${fallbackTrigger}, `);
  }
  return value.trim();
}

function getWorkflowTriggerWord(text: string): string | undefined {
  return text.match(/\b(oh[wm]x)\s*,/i)?.[1];
}

function randomWorkflowSeed() {
  return Math.floor(Math.random() * 1_000_000_000_000_000);
}

function inputNameLooksLikeSeed(name: string): boolean {
  return /(?:^|_)(?:seed|noise_seed)(?:$|_)/i.test(name) || /seed/i.test(name);
}

function applyRandomSeedInputs(inputs: Record<string, any>) {
  for (const key of Object.keys(inputs)) {
    if (inputNameLooksLikeSeed(key) && typeof inputs[key] === "number") {
      inputs[key] = randomWorkflowSeed();
    }
  }
  if ("control_after_generate" in inputs) {
    inputs.control_after_generate = "randomize";
  }
}

function getWorkflowVisualAnchorText(workflow: ComfyWorkflow, config: PersonaWorkflowImageConfig, defaultText: string): string {
  if (!config.visualAnchorNodeId && !config.visualAnchorAddendum) return defaultText;
  const anchorNode = (workflow.nodes || []).find((node) => node.id === config.visualAnchorNodeId);
  const anchorText = anchorNode ? getWorkflowNodeDefaultText(anchorNode) : "";
  const normalized = normalizeWorkflowVisualAnchorText(anchorText, getWorkflowTriggerWord(defaultText)) || defaultText;
  return [normalized, config.visualAnchorAddendum?.trim() || ""].filter(Boolean).join(", ");
}

function buildWorkflowPrompt(
  workflow: ComfyWorkflow,
  config: PersonaWorkflowImageConfig,
  rawPrompt: string,
  aspectRatio?: string,
  referenceFilename?: string | null,
): Record<string, any> {
  const nodes = workflow.nodes || [];
  const group = chooseWorkflowImageGroup(workflow, config.workflowGroup);
  let groupNodes = group ? nodes.filter((node) => workflowNodeInGroup(node, group)) : nodes;
  let outputNodes = findWorkflowOutputNodes(groupNodes);
  if (outputNodes.length === 0 && group) {
    groupNodes = nodes;
    outputNodes = findWorkflowOutputNodes(groupNodes);
  }
  if (outputNodes.length === 0) {
    throw new Error(`工作流未找到圖片輸出節點：${config.workflowFile}`);
  }

  const allowedIds = new Set(groupNodes.map((node) => node.id));
  const selectedIds = collectWorkflowAncestors(workflow, outputNodes.map((node) => node.id), allowedIds);
  for (const outputNode of outputNodes) selectedIds.add(outputNode.id);
  const selectedNodes = nodes.filter((node) => selectedIds.has(node.id));
  const prompt = [
    rawPrompt,
    `composition aspect ratio ${normalizeImageAspectRatio(aspectRatio)}`,
    config.promptSuffix,
    "no watermark, no logo, no visible text",
  ].filter(Boolean).join(", ");
  const relaxLoraForMediumLong = isMediumLongCompositionPrompt(prompt);
  const workflowSize = getWorkflowImageSize(normalizeImageAspectRatio(aspectRatio));

  const apiPrompt: Record<string, any> = {};
  for (const node of selectedNodes) {
    const subgraphNode = getWorkflowSingleNodeSubgraph(workflow, node);
    const inputs: Record<string, any> = {};
    let widgetIndex = 0;
    for (const input of normalizeWorkflowInputs(node)) {
      const name = input?.name;
      if (!name) continue;
      const link = input.link ? findWorkflowLink(workflow, input.link) : undefined;
      const ignoreLink = shouldIgnoreWorkflowEdge(node, input);
      if (link && selectedIds.has(Number(link[1])) && !ignoreLink) {
        inputs[name] = [String(link[1]), link[2]];
        continue;
      }
      if (input.widget) {
        inputs[name] = normalizeComfyModelSelectorValue(name, getWorkflowWidgetValue(node, name, widgetIndex));
        widgetIndex += 1;
      }
    }

    let classType = subgraphNode?.type || node.type;
    if (classType === "RHLoraLoader") {
      classType = "LoraLoader";
    }
    if (/LoraLoader/i.test(String(classType || ""))) {
      applyMediumLongLoraRelaxation(inputs, relaxLoraForMediumLong);
    }
    if (isPositiveClipTextNode(workflow, node)) {
      const defaultText = getWorkflowNodeDefaultText(node, subgraphNode);
      const anchorText = getWorkflowVisualAnchorText(workflow, config, defaultText);
      inputs.text = config.originalPromptMode === "filtered-original"
        ? buildFilteredOriginalWorkflowPrompt(anchorText, prompt)
        : mergeWorkflowPositivePromptWithVisualAnchor(anchorText, prompt);
    }
    if (node.type === "PromptBatchQueue") {
      inputs["提示词文本"] = prompt;
      delete inputs.text;
    }
    if (isWorkflowNegativeConditioningPlaceholder(node)) {
      classType = "CLIPTextEncode";
      inputs.text = WORKFLOW_NEGATIVE_PROMPT;
    }
    if (subgraphNode?.type === "CLIPTextEncode") {
      const subgraphDefaultText = Array.isArray((subgraphNode as any).widgets_values)
        ? String((subgraphNode as any).widgets_values[0] || "")
        : "";
      if (!inputs.text && subgraphDefaultText) {
        inputs.text = subgraphDefaultText;
      }
      if (!inputs.text && isWorkflowNegativeSubgraph(workflow, node, subgraphNode)) {
        inputs.text = WORKFLOW_NEGATIVE_PROMPT;
      }
    }
    const effectiveNodeType = String(classType || node.type || "");
    if (/KSampler|Sampler|RandomNoise|Noise/i.test(effectiveNodeType)) {
      if (!Object.keys(inputs).some(inputNameLooksLikeSeed)) {
        inputs.seed = randomWorkflowSeed();
      }
    }
    applyRandomSeedInputs(inputs);
    if (/Empty.*LatentImage/i.test(node.type)) {
      inputs.width = workflowSize.width;
      inputs.height = workflowSize.height;
      inputs.batch_size = 1;
    }
    if (/SaveImagePlus|ImageBatchSave/i.test(node.type)) {
      classType = "SaveImage";
      for (const key of Object.keys(inputs)) {
        if (key !== "images") delete inputs[key];
      }
      inputs.filename_prefix = config.personaKey || "persona";
    }

    apiPrompt[String(node.id)] = { class_type: classType, inputs: sanitizeWorkflowInputs(inputs) };
  }

  if (referenceFilename) {
    for (const node of selectedNodes) {
      if (node.type === "LoadImage" && apiPrompt[String(node.id)]) {
        apiPrompt[String(node.id)].inputs.image = referenceFilename;
      }
    }
  }

  return apiPrompt;
}

function resolveWorkflowConfig(config?: WorkflowRuntimeConfig): Required<Pick<WorkflowRuntimeConfig, "jupyterBase" | "comfyBase" | "workflowToken" | "workflowLocalDir">>
  & Pick<WorkflowRuntimeConfig, "workflowAuthHeader" | "workflowAuthValue" | "workflowGatewayToken"> {
  const runtimeConfig = readRuntimeApiConfig(config);
  return {
    jupyterBase: config?.jupyterBase
      || process.env.PERSONA_WORKFLOW_JUPYTER_BASE
      || runtimeConfig.personaWorkflowJupyterBase
      || runtimeConfig.comfyWorkflowJupyterBase
      || WORKFLOW_JUPYTER_BASE,
    comfyBase: config?.comfyBase
      || process.env.PERSONA_WORKFLOW_COMFY_BASE
      || runtimeConfig.personaWorkflowComfyBase
      || runtimeConfig.comfyWorkflowComfyBase
      || WORKFLOW_COMFY_BASE,
    workflowToken: config?.workflowToken
      || process.env.PERSONA_WORKFLOW_TOKEN
      || runtimeConfig.personaWorkflowToken
      || runtimeConfig.comfyWorkflowToken
      || WORKFLOW_JUPYTER_TOKEN,
    workflowLocalDir: config?.workflowLocalDir
      || process.env.PERSONA_WORKFLOW_LOCAL_DIR
      || runtimeConfig.personaWorkflowLocalDir
      || runtimeConfig.comfyWorkflowLocalDir
      || WORKFLOW_LOCAL_DIR,
    workflowAuthHeader: config?.workflowAuthHeader
      || process.env.PERSONA_WORKFLOW_AUTH_HEADER
      || runtimeConfig.personaWorkflowAuthHeader
      || runtimeConfig.comfyWorkflowAuthHeader,
    workflowAuthValue: config?.workflowAuthValue
      || process.env.PERSONA_WORKFLOW_AUTH_VALUE
      || runtimeConfig.personaWorkflowAuthValue
      || runtimeConfig.comfyWorkflowAuthValue,
    workflowGatewayToken: config?.workflowGatewayToken
      || process.env.PERSONA_WORKFLOW_GATEWAY_TOKEN
      || runtimeConfig.personaWorkflowGatewayToken
      || runtimeConfig.comfyWorkflowGatewayToken,
  };
}

function buildWorkflowHttpHeaders(runtime: ReturnType<typeof resolveWorkflowConfig>, headers?: HeadersInit): HeadersInit {
  const merged: Record<string, string> = {};
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      merged[key] = value;
    });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) merged[key] = value;
  } else if (headers) {
    Object.assign(merged, headers as Record<string, string>);
  }
  if (runtime.workflowAuthHeader && runtime.workflowAuthValue) {
    merged[runtime.workflowAuthHeader] = runtime.workflowAuthValue;
  }
  if (runtime.workflowGatewayToken) {
    merged.Authorization ||= `Bearer ${runtime.workflowGatewayToken}`;
    merged["X-Gateway-Token"] ||= runtime.workflowGatewayToken;
  }
  return merged;
}

function resolveWorkflowExecutionProvider(config: PersonaWorkflowImageConfig): "runninghub" | "comfyui" | undefined {
  if (config.executionProvider) return config.executionProvider;
  if (process.env.PERSONA_WORKFLOW_EXECUTION_PROVIDER === "runninghub" || process.env.PERSONA_WORKFLOW_EXECUTION_PROVIDER === "comfyui") {
    return process.env.PERSONA_WORKFLOW_EXECUTION_PROVIDER;
  }
  const identity = [config.personaKey, config.workflowFile].filter(Boolean).join(" ");
  if (/jinjunya|金君雅/i.test(identity)) return "comfyui";
  return undefined;
}

async function fetchPersonaWorkflow(config: PersonaWorkflowImageConfig, runtimeConfig?: WorkflowRuntimeConfig): Promise<ComfyWorkflow> {
  if (!config.workflowFile) throw new Error("缺少工作流檔名");
  const runtime = resolveWorkflowConfig(runtimeConfig);
  const timeout = createAbortTimeout(30_000);
  try {
    const url = `${runtime.jupyterBase.replace(/\/+$/, "")}/api/contents/workspace/${encodeURIComponent(config.workflowFile)}?token=${encodeURIComponent(runtime.workflowToken)}`;
    const resp = await fetch(url, { signal: timeout.signal });
    if (!resp.ok) {
      throw new Error(`讀取工作流失敗 ${resp.status}`);
    }
    const meta: any = await resp.json();
    const content = meta.format === "base64"
      ? Buffer.from(String(meta.content || "").replace(/\s+/g, ""), "base64").toString("utf-8")
      : String(meta.content || "");
    return JSON.parse(content);
  } catch (error) {
    const local = loadLocalPersonaWorkflow(config, runtime, { includeRunningHubMapped: false });
    if (local) return local;
    const mappedLocal = loadLocalPersonaWorkflow(config, runtime, { includeRunningHubMapped: true });
    if (mappedLocal) return mappedLocal;
    throw error;
  } finally {
    timeout.cleanup();
  }
}

function loadLocalPersonaWorkflow(
  config: PersonaWorkflowImageConfig,
  runtimeConfig?: Pick<WorkflowRuntimeConfig, "workflowLocalDir">,
  options: { includeRunningHubMapped?: boolean } = {},
): ComfyWorkflow | null {
  const localDir = runtimeConfig?.workflowLocalDir || WORKFLOW_LOCAL_DIR;
  const candidates = [
    config.workflowFile,
    localDir ? path.join(localDir, config.workflowFile) : "",
    options.includeRunningHubMapped ? path.join("output", "runninghub-workflows", config.workflowFile) : "",
    path.join("output", config.workflowFile),
    path.join("workflows", config.workflowFile),
    config.personaKey ? path.join("output", `${config.personaKey}-workflow.json`) : "",
    config.personaKey ? path.join("workflows", `${config.personaKey}-workflow.json`) : "",
  ].filter(Boolean);

  for (const candidate of candidates) {
    const fullPath = path.isAbsolute(candidate) ? candidate : path.resolve(process.cwd(), candidate);
    if (!fs.existsSync(fullPath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
      if (parsed?.content && typeof parsed.content === "string") {
        const content = parsed.format === "base64"
          ? Buffer.from(parsed.content.replace(/\s+/g, ""), "base64").toString("utf-8")
          : parsed.content;
        return JSON.parse(content);
      }
      return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

async function fetchComfyJson(pathname: string, init?: RequestInit, timeoutMs = 30_000, runtimeConfig?: WorkflowRuntimeConfig): Promise<any> {
  const runtime = resolveWorkflowConfig(runtimeConfig);
  const timeout = createAbortTimeout(timeoutMs);
  const url = `${runtime.comfyBase.replace(/\/+$/, "")}${pathname}`;
  try {
    const resp = await fetch(url, {
      ...init,
      headers: buildWorkflowHttpHeaders(runtime, init?.headers),
      signal: timeout.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`ComfyUI 返回 ${resp.status}：${text.slice(0, 500)}`);
    }
    return await resp.json();
  } catch (error: any) {
    if (/ComfyUI 返回/.test(String(error?.message || ""))) throw error;
    throw new Error(`ComfyUI 连接失败：${url}（${error?.message || String(error)}）`);
  } finally {
    timeout.cleanup();
  }
}

function summarizeComfyQueue(queue: any, promptId?: string) {
  const running = Array.isArray(queue?.queue_running) ? queue.queue_running : [];
  const pending = Array.isArray(queue?.queue_pending) ? queue.queue_pending : [];
  const findPrompt = (items: any[], state: "running" | "pending") => {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (Array.isArray(item) && item[1] === promptId) {
        return { promptState: state, promptAhead: state === "running" ? index : running.length + index };
      }
    }
    return null;
  };
  const found = promptId ? (findPrompt(running, "running") || findPrompt(pending, "pending")) : null;
  return {
    runningCount: running.length,
    pendingCount: pending.length,
    aheadCount: running.length + pending.length,
    promptState: found?.promptState,
    promptAhead: found?.promptAhead,
  };
}

async function uploadReferenceImageToComfy(base64: string, mimeType: string, runtimeConfig?: WorkflowRuntimeConfig): Promise<string | null> {
  const runtime = resolveWorkflowConfig(runtimeConfig);
  try {
    const ext = mimeType.includes("png") ? "png" : mimeType.includes("webp") ? "webp" : "jpg";
    const filename = `reference_${Date.now()}.${ext}`;
    const buffer = Buffer.from(base64, "base64");
    const boundary = `----FormBoundary${Date.now()}`;
    const bodyParts: Buffer[] = [];
    bodyParts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`));
    bodyParts.push(buffer);
    bodyParts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(bodyParts);
    const timeout = createAbortTimeout(30_000);
    try {
      const resp = await fetch(`${runtime.comfyBase.replace(/\/+$/, "")}/upload/image`, {
        method: "POST",
        headers: buildWorkflowHttpHeaders(runtime, { "Content-Type": `multipart/form-data; boundary=${boundary}` }),
        body,
        signal: timeout.signal,
      });
      if (!resp.ok) return null;
      const json = await resp.json();
      return json?.name || null;
    } finally {
      timeout.cleanup();
    }
  } catch {
    return null;
  }
}

export async function generateWorkflowPersonaImage(
  params: {
    prompt: string;
    workflowImage: PersonaWorkflowImageConfig;
    aspectRatio?: string;
    timeoutMs?: number;
    referenceImageBase64?: string;
    referenceImageMimeType?: string;
  },
  runtimeConfig?: WorkflowRuntimeConfig,
): Promise<ImageGenerateResult> {
  const startedAt = Date.now();
  if (params.workflowImage.provider && params.workflowImage.provider !== "comfyui") {
    return { ok: false, error: `不支援的工作流供應商：${params.workflowImage.provider}`, retryable: false };
  }
  const executionProvider = resolveWorkflowExecutionProvider(params.workflowImage);
  if (params.workflowImage.workflowId && executionProvider !== "comfyui") {
    const runningHubConfig = resolveRunningHubConfig();
    if (runningHubConfig.apiKey) {
      return generateRunningHubPersonaImage({
        prompt: params.prompt,
        workflowImage: params.workflowImage,
        aspectRatio: params.aspectRatio,
        timeoutMs: params.timeoutMs,
      });
    } else if (!params.workflowImage.workflowFile) {
      return {
        ok: false,
        error: "缺少 RunningHub API Key，且当前人设未配置可直接执行的工作流文件",
        retryable: false,
        reasonCode: "auth_missing",
      };
    }
  }
  const runtime = resolveWorkflowConfig(runtimeConfig);
  const timeoutMs = Math.max(params.timeoutMs || 300_000, 60_000);
  try {
    try {
      const queue = await fetchComfyJson("/queue", undefined, 10_000, runtime);
      const summary = summarizeComfyQueue(queue);
      if (summary.aheadCount > 0) {
        return {
          ok: false,
          error: `工作流隊列繁忙，前方還有 ${summary.aheadCount} 筆任務（執行中 ${summary.runningCount} / 等待中 ${summary.pendingCount}），本次未上傳任務，請稍後再試`,
          retryable: true,
          reasonCode: "queue_busy",
          timings: { provider: "comfyui-workflow", elapsedMs: Date.now() - startedAt, timeoutMs },
        };
      }
    } catch {
      // ignore queue diagnostics errors
    }

    const workflow = await fetchPersonaWorkflow(params.workflowImage, runtime);
    let referenceFilename: string | null = null;
    if (params.referenceImageBase64) {
      referenceFilename = await uploadReferenceImageToComfy(
        params.referenceImageBase64,
        params.referenceImageMimeType || "image/jpeg",
        runtime,
      );
    }

    const apiPrompt = buildWorkflowPrompt(workflow, params.workflowImage, params.prompt, params.aspectRatio, referenceFilename);
    const clientId = `automatic-script-${crypto.randomUUID()}`;
    const queued = await fetchComfyJson(
      "/prompt",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: apiPrompt, client_id: clientId }),
      },
      30_000,
      runtime,
    );
    const promptId = queued?.prompt_id;
    if (!promptId) {
      return {
        ok: false,
        error: "ComfyUI 未返回 prompt_id",
        retryable: true,
        reasonCode: "upstream_error",
        timings: { provider: "comfyui-workflow", elapsedMs: Date.now() - startedAt, timeoutMs },
      };
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await delay(2500);
      const history = await fetchComfyJson(`/history/${encodeURIComponent(promptId)}`, undefined, 20_000, runtime);
      const item = history?.[promptId];
      if (!item) continue;
      const outputs = item.outputs || {};
      for (const output of Object.values<any>(outputs)) {
        const image = output?.images?.[0];
        if (!image?.filename) continue;
        const query = new URLSearchParams({
          filename: image.filename,
          subfolder: image.subfolder || "",
          type: image.type || "output",
        });
        const viewUrl = `${runtime.comfyBase.replace(/\/+$/, "")}/view?${query.toString()}`;
        const resp = await fetch(viewUrl, { headers: buildWorkflowHttpHeaders(runtime) });
        if (!resp.ok) throw new Error(`讀取工作流圖片失敗 ${resp.status}`);
        const buffer = Buffer.from(await resp.arrayBuffer());
        const ext = String(image.filename).split(".").pop()?.toLowerCase();
        const mimeType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
        return {
          ok: true,
          url: `data:${mimeType};base64,${buffer.toString("base64")}`,
          timings: { provider: "comfyui-workflow", elapsedMs: Date.now() - startedAt, timeoutMs },
        };
      }
      const status = item.status?.status_str;
      if (status && status !== "success" && item.status?.completed) {
        return {
          ok: false,
          error: `工作流執行失敗：${status}`,
          retryable: true,
          reasonCode: "upstream_error",
          timings: { provider: "comfyui-workflow", elapsedMs: Date.now() - startedAt, timeoutMs },
        };
      }
    }

    try {
      const queue = await fetchComfyJson("/queue", undefined, 10_000, runtime);
      const summary = summarizeComfyQueue(queue, promptId);
      if (summary.promptState) {
        const ahead = typeof summary.promptAhead === "number" ? Math.max(summary.promptAhead, 0) : 0;
        return {
          ok: false,
          error: `工作流排隊逾時（${Math.round(timeoutMs / 1000)} 秒）｜目前執行中 ${summary.runningCount} 筆、等待中 ${summary.pendingCount} 筆，你的任務仍在${summary.promptState === "running" ? "執行中" : `等待佇列前方還有 ${ahead} 筆`}`,
          retryable: true,
          reasonCode: "timeout",
          timings: { provider: "comfyui-workflow", elapsedMs: Date.now() - startedAt, timeoutMs },
        };
      }
    } catch {
      // fall through
    }

    return {
      ok: false,
      error: `工作流生圖逾時（${Math.round(timeoutMs / 1000)} 秒）`,
      retryable: true,
      reasonCode: "timeout",
      timings: { provider: "comfyui-workflow", elapsedMs: Date.now() - startedAt, timeoutMs },
    };
  } catch (error: any) {
    const message = error?.message || String(error);
    const classified = classifyImageGenerateError(message);
    return {
      ok: false,
      error: message,
      ...classified,
      timings: { provider: "comfyui-workflow", elapsedMs: Date.now() - startedAt, timeoutMs },
    };
  }
}
