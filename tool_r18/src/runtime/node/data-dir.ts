import path from "node:path";
import fs from "node:fs";

export interface NodeRuntimePathsOptions {
  appName?: string;
  dataDir?: string;
  cwd?: string;
}

function sanitizeAppName(appName: string): string {
  return appName.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "automatic-script";
}

export function getDefaultDataDir(options: NodeRuntimePathsOptions = {}): string {
  if (options.dataDir) return options.dataDir;
  const envDir = process.env.TOOL_R18_RUNTIME_DIR || process.env.AUTO_TWEET_RUNTIME_DIR;
  if (envDir) return envDir;
  const appName = sanitizeAppName(options.appName || "automatic-script");
  const cwd = options.cwd || process.cwd();
  return path.join(cwd, ".runtime", appName);
}

export function ensureDataDir(options: NodeRuntimePathsOptions = {}): string {
  const dir = getDefaultDataDir(options);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function resolveRuntimeFile(filename: string, options: NodeRuntimePathsOptions = {}): string {
  return path.join(ensureDataDir(options), filename);
}
