import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveRuntimeFile } from "@/runtime/node/data-dir";

type Input = {
  workflowDir?: string;
  outputDir?: string;
  mapFile?: string;
  dryRun?: boolean;
};

const DEFAULT_WORKFLOW_DIR = "C:\\Users\\14471\\Downloads\\数字人";
const DEFAULT_OUTPUT_DIR = path.resolve(process.cwd(), "output", "runninghub-workflows");
const DEFAULT_MAP_FILE = resolveRuntimeFile("runninghub-lora-map.json");

const WORKFLOW_PERSONA_KEYS: Record<string, string> = {
  "人设1 金君雅.json": "jinjunya",
  "人设2 向婉婉.json": "xiangwanwan",
  "人设3小mii.json": "xiaomii",
  "人设4 F1.json": "f1",
  "人设5 jason.json": "jason",
  "人设6 50岁阿姨.json": "aunt50",
  "热点文+图.json": "xiangwanwan",
};

const LORA_NAME_KEYS: Array<[RegExp, string]> = [
  [/人设1捞女1金君雅|金君雅/i, "jinjunya"],
  [/人设2捞女2向晚晚|向晚晚|向婉婉/i, "xiangwanwan"],
  [/人设3捞女小mi|小mi|小mii/i, "xiaomii"],
  [/人设4日系可爱|日系可爱/i, "cute_jp"],
  [/人设5瑜伽老师|瑜伽老师/i, "yoga"],
  [/人设6电竞女芙依F1|电竞女芙依|(?:^|[^a-z0-9])F1(?:[^a-z0-9]|$)/i, "f1"],
  [/人设7电竞男jason|jason/i, "jason"],
  [/50岁阿姨/i, "aunt50"],
  [/臀部Z-Hip-Slider|Hip-Slider/i, "hip_slider"],
  [/胸部Z-Breast-Slider|Breast-Slider/i, "breast_slider"],
  [/REDZ15_DetailDaemonZ|DetailDaemon/i, "detail_daemon"],
];

function printJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function loadWorkflow(filePath: string) {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  if (parsed?.content && typeof parsed.content === "string") {
    return {
      wrapper: parsed,
      workflow: JSON.parse(parsed.content),
    };
  }
  return { wrapper: null, workflow: parsed };
}

function saveWorkflow(filePath: string, wrapper: any, workflow: any) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (wrapper) {
    fs.writeFileSync(filePath, JSON.stringify({ ...wrapper, content: JSON.stringify(workflow, null, 2) }, null, 2), "utf-8");
  } else {
    fs.writeFileSync(filePath, JSON.stringify(workflow, null, 2), "utf-8");
  }
}

function personaKeyForLora(rawName: string, workflowPersonaKey?: string) {
  const name = String(rawName || "");
  for (const [pattern, key] of LORA_NAME_KEYS) {
    if (pattern.test(name)) return key;
  }
  if (/人设\/|人設\/|ai-toolkit\/50岁阿姨/i.test(name) && workflowPersonaKey) return workflowPersonaKey;
  return "";
}

function convertWorkflow(filePath: string, outputDir: string, loraMap: any, dryRun: boolean) {
  const fileName = path.basename(filePath);
  const workflowPersonaKey = WORKFLOW_PERSONA_KEYS[fileName];
  const { wrapper, workflow } = loadWorkflow(filePath);
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const conversions: any[] = [];
  const misses: any[] = [];

  for (const node of nodes) {
    if (!/LoraLoader/i.test(String(node.type || ""))) continue;
    const widgets = Array.isArray(node.widgets_values) ? node.widgets_values : [];
    const originalName = String(widgets[0] || "");
    const key = personaKeyForLora(originalName, workflowPersonaKey);
    if (!key) continue;
    const mapped = loraMap?.byPersonaKey?.[key];
    if (!mapped?.fileName) {
      misses.push({ nodeId: node.id, originalName, personaKey: key });
      continue;
    }
    const previousType = node.type;
    node.type = String(previousType).includes("ModelOnly") ? "RHLoraLoaderModelOnly" : "RHLoraLoader";
    if (node.properties?.["Node name for S&R"]) {
      node.properties["Node name for S&R"] = node.type;
    }
    widgets[0] = mapped.fileName;
    conversions.push({
      nodeId: node.id,
      title: node.title || "",
      fromType: previousType,
      toType: node.type,
      originalName,
      personaKey: key,
      runningHubFileName: mapped.fileName,
      strengthModel: widgets[1],
      strengthClip: widgets[2],
    });
  }

  const outputFile = path.join(outputDir, fileName);
  if (!dryRun) saveWorkflow(outputFile, wrapper, workflow);
  return { fileName, personaKey: workflowPersonaKey, outputFile, conversions, misses };
}

async function main() {
  const input = JSON.parse(process.argv[2] || "{}") as Input;
  const workflowDir = input.workflowDir || DEFAULT_WORKFLOW_DIR;
  const outputDir = input.outputDir || DEFAULT_OUTPUT_DIR;
  const mapFile = input.mapFile || DEFAULT_MAP_FILE;
  const dryRun = Boolean(input.dryRun);
  const loraMap = JSON.parse(fs.readFileSync(mapFile, "utf-8"));
  const files = fs.readdirSync(workflowDir).filter((name) => name.endsWith(".json"));
  const results = files.map((name) => convertWorkflow(path.join(workflowDir, name), outputDir, loraMap, dryRun));
  const report = {
    ok: true,
    dryRun,
    workflowDir,
    outputDir,
    count: results.length,
    convertedNodeCount: results.reduce((sum, item) => sum + item.conversions.length, 0),
    missedNodeCount: results.reduce((sum, item) => sum + item.misses.length, 0),
    results,
  };
  if (!dryRun) {
    fs.writeFileSync(path.join(outputDir, "runninghub-workflow-map-report.json"), JSON.stringify(report, null, 2), "utf-8");
  }
  printJson(report);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    printJson({ ok: false, error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  });
}
