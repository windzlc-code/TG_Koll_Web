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

const authenticatedMediaUrlBody = functionBody("authenticatedMediaUrl");
const authenticatedMediaUrl = Function(
  "safeHttpUrl",
  "window",
  "ADMIN_CONSOLE_SESSION",
  "ADMIN_WORKSPACE_USER_ID",
  `return function authenticatedMediaUrl(value) {${authenticatedMediaUrlBody}}`,
)(
  (value) => String(value || ""),
  { location: { origin: "https://console.test", href: "https://console.test/admin-video.html" } },
  true,
  "42",
);
assert.equal(
  authenticatedMediaUrl("/api/tasks/task-1/media/0"),
  "/api/tasks/task-1/media/0?admin_console=1&admin_workspace_user_id=42",
);
assert.equal(
  authenticatedMediaUrl("https://cdn.example.com/image.png"),
  "https://cdn.example.com/image.png",
);

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
const promptPreviewRequest = functionBody("confirmPromptPreview");
assert.match(promptPreviewRequest, /body\.append\("files", file\)/);
assert.match(promptPreviewRequest, /if \(String\(module\?\.id \|\| module \|\| ""\) === "digital_human_video"\) return preview;/);
assert.match(confirmedPreview, /submitValues\.speech_text\s*=\s*promptPreview\.speech_text/);
assert.match(confirmedPreview, /submitValues\.prompt_text\s*=\s*String\(promptPreview\.prompt_text/);
assert.match(confirmedPreview, /submitValues\.copy_text\s*=\s*submitValues\.speech_text/);
assert.match(confirmedPreview, /const hasAuthoredSpeech = Boolean\(String\(submitValues\.speech_text/);
assert.match(confirmedPreview, /hasOwnProperty\.call\(promptPreview, "speech_text"\) && !hasAuthoredSpeech/);
assert.match(confirmedPreview, /const hasAuthoredPrompt = Boolean\(String\(submitValues\.prompt_text/);
assert.match(confirmedPreview, /hasOwnProperty\.call\(promptPreview, "prompt_text"\) && !hasAuthoredPrompt/);
assert.match(source, /function editGeneratedPromptPreview\(/);
assert.match(source, /data-video-prompt-preview-speech/);
assert.match(source, /AI 文案预览与确认/);
assert.match(source, /function requiresPromptPreviewForSubmit\(/);
assert.match(source, /draft\.values\.speech_text = String\(preview\.speech_text\)\.trim\(\)/);
assert.match(source, /function openVideoInfo\(/);
assert.match(source, /updateVideoSuccess\(\s*progress,/);
assert.match(functionBody("submit"), /!draft\.values\._prompt_preview_ready\s*\|\|\s*!draft\.values\._prompt_preview/);
assert.match(functionBody("submit"), /await generatePromptDraft\(\{ autoSubmit: false \}\)/);
assert.doesNotMatch(functionBody("submit"), /await generatePromptDraft\(\{ autoSubmit: true \}\)/);
assert.match(functionBody("submit"), /applyStoredPromptPreviewForSubmit\(module, submitValues, draft\)/);
assert.match(source, /async function submitPreparedVideoTask\(/);
assert.match(source, /async function submitVisualFinalizeTask\(/);
assert.match(source, /stage: "auto_finalizing"/);
assert.match(source, /const VIDEO_PROGRESS_STEP_DEFINITIONS = \[/);
assert.match(source, /const VIDEO_PUBLIC_PROGRESS_KEYS = new Set\(\["prepare", "generate", "archive"\]\)/);
assert.match(source, /const VIDEO_PUBLIC_PROGRESS_STAGE_MAP = \{/);
assert.match(source, /label: "准备"/);
assert.match(source, /label: "归档"/);
assert.match(source, /function progressStepsForMonitor\(/);
assert.match(source, /steps: progressStepsForMonitor\(monitor, monitor\.stage/);
assert.match(source, /new window\.EventSource\(`/);
assert.match(source, /key: `segment-\$\{index\}`/);
assert.doesNotMatch(source, /applyConfirmedPromptPreview\(module, draft\.values, preview\)/);
const applyConfirmedPromptPreview = Function(
  "requiresPromptPreview",
  `return function applyConfirmedPromptPreview(module, submitValues, promptPreview) {${confirmedPreview}}`,
)((module) => ["digital_human_video", "ecommerce_short_video"].includes(String(module?.id || module || "")));
const confirmedValues = applyConfirmedPromptPreview(
  { id: "ecommerce_short_video" },
  { speech_text: "", copy_text: "", prompt_text: "", prompt: "" },
  { speech_text: "confirmed speech", prompt_text: "confirmed prompt", storyboard: [{ prompt: "confirmed shot" }] },
);
assert.equal(confirmedValues.speech_text, "confirmed speech");
assert.equal(confirmedValues.copy_text, "confirmed speech");
assert.equal(confirmedValues.prompt_text, "confirmed prompt");
assert.equal(confirmedValues.prompt, "confirmed prompt");
assert.deepEqual(confirmedValues.prompt_segments, ["confirmed shot"]);

const authoredValues = applyConfirmedPromptPreview(
  { id: "ecommerce_short_video" },
  { speech_text: "custom speech", copy_text: "custom copy", prompt_text: "custom prompt", prompt: "custom prompt" },
  { speech_text: "confirmed speech", prompt_text: "confirmed prompt", storyboard: [{ prompt: "confirmed shot" }] },
);
assert.equal(authoredValues.speech_text, "custom speech");
assert.equal(authoredValues.copy_text, "custom copy");
assert.equal(authoredValues.prompt_text, "custom prompt");
assert.equal(authoredValues.prompt, "custom prompt");
assert.deepEqual(authoredValues.prompt_segments, ["confirmed shot"]);

const storedPreview = functionBody("applyStoredPromptPreviewForSubmit");
const applyStoredPromptPreviewForSubmit = Function(
  "applyConfirmedPromptPreview",
  `return function applyStoredPromptPreviewForSubmit(module, submitValues, draft) {${storedPreview}}`,
)(applyConfirmedPromptPreview);
const generatedSubmitValues = applyStoredPromptPreviewForSubmit(
  { id: "digital_human_video" },
  { speech_text: "", prompt_text: "", prompt: "", use_ai_copy: true },
  { values: { _prompt_preview: { speech_text: "generated speech", prompt_text: "generated prompt" } } },
);
assert.equal(generatedSubmitValues.speech_text, "generated speech");
assert.equal(generatedSubmitValues.prompt_text, "generated prompt");
assert.equal(generatedSubmitValues.use_ai_copy, false);
const customSubmitValues = applyStoredPromptPreviewForSubmit(
  { id: "digital_human_video" },
  { speech_text: "custom speech", prompt_text: "custom prompt", prompt: "custom prompt" },
  { values: { _prompt_preview: { speech_text: "generated speech", prompt_text: "generated prompt" } } },
);
assert.equal(customSubmitValues.speech_text, "custom speech");
assert.equal(customSubmitValues.prompt_text, "custom prompt");
assert.equal(customSubmitValues.prompt, "custom prompt");

const promptRequirement = functionBody("requiresPromptPreviewForSubmit");
const requiresPromptPreviewForSubmit = Function(
  "requiresPromptPreview",
  `return function requiresPromptPreviewForSubmit(module, values = {}) {${promptRequirement}}`,
)((module) => ["digital_human_video", "ecommerce_short_video"].includes(String(module?.id || module || "")));
assert.equal(requiresPromptPreviewForSubmit({ id: "digital_human_video" }, { speech_text: "用户已填写的口播" }), false);
assert.equal(requiresPromptPreviewForSubmit({ id: "digital_human_video" }, { speech_text: "" }), true);
assert.equal(requiresPromptPreviewForSubmit({ id: "ecommerce_short_video" }, { speech_text: "用户已填写的口播" }), true);

assert.match(source, /function renderDigitalHumanSettings\(/);
const digitalHumanSettings = functionBody("renderDigitalHumanSettings");
assert.doesNotMatch(digitalHumanSettings, /video-subsection-heading/);
assert.doesNotMatch(digitalHumanSettings, /CONTENT REFERENCE|FINAL INPUT|OUTPUT SETTINGS/);
assert.doesNotMatch(source, /function renderWorkbenchHero\(/);
assert.doesNotMatch(source, /video-workbench-hero/);
assert.doesNotMatch(digitalHumanSettings, /prompt_text/);

const invalidatePreview = functionBody("invalidatePromptPreview");
const invalidatePromptPreview = Function(
  "requiresPromptPreview",
  `return function invalidatePromptPreview(module, draft, changedKey = "") {${invalidatePreview}}`,
)((module) => String(module?.id || module) === "digital_human_video");
const staleDraft = { values: { _prompt_preview: { speech_text: "stale" }, _prompt_preview_ready: true } };
invalidatePromptPreview({ id: "digital_human_video" }, staleDraft, "speech_text");
assert.equal(staleDraft.values._prompt_preview, undefined);
assert.equal(staleDraft.values._prompt_preview_ready, false);
assert.equal(staleDraft.values._prompt_preview_confirmed, undefined);

const generatedDraft = { values: {
  product_details: "旧产品信息",
  speech_text: "旧 AI 文案",
  _prompt_preview: { speech_text: "旧 AI 文案" },
  _generated_speech_text: "旧 AI 文案",
  _prompt_preview_ready: true,
} };
const invalidatedGeneratedSpeech = invalidatePromptPreview({ id: "digital_human_video" }, generatedDraft, "product_details");
assert.equal(invalidatedGeneratedSpeech, true);
assert.equal(generatedDraft.values.speech_text, "");
assert.equal(generatedDraft.values._prompt_preview_stale, true);

const authoredDraft = { values: {
  product_details: "旧产品信息",
  speech_text: "用户自己写的文案",
  _prompt_preview: { speech_text: "旧 AI 文案" },
  _generated_speech_text: "旧 AI 文案",
  _prompt_preview_ready: true,
} };
assert.equal(invalidatePromptPreview({ id: "digital_human_video" }, authoredDraft, "product_details"), false);
assert.equal(authoredDraft.values.speech_text, "用户自己写的文案");

const sameTextManualDraft = { values: {
  product_details: "旧产品信息",
  speech_text: "与 AI 相同的手动文案",
  _prompt_preview: { speech_text: "与 AI 相同的手动文案" },
  _generated_speech_text: "与 AI 相同的手动文案",
  _speech_text_source: "ai",
  _prompt_preview_ready: true,
} };
invalidatePromptPreview({ id: "digital_human_video" }, sameTextManualDraft, "speech_text");
assert.equal(sameTextManualDraft.values._speech_text_source, "manual");
assert.equal(invalidatePromptPreview({ id: "digital_human_video" }, sameTextManualDraft, "product_details"), false);
assert.equal(sameTextManualDraft.values.speech_text, "与 AI 相同的手动文案");

const voiceMapping = functionBody("publicSubmitValues");
assert.match(voiceMapping, /values\.speaker\s*=\s*draft\.values\.voice_name\s*\|\|\s*draft\.values\.speaker\s*\|\|\s*""/);
assert.match(voiceMapping, /values\.elevenlabs_tts_preset_key\s*=\s*draft\.values\.elevenlabs_tts_preset_key/);
assert.match(voiceMapping, /values\.elevenlabs_tts_voice_id\s*=\s*draft\.values\.voice_id/);
assert.match(voiceMapping, /values\.minimax_tts_voice_id\s*=\s*""/);
assert.doesNotMatch(voiceMapping, /values\.voice_id\s*=/);
assert.doesNotMatch(voiceMapping, /values\.speaker[^;]*draft\.values\.voice_id/);
assert.match(source, /voiceLanguageChanged\s*=\s*VOICE_MODULES\.has\(module\.id\)\s*&&\s*field\.key\s*===\s*"target_language"/);
assert.match(functionBody("handleFieldChange"), /state\.voiceModalOpen\)\s*refreshVoicePresetListInPlace\(module, draft\)/);
assert.match(functionBody("previewVoice"), /audio\.pause\(\)/);
assert.match(functionBody("previewVoice"), /audio\.play\(\)/);
assert.match(source, /data-video-voice-presets/);
assert.match(source, /data-video-file-state/);
assert.match(source, /workbenchIcon\(active \? "pause" : "play"\)/);
assert.match(source, /音色列表已按/);
assert.doesNotMatch(source, /data-video-voice-filter/);
assert.doesNotMatch(source, /data-video-reload-voices/);

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
assert.match(submit, /if \(requiresPromptPreviewForSubmit\(module, submitValues\)\)/);
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
  "openVideoProgress",
  "updateVideoSuccess",
  `return async function regenerateTaskFusionView(taskId, requestedViewIndex) {${regenerateFusionView}}`,
)(
  { tasks: [{ id: "task-fusion", fusionImages: ["main.png", "view-2.png"] }], fusionViewBusy: {}, taskError: "" },
  () => {},
  async (url, options) => { fusionRequests.push({ url, options }); return { ok: true }; },
  (taskId) => invalidatedFusionTasks.push(taskId),
  async () => { fusionReloads += 1; },
  () => ({ isOpen: () => true, update: () => {} }),
  () => {},
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
