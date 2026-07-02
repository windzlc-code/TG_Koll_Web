import fs from "node:fs";
import { resolveRuntimeFile, type NodeRuntimePathsOptions } from "./data-dir";

export type SupportedApiProtocol = "gemini" | "gemini-text" | "openai" | "anthropic";

export interface RuntimeApiConfig {
  geminiKey?: string;
  geminiTextKey?: string;
  gptKey?: string;
  anthropicKey?: string;
  geminiEndpoint?: string;
  geminiTextEndpoint?: string;
  gptEndpoint?: string;
  anthropicEndpoint?: string;
  zhanhuKey?: string;
  zhanhuEndpoint?: string;
  runningHubKey?: string;
  runningHubEndpoint?: string;
  runningHubWorkflowId?: string;
  runningHubImageWebappId?: string;
  runningHubAccessPassword?: string;
  newPersonaRunningHubPersonaTextToImageEndpoint?: string;
  newPersonaRunningHubPersonaTextToImageDetailUrl?: string;
  newPersonaRunningHubTweetImageToImageEndpoint?: string;
  newPersonaRunningHubTweetImageToImageDetailUrl?: string;
  comfyWorkflowJupyterBase?: string;
  comfyWorkflowComfyBase?: string;
  comfyWorkflowToken?: string;
  comfyWorkflowLocalDir?: string;
  comfyWorkflowAuthHeader?: string;
  comfyWorkflowAuthValue?: string;
  comfyWorkflowGatewayToken?: string;
  personaWorkflowJupyterBase?: string;
  personaWorkflowComfyBase?: string;
  personaWorkflowToken?: string;
  personaWorkflowLocalDir?: string;
  personaWorkflowAuthHeader?: string;
  personaWorkflowAuthValue?: string;
  personaWorkflowGatewayToken?: string;
  retryCount?: number;
  retryDelayMs?: number;
  llmModelPriorityOrder?: string;
  llm_model_priority_order?: string;
  llmFreeModelPriorityOrder?: string;
  llm_free_model_priority_order?: string;
  llmPaidModelPriorityOrder?: string;
  llm_paid_model_priority_order?: string;
  llmDefaultModelGpt?: string;
  llm_default_model_gpt?: string;
  llmDefaultModel?: string;
  llm_default_model?: string;
  modelMappings?: Record<string, { modelId?: string; protocol?: SupportedApiProtocol | "auto" }>;
}

export interface RuntimeConfigOptions extends NodeRuntimePathsOptions {
  configPath?: string;
}

export function resolveConfigPath(options: RuntimeConfigOptions = {}): string {
  return options.configPath || process.env.AUTO_TWEET_API_CONFIG_PATH || resolveRuntimeFile("api_config.json", options);
}

export function readRuntimeApiConfig(options: RuntimeConfigOptions = {}): RuntimeApiConfig {
  const configPath = resolveConfigPath(options);
  try {
    if (!fs.existsSync(configPath)) return {};
    return JSON.parse(fs.readFileSync(configPath, "utf-8")) || {};
  } catch {
    return {};
  }
}

export function getRuntimeApiConfigForProtocol(
  protocol: SupportedApiProtocol,
  options: RuntimeConfigOptions = {},
): { apiKey: string; endpoint: string } {
  const config = readRuntimeApiConfig(options);
  const fallbackEndpoint = config.zhanhuEndpoint || "http://202.90.21.53:13003";

  if (protocol === "gemini-text") {
    return {
      apiKey: config.geminiTextKey || config.geminiKey || config.zhanhuKey || process.env.GEMINI_TEXT_API_KEY || "",
      endpoint: config.geminiTextEndpoint || config.geminiEndpoint || fallbackEndpoint,
    };
  }

  if (protocol === "gemini") {
    return {
      apiKey: config.geminiKey || config.zhanhuKey || process.env.GEMINI_API_KEY || "",
      endpoint: config.geminiEndpoint || fallbackEndpoint,
    };
  }

  if (protocol === "anthropic") {
    return {
      apiKey: config.anthropicKey || process.env.ANTHROPIC_API_KEY || "",
      endpoint: config.anthropicEndpoint || fallbackEndpoint,
    };
  }

  return {
    apiKey: config.gptKey || config.zhanhuKey || process.env.OPENAI_API_KEY || "",
    endpoint: config.gptEndpoint || fallbackEndpoint,
  };
}

export function resolveModelProtocol(model: string, options: RuntimeConfigOptions = {}): SupportedApiProtocol {
  const config = readRuntimeApiConfig(options);
  const override = config.modelMappings?.[model]?.protocol;
  if (override && override !== "auto") return override;
  if (model.startsWith("claude")) return "anthropic";
  if (model.startsWith("xai/") || model.startsWith("grok-")) return "openai";
  if (model.startsWith("google/")) return "openai";
  if (model.startsWith("gpt-") || /dall-e/i.test(model)) return "openai";
  return "gemini";
}

export function readRuntimeTextGenConfig(options: RuntimeConfigOptions = {}): {
  retryCount: number;
  retryDelayMs: number;
} {
  const config = readRuntimeApiConfig(options);
  return {
    retryCount: Number(config.retryCount ?? 1) || 1,
    retryDelayMs: Number(config.retryDelayMs ?? 800) || 800,
  };
}

export interface MobileCredentialConfig {
  name?: string;
  ak?: string;
  sk?: string;
}

export function resolveMobileCredentialList(_options: RuntimeConfigOptions = {}): MobileCredentialConfig[] {
  return [];
}

export function resolveMobileCredentials(options: RuntimeConfigOptions = {}): { ak: string; sk: string; accounts: MobileCredentialConfig[] } {
  const accounts = resolveMobileCredentialList(options);
  return { ak: "", sk: "", accounts };
}
