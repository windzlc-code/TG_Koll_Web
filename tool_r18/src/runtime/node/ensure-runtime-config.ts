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
  geminiKey: "sk-qqbIaLTFSxYSD36MbMZKP0AYSNBipu6I0Go6sikJDiYI3g2S",
  geminiEndpoint: "http://202.90.21.53:3008",
  geminiTextKey: "sk-j1DTFkTVyVmqASLkirS74tOQqHPQSYd4DL0IEDRiSH5sLW00",
  geminiTextEndpoint: "http://202.90.21.53:3008",
  gptKey: "sk-arrUuuLwp2sEk4GrejppyjIjzzqBlVkKuBjvw0hjtUPbDs84",
  gptEndpoint: "http://202.90.21.53:3008",
  zhanhuKey: "sk-cp-v9uqkIooHvt4zM7u4eyNY39lViw5hiWL_YGJ4Dn5Tu6re3mKSj2lHZpBDnh9asbHJU3TfKjdhXBMUNoI5QZFRMcWPJJ6isxwaXfhkeJkElvZV00knm1MxGk",
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
