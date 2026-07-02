import fs from "node:fs";
import path from "node:path";
import { resolveRuntimeFile } from "@/runtime/node/data-dir";

export interface EnsureRuntimeSecretsOptions {
  projectRoot?: string;
}

export function ensureRuntimeSecrets(options: EnsureRuntimeSecretsOptions = {}): void {
  const runtimeDir = path.dirname(resolveRuntimeFile("api_config.json"));
  fs.mkdirSync(runtimeDir, { recursive: true });

  const apiConfigPath = resolveRuntimeFile("api_config.json");

  if (!fs.existsSync(apiConfigPath)) {
    fs.writeFileSync(apiConfigPath, JSON.stringify({ retryCount: 2, retryDelayMs: 1000 }, null, 2), "utf-8");
  }
}
