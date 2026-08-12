import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
STATIC_ROOT = REPO_ROOT / "webapp" / "static"


class MediaUploadComponentContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.script = (STATIC_ROOT / "assets" / "console.js").read_text(encoding="utf-8")
        cls.styles = (STATIC_ROOT / "assets" / "console.css").read_text(encoding="utf-8")

    def test_upload_component_keeps_multi_file_input_and_thumbnail_grid(self):
        self.assertIn('type="file" ${multiple ? "multiple" : ""}', self.script)
        self.assertIn('class="upload-thumbnail-grid ${publicMediaCards ?', self.script)
        self.assertIn('class="file-preview-frame', self.script)
        self.assertIn('class="upload-add-media ${publicMediaCards ?', self.script)
        self.assertIn('alt=""', self.script)
        self.assertIn('zone.classList.toggle("has-files", files.length > 0);', self.script)
        self.assertIn("appendUploadDropzoneFiles(input, input.files);", self.script)
        self.assertIn("uploadFileSignature(file)", self.script)
        self.assertIn("Number(file?.lastModified || 0)", self.script)
        self.assertIn('input.dispatchEvent(new Event("change", { bubbles: true }));', self.script)
        self.assertIn("function currentUploadDropzoneFiles(input)", self.script)
        self.assertIn("return currentUploadDropzoneFiles(node);", self.script)

    def test_drag_and_picker_share_one_file_collection_and_append_path(self):
        self.assertNotIn("const uploadTrackedFiles = new WeakMap();", self.script)
        self.assertIn("uploadFilesById.has(stateKey)", self.script)
        self.assertIn("function appendUploadDropzoneFiles(input, incomingFiles", self.script)
        self.assertIn("appendUploadDropzoneFiles(input, fileList, { notify: true });", self.script)
        self.assertIn("appendUploadDropzoneFiles(input, input.files);", self.script)

    def test_upload_component_supports_individual_and_selected_deletion(self):
        self.assertIn("data-upload-remove-index", self.script)
        self.assertIn("data-upload-select-index", self.script)
        self.assertIn("file-chip-select-checkbox", self.script)
        self.assertIn("${renderUploadSelectionIcon(isSelected)}", self.script)
        self.assertIn("data-upload-select-all", self.script)
        self.assertIn("data-upload-delete-selected", self.script)
        self.assertIn(
            '<button type="button" class="upload-delete-selected unified-action-icon-button"',
            self.script,
        )
        self.assertIn('${selectedIndexes.size ? "" : "hidden"}', self.script)
        self.assertNotIn('data-upload-delete-selected="${esc(input.id)}" disabled', self.script)
        self.assertIn("removeUploadDropzoneFiles(input, indexes)", self.script)
        self.assertIn("assignUploadDropzoneFiles(input, remaining);", self.script)
        self.assertIn("const selectedFiles = new Set(", self.script)
        self.assertIn("selectedFiles.has(file) ? index : -1", self.script)

    def test_upload_empty_state_has_no_nested_unselected_file_block(self):
        self.assertNotIn("upload-empty-state", self.script)
        self.assertIn('data-upload-file-list="${esc(id)}" hidden', self.script)
        self.assertIn("host.hidden = !files.length;", self.script)
        self.assertIn(".file-strip[hidden] {\n  display: none;", self.styles)

    def test_upload_thumbnail_reuses_media_viewer_and_aligned_icon_controls(self):
        self.assertIn("uploadPreviewGroupIds", self.script)
        self.assertIn("registerMediaPreviewGroup", self.script)
        self.assertIn("file-chip-action file-chip-view", self.script)
        self.assertIn("data-media-preview-group", self.script)
        self.assertIn("${renderEyeIcon()}", self.script)
        self.assertIn("${renderPlusIcon()}", self.script)
        self.assertIn(".file-chip-actions {", self.styles)
        self.assertIn(".file-chip-action :is(.ui-eye-icon, .ui-trash-icon, .ui-replace-icon)", self.styles)
        self.assertIn("display: block;", self.styles)
        self.assertIn("line-height: 0;", self.styles)

    def test_upload_drag_capture_accepts_data_transfer_items(self):
        self.assertIn("function uploadFilesFromDataTransfer(dataTransfer)", self.script)
        self.assertIn('item?.kind === "file"', self.script)
        self.assertIn("uploadFilesFromDataTransfer(event.dataTransfer)", self.script)
        self.assertIn('document.addEventListener("drop", handleUploadDrop, true);', self.script)
        self.assertIn('draggable="false"', self.script)
        self.assertIn("handleUploadPreviewDragStart", self.script)

    def test_upload_zone_allows_physical_drag_before_file_payload_is_exposed(self):
        drag_enter = self.script.split("function handleUploadDragEnter(event)", 1)[1].split(
            "function handleUploadDragOver",
            1,
        )[0]
        drag_over = self.script.split("function handleUploadDragOver(event)", 1)[1].split(
            "function handleUploadDragLeave",
            1,
        )[0]
        drop = self.script.split("function handleUploadDrop(event)", 1)[1].split(
            "function handleUploadPreviewDragStart",
            1,
        )[0]
        self.assertNotIn("uploadDataTransferHasFiles(event.dataTransfer)", drag_enter)
        self.assertNotIn("uploadDataTransferHasFiles(event.dataTransfer)", drag_over)
        self.assertNotIn("uploadDataTransferHasFiles(event.dataTransfer)", drop)
        self.assertIn("event.preventDefault();", drag_enter)
        self.assertIn("event.preventDefault();", drag_over)
        self.assertIn("const files = uploadFilesFromDataTransfer(event.dataTransfer);", drop)
        self.assertIn("if (!files.length) return;", drop)
        self.assertIn('event.target?.closest?.("[data-upload-sort-card]")', self.script)
        self.assertIn("event.stopImmediatePropagation();", self.script)
        self.assertIn("-webkit-user-drag: none;", self.styles)
        self.assertIn('typeof event?.composedPath === "function"', self.script)

    def test_upload_dropzone_does_not_restore_the_blocking_input_overlay(self):
        self.assertIn('data-upload-dropzone>', self.script)
        self.assertNotIn('<label class="upload-zone" data-upload-dropzone>', self.script)
        input_styles = self.styles.split(".upload-zone-input {", 1)[1].split("}", 1)[0]
        self.assertIn("width: 1px;", input_styles)
        self.assertIn("height: 1px;", input_styles)
        self.assertIn("pointer-events: none;", input_styles)
        file_strip_styles = self.styles.split(".file-strip {", 1)[1].split("}", 1)[0]
        self.assertNotIn("pointer-events: none;", file_strip_styles)

    def test_upload_component_keeps_files_when_data_transfer_assignment_is_unsupported(self):
        self.assertIn("const uploadSyntheticChangeInputs = new WeakSet();", self.script)
        self.assertIn('if (typeof DataTransfer === "function") {', self.script)
        self.assertIn("} catch (_error) {", self.script)
        self.assertIn("if (uploadSyntheticChangeInputs.has(input)) return;", self.script)
        self.assertIn("function currentUploadDropzoneFiles(input)", self.script)

    def test_hotspot_edit_waits_until_confirmation_before_platform_import(self):
        starter = self.script[
            self.script.index("function startPersonaHotCandidateEdit"):
            self.script.index("\nfunction cancelPersonaHotCandidateEdit")
        ]
        handler = self.script[
            self.script.index('const startHotEditButton = event.target.closest("[data-persona-start-hot-edit]")'):
            self.script.index('const hotBulkButton = event.target.closest', self.script.index('const startHotEditButton = event.target.closest("[data-persona-start-hot-edit]")'))
        ]

        self.assertIn("form.hotEditingCandidateId = cleanCandidateId;", starter)
        self.assertIn("form.hotPreviewId = cleanCandidateId;", starter)
        self.assertIn('modalKey: "persona-hot-editor"', starter)
        self.assertIn("modal.__requestClose = async (result) =>", starter)
        self.assertLess(starter.index('modalKey: "persona-hot-editor"'), starter.index("importPersonaHotDrafts"))
        self.assertIn("applyStoredEdits: true, choosePlatform: true", starter)
        self.assertNotIn("choosePublishPlatformAccount", starter)
        self.assertIn("data-persona-hot-content-editor", self.script)
        self.assertIn("renderPersonaHotCandidateEditorModal", self.script)
        self.assertIn("startPersonaHotCandidateEdit(persona, candidateId);", handler)
        self.assertNotIn("importPersonaHotDrafts", handler)
        self.assertNotIn("openPersonaHotCandidateInDraftEditor", self.script)

    def test_hotspot_cards_open_media_and_source_without_detail_modal(self):
        self.assertIn('class="row-actions persona-hot-card-actions"', self.script)
        self.assertIn('target="_blank" rel="noopener">打开帖子</a>', self.script)
        self.assertIn('data-persona-start-hot-edit="${esc(candidateId)}"', self.script)
        self.assertIn(">编辑</button>", self.script)
        self.assertNotIn("async function openPersonaHotCandidateDetail", self.script)
        self.assertNotIn('data-persona-view-hot-candidate=', self.script)
        self.assertNotIn('modalKey: "persona-hot-candidate-detail"', self.script)
        self.assertIn('class="persona-edit-media-grid persona-hot-media-grid is-previewing"', self.script)
        self.assertIn('class="persona-edit-media-card persona-hot-media-item"', self.script)
        self.assertIn('className: "persona-edit-media-preview"', self.script)
        self.assertIn('class="persona-edit-media-order persona-hot-media-index-badge"', self.script)
        self.assertIn('interactive: Boolean(previewGroupId) && itemPreviewIndex >= 0,', self.script)
        self.assertIn(".persona-hot-card-actions a {", self.styles)
        self.assertIn("justify-content: center;", self.styles)

    def test_hotspot_editor_reuses_public_modal_and_complete_media_editor(self):
        modal_renderer = self.script[
            self.script.index("function renderPersonaHotCandidateEditorModal"):
            self.script.index("\nfunction choosePersonaHotEditorFiles")
        ]
        editor_renderer = self.script[
            self.script.index("function renderPersonaEditableMediaGrid"):
            self.script.index("\nfunction renderPersonaImageUploadPlaceholderCard")
        ]

        self.assertIn("renderPersonaEditableMediaGrid(mediaItems, {", modal_renderer)
        self.assertIn('mode: "hot"', modal_renderer)
        self.assertIn("data-persona-hot-content-editor", modal_renderer)
        self.assertIn("data-persona-hot-editor-media-input", editor_renderer)
        self.assertIn("data-persona-hot-editor-media-replace", editor_renderer)
        self.assertIn("data-persona-hot-editor-media-delete", editor_renderer)
        self.assertIn("data-persona-hot-media-delete-selected", editor_renderer)
        self.assertIn("data-persona-media-drag-handle", self.script)
        self.assertIn("preparePersonaDraftMediaOps(operations)", self.script)
        self.assertIn("preparedMediaOpsByCandidate", self.script)
        self.assertIn('.persona-hot-editor-modal {', self.styles)

    def test_hotspot_cards_show_source_identity_all_media_and_merged_heat_views(self):
        picker = self.script[
            self.script.index("function renderPersonaHotCandidatePicker"):
            self.script.index("\nfunction personaMediaTaskOptions")
        ]
        metrics = self.script[
            self.script.index("function personaHotMetricSummary"):
            self.script.index("\nfunction normalizePersonaHotSearchMode")
        ]

        self.assertIn("renderPersonaHotSourceIdentity(candidate)", picker)
        self.assertIn("renderPersonaHotMediaPreview(persona, candidate)", picker)
        source_identity = self.script[
            self.script.index("function renderPersonaHotSourceIdentity"):
            self.script.index("\nfunction normalizePersonaHotSearchMode")
        ]
        self.assertNotIn("来源人设", source_identity)
        self.assertNotIn("persona-hot-source-avatar", source_identity)
        self.assertIn("persona-hot-source-byline", source_identity)
        self.assertIn("persona-hot-source-context", source_identity)
        self.assertIn('["热度/浏览", personaHotCombinedViewMetric(candidate)]', metrics)
        self.assertNotIn('["热度",', metrics)
        self.assertNotIn('["浏览",', metrics)

    def test_hotspot_import_uses_public_platform_picker_before_writing_drafts(self):
        importer = self.script[
            self.script.index("async function importPersonaHotDrafts"):
            self.script.index("\nfunction resetPersonaDraftEditor", self.script.index("async function importPersonaHotDrafts"))
        ]
        submitter = self.script[
            self.script.index("async function submitPersonaHotDraftImport"):
            self.script.index("\nasync function importPersonaHotDrafts")
        ]
        handler = self.script[
            self.script.index('if (event.target.closest("[data-persona-import-hot-drafts]"))'):
            self.script.index('const hotMediaReplace = event.target.closest', self.script.index('if (event.target.closest("[data-persona-import-hot-drafts]"))'))
        ]

        self.assertIn("await choosePublishPlatformAccount(persona, {", importer)
        self.assertIn('title: "选择导入平台"', importer)
        self.assertIn('confirmText: "导入草稿"', importer)
        self.assertIn("targetPlatform", submitter)
        self.assertIn("platform: resolvedTargetPlatform", submitter)
        self.assertIn("choosePlatform: true", handler)

    def test_mobile_hotspot_cards_expand_without_inline_single_preview(self):
        mobile_hotspot = self.styles.split("@media (max-width: 980px) {\n  .persona-hot-layout {", 1)[1].split("\n}", 1)[0]
        self.assertIn("grid-template-columns: 1fr;", mobile_hotspot)
        self.assertIn(".persona-hot-grid {", mobile_hotspot)
        self.assertIn("max-height: none;", mobile_hotspot)
        self.assertIn("overflow: visible;", mobile_hotspot)
        self.assertIn(".persona-hot-preview {", mobile_hotspot)
        self.assertIn("display: none;", mobile_hotspot)

    def test_upload_files_survive_component_rerenders(self):
        self.assertIn("const uploadFilesById = new Map();", self.script)
        self.assertIn("queueMicrotask(() => restoreUploadDropzoneFiles(id));", self.script)
        self.assertIn("function restoreUploadDropzoneFiles(inputId)", self.script)
        self.assertIn("uploadFilesById.set(stateKey, selected);", self.script)
        self.assertIn("function clearUploadDropzoneState(inputId, capturedStateKey", self.script)
        self.assertIn("function captureUploadDropzoneState(inputId)", self.script)
        self.assertIn("function uploadDropzoneStateKey(inputOrId)", self.script)
        self.assertIn('"personaMediaTaskFiles"', self.script)
        self.assertIn('"personaPublishFiles"', self.script)
        self.assertIn("`${inputId}:${personaId}:${source}:${postId}`", self.script)
        self.assertIn("currentStateKey !== stateKey", self.script)

    def test_persona_publish_snapshots_files_before_busy_rerender(self):
        snapshot = self.script.index('const publishUploadState = captureUploadDropzoneState("personaPublishFiles");')
        rerender = self.script.index("renderPersonaDetail();", snapshot)
        upload = self.script.index('uploadAutomationMedia(publishFiles, "commandMsg")', rerender)
        self.assertLess(snapshot, rerender)
        self.assertLess(rerender, upload)

    def test_upload_thumbnails_are_visible_in_persona_media_editor(self):
        self.assertIn(".upload-thumbnail-grid {", self.styles)
        self.assertIn(".file-chip--preview.is-selected", self.styles)
        self.assertIn(".upload-zone.has-files .upload-zone-picker {\n  display: none;", self.styles)
        self.assertIn("aspect-ratio: 1;", self.styles)
        self.assertIn(
            ".persona-media-edit-pane--upload .upload-zone .file-strip:not([hidden]) {\n  display: grid;",
            self.styles,
        )

    def test_persona_media_editor_uses_one_wysiwyg_grid_and_card_actions(self):
        self.assertIn("data-persona-unified-media-editor", self.script)
        self.assertIn("data-persona-direct-media-input", self.script)
        self.assertIn("acceptPersonaDirectMediaFiles(input, files);", self.script)
        self.assertNotIn("data-persona-upload-post-media", self.script)
        self.assertNotIn("<strong>当前媒体</strong>", self.script)
        self.assertIn('data-persona-edit-post-media="${esc(index)}"', self.script)
        self.assertIn('title="编辑媒体"', self.script)
        self.assertNotIn('data-persona-attach-task-media="replace"', self.script)
        self.assertIn('["replace", "自定义上传"]', self.script)
        self.assertIn('["generate", "AI 生成"]', self.script)
        self.assertIn('aria-label="配图模式"', self.script)
        self.assertIn("function renderEyeIcon()", self.script)
        self.assertIn("function renderReplaceIcon(", self.script)
        self.assertIn("function renderEditIcon()", self.script)
        self.assertIn("function renderPlusIcon()", self.script)
        self.assertIn("function renderTrashIcon()", self.script)
        self.assertIn("${renderEyeIcon()}</button>", self.script)
        self.assertIn("${renderPlusIcon()}</button>", self.script)
        self.assertIn("${renderEditIcon()}</summary>", self.script)
        self.assertIn("${renderTrashIcon()}</span>", self.script)
        self.assertNotIn("function renderMediaCardViewIcon()", self.script)
        self.assertNotIn("function renderMediaCardEditIcon()", self.script)
        self.assertIn(".ui-eye-icon", self.styles)
        self.assertIn(".ui-replace-icon", self.styles)
        self.assertIn(".ui-trash-icon", self.styles)

    def test_compose_media_upload_mode_uses_one_compact_plus_picker(self):
        renderer_start = self.script.index("function renderPersonaCompactMediaUpload(persona, post = null)")
        renderer_end = self.script.index(
            "\nfunction renderPersonaPendingMediaInput(persona)",
            renderer_start,
        )
        renderer = self.script[renderer_start:renderer_end]
        self.assertIn('accept="image/*,video/*"', renderer)
        self.assertIn('class="account-pool-add-button persona-compose-media-upload-trigger"', renderer)
        self.assertIn('<span aria-hidden="true"></span>', renderer)
        self.assertIn("<strong>添加媒体</strong>", renderer)
        self.assertIn('title="上传图片或视频"', renderer)
        self.assertIn('directUpload ? "data-persona-direct-media-input"', renderer)
        self.assertNotIn("选择媒体文件", renderer)
        self.assertNotIn("拖动图片或视频", renderer)
        self.assertIn(
            ".persona-compose-media-upload .account-pool-add-button.persona-compose-media-upload-trigger {",
            self.styles,
        )
        upload_trigger_styles = self.styles.split(
            ".persona-compose-media-upload .account-pool-add-button.persona-compose-media-upload-trigger {",
            1,
        )[1].split("}", 1)[0]
        self.assertIn("justify-content: center;", upload_trigger_styles)
        self.assertIn("width: 100%;", upload_trigger_styles)

    def test_persona_media_bulk_selection_keeps_actions_visible_and_count_centered(self):
        self.assertIn("function renderPersonaPublicMediaSelectionToolbar", self.script)
        self.assertGreaterEqual(self.script.count("renderPersonaPublicMediaSelectionToolbar({"), 2)
        self.assertIn("data-persona-media-select-index", self.script)
        self.assertIn("data-persona-media-select-all", self.script)
        self.assertIn('persona-media-selection-toolbar ${allSelected ? "is-all-selected" : ""}', self.script)
        self.assertIn('toolbar.classList.toggle("is-all-selected", allSelected);', self.script)
        self.assertIn("function togglePersonaMediaBulkSelection", self.script)
        self.assertIn("function deleteSelectedPersonaPostMedia", self.script)
        self.assertIn('data-persona-hot-media-delete-selected', self.script)
        self.assertIn('data-persona-media-delete-selected', self.script)
        self.assertIn("deleteSelected.disabled = selected.size === 0;", self.script)
        self.assertIn(
            ".persona-media-selection-toolbar {\n  position: relative;\n  display: flex;\n  justify-content: flex-end;",
            self.styles,
        )
        self.assertIn(
            ".persona-media-selection-toolbar .upload-selection-count {\n  position: absolute;\n  left: 50%;",
            self.styles,
        )
        self.assertIn(
            ".persona-media-selection-toolbar .upload-delete-selected:disabled {",
            self.styles,
        )
        self.assertIn(
            ".persona-media-selection-toolbar .upload-delete-selected {\n  margin-left: 8px;",
            self.styles,
        )

    def test_persona_media_cards_have_order_badges_and_pointer_reordering(self):
        self.assertIn("data-persona-media-sort-grid", self.script)
        public_order = self.script.split("function renderPersonaPublicMediaOrder", 1)[1].split(
            "function renderPersonaPublicMediaEditMenu", 1
        )[0]
        self.assertIn('dragKind === "upload" ? "data-upload-sort-handle"', public_order)
        self.assertIn('class="persona-public-media-order"', public_order)
        self.assertNotIn("renderMediaOrderHandle", public_order)
        self.assertIn('${renderPersonaPublicMediaOrder(index, { draggable: true })}', self.script)
        self.assertIn('${renderPersonaPublicMediaOrder(index, { draggable: true, dragKind: "upload" })}', self.script)
        self.assertIn('<span class="media-order-number">${esc(order)}</span>', self.script)
        self.assertIn('data-persona-media-card-index="${esc(index)}"', self.script)
        self.assertIn("function handlePersonaMediaPointerDown(event)", self.script)
        self.assertIn("function handlePersonaMediaPointerMove(event)", self.script)
        self.assertIn("function handlePersonaMediaPointerUp(event)", self.script)
        self.assertIn("if (wasActive) updatePersonaMediaPointerDragTarget(event.clientX, event.clientY);", self.script)
        self.assertIn("function handlePersonaMediaSortKeydown(event)", self.script)
        self.assertIn('drag.captureTarget?.setPointerCapture?.(event.pointerId);', self.script)
        self.assertIn("personaMediaMoveLocks.has(moveKey)", self.script)
        self.assertIn("personaMediaMoveLocks.delete(moveKey)", self.script)
        self.assertIn("item.offsetTop !== firstRowTop", self.script)
        self.assertIn('queuePersonaDraftMediaChange("move"', self.script)
        self.assertIn('type: "move"', self.script)
        self.assertIn(".persona-edit-media-order {", self.styles)
        self.assertIn("touch-action: none;", self.styles)
        self.assertIn(".persona-media-drag-ghost {", self.styles)
        self.assertIn(
            ".persona-unified-media-editor .persona-edit-media-grid {\n  width: 100%;\n  grid-template-columns: repeat(2, minmax(0, 1fr));",
            self.styles,
        )
        self.assertIn(
            ".persona-unified-media-editor .persona-edit-media-grid {\n    grid-template-columns: repeat(2, minmax(0, 1fr));",
            self.styles,
        )
        self.assertIn("border: 2px solid var(--accent);", self.styles)
        self.assertIn("font-weight: 950;", self.styles)
        self.assertIn("const items = personaDraftMediaPreviewItems(persona, source, post);", self.script)
        self.assertIn("return Math.min(Math.max(hitIndex, 0), cards.length - 1);", self.script)
        self.assertNotIn("const adjustedSlot = insertSlot > fromIndex ? insertSlot - 1 : insertSlot;", self.script)

    def test_persona_media_card_controls_use_scoped_icons_and_single_selection_ring(self):
        self.assertIn("function renderPersonaMediaSelectionIcon(selected)", self.script)
        self.assertIn('if (!selected) return "";', self.script)
        self.assertIn("function renderEyeIcon()", self.script)
        self.assertIn('<circle cx="12" cy="12" r="2.5"></circle>', self.script)
        self.assertIn("function renderReplaceIcon(", self.script)
        self.assertIn("function renderEditIcon()", self.script)
        self.assertIn("function renderPlusIcon()", self.script)
        self.assertNotIn("ui-media-card-view-icon", self.script)
        self.assertNotIn("ui-media-card-edit-icon", self.script)
        self.assertIn("function renderTrashIcon()", self.script)
        self.assertIn(".persona-public-media-select .persona-media-selection-icon", self.styles)
        self.assertIn("width: 17px;\n  height: 17px;", self.styles)
        self.assertIn("background: color-mix(in srgb, var(--panel-solid) 94%, transparent);", self.styles)
        order_rule = self.styles.split(".persona-public-media-order {", 1)[1].split("}", 1)[0]
        self.assertIn("width: 26px !important;", order_rule)
        self.assertIn("height: 26px !important;", order_rule)
        self.assertIn("border-radius: 50% !important;", order_rule)
        self.assertIn("button.persona-public-media-select {", self.styles)
        self.assertIn('button.persona-public-media-select[aria-pressed="true"]', self.styles)
        self.assertIn("border-radius: 50%;", self.styles)

    def test_ai_generation_reuses_horizontal_image_upload_without_preview_tile(self):
        self.assertNotIn('data-persona-media-ai-edit="${esc(index)}"', self.script)
        self.assertNotIn("function openPersonaPostMediaInAiEditor", self.script)
        self.assertNotIn("function personaMediaItemToImageFile", self.script)
        self.assertNotIn("function addPersonaTaskPreviewImages(fileList)", self.script)
        self.assertNotIn("data-persona-task-media-upload", self.script)
        self.assertNotIn("local-media-upload-", self.script)
        self.assertNotIn("appendedResults", self.script)
        self.assertNotIn("renderPersonaTaskMediaPreview(null, [])", self.script)
        self.assertNotIn("function renderPersonaPublicMediaAddTile(inputId", self.script)
        self.assertGreaterEqual(self.script.count('renderUploadDropzone("personaMediaTaskFiles"'), 2)
        self.assertGreaterEqual(self.script.count('label: "添加媒体"'), 2)
        self.assertGreaterEqual(self.script.count('hint: "仅支持图片；可作为 AI 生成的参考素材。"'), 2)
        self.assertIn('class="account-pool-add-button upload-zone-mobile-picker"', self.script)
        self.assertIn("const mediaUploadState = captureUploadDropzoneState(\"personaMediaTaskFiles\");", self.script)
        self.assertIn('files.forEach((file) => body.append("files", file, file.name));', self.script)
        self.assertNotIn("persona-task-media-add-tile", self.script)
        self.assertIn("${renderPlusIcon()}", self.script)
        self.assertNotIn(".persona-task-media-add-tile {", self.styles)
        self.assertIn(".persona-public-media-add-tile {", self.styles)
        public_add_tile = self.styles.split(".persona-public-media-add-tile {", 1)[1].split("}", 1)[0]
        self.assertIn("min-height: 0;", public_add_tile)
        self.assertNotIn("height: 100%;", public_add_tile)
        self.assertNotIn("aspect-ratio: auto;", public_add_tile)
        self.assertGreaterEqual(self.script.count('renderUploadDropzone("personaMediaEditSourceFile"'), 2)
        self.assertGreaterEqual(self.script.count('accept: "image/*"'), 2)
        self.assertGreaterEqual(self.script.count("imageEditSource: true"), 2)
        self.assertGreaterEqual(self.script.count("publicMediaCards: true"), 4)
        self.assertIn('publicMediaCards ? "data-public-media-cards" : ""', self.script)
        self.assertIn('input.matches("[data-public-media-cards]")', self.script)
        self.assertIn('class="persona-public-media-card persona-upload-media-card', self.script)
        self.assertIn('renderPersonaPublicMediaFooter(index, actions)', self.script)
        self.assertIn('class="upload-thumbnail-grid ${publicMediaCards ? "persona-public-media-upload-grid" : ""}', self.script)
        self.assertIn('.upload-thumbnail-grid.persona-public-media-upload-grid {', self.styles)
        compact_upload = self.script.split("function renderPersonaCompactMediaUpload", 1)[1].split(
            "function renderPersonaPendingMediaInput", 1
        )[0]
        pending_upload = self.script.split("function renderPersonaPendingMediaInput", 1)[1].split(
            "function renderPersonaMediaComposerPlaceholder", 1
        )[0]
        self.assertIn("data-public-media-cards", compact_upload)
        self.assertIn("data-public-media-cards", pending_upload)
        self.assertIn('input.matches?.("[data-persona-image-edit-source]")', self.script)
        self.assertIn("files = imageFiles.slice(-1);", self.script)
        self.assertIn("const files = modifyItem ? [] : mediaUploadState.files;", self.script)

    def test_ai_upload_lives_inside_task_preview_and_replaces_only_preview_content(self):
        inline = self.script.split("function renderPersonaInlineMediaComposer", 1)[1].split(
            "function taskOutputMediaItems", 1
        )[0]
        self.assertIn('data-persona-media-preview-surface', inline)
        self.assertLess(inline.index("任务结果预览"), inline.index('renderUploadDropzone("personaMediaTaskFiles"'))
        self.assertGreaterEqual(self.script.count("embeddedPreview: true"), 4)
        self.assertIn('class="persona-media-task-result-preview"', self.script)
        self.assertIn('previewSurface.classList.toggle("has-upload-preview", files.length > 0);', self.script)
        self.assertIn(
            ".persona-media-preview-surface.has-upload-preview .persona-media-task-result-preview",
            self.styles,
        )

        result_renderer = self.script.split("function renderPersonaMediaTaskResult", 1)[1].split(
            "function renderPersonaCreateWorkbench", 1
        )[0]
        self.assertIn('title: "等待生成结果"', result_renderer)
        self.assertIn(
            'detail: "提交任务后，结果预览会显示在这里并可直接添加至草稿"',
            result_renderer,
        )
        self.assertIn('action: renderUploadAddMediaButton(addMediaInputId)', result_renderer)
        self.assertNotIn('renderPersonaTaskMediaPreview(taskState, [], { addMediaInputId })', result_renderer)
        self.assertIn(
            ".persona-media-task-result-preview .empty-state-action",
            self.styles,
        )

    def test_image_edit_flow_uses_textarea_box_and_preserves_label_fill(self):
        shared_border_selector = ".persona-media-prompt-field.is-image-editing .persona-media-prompt-input-shell::before {"
        self.assertIn(
            shared_border_selector,
            self.styles,
        )
        self.assertNotIn(
            ".persona-media-prompt-field.is-image-editing::before {",
            self.styles,
        )
        label_rule = self.styles.split(
            ".persona-media-prompt-field.is-image-editing .persona-media-prompt-label {", 1
        )[1].split("}", 1)[0]
        self.assertIn("color: var(--ink);", label_rule)
        self.assertIn("-webkit-text-fill-color: currentColor;", label_rule)
        self.assertNotIn("color: transparent", label_rule)
        self.assertNotIn("background-clip: text", label_rule)

        border_rule = self.styles.split(shared_border_selector, 1)[1].split("}", 1)[0]
        self.assertIn("padding: 2px;", border_rule)
        self.assertIn("border-radius: inherit;", border_rule)
        self.assertIn("pointer-events: none;", border_rule)
        self.assertIn("mask-composite: exclude;", border_rule)
        self.assertNotIn("animation:", border_rule)
        self.assertNotIn("persona-static-flow-action", self.script)
        self.assertNotIn("persona-static-flow-action", self.styles)
        self.assertIn(
            'class="primary persona-draft-global-save-button persona-gradient-outline-action"',
            self.script,
        )
        self.assertIn(
            'class="primary persona-gradient-outline-action" data-persona-publish-submit',
            self.script,
        )
        self.assertIn(
            'class="primary${moduleId === "publishing" ? " persona-gradient-outline-action" : ""}"',
            self.script,
        )
        flow_tokens = self.styles.split(
            ".persona-public-media-card,\n"
            ".persona-media-prompt-field.is-image-editing,\n"
            ".persona-gradient-outline-action {",
            1,
        )[1].split("}", 1)[0]
        self.assertIn("--media-edit-flow-deep: color-mix(in srgb, var(--accent-dark) 8%, #326f8e);", flow_tokens)
        self.assertIn("--media-edit-flow-blue: color-mix(in srgb, var(--accent-dark) 10%, #2b83ad);", flow_tokens)
        self.assertIn("var(--media-edit-flow-deep) 26%", flow_tokens)
        self.assertIn("var(--media-edit-flow-blue) 46%", flow_tokens)
        self.assertIn("var(--media-edit-flow-cyan) 62%", flow_tokens)
        self.assertIn("var(--media-edit-flow-bright) 72%", flow_tokens)
        self.assertIn("var(--media-edit-flow-cyan) 82%", flow_tokens)
        self.assertIn("var(--media-edit-flow-blue) 92%", flow_tokens)
        self.assertIn("background: var(--media-edit-flow-gradient);", border_rule)
        self.assertIn("background-size: 200% 100%;", border_rule)
        self.assertIn("background-repeat: repeat-x;", border_rule)
        self.assertIn("background-position: 0 0;", border_rule)
        prompt_animation_rule = self.styles.split(
            ".persona-media-prompt-field.is-image-editing .persona-media-prompt-input-shell::before {",
            2,
        )[2].split("}", 1)[0]
        self.assertIn("animation: personaMediaPromptBorderFlow 2.8s linear infinite;", prompt_animation_rule)
        action_border_selector = (
            ':root[data-theme="light"] body.console-page :is(.console-shell, .console-modal) '
            'button.primary.persona-gradient-outline-action:not([aria-busy="true"]),\n'
            ':root[data-theme="dark"] body.console-page :is(.console-shell, .console-modal) '
            'button.primary.persona-gradient-outline-action:not([aria-busy="true"]) {'
        )
        action_border = self.styles.split(
            action_border_selector,
            1,
        )[1].split("}", 1)[0]
        self.assertIn("border-width: 2px;", action_border)
        self.assertIn("border-style: solid;", action_border)
        self.assertIn("border-color: transparent !important;", action_border)
        self.assertIn("background-color: #071112 !important;", action_border)
        self.assertIn("background-image:", action_border)
        self.assertIn("var(--vecto-action-static-gradient),", action_border)
        self.assertIn("var(--media-edit-flow-gradient) !important;", action_border)
        self.assertIn("background-origin: padding-box, border-box;", action_border)
        self.assertIn("background-clip: padding-box, border-box;", action_border)
        self.assertIn("background-size: 100% 100%, 100% 100%;", action_border)
        self.assertIn("animation: none;", action_border)
        self.assertNotIn("::before", action_border)
        self.assertIn('<span class="persona-media-prompt-input-shell">', self.script)
        self.assertIn(
            ':root[data-theme="light"] .console-page .persona-media-operation-pane .persona-media-prompt-field.is-image-editing textarea:focus {',
            self.styles,
        )

    def test_edit_draft_ai_upload_selection_is_the_media_modify_state(self):
        upload_renderer = self.script.split("function syncUploadDropzone", 1)[1].split(
            "function syncUploadDropzoneSelectionState", 1
        )[0]
        editable_renderer = self.script.split("function renderPersonaEditableMediaGrid", 1)[1].split(
            "function renderPersonaImageLibraryPreview", 1
        )[0]
        self.assertIn("personaAiUploadSelectionControlsModify(input)", upload_renderer)
        self.assertIn("selectedIndexes.clear();", upload_renderer)
        self.assertIn('type === "image" && !selectionControlsModify', upload_renderer)
        self.assertIn('data-upload-media-modify="${esc(index)}"', upload_renderer)
        self.assertIn('data-persona-post-media-modify="${esc(index)}"', editable_renderer)
        self.assertIn('item.type === "image"', editable_renderer)
        self.assertIn("function setPersonaCustomMediaModifySource", self.script)
        self.assertIn("function personaCustomMediaModifyItem", self.script)
        self.assertIn('image_edit_mode: Boolean(modifyItem)', self.script)
        self.assertIn('data-persona-post-media-modify]', self.script)
        selection_toggle = self.script.split("function toggleUploadDropzoneSelection", 1)[1].split(
            "function handleUploadDropzoneAction", 1
        )[0]
        self.assertIn("personaAiUploadSelectionControlsModify(input)", selection_toggle)
        self.assertIn(
            "setPersonaCustomMediaModifySource({ input, index, scrollToComposer: false })",
            selection_toggle,
        )
        self.assertIn('mediaModifyItem?.inputId !== "personaMediaTaskFiles"', self.script)
        self.assertIn('data-upload-media-modify]', self.script)

    def test_public_media_edit_menu_reuses_outside_click_dropdown_behavior(self):
        menu_renderer = self.script.split("function renderPersonaPublicMediaEditMenu", 1)[1].split(
            "function renderPersonaPublicMediaFooter", 1
        )[0]
        self.assertIn("data-console-dropdown", menu_renderer)
        self.assertIn('closeConsoleDropdowns(event.target.closest("[data-console-dropdown]"));', self.script)
        self.assertIn(".persona-public-media-edit-menu[open] > summary", self.styles)

    def test_hot_editor_and_standard_upload_share_public_media_cards(self):
        renderer = self.script.split("function renderPersonaEditableMediaGrid", 1)[1].split(
            "function renderPersonaImageLibraryPreview", 1
        )[0]
        self.assertEqual(renderer.count('class="persona-public-media-card persona-edit-media-card'), 1)
        self.assertIn('replaceAttribute: hotMode', renderer)
        self.assertIn('data-persona-hot-editor-media-replace', renderer)
        self.assertIn('data-persona-hot-editor-media-delete', renderer)
        self.assertIn('renderPersonaPublicMediaFooter(index, actions)', renderer)
        self.assertNotIn("persona-media-card-select", renderer)
        self.assertNotIn("persona-edit-media-actions", renderer)
        self.assertNotIn("persona-hot-media-action", renderer)
        self.assertNotIn(".persona-media-card-select", self.styles)
        self.assertNotIn(".persona-edit-media-actions", self.styles)
        self.assertNotIn(".persona-hot-media-action", self.styles)

    def test_persona_media_card_surface_selects_and_only_eye_opens_preview(self):
        self.assertIn('interactive: false,', self.script)
        self.assertIn('data-media-preview-group="${esc(groupId)}"', self.script)
        self.assertIn('const personaMediaCard = event.target.closest(".persona-edit-media-card', self.script)

    def test_new_upload_media_cards_support_edit_and_cross_device_reordering(self):
        self.assertIn('data-upload-sort-card="${esc(index)}"', self.script)
        self.assertIn('dragKind === "upload" ? "data-upload-sort-handle" : "data-persona-media-drag-handle"', self.script)
        self.assertIn("${renderMediaOrderHandle(index)}", self.script)
        self.assertIn('data-upload-edit-index="${esc(index)}"', self.script)
        self.assertIn("function reorderUploadDropzoneFiles(input, fromIndex, toIndex)", self.script)
        self.assertIn("function editUploadDropzoneFile(input, index)", self.script)
        self.assertIn("function handleUploadSortPointerDown(event)", self.script)
        self.assertIn("function handleUploadSortPointerMove(event)", self.script)
        self.assertIn("function handleUploadSortPointerUp(event)", self.script)
        self.assertIn('document.addEventListener("pointermove", handleUploadSortPointerMove', self.script)
        self.assertNotIn('class="media-order-grip"', self.script)
        self.assertIn("grabOffsetX: event.clientX - cardRect.left", self.script)
        self.assertIn("grabOffsetY: event.clientY - cardRect.top", self.script)
        self.assertIn("event.clientX - drag.grabOffsetX", self.script)
        self.assertIn("event.clientY - drag.grabOffsetY", self.script)
        self.assertGreaterEqual(self.script.count("armPointerReorderLongPress(drag, () =>"), 3)
        self.assertGreaterEqual(
            self.script.count("pointerReorderMovedBeforeLongPress(drag, event.clientX, event.clientY)"),
            3,
        )
        upload_order_styles = self.styles.split(".file-chip-order {", 1)[1].split("}", 1)[0]
        persona_order_styles = self.styles.split(".persona-edit-media-order {", 1)[1].split("}", 1)[0]
        self.assertIn("touch-action: pan-y;", upload_order_styles)
        self.assertIn("touch-action: pan-y;", persona_order_styles)

    def test_persona_media_drag_ghost_preserves_pointer_grab_position(self):
        self.assertIn("grabOffsetX: event.clientX - sourceRect.left", self.script)
        self.assertIn("grabOffsetY: event.clientY - sourceRect.top", self.script)
        self.assertGreaterEqual(self.script.count("event.clientX - drag.grabOffsetX"), 2)
        self.assertGreaterEqual(self.script.count("event.clientY - drag.grabOffsetY"), 2)
        self.assertIn('event.pointerType === "mouse" && !blockedInteractive', self.script)
        self.assertIn("uploadSuppressedCardClick = { card, until: Date.now() + 350 };", self.script)
        self.assertIn("function renderMediaOrderHandle", self.script)
        self.assertIn("${renderMediaOrderHandle(index", self.script)
        self.assertIn(".file-chip-order {", self.styles)
        self.assertIn("flex-direction: column;", self.styles)
        self.assertIn(".upload-media-drag-ghost {", self.styles)

    def test_upload_card_selection_uses_a_small_round_checkbox_and_card_surface(self):
        select_styles = self.styles.split(".file-chip-select {", 1)[1].split("}", 1)[0]
        self.assertIn("top: 6px;", select_styles)
        self.assertIn("left: 6px;", select_styles)
        self.assertIn("width: 28px;", select_styles)
        self.assertIn("height: 28px;", select_styles)
        self.assertIn("border-radius: 50%;", select_styles)
        self.assertNotIn("inset: 0;", select_styles)
        self.assertNotIn("width: 100%;", select_styles)
        self.assertNotIn("height: 100%;", select_styles)
        self.assertIn('<circle cx="10" cy="10" r="7.5"></circle>', self.script)
        self.assertIn("function toggleUploadDropzoneSelection(trigger, rawIndex)", self.script)
        self.assertIn("function syncUploadDropzoneSelectionState(input)", self.script)
        self.assertIn("syncUploadDropzoneSelectionState(input);", self.script)
        self.assertIn('const selectUploadCard = event.target.closest("[data-upload-sort-card]");', self.script)
        self.assertIn('event.target.closest("button, a, input, label, [role=\\"button\\"]")', self.script)
        self.assertIn('event.target.closest(".file-chip-actions, .persona-public-media-card-actions, [data-upload-sort-handle]")', self.script)
        persona_select_styles = self.styles.split(".persona-public-media-select {", 1)[1].split("}", 1)[0]
        self.assertIn("top: 8px;", persona_select_styles)
        self.assertIn("left: 8px;", persona_select_styles)
        self.assertIn("width: 28px;", persona_select_styles)
        self.assertIn("height: 28px;", persona_select_styles)
        self.assertIn("place-items: center;", persona_select_styles)
        self.assertIn("border-radius: 50%;", persona_select_styles)
        self.assertIn('const personaMediaCard = event.target.closest(".persona-edit-media-card', self.script)

    def test_upload_sorting_blocks_native_card_drag_and_keeps_actions_out_of_drag_gesture(self):
        drag_start = self.script.split("function handleUploadPreviewDragStart(event)", 1)[1].split(
            "function uploadSortTargetIndex",
            1,
        )[0]
        self.assertIn('[data-upload-sort-card]', drag_start)
        self.assertIn('[data-persona-media-sort-grid] .persona-edit-media-card', drag_start)
        self.assertIn('draggable="false"', self.script)
        self.assertIn(".persona-edit-media-card :is(img, video)", self.styles)
        pointer_down = self.script.split("function handleUploadSortPointerDown(event)", 1)[1].split(
            "function handleUploadSortPointerMove",
            1,
        )[0]
        self.assertIn('event.target?.closest?.(".file-chip-select, .file-chip-actions, .persona-public-media-select, .persona-public-media-card-actions")', pointer_down)
        self.assertIn("const captureTarget = explicitHandle || card;", pointer_down)
        self.assertNotIn("setPointerCapture", pointer_down)
        pointer_move = self.script.split("function handleUploadSortPointerMove(event)", 1)[1].split(
            "function handleUploadSortPointerUp",
            1,
        )[0]
        self.assertIn("drag.captureTarget?.setPointerCapture?.(event.pointerId);", pointer_move)
        self.assertIn("if (explicitHandle && !pointerReorderNeedsLongPress(event)) event.preventDefault();", pointer_down)
        self.assertIn("function handleUploadSortKeydown(event)", self.script)
        self.assertIn('document.addEventListener("keydown", handleUploadSortKeydown, true);', self.script)

        persona_pointer_down = self.script.split("function handlePersonaMediaPointerDown(event)", 1)[1].split(
            "function handlePersonaMediaPointerMove",
            1,
        )[0]
        self.assertIn('event.target.closest?.(".persona-edit-media-card[data-persona-media-card-index]")', persona_pointer_down)
        self.assertIn(
            ".persona-public-media-select, .persona-public-media-card-actions, input, label, a",
            persona_pointer_down,
        )
        self.assertIn('event.pointerType !== "mouse" || blockedInteractive', persona_pointer_down)


if __name__ == "__main__":
    unittest.main()
