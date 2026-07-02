import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  md5FileHex,
  resolveRunningHubConfig,
  uploadRunningHubLora,
  type RunningHubNodeInfo,
} from "@/runtime/node/runninghub-client";
import { resolveRuntimeFile } from "@/runtime/node/data-dir";

type Action = "inventory" | "upload" | "node-info";

type Input = {
  action?: Action;
  modelDir?: string;
  outputFile?: string;
  mapFile?: string;
  dryRun?: boolean;
  personaKey?: string;
  personaKeys?: string[];
  names?: string[];
  loraNodeId?: string;
  loraFieldName?: string;
  strengthModelNodeId?: string;
  strengthModelFieldName?: string;
  strengthClipNodeId?: string;
  strengthClipFieldName?: string;
  strengthModel?: number;
  strengthClip?: number;
  runningHubFileName?: string;
  configPath?: string;
  dataDir?: string;
};

const DEFAULT_MODEL_DIR = "C:\\Users\\14471\\Downloads\\模型";
const DEFAULT_MAP_FILE = resolveRuntimeFile("runninghub-lora-map.json");

const PERSONA_LORA_ALIASES: Record<string, string> = {
  jinjunya: "人设1捞女1金君雅.safetensors",
  xiangwanwan: "人设2捞女2向晚晚.safetensors",
  xiaomii: "人设3捞女小mi.safetensors",
  f1: "人设6电竞女芙依F1 .safetensors",
  jason: "人设7电竞男jason.safetensors",
  cute_jp: "人设4日系可爱.safetensors",
  yoga: "人设5瑜伽老师.safetensors",
  aunt50: "50岁阿姨.safetensors",
  hip_slider: "臀部Z-Hip-Slider.safetensors",
  breast_slider: "胸部Z-Breast-Slider.safetensors",
  detail_daemon: "REDZ15_DetailDaemonZ_lora.safetensors",
};

function printJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function safeName(filename: string) {
  return path.basename(filename, path.extname(filename)).trim();
}

function listLoras(modelDir: string) {
  if (!fs.existsSync(modelDir)) throw new Error(`LoRA 目录不存在：${modelDir}`);
  const files = fs.readdirSync(modelDir)
    .filter((name) => /\.safetensors$/i.test(name))
    .map((name) => {
      const filePath = path.join(modelDir, name);
      const stat = fs.statSync(filePath);
      const personaKey = Object.entries(PERSONA_LORA_ALIASES).find(([, filename]) => filename === name)?.[0];
      return {
        personaKey,
        name,
        loraName: safeName(name),
        path: filePath,
        sizeBytes: stat.size,
        md5Hex: md5FileHex(filePath),
      };
    });
  return files;
}

function filterLoras(loras: ReturnType<typeof listLoras>, input: Input) {
  const wantedKeys = new Set([...(input.personaKeys || []), input.personaKey || ""].filter(Boolean));
  const wantedNames = new Set(input.names || []);
  if (wantedKeys.size === 0 && wantedNames.size === 0) return loras;
  return loras.filter((lora) =>
    (lora.personaKey && wantedKeys.has(lora.personaKey))
    || wantedNames.has(lora.name)
    || wantedNames.has(lora.loraName)
  );
}

function writeJsonFile(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

async function uploadAll(input: Input) {
  const modelDir = input.modelDir || DEFAULT_MODEL_DIR;
  const mapFile = input.mapFile || DEFAULT_MAP_FILE;
  const loras = filterLoras(listLoras(modelDir), input);
  if (loras.length === 0) throw new Error("没有匹配到要处理的 LoRA");
  const config = resolveRunningHubConfig({ configPath: input.configPath, dataDir: input.dataDir });
  const previous = fs.existsSync(mapFile) ? JSON.parse(fs.readFileSync(mapFile, "utf-8")) : {};
  const previousByPersonaKey = previous?.byPersonaKey || {};
  const previousByFileName = previous?.byFileName || {};
  const results: any[] = [];

  for (const lora of loras) {
    if (input.dryRun) {
      const prev = (lora.personaKey && previousByPersonaKey[lora.personaKey]) || previousByFileName[lora.name];
      results.push({ ...lora, ...prev, uploaded: Boolean(prev?.fileName), dryRun: true });
      continue;
    }
    const prev = (lora.personaKey && previousByPersonaKey[lora.personaKey]) || previousByFileName[lora.name];
    if (prev?.fileName && String(prev.md5Hex || "").toLowerCase() === lora.md5Hex.toLowerCase()) {
      results.push({ ...lora, ...prev, uploaded: true, skipped: true });
      continue;
    }
    const uploaded = await uploadRunningHubLora(config, lora.path, lora.loraName, lora.md5Hex);
    results.push({ ...lora, ...uploaded });
  }

  const byPersonaKey: Record<string, any> = { ...previousByPersonaKey };
  const byFileName: Record<string, any> = { ...previousByFileName };
  for (const item of results) {
    byFileName[item.name] = item;
    if (item.personaKey) byPersonaKey[item.personaKey] = item;
  }
  const output = {
    generatedAt: new Date().toISOString(),
    modelDir,
    dryRun: Boolean(input.dryRun),
    count: results.length,
    byPersonaKey,
    byFileName,
    items: results,
  };
  writeJsonFile(mapFile, output);
  return { ok: true, action: input.action || (input.dryRun ? "inventory" : "upload"), mapFile, ...output };
}

function makeNodeInfo(input: Input) {
  const personaKey = input.personaKey || "";
  if (!personaKey) throw new Error("node-info 需要 personaKey");
  if (!input.loraNodeId) throw new Error("node-info 需要 loraNodeId，也就是 RunningHub 工作流里 RHLoraLoader 的节点 ID");
  const mapFile = input.mapFile || DEFAULT_MAP_FILE;
  if (!fs.existsSync(mapFile)) throw new Error(`LoRA 映射文件不存在，请先执行 upload：${mapFile}`);
  const map = JSON.parse(fs.readFileSync(mapFile, "utf-8"));
  const item = map?.byPersonaKey?.[personaKey];
  const runningHubFileName = input.runningHubFileName || item?.fileName;
  if (!runningHubFileName) throw new Error(`映射文件中找不到 ${personaKey} 的 RunningHub fileName，请先执行 upload，或传入 runningHubFileName`);

  const nodeInfoList: RunningHubNodeInfo[] = [
    {
      nodeId: String(input.loraNodeId),
      fieldName: input.loraFieldName || "lora_name",
      fieldValue: runningHubFileName,
      description: `${personaKey} LoRA`,
    },
  ];
  if (input.strengthModelNodeId || input.strengthModelFieldName || typeof input.strengthModel === "number") {
    nodeInfoList.push({
      nodeId: String(input.strengthModelNodeId || input.loraNodeId),
      fieldName: input.strengthModelFieldName || "strength_model",
      fieldValue: input.strengthModel ?? 0.8,
      description: "LoRA model strength",
    });
  }
  if (input.strengthClipNodeId || input.strengthClipFieldName || typeof input.strengthClip === "number") {
    nodeInfoList.push({
      nodeId: String(input.strengthClipNodeId || input.loraNodeId),
      fieldName: input.strengthClipFieldName || "strength_clip",
      fieldValue: input.strengthClip ?? 1,
      description: "LoRA clip strength",
    });
  }
  return { ok: true, action: "node-info", personaKey, nodeInfoList };
}

async function main() {
  const raw = process.argv[2] || "{}";
  const input = JSON.parse(raw) as Input;
  const action: Action = input.action || "inventory";

  if (action === "node-info") {
    printJson(makeNodeInfo(input));
    return;
  }

  const result = await uploadAll({
    ...input,
    dryRun: action === "inventory" ? true : input.dryRun,
  });
  if (input.outputFile) writeJsonFile(input.outputFile, result);
  printJson(result);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    printJson({ ok: false, error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  });
}
