import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { WORKFLOW_PERSONA_SEEDS } from "@/lib/workflow-personas";

type Node = {
  id: number;
  type: string;
  title?: string;
  widgets_values?: any[];
  inputs?: any[];
  outputs?: any[];
  pos?: [number, number];
  size?: [number, number];
  properties?: Record<string, any>;
};

type Workflow = {
  nodes?: Node[];
  links?: any[];
  groups?: Array<{ title?: string; bounding?: [number, number, number, number] }>;
  definitions?: {
    subgraphs?: Array<{ id?: string; name?: string; nodes?: Node[] }>;
  };
  [key: string]: any;
};

const INPUT_DIR = path.resolve(process.cwd(), "output", "runninghub-workflows");
const DESKTOP_DIR = path.join(process.env.USERPROFILE || "C:\\Users\\14471", "Desktop", "开源工作流人设-精简可跑通版");
const NEGATIVE_PROMPT = "ai-generated, worst detail, sketch, monochrome, extra digits, watermark, logo, text, bad anatomy, malformed hands";
const IMAGE_OUTPUT_PATTERN = /SaveImage|SaveImagePlus|ImageBatchSave|PreviewImage/i;
const TEXT_OUTPUT_PATTERN = /Text File/i;

function readWorkflow(fileName: string): Workflow {
  return JSON.parse(fs.readFileSync(path.join(INPUT_DIR, fileName), "utf-8"));
}

function normalizeGroupName(value: string) {
  return String(value || "").trim().toLowerCase();
}

function nodeInGroup(node: Node, group?: { bounding?: [number, number, number, number] }) {
  if (!group || !Array.isArray(node.pos) || !Array.isArray(group.bounding)) return false;
  const [x, y] = node.pos;
  const [gx, gy, gw, gh] = group.bounding;
  return x >= gx && x <= gx + gw && y >= gy && y <= gy + gh;
}

function chooseGroup(workflow: Workflow, preferred?: string) {
  const groups = Array.isArray(workflow.groups) ? workflow.groups : [];
  if (groups.length === 0) return null;
  const wanted = normalizeGroupName(preferred || "");
  if (wanted) {
    const exact = groups.find((group) => normalizeGroupName(group.title || "") === wanted);
    if (exact) return exact;
    const fuzzy = groups.find((group) => normalizeGroupName(group.title || "").includes(wanted));
    if (fuzzy) return fuzzy;
  }
  return groups.find((group) => /批量文生图|批量文生圖|文生图|文生圖|txt2img/i.test(normalizeGroupName(group.title || "")))
    || groups.find((group) => /图片推帖子|圖片推帖子|圖文|image/i.test(normalizeGroupName(group.title || "")))
    || groups[0];
}

function findLink(workflow: Workflow, linkId: number) {
  return (workflow.links || []).find((link) => Array.isArray(link) && link[0] === linkId);
}

function inputByLink(workflow: Workflow, node: Node | undefined, linkId: number) {
  return (node?.inputs || []).find((input: any) => input?.link === linkId);
}

function shouldIgnoreEdge(target: Node, input: any) {
  const name = String(input?.name || "");
  if (/SaveImagePlus|ImageBatchSave/i.test(target.type) && /filename|custom_path|path|prefix/i.test(name)) return true;
  if (target.type === "CLIPTextEncode" && name === "text") return true;
  if (target.type === "PromptBatchQueue" && /提示词|prompt|text/i.test(name)) return true;
  return false;
}

function outputNodes(nodes: Node[]) {
  const outputs = nodes.filter((node) => IMAGE_OUTPUT_PATTERN.test(node.type) && !TEXT_OUTPUT_PATTERN.test(node.type));
  const preferred = outputs.filter((node) => /SaveImagePlus|PreviewImage|^SaveImage$/i.test(node.type) && !/ImageBatchSave/i.test(node.type));
  return preferred.length > 0 ? preferred : outputs;
}

function collectAncestors(workflow: Workflow, startIds: number[], allowedIds: Set<number>) {
  const selected = new Set<number>();
  const nodes = workflow.nodes || [];
  const visit = (id: number) => {
    if (selected.has(id) || !allowedIds.has(id)) return;
    const node = nodes.find((item) => item.id === id);
    if (!node) return;
    selected.add(id);
    for (const input of node.inputs || []) {
      if (!input?.link || shouldIgnoreEdge(node, input)) continue;
      const link = findLink(workflow, input.link);
      if (link) visit(Number(link[1]));
    }
  };
  for (const id of startIds) visit(id);
  return selected;
}

function getSelectedNodeIds(workflow: Workflow, workflowGroup?: string) {
  const nodes = workflow.nodes || [];
  const group = chooseGroup(workflow, workflowGroup);
  let groupNodes = group ? nodes.filter((node) => nodeInGroup(node, group)) : nodes;
  let outputs = outputNodes(groupNodes);
  if (outputs.length === 0 && group) {
    groupNodes = nodes;
    outputs = outputNodes(groupNodes);
  }
  if (outputs.length === 0) throw new Error("未找到图片输出节点");
  const selected = collectAncestors(workflow, outputs.map((node) => node.id), new Set(groupNodes.map((node) => node.id)));
  for (const node of outputs) selected.add(node.id);
  return { selected, group, outputIds: outputs.map((node) => node.id) };
}

function usedSubgraphIds(workflow: Workflow, selectedNodes: Node[]) {
  const ids = new Set((workflow.definitions?.subgraphs || []).map((item) => item.id).filter(Boolean));
  return new Set(selectedNodes.map((node) => node.type).filter((type) => ids.has(type)));
}

function cleanWorkflow(workflow: Workflow, selected: Set<number>, group: ReturnType<typeof chooseGroup>) {
  const selectedNodes = (workflow.nodes || []).filter((node) => selected.has(node.id));
  const selectedLinks = (workflow.links || []).filter((link) => Array.isArray(link) && selected.has(Number(link[1])) && selected.has(Number(link[3])));
  const linkIds = new Set(selectedLinks.map((link) => link[0]));
  const nodes = selectedNodes.map((node) => ({
    ...node,
    inputs: (node.inputs || []).map((input: any) => input?.link && !linkIds.has(input.link) ? { ...input, link: null } : input),
  }));
  const subgraphIds = usedSubgraphIds(workflow, selectedNodes);
  return {
    ...workflow,
    nodes,
    links: selectedLinks,
    groups: group ? [group] : [],
    definitions: workflow.definitions
      ? {
          ...workflow.definitions,
          subgraphs: (workflow.definitions.subgraphs || []).filter((item) => item.id && subgraphIds.has(item.id)),
        }
      : undefined,
  };
}

function widgetValue(node: Node, inputName: string, fallbackIndex: number) {
  const values = Array.isArray(node.widgets_values) ? node.widgets_values : [];
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

function singleNodeSubgraph(workflow: Workflow, node: Node): Node | null {
  const definition = workflow.definitions?.subgraphs?.find((item) => item.id === node.type);
  return definition?.nodes?.length === 1 ? definition.nodes[0] : null;
}

function isPositiveClipText(workflow: Workflow, node: Node) {
  if (node.type !== "CLIPTextEncode") return false;
  return (workflow.links || []).some((link) => {
    if (!Array.isArray(link) || link[1] !== node.id) return false;
    const target = workflow.nodes?.find((item) => item.id === link[3]);
    return target?.type === "KSampler" && inputByLink(workflow, target, link[0])?.name === "positive";
  });
}

function sanitize(value: any): any {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    const items = value.map(sanitize);
    return items.some((item) => item === undefined) ? undefined : items;
  }
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]).filter(([, item]) => item !== undefined));
  }
  return value;
}

function buildApiPrompt(workflow: Workflow, selected: Set<number>, personaKey: string, promptSuffix?: string) {
  const prompt = [
    `A realistic daily social media photo of ${personaKey}, clear same-person identity, natural smartphone snapshot`,
    "composition aspect ratio 1:1",
    promptSuffix,
    "no watermark, no logo, no visible text",
  ].filter(Boolean).join(", ");
  const apiPrompt: Record<string, any> = {};
  for (const node of (workflow.nodes || []).filter((item) => selected.has(item.id))) {
    const subgraphNode = singleNodeSubgraph(workflow, node);
    const inputs: Record<string, any> = {};
    let widgetIndex = 0;
    for (const input of node.inputs || []) {
      const name = input?.name;
      if (!name) continue;
      const link = input.link ? findLink(workflow, input.link) : undefined;
      if (link && selected.has(Number(link[1])) && !shouldIgnoreEdge(node, input)) {
        inputs[name] = [String(link[1]), link[2]];
        continue;
      }
      if (input.widget) {
        inputs[name] = widgetValue(node, name, widgetIndex);
        widgetIndex += 1;
      }
    }

    let classType = subgraphNode?.type || node.type;
    if (isPositiveClipText(workflow, node)) inputs.text = prompt;
    if (node.type === "PromptBatchQueue") {
      inputs["提示词文本"] = prompt;
      delete inputs.text;
    }
    if (node.type === "e7b9c3fe-fcf5-4674-8984-5b474e4716d0") {
      classType = "CLIPTextEncode";
      inputs.text = NEGATIVE_PROMPT;
    }
    if (subgraphNode?.type === "CLIPTextEncode") {
      inputs.text ||= Array.isArray(subgraphNode.widgets_values) ? subgraphNode.widgets_values[0] : "";
    }
    if (node.type === "KSampler") inputs.seed = Math.floor(Math.random() * 1_000_000_000_000_000);
    if (/Empty.*LatentImage/i.test(node.type)) {
      inputs.width = 1024;
      inputs.height = 1024;
      inputs.batch_size = 1;
    }
    if (/SaveImagePlus|ImageBatchSave/i.test(node.type)) {
      classType = "SaveImage";
      for (const key of Object.keys(inputs)) {
        if (key !== "images") delete inputs[key];
      }
      inputs.filename_prefix = personaKey;
    }
    apiPrompt[String(node.id)] = { class_type: classType, inputs: sanitize(inputs) };
  }
  return apiPrompt;
}

function validateApiPrompt(apiPrompt: Record<string, any>) {
  const values = Object.values(apiPrompt);
  const imageOutputCount = values.filter((node: any) => IMAGE_OUTPUT_PATTERN.test(String(node.class_type || ""))).length;
  const promptInputCount = values.filter((node: any) => {
    const inputs = node.inputs || {};
    return typeof inputs.text === "string" || typeof inputs.prompt === "string" || typeof inputs["提示词文本"] === "string";
  }).length;
  const malformedCount = values.filter((node: any) => !node.class_type).length;
  return { imageOutputCount, promptInputCount, malformedCount };
}

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

async function main() {
  const cleanDir = path.join(DESKTOP_DIR, "clean-comfyui-workflows");
  const apiDir = path.join(DESKTOP_DIR, "runninghub-api-prompts");
  fs.rmSync(DESKTOP_DIR, { recursive: true, force: true });
  fs.mkdirSync(cleanDir, { recursive: true });
  fs.mkdirSync(apiDir, { recursive: true });

  const results = [];
  for (const seed of WORKFLOW_PERSONA_SEEDS) {
    const imageWorkflow = seed.setup.imageWorkflow;
    if (!imageWorkflow?.workflowFile || !imageWorkflow.personaKey) continue;
    const workflow = readWorkflow(imageWorkflow.workflowFile);
    const { selected, group, outputIds } = getSelectedNodeIds(workflow, imageWorkflow.workflowGroup);
    const cleaned = cleanWorkflow(workflow, selected, group);
    const apiPrompt = buildApiPrompt(workflow, selected, imageWorkflow.personaKey, imageWorkflow.promptSuffix);
    const validation = validateApiPrompt(apiPrompt);
    if (validation.imageOutputCount === 0 || validation.promptInputCount === 0 || validation.malformedCount > 0) {
      throw new Error(`${seed.name} 导出后校验失败：${JSON.stringify(validation)}`);
    }
    const cleanFile = path.join(cleanDir, imageWorkflow.workflowFile);
    const apiFile = path.join(apiDir, imageWorkflow.workflowFile);
    writeJson(cleanFile, cleaned);
    writeJson(apiFile, apiPrompt);
    results.push({
      id: seed.id,
      name: seed.name,
      personaKey: imageWorkflow.personaKey,
      workflowId: imageWorkflow.workflowId,
      fileName: imageWorkflow.workflowFile,
      originalNodes: workflow.nodes?.length || 0,
      cleanNodes: cleaned.nodes?.length || 0,
      originalLinks: workflow.links?.length || 0,
      cleanLinks: cleaned.links?.length || 0,
      outputIds,
      ...validation,
    });
  }

  const manifest = {
    ok: true,
    generatedAt: new Date().toISOString(),
    sourceDir: INPUT_DIR,
    outputDir: DESKTOP_DIR,
    note: "clean-comfyui-workflows 是保留可导入图形工作流的精简版；runninghub-api-prompts 是运行时实际提交给 RunningHub 的最小 API prompt。",
    count: results.length,
    results,
  };
  writeJson(path.join(DESKTOP_DIR, "manifest.json"), manifest);
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
    process.exitCode = 1;
  });
}
