import fs from "node:fs";
import path from "node:path";
import { resolveRuntimeFile } from "@/runtime/node/data-dir";

export interface RuntimeBootstrapConfig {
  geminiKey?: string;
  geminiEndpoint?: string;
  geminiTextKey?: string;
  geminiTextEndpoint?: string;
  gptKey?: string;
  gptEndpoint?: string;
  zhanhuKey?: string;
  zhanhuEndpoint?: string;
  retryCount?: number;
  retryDelayMs?: number;
}

const DEFAULT_RUNTIME_CONFIG: RuntimeBootstrapConfig = {
  geminiEndpoint: "http://202.90.21.53:3008",
  geminiTextEndpoint: "http://202.90.21.53:3008",
  gptEndpoint: "http://202.90.21.53:3008",
  zhanhuEndpoint: "https://api.minimax.io/v1",
  retryCount: 2,
  retryDelayMs: 1000,
};

export function ensureRuntimeApiConfig() {
  const filePath = resolveRuntimeFile("api_config.json");
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(DEFAULT_RUNTIME_CONFIG, null, 2), "utf-8");
    return filePath;
  }

  try {
    const current = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const merged = { ...DEFAULT_RUNTIME_CONFIG, ...current };
    fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), "utf-8");
  } catch {
    fs.writeFileSync(filePath, JSON.stringify(DEFAULT_RUNTIME_CONFIG, null, 2), "utf-8");
  }

  return filePath;
}
