import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(here, "../static/assets/video-workbench.js");
const source = fs.readFileSync(sourcePath, "utf8");

assert.match(source, /subject_replace:\s*"image_generate"/);
assert.match(source, /const VIDEO_PROMPT_MODULES = new Set\(\["digital_human_video", "ecommerce_short_video"\]\)/);

function functionBody(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing ${name}`);
  const brace = source.indexOf("{", start);
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = brace; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") depth -= 1;
    if (depth === 0) return source.slice(brace + 1, index);
  }
  assert.fail(`unterminated ${name}`);
}

function functionBodyUntil(name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`\n  function ${nextName}(`, start);
  assert.notEqual(start, -1, `missing ${name}`);
  assert.notEqual(end, -1, `missing boundary after ${name}`);
  const block = source.slice(start, end);
  return block.slice(block.indexOf("{") + 1, block.lastIndexOf("}"));
}

const confirmedPreview = functionBody("applyConfirmedPromptPreview");
assert.match(confirmedPreview, /!requiresPromptPreview\(module\)/);
assert.match(functionBody("confirmPromptPreview"), /body\.append\("files", file\)/);
assert.match(confirmedPreview, /submitValues\.speech_text\s*=\s*promptPreview\.speech_text/);
assert.match(confirmedPreview, /submitValues\.prompt_text\s*=\s*String\(promptPreview\.prompt_text/);
assert.match(confirmedPreview, /submitValues\.copy_text\s*=\s*submitValues\.speech_text/);
assert.doesNotMatch(confirmedPreview, /!String\(submitValues\.(?:speech_text|prompt_text)/);
assert.match(functionBody("submit"), /!draft\.values\._prompt_preview_ready\s*\|\|\s*!draft\.values\._prompt_preview/);
assert.match(functionBody("submit"), /await generatePromptDraft\(\)/);
assert.match(functionBody("submit"), /applyStoredPromptPreviewForSubmit\(module, submitValues, draft\)/);
const applyConfirmedPromptPreview = Function(
  "requiresPromptPreview",
  `return function applyConfirmedPromptPreview(module, submitValues, promptPreview) {${confirmedPreview}}`,
)((module) => ["digital_human_video", "ecommerce_short_video"].includes(String(module?.id || module || "")));
const confirmedValues = applyConfirmedPromptPreview(
  { id: "ecommerce_short_video" },
  { speech_text: "old speech", copy_text: "old copy", prompt_text: "old prompt", prompt: "old prompt" },
  { speech_text: "confirmed speech", prompt_text: "confirmed prompt", storyboard: [{ prompt: "confirmed shot" }] },
);
assert.equal(confirmedValues.speech_text, "confirmed speech");
assert.equal(confirmedValues.copy_text, "confirmed speech");
assert.equal(confirmedValues.prompt_text, "confirmed prompt");
assert.equal(confirmedValues.prompt, "confirmed prompt");
assert.deepEqual(confirmedValues.prompt_segments, ["confirmed shot"]);

const voiceMapping = functionBody("publicSubmitValues");
assert.match(voiceMapping, /values\.speaker\s*=\s*draft\.values\.voice_name\s*\|\|\s*draft\.values\.speaker\s*\|\|\s*""/);
assert.match(voiceMapping, /values\.elevenlabs_tts_preset_key\s*=\s*draft\.values\.elevenlabs_tts_preset_key/);
assert.match(voiceMapping, /values\.minimax_tts_voice_id\s*=\s*""/);
assert.doesNotMatch(voiceMapping, /values\.voice_id\s*=/);
assert.doesNotMatch(voiceMapping, /values\.speaker[^;]*draft\.values\.voice_id/);

const segmentMapping = functionBody("taskSegments");
assert.match(segmentMapping, /task\?\.completed_segments/);
assert.match(segmentMapping, /completedByIndex/);
assert.match(segmentMapping, /failedTask\s*&&\s*hasDeclaredPlan\s*\?\s*"failed"/);
assert.match(segmentMapping, /endpointIndex/);
assert.match(functionBody("normalizeTask"), /segments:\s*taskSegments\(task, result, status\)/);
const taskSegments = Function(
  `${source.slice(source.indexOf("function segmentRows("), source.indexOf("function taskSegments("))}
   return function taskSegments(task, result, status) {${segmentMapping}}`,
)();
const recoveredSegments = taskSegments({
  completed_segments: [{ index: 1, path: "segment-1.mp4" }],
  storyboard: { items: [{ index: 1, text: "first" }, { index: 2, text: "second" }] },
}, {}, "failed");
assert.deepEqual(recoveredSegments.map((item) => item.endpointIndex), [1, 2]);
assert.deepEqual(recoveredSegments.map((item) => item.status), ["success", "failed"]);
assert.equal(recoveredSegments[1].label, "second");

const explicitMissingSegments = taskSegments({
  completed_segments: [{ index: 1 }],
  raw_result: { segment_count: 3, missing_segment_indices: [2, 3] },
}, {}, "failed");
assert.deepEqual(explicitMissingSegments.map((item) => item.status), ["success", "failed", "failed"]);

const submit = functionBody("submit");
assert.match(submit, /source_text:\s*String\(row\.text/);
assert.match(submit, /if \(requiresPromptPreview\(module\)\)/);
assert.doesNotMatch(submit, /regenerate:\s*true/);
assert.doesNotMatch(submit, /regenerate_revision/);

const parseTimedScriptBody = functionBodyUntil("parseTimedScript", "scriptSource");
assert.doesNotMatch(parseTimedScriptBody, /cursor \+ 3/);
const parseTimedScript = Function(
  "parseTimecode",
  "normalizeTimelineRows",
  `return function parseTimedScript(source) {${parseTimedScriptBody}}`,
)(
  (value) => {
    const parts = String(value).replace(",", ".").split(":").map(Number);
    return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
  },
  (rows) => rows,
);
assert.deepEqual(parseTimedScript("第一句\n第二句"), []);
assert.deepEqual(parseTimedScript("[00:01-00:04] 第一句"), [{ start: 1, end: 4, text: "第一句" }]);

const parseCurrentScriptBody = functionBody("parseCurrentScript");
assert.doesNotMatch(parseCurrentScriptBody, /\/api\/video\/language-script\/parse/);
assert.match(parseCurrentScriptBody, /\/api\/video\/language-script\/analyze/);
assert.match(parseCurrentScriptBody, /video_language_script_step\s*=\s*"inline_timecodes"/);

assert.doesNotMatch(source, /data-video-regenerate-segment=/);
assert.equal(source.includes("function regenerateDraftSegment("), false);
const regenerateTaskSegmentBody = functionBody("regenerateTaskSegment");
assert.match(regenerateTaskSegmentBody, /\/api\/video\/tasks\/\$\{encodeURIComponent\(taskId\)\}\/segments\/\$\{encodeURIComponent\(segmentId\)\}\/regenerate/);
assert.doesNotMatch(regenerateTaskSegmentBody, /\/api\/tasks\/\$\{encodeURIComponent\(taskId\)\}\/retry/);
assert.match(functionBody("renderTaskList"), /canRegenerateTaskSegments\(task\)/);

const subtitleEligibility = functionBody("canAddSubtitlesToTask");
assert.match(subtitleEligibility, /task\.status\s*!==\s*"success"/);
assert.match(subtitleEligibility, /!task\.has_download/);
assert.match(subtitleEligibility, /task\.subtitled/);
assert.match(subtitleEligibility, /taskHasVideoOutput\(task\)/);
const canAddSubtitlesToTask = Function(`
  const VIDEO_OUTPUT_TASK_TYPES = new Set(["create_video", "ecommerce_short_video", "video_language_replace", "replace_model", "replace_product"]);
  function taskOutput(task) {${functionBody("taskOutput")}}
  function taskHasVideoOutput(task) {${functionBody("taskHasVideoOutput")}}
  return function canAddSubtitlesToTask(task) {${subtitleEligibility}};
`)();
assert.equal(canAddSubtitlesToTask({
  status: "success",
  has_download: true,
  subtitleStateKnown: true,
  subtitled: false,
  type: "create_video",
  mediaItems: [{ type: "video" }],
}), true);
assert.equal(canAddSubtitlesToTask({
  status: "success",
  has_download: true,
  subtitleStateKnown: true,
  subtitled: true,
  type: "create_video",
}), false);
const taskHydration = functionBody("hydrateTaskMedia");
assert.match(taskHydration, /!task\.subtitleStateKnown\s*&&\s*taskHasVideoOutput\(task\)/);
assert.match(taskHydration, /Object\.assign\(task, detailedTask, \{ mediaItems \}\)/);
assert.equal(canAddSubtitlesToTask({
  status: "success",
  has_download: true,
  subtitleStateKnown: true,
  subtitled: false,
  type: "image_generate",
  mediaItems: [{ type: "image" }],
}), false);
assert.equal(canAddSubtitlesToTask({
  status: "success",
  has_download: true,
  subtitleStateKnown: false,
  subtitled: false,
  type: "create_video",
}), false);

const subtitleModal = functionBody("renderSubtitleTemplateModal");
assert.match(subtitleModal, /data-video-subtitle-template/);
assert.match(subtitleModal, /data-video-subtitle-confirm/);
assert.match(subtitleModal, /SUBTITLE_TEMPLATE_OPTIONS/);

const subtitleAction = functionBody("addSubtitlesToTask");
assert.match(subtitleAction, /\/api\/tasks\/\$\{encodeURIComponent\(taskId\)\}\/subtitles/);
assert.match(subtitleAction, /method:\s*"POST"/);
assert.match(subtitleAction, /subtitle_template:\s*template/);
assert.match(subtitleAction, /invalidateTaskMedia\(taskId\)/);
assert.match(subtitleAction, /await loadTasks\(\{ quiet:\s*true \}\)/);

assert.match(source, /data-video-task-subtitle/);
assert.doesNotMatch(source, /select\("subtitle_template"/);

const fusionImagesBody = functionBody("fusionImagesFromTask");
const fusionImagesFromTask = Function(`return function fusionImagesFromTask(task) {${fusionImagesBody}}`)();
assert.deepEqual(fusionImagesFromTask({ output: { fusion_images: ["main.png", "view-2.png"] } }), ["main.png", "view-2.png"]);
assert.deepEqual(fusionImagesFromTask({ output: { raw_result: { fusion_images: ["main.png", "view-2.png", "view-3.png"] } } }), ["main.png", "view-2.png", "view-3.png"]);
assert.deepEqual(fusionImagesFromTask({ output: { video_checkpoint: { fusion_images: ["main.png", "view-2.png"] } } }), ["main.png", "view-2.png"]);

const fusionActions = functionBody("renderFusionViewActions");
assert.match(fusionActions, /fusionImages\.slice\(1\)/);
assert.match(fusionActions, /viewIndex\s*=\s*offset\s*\+\s*2/);
assert.match(fusionActions, /重生成视角/);
assert.match(fusionActions, /data-video-task-fusion-view/);
assert.doesNotMatch(fusionActions, /重生成视角 1/);
const renderFusionViewActions = Function(
  "state",
  "escapeHtml",
  `return function renderFusionViewActions(task) {${fusionActions}}`,
)({ fusionViewBusy: {}, fusionHistory: {} }, (value) => String(value));
const fusionActionHtml = renderFusionViewActions({
  id: "task-fusion",
  moduleId: "create_video",
  fusionImages: ["main.png", "view-2.png", "view-3.png"],
});
assert.match(fusionActionHtml, /重生成视角 2/);
assert.match(fusionActionHtml, /重生成视角 3/);
assert.doesNotMatch(fusionActionHtml, /重生成视角 1/);

const regenerateFusionView = functionBody("regenerateTaskFusionView");
assert.match(regenerateFusionView, /\/api\/video\/create-video\/step/);
assert.match(regenerateFusionView, /step:\s*"fusion_view"/);
assert.match(regenerateFusionView, /digital_human_regenerate_view_index:\s*viewIndex/);
assert.match(regenerateFusionView, /invalidateTaskMedia\(taskId\)/);
assert.match(regenerateFusionView, /await loadTasks\(\{ quiet:\s*true \}\)/);
const fusionRequests = [];
const invalidatedFusionTasks = [];
let fusionReloads = 0;
const regenerateTaskFusionView = Function(
  "state",
  "renderTaskPanelOnly",
  "request",
  "invalidateTaskMedia",
  "loadTasks",
  `return async function regenerateTaskFusionView(taskId, requestedViewIndex) {${regenerateFusionView}}`,
)(
  { tasks: [{ id: "task-fusion", fusionImages: ["main.png", "view-2.png"] }], fusionViewBusy: {}, taskError: "" },
  () => {},
  async (url, options) => { fusionRequests.push({ url, options }); return { ok: true }; },
  (taskId) => invalidatedFusionTasks.push(taskId),
  async () => { fusionReloads += 1; },
);
await regenerateTaskFusionView("task-fusion", 2);
assert.equal(fusionRequests.length, 1);
assert.equal(fusionRequests[0].url, "/api/video/create-video/step");
assert.deepEqual(JSON.parse(fusionRequests[0].options.body), {
  task_id: "task-fusion",
  step: "fusion_view",
  params: { digital_human_regenerate_view_index: 2 },
});
assert.deepEqual(invalidatedFusionTasks, ["task-fusion"]);
assert.equal(fusionReloads, 1);
assert.match(source, /data-video-task-fusion-view/);
assert.match(source, /data-video-task-segment-regenerate/);
assert.match(source, /completedSegments\.length\s*>\s*1/);
assert.match(source, /已完成片段/);

// Original app.js contract: digital human has subtitles disabled; seeding enables them.
assert.match(voiceMapping, /add_subtitles:\s*false/);
assert.match(voiceMapping, /subtitle_enabled:\s*false/);
assert.match(voiceMapping, /values\.add_subtitles\s*=\s*true/);
assert.match(voiceMapping, /values\.subtitle_enabled\s*=\s*true/);

console.log("video workbench interaction contract: ok");
