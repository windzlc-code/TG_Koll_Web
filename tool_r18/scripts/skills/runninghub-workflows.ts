import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveRuntimeFile } from "@/runtime/node/data-dir";
import {
  getRunningHubWorkflowJson,
  resolveRunningHubConfig,
} from "@/runtime/node/runninghub-client";

type Input = {
  action?: "list" | "write-map" | "verify" | "fetch";
  outputFile?: string;
  workflowId?: string;
  workflowName?: string;
  timeoutMs?: number;
};

type WorkflowMapEntry = {
  key: string;
  name: string;
  workflowId: string;
  localFile?: string;
  personaKey?: string;
  kind: "persona" | "image" | "hotspot" | "video" | "edit";
};

const DEFAULT_OUTPUT_FILE = resolveRuntimeFile("runninghub-workflow-ids.json");
const DEFAULT_FETCH_DIR = path.resolve(process.cwd(), "output", "runninghub-api-workflows");

const WORKFLOWS: WorkflowMapEntry[] = [
  {
    key: "persona-xiangwanwan",
    name: "人设2 向婉婉",
    workflowId: "2056699883402387457",
    localFile: "人设2 向婉婉.json",
    personaKey: "xiangwanwan",
    kind: "persona",
  },
  {
    key: "image-set",
    name: "套图生产",
    workflowId: "2056700120942596097",
    localFile: "套图生产.json",
    kind: "image",
  },
  {
    key: "persona-xiaomii",
    name: "人设3小mii",
    workflowId: "2056699900515143681",
    localFile: "人设3小mii.json",
    personaKey: "xiaomii",
    kind: "persona",
  },
  {
    key: "persona-f1",
    name: "人设4 F1",
    workflowId: "2056699923801919490",
    localFile: "人设4 F1.json",
    personaKey: "f1",
    kind: "persona",
  },
  {
    key: "persona-jason",
    name: "人设5 jason",
    workflowId: "2056699950502858753",
    localFile: "人设5 jason.json",
    personaKey: "jason",
    kind: "persona",
  },
  {
    key: "persona-aunt50",
    name: "人设6 50岁阿姨",
    workflowId: "2056699983528808450",
    localFile: "人设6 50岁阿姨.json",
    personaKey: "aunt50",
    kind: "persona",
  },
  {
    key: "persona-inlaw",
    name: "人设7 婆家",
    workflowId: "2056700054240579586",
    localFile: "人设7 婆家.json",
    personaKey: "inlaw",
    kind: "persona",
  },
  {
    key: "persona-jinjunya",
    name: "人设1 金君雅",
    workflowId: "2056699867040403457",
    localFile: "人设1 金君雅.json",
    personaKey: "jinjunya",
    kind: "persona",
  },
  {
    key: "hotspot-text-image",
    name: "热点文+图",
    workflowId: "2056699841174138881",
    localFile: "热点文+图.json",
    kind: "hotspot",
  },
  {
    key: "grok-video",
    name: "grok视频",
    workflowId: "2056699792230805506",
    localFile: "grok视频.json",
    kind: "video",
  },
  {
    key: "grok-multi-image",
    name: "grok多图",
    workflowId: "2056699771372531714",
    localFile: "grok多图.json",
    kind: "image",
  },
  {
    key: "firered-image-edit",
    name: "firered图像编辑",
    workflowId: "2056699757585850370",
    localFile: "firered图像编辑.json",
    kind: "edit",
  },
];

function printJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeMap(outputFile = DEFAULT_OUTPUT_FILE) {
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  const now = new Date().toISOString();
  const payload = {
    updatedAt: now,
    source: "user-provided-runninghub-workbench-ids",
    count: WORKFLOWS.length,
    workflows: WORKFLOWS,
    byKey: Object.fromEntries(WORKFLOWS.map((item) => [item.key, item])),
    byPersonaKey: Object.fromEntries(WORKFLOWS.filter((item) => item.personaKey).map((item) => [item.personaKey, item])),
    byLocalFile: Object.fromEntries(WORKFLOWS.filter((item) => item.localFile).map((item) => [item.localFile, item])),
  };
  fs.writeFileSync(outputFile, JSON.stringify(payload, null, 2), "utf-8");
  return payload;
}

function resolveWorkflow(input: Input): WorkflowMapEntry {
  const exact = WORKFLOWS.find((item) => item.workflowId === input.workflowId)
    || WORKFLOWS.find((item) => item.key === input.workflowName)
    || WORKFLOWS.find((item) => item.name === input.workflowName)
    || WORKFLOWS.find((item) => item.localFile === input.workflowName);
  if (!exact) throw new Error(`找不到工作流：${input.workflowId || input.workflowName || ""}`);
  return exact;
}

function summarizeWorkflowApiData(data: any) {
  const payload = data?.data ?? data;
  const rawWorkflow = payload?.prompt ?? payload;
  const workflow = typeof rawWorkflow === "string"
    ? JSON.parse(rawWorkflow)
    : typeof payload === "string"
    ? JSON.parse(payload)
    : payload?.workflow || payload?.workflowJson || payload?.json || payload;
  const nodes = Array.isArray(workflow?.nodes)
    ? workflow.nodes
    : workflow && typeof workflow === "object"
      ? Object.values(workflow).filter((item: any) => item?.class_type || item?.inputs)
      : [];
  return {
    nodeCount: nodes.length,
    topLevelKeys: payload && typeof payload === "object" ? Object.keys(payload).slice(0, 20) : [],
    classTypes: Array.from(new Set(nodes.map((node: any) => node.type || node.class_type).filter(Boolean))).slice(0, 20),
  };
}

async function verifyWorkflows(input: Input) {
  const config = resolveRunningHubConfig();
  const results = [];
  for (const item of WORKFLOWS) {
    try {
      const response = await getRunningHubWorkflowJson(config, item.workflowId);
      results.push({
        ...item,
        ok: true,
        ...summarizeWorkflowApiData(response),
      });
    } catch (error: any) {
      results.push({
        ...item,
        ok: false,
        error: error?.message || String(error),
      });
    }
  }
  return {
    ok: results.every((item) => item.ok),
    count: results.length,
    passed: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    results,
  };
}

async function fetchWorkflow(input: Input) {
  const item = resolveWorkflow(input);
  const config = resolveRunningHubConfig();
  const response = await getRunningHubWorkflowJson(config, item.workflowId);
  fs.mkdirSync(DEFAULT_FETCH_DIR, { recursive: true });
  const outputFile = path.join(DEFAULT_FETCH_DIR, `${item.key}.json`);
  fs.writeFileSync(outputFile, JSON.stringify(response, null, 2), "utf-8");
  return {
    ok: true,
    workflow: item,
    outputFile,
    ...summarizeWorkflowApiData(response),
  };
}

async function main() {
  const input = JSON.parse(process.argv[2] || "{}") as Input;
  const action = input.action || "list";
  if (action === "list") {
    printJson({ ok: true, count: WORKFLOWS.length, workflows: WORKFLOWS });
    return;
  }
  if (action === "write-map") {
    printJson({ ok: true, outputFile: input.outputFile || DEFAULT_OUTPUT_FILE, ...writeMap(input.outputFile) });
    return;
  }
  if (action === "verify") {
    printJson(await verifyWorkflows(input));
    return;
  }
  if (action === "fetch") {
    printJson(await fetchWorkflow(input));
    return;
  }
  throw new Error(`未知 action：${action}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    printJson({ ok: false, error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  });
}
