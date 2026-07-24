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
        self.assertIn('class="upload-thumbnail-grid"', self.script)
        self.assertIn('class="file-preview-frame"', self.script)
        self.assertIn('class="upload-add-media"', self.script)
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
        self.assertIn('<button type="button" class="upload-delete-selected"', self.script)
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
        self.assertIn('<div class="upload-zone" data-upload-dropzone>', self.script)
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
        self.assertIn(
            'if (event.target?.id === "personaHotReplacementFiles")',
            self.script,
        )
        hot_replacement_handler = self.script.split(
            'if (event.target?.id === "personaHotReplacementFiles")',
            1,
        )[1].split(
            'if (event.target?.matches?.("[data-persona-upload-image-file]"))',
            1,
        )[0]
        self.assertIn("const files = currentUploadDropzoneFiles(event.target);", hot_replacement_handler)
        self.assertNotIn("event.target.files", hot_replacement_handler)
        self.assertIn('clearUploadDropzoneState("personaHotReplacementFiles")', hot_replacement_handler)

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

    def test_persona_media_editor_uses_direct_add_and_card_edit_actions(self):
        self.assertIn('data-persona-upload-post-media="add">添加媒体</button>', self.script)
        self.assertIn('data-persona-edit-post-media="${esc(index)}"', self.script)
        self.assertIn('title="编辑媒体"', self.script)
        self.assertNotIn('data-persona-upload-post-media="append">追加</button>', self.script)
        self.assertNotIn('data-persona-attach-task-media="replace"', self.script)
        self.assertIn('["replace", "媒体编辑"]', self.script)

    def test_persona_media_cards_have_order_badges_and_pointer_reordering(self):
        self.assertIn("data-persona-media-sort-grid", self.script)
        self.assertIn('const dataAttribute = persona ? "data-persona-media-drag-handle"', self.script)
        self.assertIn('${renderMediaOrderHandle(index, "persona")}', self.script)
        self.assertIn('data-persona-media-card-index="${esc(index)}"', self.script)
        self.assertIn("function handlePersonaMediaPointerDown(event)", self.script)
        self.assertIn("function handlePersonaMediaPointerMove(event)", self.script)
        self.assertIn("function handlePersonaMediaPointerUp(event)", self.script)
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

    def test_new_upload_media_cards_support_edit_and_cross_device_reordering(self):
        self.assertIn('data-upload-sort-card="${esc(index)}"', self.script)
        self.assertIn('const dataAttribute = persona ? "data-persona-media-drag-handle" : "data-upload-sort-handle"', self.script)
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
        self.assertIn('event.target.closest(".file-chip-actions, [data-upload-sort-handle]")', self.script)

    def test_upload_sorting_blocks_native_card_drag_and_keeps_actions_out_of_drag_gesture(self):
        drag_start = self.script.split("function handleUploadPreviewDragStart(event)", 1)[1].split(
            "function uploadSortTargetIndex",
            1,
        )[0]
        self.assertIn('[data-upload-sort-card]', drag_start)
        pointer_down = self.script.split("function handleUploadSortPointerDown(event)", 1)[1].split(
            "function handleUploadSortPointerMove",
            1,
        )[0]
        self.assertIn('event.target?.closest?.(".file-chip-select, .file-chip-actions")', pointer_down)
        self.assertIn("const captureTarget = explicitHandle || card;", pointer_down)
        self.assertNotIn("setPointerCapture", pointer_down)
        pointer_move = self.script.split("function handleUploadSortPointerMove(event)", 1)[1].split(
            "function handleUploadSortPointerUp",
            1,
        )[0]
        self.assertIn("drag.captureTarget?.setPointerCapture?.(event.pointerId);", pointer_move)
        self.assertIn("if (explicitHandle) event.preventDefault();", pointer_down)
        self.assertIn("function handleUploadSortKeydown(event)", self.script)
        self.assertIn('document.addEventListener("keydown", handleUploadSortKeydown, true);', self.script)


if __name__ == "__main__":
    unittest.main()
