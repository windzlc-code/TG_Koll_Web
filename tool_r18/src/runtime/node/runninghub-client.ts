import fs from "node:fs";
import crypto from "node:crypto";
import { readRuntimeApiConfig, type RuntimeConfigOptions } from "./config";

export interface RunningHubConfig {
  apiKey: string;
  endpoint: string;
  workflowId?: string;
  imageWebappId?: string;
  accessPassword?: string;
}

export interface RunningHubNodeInfo {
  nodeId: string;
  fieldName: string;
  fieldValue: unknown;
  description?: string;
}

export interface RunningHubLoraUploadResult {
  loraName: string;
  md5Hex: string;
  fileName: string;
  uploaded: boolean;
}

export interface RunningHubRawResponse<T = any> {
  ok: boolean;
  status: number;
  json: T | null;
  text: string;
}

function normalizeEndpoint(endpoint?: string) {
  return String(endpoint || "https://www.runninghub.ai").replace(/\/+$/, "");
}

export function resolveRunningHubConfig(options: RuntimeConfigOptions = {}): RunningHubConfig {
  const runtime = readRuntimeApiConfig(options);
  return {
    apiKey: process.env.RUNNINGHUB_API_KEY || runtime.runningHubKey || "",
    endpoint: normalizeEndpoint(process.env.RUNNINGHUB_ENDPOINT || runtime.runningHubEndpoint),
    workflowId: process.env.RUNNINGHUB_WORKFLOW_ID || runtime.runningHubWorkflowId,
    imageWebappId: process.env.RUNNINGHUB_IMAGE_WEBAPP_ID || runtime.runningHubImageWebappId,
    accessPassword: process.env.RUNNINGHUB_ACCESS_PASSWORD || runtime.runningHubAccessPassword,
  };
}

function summarizeRunningHubPayload(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function runningHubErrorMessage(payload: any): string {
  const parts = [
    payload?.msg,
    payload?.message,
    payload?.error,
    payload?.data?.msg,
    payload?.data?.message,
    payload?.data?.error,
    payload?.data?.failedReason,
    payload?.data?.failReason,
    payload?.data?.reason,
    payload?.data?.status,
  ]
    .map(summarizeRunningHubPayload)
    .filter(Boolean);
  return parts.length ? parts.join(" | ") : summarizeRunningHubPayload(payload).slice(0, 500);
}

function isRunningHubSuccessCode(code: unknown): boolean {
  return code === undefined || code === null || code === "" || code === 0 || code === "0";
}

export async function runningHubRequestRaw<T = any>(
  config: RunningHubConfig,
  pathname: string,
  body: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<RunningHubRawResponse<T>> {
  if (!config.apiKey) throw new Error("缺少 RunningHub API Key，请配置 RUNNINGHUB_API_KEY 或 api_config.json.runningHubKey");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${normalizeEndpoint(config.endpoint)}${pathname}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ apiKey: config.apiKey, ...body }),
      signal: controller.signal,
    });
    const text = await resp.text();
    const json = text ? JSON.parse(text) : {};
    return { ok: resp.ok, status: resp.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

export async function runningHubRequest<T>(
  config: RunningHubConfig,
  pathname: string,
  body: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<T> {
  const response = await runningHubRequestRaw<T>(config, pathname, body, timeoutMs);
  if (!response.ok) throw new Error(`RunningHub 返回 ${response.status}: ${response.text.slice(0, 500)}`);
  const json: any = response.json || {};
  if (json?.code !== 0) {
    throw new Error(`RunningHub 调用失败：${runningHubErrorMessage(json)}`);
  }
    return json as T;
}

export async function runningHubOpenApiV2RequestRaw<T = any>(
  config: RunningHubConfig,
  pathname: string,
  body: Record<string, unknown>,
  timeoutMs = 60_000,
): Promise<RunningHubRawResponse<T>> {
  if (!config.apiKey) throw new Error("缺少 RunningHub API Key，请配置 RUNNINGHUB_API_KEY 或 api_config.json.runningHubKey");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${normalizeEndpoint(config.endpoint)}/openapi/v2${pathname}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await resp.text();
    const json = text ? JSON.parse(text) : {};
    return { ok: resp.ok, status: resp.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

export async function runningHubOpenApiV2Request<T>(
  config: RunningHubConfig,
  pathname: string,
  body: Record<string, unknown>,
  timeoutMs = 60_000,
): Promise<T> {
  const response = await runningHubOpenApiV2RequestRaw<T>(config, pathname, body, timeoutMs);
  if (!response.ok) throw new Error(`RunningHub OpenAPI v2 返回 ${response.status}: ${response.text.slice(0, 500)}`);
  const json: any = response.json || {};
  const code = json?.code ?? json?.errorCode;
  if (!isRunningHubSuccessCode(code)) {
    throw new Error(`RunningHub OpenAPI v2 调用失败：${runningHubErrorMessage(json)}`);
  }
  return json as T;
}

export function md5FileHex(filePath: string): string {
  const hash = crypto.createHash("md5");
  const buffer = fs.readFileSync(filePath);
  hash.update(buffer);
  return hash.digest("hex");
}

export async function getRunningHubWorkflowJson(config: RunningHubConfig, workflowId = config.workflowId) {
  if (!workflowId) throw new Error("缺少 RunningHub workflowId");
  return runningHubRequest<any>(config, "/api/openapi/getJsonApiFormat", { workflowId });
}

export async function createRunningHubTask(
  config: RunningHubConfig,
  nodeInfoList: RunningHubNodeInfo[],
  workflowId = config.workflowId,
  workflow?: unknown,
) {
  if (!workflowId && !workflow) throw new Error("缺少 RunningHub workflowId 或 workflow JSON");
  return runningHubRequest<any>(config, "/task/openapi/create", {
    ...(workflowId ? { workflowId } : {}),
    ...(workflow ? { workflow } : {}),
    ...(nodeInfoList.length > 0 ? { nodeInfoList } : {}),
    addMetadata: true,
    ...(config.accessPassword ? { accessPassword: config.accessPassword } : {}),
  }, 60_000);
}

export async function getRunningHubAiAppCallDemo(config: RunningHubConfig, webappId: string) {
  if (!config.apiKey) throw new Error("缺少 RunningHub API Key，请配置 RUNNINGHUB_API_KEY 或 api_config.json.runningHubKey");
  if (!webappId) throw new Error("缺少 RunningHub AI 应用 webappId");
  const endpoint = normalizeEndpoint(config.endpoint);
  const url = new URL(`${endpoint}/api/webapp/apiCallDemo`);
  url.searchParams.set("apiKey", config.apiKey);
  url.searchParams.set("webappId", webappId);
  const resp = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });
  const text = await resp.text();
  const json = text ? JSON.parse(text) : {};
  if (!resp.ok) throw new Error(`RunningHub AI 应用示例返回 ${resp.status}: ${text.slice(0, 500)}`);
  if (json?.code !== 0) {
    throw new Error(`RunningHub AI 应用示例调用失败：${runningHubErrorMessage(json)}`);
  }
  return json;
}

export async function createRunningHubAiAppTask(
  config: RunningHubConfig,
  webappId: string,
  nodeInfoList: RunningHubNodeInfo[],
) {
  if (!webappId) throw new Error("缺少 RunningHub AI 应用 webappId");
  return runningHubRequest<any>(config, "/task/openapi/ai-app/run", {
    webappId,
    nodeInfoList,
  }, 60_000);
}

export async function createRunningHubStandardModelTask(
  config: RunningHubConfig,
  endpointPath: string,
  payload: Record<string, unknown>,
) {
  if (!endpointPath) throw new Error("缺少 RunningHub 标准模型 endpoint");
  const normalizedPath = endpointPath.startsWith("/") ? endpointPath : `/${endpointPath}`;
  return runningHubOpenApiV2Request<any>(config, normalizedPath, payload, 60_000);
}

export async function getRunningHubTaskStatus(config: RunningHubConfig, taskId: string) {
  return runningHubRequest<any>(config, "/task/openapi/status", { taskId });
}

export async function getRunningHubTaskOutputs(config: RunningHubConfig, taskId: string) {
  return runningHubRequest<any>(config, "/task/openapi/outputs", { taskId });
}

export async function waitRunningHubOpenApiV2TaskOutputs(
  config: RunningHubConfig,
  taskId: string,
  timeoutMs = 300_000,
  pollMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "";
  let lastError = "";
  while (Date.now() < deadline) {
    const raw = await runningHubOpenApiV2RequestRaw<any>(
      config,
      "/query",
      { taskId },
      30_000,
    ).catch((error) => ({
      ok: false,
      status: 0,
      json: { msg: error?.message || String(error) },
      text: error?.message || String(error),
    }));
    const json: any = raw.json || {};
    if (!raw.ok) {
      lastError = raw.text || `HTTP ${raw.status}`;
    } else {
      const code = json?.code ?? json?.errorCode;
      if (!isRunningHubSuccessCode(code)) {
        lastError = runningHubErrorMessage(json);
      } else {
        lastStatus = summarizeRunningHubPayload(json?.status || json?.data?.status || lastStatus || "");
        if (/SUCCESS/i.test(lastStatus)) {
          const results = json?.results ?? json?.data?.results ?? json?.data;
          if (hasOutputData(results)) return results;
          throw new Error(`RunningHub OpenAPI v2 任务成功但未返回图片输出：taskId=${taskId}`);
        }
        if (/FAIL|ERROR/i.test(lastStatus)) {
          const detail = runningHubErrorMessage(json) || lastStatus;
          throw new Error(`RunningHub OpenAPI v2 任务失败：taskId=${taskId} ${detail}`);
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`RunningHub OpenAPI v2 任务等待超时：taskId=${taskId} status=${lastStatus || "unknown"}${lastError ? `；query=${lastError}` : ""}`);
}

function hasOutputData(data: unknown): boolean {
  if (Array.isArray(data)) return data.length > 0;
  if (data && typeof data === "object") return Object.keys(data).length > 0;
  return Boolean(data);
}

export async function waitRunningHubTaskOutputs(
  config: RunningHubConfig,
  taskId: string,
  timeoutMs = 300_000,
  pollMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "";
  let lastOutputsError = "";
  let successWithoutOutputs = 0;
  while (Date.now() < deadline) {
    const outputsRaw = await runningHubRequestRaw<any>(config, "/task/openapi/outputs", { taskId }, 30_000).catch((error) => ({
      ok: false,
      status: 0,
      json: { msg: error?.message || String(error) },
      text: error?.message || String(error),
    }));
    const outputsJson: any = outputsRaw.json || {};
    if (outputsRaw.ok && outputsJson?.code === 0 && hasOutputData(outputsJson.data)) return outputsJson.data;
    if (!outputsRaw.ok || outputsJson?.code !== 0) {
      lastOutputsError = runningHubErrorMessage(outputsJson) || outputsRaw.text || `HTTP ${outputsRaw.status}`;
    }

    const statusRaw = await runningHubRequestRaw<any>(config, "/task/openapi/status", { taskId }, 30_000).catch((error) => ({
      ok: false,
      status: 0,
      json: { msg: error?.message || String(error) },
      text: error?.message || String(error),
    }));
    const statusJson: any = statusRaw.json || {};
    if (!statusRaw.ok || statusJson?.code !== 0) {
      const detail = runningHubErrorMessage(statusJson) || statusRaw.text || `HTTP ${statusRaw.status}`;
      throw new Error(`RunningHub 任务状态查询失败：${detail}${lastOutputsError ? `；outputs=${lastOutputsError}` : ""}`);
    }
    lastStatus = summarizeRunningHubPayload(statusJson?.data || lastStatus || "");
    if (/FAIL|ERROR/i.test(lastStatus)) {
      throw new Error(`RunningHub 任务失败：taskId=${taskId} status=${lastStatus}${lastOutputsError ? `；outputs=${lastOutputsError}` : ""}`);
    }
    if (/SUCCESS/i.test(lastStatus)) {
      successWithoutOutputs += 1;
      if (successWithoutOutputs >= 6) {
        throw new Error(`RunningHub 任务成功但未返回图片输出：taskId=${taskId}${lastOutputsError ? `；outputs=${lastOutputsError}` : ""}`);
      }
    } else {
      successWithoutOutputs = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`RunningHub 任务等待超时：taskId=${taskId} status=${lastStatus || "unknown"}${lastOutputsError ? `；outputs=${lastOutputsError}` : ""}`);
}

export async function uploadRunningHubLora(
  config: RunningHubConfig,
  filePath: string,
  loraName: string,
  md5Hex = md5FileHex(filePath),
): Promise<RunningHubLoraUploadResult> {
  const uploadMeta = await runningHubRequest<any>(
    config,
    "/api/openapi/getLoraUploadUrl",
    { loraName, md5Hex: md5Hex.toLowerCase() },
  );
  const fileName = uploadMeta?.data?.fileName;
  const uploadUrl = uploadMeta?.data?.url;
  if (!fileName || !uploadUrl) {
    throw new Error(`RunningHub 未返回 LoRA 上传地址：${JSON.stringify(uploadMeta).slice(0, 500)}`);
  }

  const buffer = fs.readFileSync(filePath);
  let resp = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: buffer,
  });
  if (!resp.ok && (resp.status === 405 || resp.status === 403)) {
    resp = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: buffer,
    });
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`LoRA 上传失败 ${resp.status}: ${text.slice(0, 500)}`);
  }

  return {
    loraName,
    md5Hex: md5Hex.toLowerCase(),
    fileName,
    uploaded: true,
  };
}
