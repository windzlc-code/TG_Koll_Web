(function videoEditorBootstrap() {
  "use strict";

  const ADMIN_WORKSPACE_USER_ID = String(document.querySelector('meta[name="admin-workspace-user-id"]')?.content || "").trim();
  const ADMIN_CONSOLE_SESSION = document.querySelector('meta[name="admin-console-session"]')?.content === "1";
  const API = "/api/video/editor";
  const ACTIVE_EXPORTS = new Set(["queued", "running"]);
  const VIDEO_TRACKS = 3;
  const state = {
    active: false,
    loaded: false,
    loading: false,
    assets: [],
    projects: [],
    project: null,
    selectedClipId: "",
    filter: "all",
    search: "",
    dirty: false,
    saving: false,
    editRevision: 0,
    savedRevision: 0,
    savePromise: null,
    saveTimer: 0,
    uploadBusy: false,
    uploadMessage: "",
    message: "",
    messageType: "success",
    exportJob: null,
    exportTimer: 0,
    previewPlaying: false,
    previewTimelineTime: 0,
    previewFrame: 0,
    previewAnchorTime: 0,
    previewAnchorNow: 0,
    timelineZoom: 64,
    history: [],
    future: [],
    trimDrag: null,
    pendingAssetId: "",
    assetPage: 1,
    assetPageSize: 6,
    inspectorSnapshot: "",
  };

  const root = () => document.getElementById("videoEditorRoot");
  const headingRoot = () => document.getElementById("videoStudioHeadingHost");
  const escapeHtml = (value) => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
  const icon = (name, className = "") => window.VideoIcons?.render?.(name, className) || "";

  function formatDuration(seconds) {
    const value = Math.max(0, Number(seconds) || 0);
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const rawSeconds = value % 60;
    const secs = value < 60 ? rawSeconds.toFixed(1) : String(Math.floor(rawSeconds));
    const tail = `${String(minutes).padStart(hours ? 2 : 1, "0")}:${String(secs).padStart(value < 60 ? 4 : 2, "0")}`;
    return hours ? `${hours}:${tail}` : tail;
  }

  function formatBytes(bytes) {
    let value = Math.max(0, Number(bytes) || 0);
    const units = ["B", "KB", "MB", "GB"];
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024;
      index += 1;
    }
    return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
  }

  function sourceLabel(type) {
    return ({ generated: "生成记录", upload: "本地上传", export: "剪辑成品" })[type] || "视频素材";
  }

  function authenticatedMediaUrl(value) {
    const url = new URL(String(value || ""), window.location.origin);
    if (ADMIN_CONSOLE_SESSION) url.searchParams.set("admin_console", "1");
    if (ADMIN_WORKSPACE_USER_ID) url.searchParams.set("admin_workspace_user_id", ADMIN_WORKSPACE_USER_ID);
    return `${url.pathname}${url.search}${url.hash}`;
  }

  async function request(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (ADMIN_WORKSPACE_USER_ID) headers.set("X-Admin-Workspace-User-ID", ADMIN_WORKSPACE_USER_ID);
    if (ADMIN_CONSOLE_SESSION) headers.set("X-Admin-Console", "1");
    const response = await fetch(path, { credentials: "include", ...options, headers });
    const raw = await response.text();
    let payload = {};
    try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = { detail: raw }; }
    if (!response.ok) {
      if (response.status === 401 && /video\.html$/.test(window.location.pathname)) {
        const here = `${window.location.pathname}${window.location.search}${window.location.hash}`;
        window.location.replace(`/video-login.html?return_url=${encodeURIComponent(here)}`);
      }
      const error = new Error(String(payload?.detail || payload?.error || "请求失败"));
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async function requestActionDialog({ title, message, inputLabel = "", inputValue = null, confirmText = "确定", danger = false } = {}) {
    const presenter = window.VectoSiteNavigation?.showAuthFeedback;
    if (typeof presenter !== "function") throw new Error("公共操作窗口尚未加载，请刷新页面后重试。");
    const withInput = inputValue !== null;
    const previousFocus = document.activeElement;
    let result = { confirmed: false, value: withInput ? String(inputValue || "") : "" };
    const inputMarkup = withInput ? `<label><span>${escapeHtml(inputLabel || "名称")}</span><input type="text" value="${escapeHtml(inputValue)}" maxlength="80" autocomplete="off" required data-video-dialog-input /></label>` : "";
    await presenter({
      kind: danger ? "error" : "success",
      showIcon: false,
      title,
      message,
      actionText: false,
      dialogClass: "is-form is-confirmation video-editor-action-window",
      contentHtml: `<form class="site-auth-feedback-form" data-video-action-form>${inputMarkup}<div class="site-auth-feedback-actions"><button type="button" class="site-auth-feedback-cancel" data-video-action-cancel>取消</button><button type="submit" class="site-auth-feedback-confirm ${danger ? "is-danger" : ""}" data-video-action-confirm>${escapeHtml(confirmText)}</button></div></form>`,
      onOpen(modal, close) {
        const form = modal.querySelector("[data-video-action-form]");
        const input = modal.querySelector("[data-video-dialog-input]");
        modal.querySelector("[data-video-action-cancel]")?.addEventListener("click", () => close());
        form?.addEventListener("submit", (event) => {
          event.preventDefault();
          if (input && !input.value.trim()) {
            input.setCustomValidity("请输入项目名称");
            input.reportValidity();
            input.addEventListener("input", () => input.setCustomValidity(""), { once: true });
            return;
          }
          result = { confirmed: true, value: input ? input.value.trim() : "" };
          close();
        });
        window.setTimeout(() => { input?.focus(); input?.select(); }, 0);
      },
    });
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    return result;
  }

  function assetById(assetId) {
    return state.assets.find((item) => item.id === assetId) || null;
  }

  function selectedClip() {
    return state.project?.clips?.find((item) => item.id === state.selectedClipId) || null;
  }

  function clipDuration(clip) {
    return Math.max(0, Number(clip?.end || 0) - Number(clip?.start || 0)) / Math.max(0.5, Number(clip?.speed || 1));
  }

  function timelineSegments() {
    const trackCursors = Array.from({ length: VIDEO_TRACKS }, () => 0);
    return (state.project?.clips || []).map((clip) => {
      const track = Math.max(0, Math.min(VIDEO_TRACKS - 1, Math.trunc(Number(clip.track) || 0)));
      const duration = clipDuration(clip);
      const explicitStart = Number(clip.timeline_start);
      const from = Number.isFinite(explicitStart) && explicitStart >= 0 ? explicitStart : trackCursors[track];
      const segment = { clip, track, from, to: from + duration };
      trackCursors[track] = Math.max(trackCursors[track], segment.to);
      return segment;
    });
  }

  function timelineDuration() {
    const segments = timelineSegments();
    return segments.reduce((duration, segment) => Math.max(duration, segment.to), 0);
  }

  function projectPayload() {
    return {
      name: String(state.project?.name || "未命名剪辑").trim() || "未命名剪辑",
      clips: timelineSegments().map(({ clip, track, from }) => ({
        id: clip.id,
        asset_id: clip.asset_id,
        start: Number(clip.start) || 0,
        end: Number(clip.end) || 0,
        volume: Number(clip.volume ?? 1),
        speed: Number(clip.speed ?? 1),
        track,
        timeline_start: Number(from.toFixed(3)),
        scale: Math.max(0.15, Math.min(1, Number(clip.scale ?? (track ? 0.42 : 1)))),
        position_x: Math.max(0, Math.min(1, Number(clip.position_x ?? (track ? 0.94 : 0.5)))),
        position_y: Math.max(0, Math.min(1, Number(clip.position_y ?? (track ? 0.06 : 0.5)))),
        opacity: Math.max(0.05, Math.min(1, Number(clip.opacity ?? 1))),
      })),
      settings: { ...(state.project?.settings || {}) },
    };
  }

  function markDirty() {
    state.dirty = true;
    state.editRevision += 1;
    updateSaveState();
    window.clearTimeout(state.saveTimer);
    state.saveTimer = window.setTimeout(() => saveProject().catch(showError), 700);
  }

  function updateSaveState(message = "") {
    const node = document.querySelector("[data-editor-save-state]");
    if (!node) return;
    node.textContent = message || (state.saving ? "保存中…" : state.dirty ? "有更改待保存" : "已保存到服务器");
    node.dataset.state = state.saving ? "saving" : state.dirty ? "dirty" : "saved";
  }

  async function saveProject() {
    if (!state.project) return;
    if (state.saving) {
      await state.savePromise;
      if (state.dirty) return saveProject();
      return;
    }
    if (!state.dirty) return;
    const revision = state.editRevision;
    const projectId = state.project.id;
    const body = projectPayload();
    state.saving = true;
    updateSaveState();
    state.savePromise = request(`${API}/projects/${encodeURIComponent(projectId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    try {
      const payload = await state.savePromise;
      if (state.project?.id === projectId && state.editRevision === revision) {
        state.project = { ...state.project, ...(payload.project || {}), clips: payload.project?.clips || state.project.clips };
        state.savedRevision = revision;
        state.dirty = false;
      } else if (state.project?.id === projectId) {
        state.project.updated_at = payload.project?.updated_at || state.project.updated_at;
      }
      const index = state.projects.findIndex((item) => item.id === projectId);
      if (index >= 0 && state.project?.id === projectId) state.projects[index] = { ...state.project };
    } finally {
      state.saving = false;
      state.savePromise = null;
      updateSaveState();
    }
    if (state.project?.id === projectId && state.dirty) return saveProject();
  }

  function timelineSnapshot() {
    return JSON.stringify({
      clips: state.project?.clips || [],
      selectedClipId: state.selectedClipId,
      previewTimelineTime: state.previewTimelineTime,
    });
  }

  function restoreTimelineSnapshot(value) {
    if (!state.project || !value) return;
    const snapshot = JSON.parse(value);
    state.project.clips = Array.isArray(snapshot.clips) ? snapshot.clips : [];
    state.selectedClipId = String(snapshot.selectedClipId || "");
    state.previewTimelineTime = Math.max(0, Math.min(Number(snapshot.previewTimelineTime) || 0, timelineDuration()));
    markDirty();
    render();
  }

  function recordHistory(snapshot = timelineSnapshot()) {
    if (state.history[state.history.length - 1] !== snapshot) state.history.push(snapshot);
    if (state.history.length > 80) state.history.shift();
    state.future = [];
  }

  function mutateTimeline(callback) {
    recordHistory();
    callback();
    markDirty();
    render();
  }

  function undoTimeline() {
    const previous = state.history.pop();
    if (!previous) return;
    state.future.push(timelineSnapshot());
    restoreTimelineSnapshot(previous);
  }

  function redoTimeline() {
    const next = state.future.pop();
    if (!next) return;
    state.history.push(timelineSnapshot());
    restoreTimelineSnapshot(next);
  }

  function showError(error) {
    const message = String(error?.message || error || "操作失败");
    state.message = message;
    state.messageType = "error";
    const node = document.querySelector("[data-editor-message]");
    if (node) {
      node.textContent = message;
      node.hidden = false;
      node.dataset.type = "error";
    }
  }

  function showMessage(message, type = "success") {
    state.message = String(message || "");
    state.messageType = type;
    const node = document.querySelector("[data-editor-message]");
    if (!node) return;
    node.textContent = String(message || "");
    node.hidden = !message;
    node.dataset.type = type;
  }

  async function loadAssets(syncGenerated = true) {
    const payload = await request(`${API}/assets?page=1&page_size=1000&sync_generated=${syncGenerated ? "true" : "false"}`);
    state.assets = Array.isArray(payload.items) ? payload.items : [];
  }

  async function createProject(name = "未命名剪辑") {
    const payload = await request(`${API}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, clips: [], settings: { ratio: "source", quality: "720p" } }),
    });
    const project = payload.project;
    state.projects.unshift(project);
    state.project = project;
    state.selectedClipId = "";
    state.dirty = false;
    state.editRevision = 0;
    state.savedRevision = 0;
    state.history = [];
    state.future = [];
    return project;
  }

  async function loadProjects() {
    const payload = await request(`${API}/projects`);
    state.projects = Array.isArray(payload.items) ? payload.items : [];
    if (!state.projects.length) await createProject("我的第一个剪辑");
    else {
      const existing = state.project && state.projects.find((item) => item.id === state.project.id);
      state.project = existing || state.projects[0];
    }
  }

  async function loadExports() {
    const suffix = state.project?.id ? `?project_id=${encodeURIComponent(state.project.id)}` : "";
    const payload = await request(`${API}/exports${suffix}`);
    const items = Array.isArray(payload.items) ? payload.items : [];
    state.exportJob = items.find((item) => ACTIVE_EXPORTS.has(item.status)) || items[0] || null;
    syncExportPolling();
  }

  async function loadAll() {
    if (state.loading) return;
    state.loading = true;
    renderLoading();
    try {
      await Promise.all([loadAssets(true), loadProjects()]);
      await loadExports();
      state.loaded = true;
      render();
    } catch (error) {
      renderFailure(error);
    } finally {
      state.loading = false;
    }
  }

  function filteredAssets() {
    const query = state.search.trim().toLowerCase();
    return state.assets.filter((asset) => {
      if (state.filter !== "all" && asset.source_type !== state.filter) return false;
      return !query || String(asset.name || "").toLowerCase().includes(query);
    });
  }

  function pagedAssets() {
    const assets = filteredAssets();
    const totalPages = Math.max(1, Math.ceil(assets.length / state.assetPageSize));
    state.assetPage = Math.max(1, Math.min(state.assetPage, totalPages));
    const start = (state.assetPage - 1) * state.assetPageSize;
    return { items: assets.slice(start, start + state.assetPageSize), total: assets.length, totalPages };
  }

  function renderLoading() {
    const host = root();
    if (!host) return;
    renderHeading();
    host.innerHTML = '<div class="video-editor-state" role="status"><span class="video-workbench-loader" aria-hidden="true"></span><strong>正在整理视频素材</strong><span>同步生成记录与剪辑项目…</span></div>';
  }

  function renderFailure(error) {
    const host = root();
    if (!host) return;
    renderHeading();
    host.innerHTML = `<div class="video-editor-state video-editor-state--error"><strong>视频工作区暂时无法打开</strong><span>${escapeHtml(error?.message || error)}</span><button class="secondary-btn" type="button" data-editor-retry>重新加载</button></div>`;
  }

  function assetCard(asset) {
    const visual = asset.thumbnail_url
      ? `<img src="${escapeHtml(authenticatedMediaUrl(asset.thumbnail_url))}" alt="" loading="lazy" />`
      : `<video src="${escapeHtml(authenticatedMediaUrl(asset.media_url))}#t=0.1" preload="metadata" muted></video>`;
    return `<article class="video-asset-card" draggable="true" data-asset-id="${escapeHtml(asset.id)}" tabindex="0">
      <button class="video-asset-visual" type="button" data-asset-preview="${escapeHtml(asset.id)}" aria-label="播放预览 ${escapeHtml(asset.name)}" title="播放预览">${visual}<span class="video-asset-play" aria-hidden="true">${icon("play")}</span><span class="video-asset-duration">${formatDuration(asset.duration)}</span></button>
      <div class="video-asset-body">
        <div class="video-asset-title-row"><strong title="${escapeHtml(asset.name)}">${escapeHtml(asset.name)}</strong><span>${escapeHtml(sourceLabel(asset.source_type))}</span></div>
        <small>${asset.width || "?"}×${asset.height || "?"} · ${formatBytes(asset.size_bytes)}</small>
        <div class="video-asset-actions">
          <button class="video-icon-button" type="button" data-asset-add="${escapeHtml(asset.id)}" aria-label="将 ${escapeHtml(asset.name)} 加入时间线" title="加入时间线">${icon("plus")}</button>
          <a class="video-icon-button" href="${escapeHtml(authenticatedMediaUrl(asset.download_url))}" download aria-label="下载 ${escapeHtml(asset.name)}" title="下载">${icon("download")}</a>
          <button type="button" class="video-icon-button danger-link" data-asset-delete="${escapeHtml(asset.id)}" aria-label="删除 ${escapeHtml(asset.name)}" title="删除">${icon("trash")}</button>
        </div>
      </div>
    </article>`;
  }

  function renderAssetLibrary() {
    const page = pagedAssets();
    return `<aside class="video-editor-library" aria-label="视频素材库">
      <div class="video-editor-section-heading">
        <div><span class="eyebrow">MEDIA LIBRARY</span><h3>视频素材</h3></div>
      </div>
      <label class="video-upload-drop ${state.uploadBusy ? "is-busy" : ""}" data-editor-drop-zone tabindex="${state.uploadBusy ? "-1" : "0"}">
        <input type="file" accept="video/*,.mkv,.avi,.wmv,.flv,.mts,.m2ts" multiple data-editor-upload ${state.uploadBusy ? "disabled" : ""} />
        <span class="video-upload-drop-icon" aria-hidden="true">${icon("upload")}</span>
        <span class="video-upload-drop-copy"><strong>${state.uploadBusy ? "正在处理视频" : "点击或拖入视频"}</strong><small>MP4、MOV、MKV、AVI、WebM 等主流格式</small></span>
      </label>
      ${state.uploadMessage ? `<div class="video-upload-note">${escapeHtml(state.uploadMessage)}</div>` : ""}
      <div class="video-library-tools">
        <input type="search" value="${escapeHtml(state.search)}" placeholder="搜索素材" aria-label="搜索视频素材" data-editor-search />
        <select aria-label="筛选素材来源" data-editor-filter>
          ${[["all", "全部"], ["generated", "生成记录"], ["upload", "本地上传"], ["export", "剪辑成品"]].map(([value, label]) => `<option value="${value}" ${state.filter === value ? "selected" : ""}>${label}</option>`).join("")}
        </select>
      </div>
      <div class="video-asset-grid" data-editor-assets>
        ${page.items.length ? page.items.map(assetCard).join("") : '<div class="video-library-empty"><strong>还没有匹配的视频</strong><span>生成的视频会自动保存到这里，也可以上传本地视频。</span></div>'}
      </div>
      <div data-asset-pagination>${renderAssetPagination(page)}</div>
    </aside>`;
  }

  function renderAssetPagination(page = pagedAssets()) {
    return page.totalPages > 1 ? `<div class="video-library-pagination"><button class="video-icon-button" type="button" data-asset-page="${state.assetPage - 1}" ${state.assetPage <= 1 ? "disabled" : ""} aria-label="上一页" title="上一页">${icon("left")}</button><span>${state.assetPage} / ${page.totalPages}</span><button class="video-icon-button" type="button" data-asset-page="${state.assetPage + 1}" ${state.assetPage >= page.totalPages ? "disabled" : ""} aria-label="下一页" title="下一页">${icon("right")}</button></div>` : "";
  }

  function updateAssetResults() {
    const page = pagedAssets();
    const grid = document.querySelector("[data-editor-assets]");
    if (grid) grid.innerHTML = page.items.map(assetCard).join("") || '<div class="video-library-empty"><strong>还没有匹配的视频</strong></div>';
    const pagination = document.querySelector("[data-asset-pagination]");
    if (pagination) pagination.innerHTML = renderAssetPagination(page);
  }

  function renderPreview() {
    const activeSegment = previewSegmentForTime(state.previewTimelineTime);
    const firstClip = activeSegment?.clip || selectedClip() || state.project?.clips?.[0];
    const asset = firstClip ? assetById(firstClip.asset_id) : null;
    const duration = timelineDuration();
    return `<section class="video-editor-stage" aria-label="视频实时预览">
      <div class="video-editor-section-heading">
        <div><span class="eyebrow">LIVE PREVIEW</span><h3>实时预览</h3></div>
        <span class="video-editor-resolution">${asset ? `${asset.width}×${asset.height}` : "等待素材"}</span>
      </div>
      <div class="video-preview-canvas" data-preview-canvas>
        ${asset ? `<div class="video-preview-stack" data-preview-stack>${previewLayersMarkup(state.previewTimelineTime)}</div>` : `<div class="video-preview-empty"><span class="video-preview-play">${icon("play")}</span><strong>把素材拖到时间线开始剪辑</strong><span>支持多轨叠加、裁剪、分割和连续预览</span></div>`}
      </div>
      <div class="video-preview-controls">
        <button type="button" class="video-preview-toggle video-icon-button" data-preview-toggle ${asset ? "" : "disabled"} aria-label="${state.previewPlaying ? "暂停" : "播放"}" title="播放 / 暂停">${icon(state.previewPlaying ? "pause" : "play")}</button>
        <span data-preview-current>${formatDuration(state.previewTimelineTime)}</span>
        <input type="range" min="0" max="${Math.max(duration, 0.01)}" step="0.01" value="${Math.min(state.previewTimelineTime, duration)}" data-preview-scrubber aria-label="预览播放位置" ${asset ? "" : "disabled"} />
        <span>${formatDuration(duration)}</span>
        <button type="button" class="video-icon-button" data-clip-split ${selectedClip() ? "" : "disabled"} aria-label="在播放头分割" title="在播放头分割">${icon("scissors")}</button>
      </div>
    </section>`;
  }

  function clipHtml(segment, index) {
    const { clip } = segment;
    const asset = assetById(clip.asset_id);
    const duration = clipDuration(clip);
    const width = Math.max(48, duration * state.timelineZoom);
    const left = Math.max(0, segment.from * state.timelineZoom);
    const thumbnail = asset?.thumbnail_url ? authenticatedMediaUrl(asset.thumbnail_url) : "";
    return `<article class="video-timeline-clip ${clip.id === state.selectedClipId ? "is-selected" : ""}" draggable="true" data-clip-id="${escapeHtml(clip.id)}" style="--clip-width:${width}px;--clip-left:${left}px" tabindex="0" aria-label="片段 ${index + 1}：${escapeHtml(asset?.name || "素材不可用")}">
      <button type="button" class="video-trim-handle is-left" data-trim-handle="start" aria-label="拖动片段入点"></button>
      <div class="video-clip-frames" ${thumbnail ? `style="background-image:url('${escapeHtml(thumbnail)}')"` : ""}></div>
      <div class="video-clip-label"><strong>${String(index + 1).padStart(2, "0")} · ${escapeHtml(asset?.name || "素材不可用")}</strong><span>${formatDuration(duration)} · ${Number(clip.speed || 1).toFixed(2)}x</span></div>
      <button type="button" class="video-trim-handle is-right" data-trim-handle="end" aria-label="拖动片段出点"></button>
    </article>`;
  }

  function rulerTicks() {
    const duration = Math.max(timelineDuration(), 1);
    const step = state.timelineZoom >= 120 ? 0.5 : state.timelineZoom >= 72 ? 1 : state.timelineZoom >= 36 ? 2 : state.timelineZoom >= 20 ? 5 : 10;
    const ticks = [];
    const count = Math.min(400, Math.ceil(duration / step) + 1);
    for (let index = 0; index < count; index += 1) {
      const time = index * step;
      const major = index % 5 === 0;
      ticks.push(`<span class="video-ruler-tick ${major ? "is-major" : ""}" style="left:${time * state.timelineZoom}px">${major ? `<b>${formatDuration(time)}</b>` : ""}</span>`);
    }
    return ticks.join("");
  }

  function timelineMarkers() {
    return (state.project?.settings?.markers || []).map((marker) => `<button type="button" class="video-timeline-marker" style="left:${Number(marker.time || 0) * state.timelineZoom}px" data-marker-time="${Number(marker.time || 0)}" title="标记 ${formatDuration(marker.time)}" aria-label="跳到标记 ${formatDuration(marker.time)}"></button>`).join("");
  }

  function renderTimeline() {
    const clips = state.project?.clips || [];
    const segments = timelineSegments();
    const duration = timelineDuration();
    const canvasWidth = Math.max(720, duration * state.timelineZoom + 80);
    const hasSelection = Boolean(selectedClip());
    return `<section class="video-editor-timeline" aria-label="剪辑时间线">
      <div class="video-timeline-header">
        <div><span class="eyebrow">SEQUENCE 01</span><h3>剪辑时间线</h3></div>
        <div><span>${clips.length} 个片段</span><strong>${formatDuration(duration)}</strong></div>
      </div>
      <div class="video-timeline-toolbar" role="toolbar" aria-label="时间线剪辑工具">
        <div class="video-timeline-tool-group">
          <button type="button" class="video-icon-button" data-timeline-undo ${state.history.length ? "" : "disabled"} title="撤销 Ctrl+Z" aria-label="撤销">${icon("undo")}</button>
          <button type="button" class="video-icon-button" data-timeline-redo ${state.future.length ? "" : "disabled"} title="重做 Ctrl+Shift+Z" aria-label="重做">${icon("redo")}</button>
        </div>
        <div class="video-timeline-tool-group">
          <button type="button" class="video-icon-button" data-clip-split ${hasSelection ? "" : "disabled"} title="在播放头分割 Ctrl+B" aria-label="分割片段">${icon("scissors")}</button>
          <button type="button" class="video-icon-button" data-trim-to-playhead="start" ${hasSelection ? "" : "disabled"} title="删除播放头左侧片段" aria-label="删除播放头左侧片段">${icon("trimLeft")}</button>
          <button type="button" class="video-icon-button" data-trim-to-playhead="end" ${hasSelection ? "" : "disabled"} title="删除播放头右侧片段" aria-label="删除播放头右侧片段">${icon("trimRight")}</button>
          <button type="button" class="video-icon-button" data-clip-duplicate ${hasSelection ? "" : "disabled"} title="复制片段 Ctrl+D" aria-label="复制片段">${icon("copy")}</button>
          <button type="button" class="video-icon-button" data-clip-remove ${hasSelection ? "" : "disabled"} title="删除片段 Delete" aria-label="删除片段">${icon("trash")}</button>
          <button type="button" class="video-icon-button" data-timeline-marker-add ${clips.length ? "" : "disabled"} title="在播放头添加标记" aria-label="添加时间线标记">${icon("marker")}</button>
        </div>
        <div class="video-timeline-zoom" aria-label="时间线缩放">
          <button type="button" class="video-icon-button" data-timeline-zoom-out title="缩小时间线" aria-label="缩小时间线">${icon("zoomOut")}</button>
          <input type="range" min="16" max="180" step="4" value="${state.timelineZoom}" data-timeline-zoom aria-label="时间线缩放比例" />
          <button type="button" class="video-icon-button" data-timeline-zoom-in title="放大时间线" aria-label="放大时间线">${icon("zoomIn")}</button>
          <button type="button" class="video-icon-button" data-timeline-zoom-fit title="适配全部时间线 Shift+Z" aria-label="适配全部时间线">${icon("fit")}</button>
        </div>
      </div>
      <div class="video-timeline-viewport" data-timeline-scroll>
        <div class="video-timeline-canvas" style="--timeline-width:${canvasWidth}px" data-timeline-drop data-timeline-seek>
          <div class="video-timeline-ruler" aria-label="时间刻度">${rulerTicks()}${timelineMarkers()}</div>
          ${[2, 1, 0].map((track) => {
            const trackSegments = segments.filter((segment) => segment.track === track).sort((a, b) => a.from - b.from);
            const label = track === 0 ? "主视频" : "叠加层";
            return `<div class="video-track-row" data-track-row="${track}"><div class="video-track-label"><strong>V${track + 1}</strong><span>${label}</span></div><div class="video-timeline-track ${trackSegments.length ? "" : "is-empty"}" data-track-index="${track}">
              ${trackSegments.length ? trackSegments.map((segment) => clipHtml(segment, clips.indexOf(segment.clip))).join("") : `<div class="video-timeline-empty"><strong>${track ? "拖入叠加素材" : "拖入主视频"}</strong><span>${track ? "可与下方轨道同步播放" : "素材会按时间位置拼接"}</span></div>`}
            </div></div>`;
          }).join("")}
          <div class="video-timeline-playhead" style="left:${54 + Math.min(state.previewTimelineTime, duration) * state.timelineZoom}px" data-timeline-playhead aria-hidden="true"><span></span></div>
        </div>
      </div>
      <p class="video-timeline-hint">拖动片段可跨轨摆放和叠加，拖动两侧手柄裁剪；Space 播放，Ctrl+B 分割，Delete 删除，方向键逐帧移动。</p>
    </section>`;
  }

  function renderInspector() {
    const clip = selectedClip();
    const asset = clip ? assetById(clip.asset_id) : null;
    return `<aside class="video-editor-inspector" aria-label="片段与导出设置">
      <section>
        <div class="video-editor-section-heading"><div><span class="eyebrow">CLIP</span><h3>片段设置</h3></div></div>
        ${clip && asset ? `<div class="video-clip-inspector">
          <strong>${escapeHtml(asset.name)}</strong>
          <label>入点（秒）<input type="number" min="0" max="${asset.duration}" step="0.01" value="${clip.start}" data-clip-start /></label>
          <label>出点（秒）<input type="number" min="0.05" max="${asset.duration}" step="0.01" value="${clip.end}" data-clip-end /></label>
          <label>播放速度<select data-clip-speed>${[[0.5, "0.5x 慢速"], [0.75, "0.75x"], [1, "1.0x 正常"], [1.25, "1.25x"], [1.5, "1.5x"], [2, "2.0x 快速"]].map(([value, label]) => `<option value="${value}" ${Number(clip.speed || 1) === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
          <div class="video-clip-layout-fields">
            <label>轨道<select data-clip-track>${[0, 1, 2].map((track) => `<option value="${track}" ${Number(clip.track || 0) === track ? "selected" : ""}>V${track + 1}${track ? " 叠加" : " 主视频"}</option>`).join("")}</select></label>
            <label>时间位置（秒）<input type="number" min="0" max="21600" step="0.01" value="${Number(selectedSegment()?.from || 0).toFixed(2)}" data-clip-timeline-start /></label>
          </div>
          <label>原声音量 <output data-volume-output>${Math.round((clip.volume ?? 1) * 100)}%</output><input type="range" min="0" max="1" step="0.05" value="${clip.volume ?? 1}" data-clip-volume /></label>
          <label>画面大小 <output data-scale-output>${Math.round(Number(clip.scale ?? (Number(clip.track) ? 0.42 : 1)) * 100)}%</output><input type="range" min="0.15" max="1" step="0.05" value="${clip.scale ?? (Number(clip.track) ? 0.42 : 1)}" data-clip-scale /></label>
          <div class="video-clip-layout-fields"><label>水平位置<input type="range" min="0" max="1" step="0.05" value="${clip.position_x ?? 0.5}" data-clip-position-x /></label><label>垂直位置<input type="range" min="0" max="1" step="0.05" value="${clip.position_y ?? 0.5}" data-clip-position-y /></label></div>
          <label>不透明度 <output data-opacity-output>${Math.round(Number(clip.opacity ?? 1) * 100)}%</output><input type="range" min="0.05" max="1" step="0.05" value="${clip.opacity ?? 1}" data-clip-opacity /></label>
        </div>` : '<div class="video-inspector-empty">选择时间线中的片段后，可调整裁剪范围和音量。</div>'}
      </section>
      <section class="video-export-panel">
        <div class="video-editor-section-heading"><div><span class="eyebrow">EXPORT</span><h3>合并导出</h3></div></div>
        <label>画布比例<select data-project-ratio>
          ${[["source", "跟随首个素材"], ["16:9", "横屏 16:9"], ["9:16", "竖屏 9:16"], ["1:1", "方形 1:1"]].map(([value, label]) => `<option value="${value}" ${state.project?.settings?.ratio === value ? "selected" : ""}>${label}</option>`).join("")}
        </select></label>
        <label>输出清晰度<select data-project-quality><option value="720p" ${state.project?.settings?.quality !== "1080p" ? "selected" : ""}>高清 720p</option><option value="1080p" ${state.project?.settings?.quality === "1080p" ? "selected" : ""}>全高清 1080p</option></select></label>
        <button type="button" class="video-export-button" data-project-export ${(state.project?.clips || []).length ? "" : "disabled"}>导出 MP4 成品</button>
        <div data-export-status-host>${renderExportStatus()}</div>
      </section>
    </aside>`;
  }

  function renderExportStatus() {
    const job = state.exportJob;
    if (!job) return '<p class="video-export-note">导出在服务器后台完成，关闭页面也不会丢失项目。</p>';
    if (ACTIVE_EXPORTS.has(job.status)) return `<div class="video-export-status"><div><strong>${job.status === "queued" ? "等待导出" : "正在导出"}</strong><span>${job.progress || 0}%</span></div><progress max="100" value="${job.progress || 0}"></progress></div>`;
    if (job.status === "success") return `<div class="video-export-status is-success"><strong>最近成品已导出</strong><div><button class="video-icon-button" type="button" data-export-preview="${escapeHtml(job.output_asset_id)}" aria-label="预览导出视频" title="预览">${icon("eye")}</button><a class="video-icon-button" href="${escapeHtml(authenticatedMediaUrl(job.download_url))}" download aria-label="下载 MP4" title="下载 MP4">${icon("download")}</a></div></div>`;
    return `<div class="video-export-status is-error"><strong>最近导出失败</strong><span>${escapeHtml(job.error || "请重试")}</span></div>`;
  }

  function render() {
    const host = root();
    if (!host || !state.project) return;
    renderHeading();
    host.innerHTML = `<div class="video-editor-app">
      <div class="video-editor-message" data-editor-message data-type="${escapeHtml(state.messageType)}" ${state.message ? "" : "hidden"}>${escapeHtml(state.message)}</div>
      <div class="video-editor-main-grid">${renderAssetLibrary()}<div class="video-editor-center">${renderPreview()}${renderTimeline()}</div>${renderInspector()}</div>
    </div>`;
    bindPreviewElement();
    if (state.project?.clips?.length) seekPreview(Math.min(state.previewTimelineTime, timelineDuration()), state.previewPlaying);
  }

  function renderHeading() {
    const host = headingRoot();
    if (!host) return;
    host.innerHTML = `<header class="video-editor-toolbar">
      <div class="video-editor-heading"><span class="video-editor-mark" aria-hidden="true">${icon("scissors")}</span><div><span class="eyebrow">VECTO CUT ROOM</span><h2>视频素材与简易剪辑</h2><p>生成记录、本地素材、剪辑项目和导出成品统一保存。</p></div></div>
      ${state.project ? `<div class="video-project-controls">
        <label><span>当前项目</span><select data-project-select>${state.projects.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === state.project.id ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}</select></label>
        <button type="button" class="video-icon-button" data-project-new aria-label="新建项目" title="新建项目">${icon("plus")}</button>
        <button type="button" class="video-icon-button" data-project-rename aria-label="重命名项目" title="重命名项目">${icon("edit")}</button>
        <button type="button" class="video-icon-button danger-link" data-project-delete aria-label="删除项目" title="删除项目">${icon("trash")}</button>
        <span class="video-save-state" data-editor-save-state data-state="${state.dirty ? "dirty" : "saved"}">${state.dirty ? "有更改待保存" : "已保存到服务器"}</span>
      </div>` : ""}
    </header>`;
  }

  function addAssetToTimeline(assetId, placement = {}) {
    const asset = assetById(assetId);
    if (!asset || !state.project) return;
    const track = Math.max(0, Math.min(VIDEO_TRACKS - 1, Math.trunc(Number(placement.track) || 0)));
    const trackEnd = timelineSegments().filter((segment) => segment.track === track).reduce((end, segment) => Math.max(end, segment.to), 0);
    const requestedStart = Number(placement.timelineStart);
    const timelineStart = Number.isFinite(requestedStart) && requestedStart >= 0 ? requestedStart : trackEnd;
    const clip = {
      id: `clip_${window.crypto?.randomUUID?.().replaceAll("-", "") || `${Date.now()}${Math.random().toString(16).slice(2)}`}`,
      asset_id: asset.id,
      start: 0,
      end: Math.max(Number(asset.duration) || 0.05, 0.05),
      volume: 1,
      speed: 1,
      track,
      timeline_start: Number(timelineStart.toFixed(3)),
      scale: track ? 0.42 : 1,
      position_x: track ? 0.94 : 0.5,
      position_y: track ? 0.06 : 0.5,
      opacity: 1,
    };
    mutateTimeline(() => {
      state.project.clips = [...(state.project.clips || []), clip];
      state.selectedClipId = clip.id;
      state.previewTimelineTime = timelineStart;
    });
  }

  function placeClip(clipId, track, timelineStart) {
    const clip = state.project?.clips?.find((item) => item.id === clipId);
    if (!clip) return;
    mutateTimeline(() => {
      clip.track = Math.max(0, Math.min(VIDEO_TRACKS - 1, Math.trunc(Number(track) || 0)));
      clip.timeline_start = Number(Math.max(0, Number(timelineStart) || 0).toFixed(3));
      if (clip.scale === undefined) clip.scale = clip.track ? 0.42 : 1;
      if (clip.position_x === undefined) clip.position_x = clip.track ? 0.94 : 0.5;
      if (clip.position_y === undefined) clip.position_y = clip.track ? 0.06 : 0.5;
    });
  }

  function splitSelectedClip() {
    const clips = state.project?.clips || [];
    const index = clips.findIndex((item) => item.id === state.selectedClipId);
    if (index < 0) return;
    const segment = timelineSegments()[index];
    const clip = clips[index];
    if (!segment || state.previewTimelineTime <= segment.from || state.previewTimelineTime >= segment.to) {
      showMessage("请先把播放头移动到所选片段内部再分割。", "error");
      return;
    }
    const relative = (state.previewTimelineTime - segment.from) * Math.max(0.5, Number(clip.speed || 1));
    const split = Number(clip.start) + relative;
    if (!(split > Number(clip.start) + 0.05 && split < Number(clip.end) - 0.05)) {
      showMessage("播放头距离片段边缘太近，无法分割。", "error");
      return;
    }
    const first = { ...clip, end: Number(split.toFixed(3)) };
    const second = { ...clip, id: `clip_${window.crypto?.randomUUID?.().replaceAll("-", "") || Date.now()}`, start: Number(split.toFixed(3)), timeline_start: Number(state.previewTimelineTime.toFixed(3)) };
    mutateTimeline(() => {
      state.project.clips = [...clips.slice(0, index), first, second, ...clips.slice(index + 1)];
      state.selectedClipId = second.id;
    });
  }

  function selectedSegment() {
    return timelineSegments().find((item) => item.clip.id === state.selectedClipId) || null;
  }

  function removeSelectedClip() {
    if (!selectedClip()) return;
    mutateTimeline(() => {
      state.project.clips = state.project.clips.filter((item) => item.id !== state.selectedClipId);
      state.selectedClipId = "";
      state.previewTimelineTime = Math.min(state.previewTimelineTime, timelineDuration());
    });
  }

  function duplicateSelectedClip() {
    const clip = selectedClip();
    if (!clip) return;
    const index = state.project.clips.findIndex((item) => item.id === clip.id);
    const sameTrackEnd = timelineSegments().filter((segment) => segment.track === Number(clip.track || 0)).reduce((end, segment) => Math.max(end, segment.to), 0);
    const copy = { ...clip, id: `clip_${window.crypto?.randomUUID?.().replaceAll("-", "") || `${Date.now()}copy`}`, timeline_start: Number(sameTrackEnd.toFixed(3)) };
    mutateTimeline(() => {
      state.project.clips = [...state.project.clips.slice(0, index + 1), copy, ...state.project.clips.slice(index + 1)];
      state.selectedClipId = copy.id;
    });
  }

  function trimSelectedToPlayhead(side) {
    const segment = selectedSegment();
    if (!segment || state.previewTimelineTime <= segment.from || state.previewTimelineTime >= segment.to) {
      showMessage("请把播放头移动到所选片段内部再执行裁切。", "error");
      return;
    }
    const sourceTime = Number(segment.clip.start) + (state.previewTimelineTime - segment.from) * Math.max(0.5, Number(segment.clip.speed || 1));
    mutateTimeline(() => {
      if (side === "start") segment.clip.start = Number(sourceTime.toFixed(3));
      else segment.clip.end = Number(sourceTime.toFixed(3));
      state.previewTimelineTime = side === "start" ? segment.from : Math.min(state.previewTimelineTime, timelineDuration());
    });
  }

  function addTimelineMarker() {
    if (!state.project?.clips?.length) return;
    const markers = [...(state.project.settings?.markers || [])];
    const time = Number(state.previewTimelineTime.toFixed(3));
    if (markers.some((item) => Math.abs(Number(item.time) - time) < 0.03)) return;
    markers.push({ id: `marker_${window.crypto?.randomUUID?.().replaceAll("-", "") || Date.now()}`, time });
    markers.sort((a, b) => Number(a.time) - Number(b.time));
    state.project.settings = { ...(state.project.settings || {}), markers };
    markDirty();
    render();
  }

  async function uploadFiles(files) {
    const videos = Array.from(files || []).filter((file) => file && (String(file.type || "").startsWith("video/") || /\.(?:mp4|mov|m4v|webm|mkv|avi|wmv|flv|mpeg|mpg|ts|mts|m2ts|3gp|ogv)$/i.test(file.name)));
    if (!videos.length || state.uploadBusy) return;
    state.uploadBusy = true;
    state.uploadMessage = `正在处理 1 / ${videos.length}`;
    render();
    try {
      for (let index = 0; index < videos.length; index += 1) {
        state.uploadMessage = `正在处理 ${index + 1} / ${videos.length}：${videos[index].name}`;
        const body = new FormData();
        body.append("video", videos[index]);
        await request(`${API}/assets/upload`, { method: "POST", body });
      }
      await loadAssets(false);
      state.uploadMessage = `已保存 ${videos.length} 个视频素材`;
      render();
    } catch (error) {
      state.uploadMessage = "";
      showError(error);
    } finally {
      state.uploadBusy = false;
      render();
    }
  }

  async function deleteAsset(assetId) {
    const asset = assetById(assetId);
    if (!asset) return;
    const decision = await requestActionDialog({ title: "删除视频素材", message: `确定删除“${asset.name}”吗？原始文件和预览文件都会删除。`, confirmText: "删除素材", danger: true });
    if (!decision.confirmed) return;
    await request(`${API}/assets/${encodeURIComponent(assetId)}`, { method: "DELETE" });
    state.assets = state.assets.filter((item) => item.id !== assetId);
    render();
    showMessage("素材已删除");
  }

  async function switchProject(projectId) {
    if (state.dirty) await saveProject();
    const project = state.projects.find((item) => item.id === projectId);
    if (!project) return;
    state.project = project;
    state.selectedClipId = "";
    state.previewTimelineTime = 0;
    state.dirty = false;
    state.editRevision = 0;
    state.savedRevision = 0;
    state.history = [];
    state.future = [];
    await loadExports();
    render();
  }

  async function newProject() {
    if (state.dirty) await saveProject();
    const decision = await requestActionDialog({ title: "新建剪辑项目", message: "为新的时间线输入一个便于识别的名称。", inputLabel: "项目名称", inputValue: `剪辑项目 ${state.projects.length + 1}`, confirmText: "新建项目" });
    if (!decision.confirmed) return;
    await createProject(decision.value);
    render();
  }

  async function renameProject() {
    const decision = await requestActionDialog({ title: "重命名剪辑项目", message: "修改只影响项目名称，不会更改时间线内容。", inputLabel: "项目名称", inputValue: state.project?.name || "", confirmText: "保存名称" });
    if (!decision.confirmed) return;
    state.project.name = decision.value;
    markDirty();
    render();
    await saveProject();
    render();
  }

  async function deleteProject() {
    if (!state.project) return;
    const decision = await requestActionDialog({ title: "删除剪辑项目", message: `确定删除“${state.project.name}”吗？素材库中的视频不会被删除。`, confirmText: "删除项目", danger: true });
    if (!decision.confirmed) return;
    await request(`${API}/projects/${encodeURIComponent(state.project.id)}`, { method: "DELETE" });
    state.projects = state.projects.filter((item) => item.id !== state.project.id);
    if (!state.projects.length) await createProject("我的剪辑");
    else state.project = state.projects[0];
    state.selectedClipId = "";
    state.dirty = false;
    state.editRevision = 0;
    state.savedRevision = 0;
    state.history = [];
    state.future = [];
    await loadExports();
    render();
  }

  async function startExport() {
    if (!state.project?.clips?.length || ACTIVE_EXPORTS.has(state.exportJob?.status)) return;
    await saveProject();
    const payload = await request(`${API}/projects/${encodeURIComponent(state.project.id)}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `${state.project.name}-成品`, settings: state.project.settings || {} }),
    });
    state.exportJob = payload.export;
    render();
    syncExportPolling();
  }

  async function refreshExport() {
    if (!state.exportJob?.id) return;
    const payload = await request(`${API}/exports/${encodeURIComponent(state.exportJob.id)}`);
    state.exportJob = payload.export;
    if (state.exportJob.status === "success") {
      await loadAssets(false);
      render();
    } else {
      const host = document.querySelector("[data-export-status-host]");
      if (host) host.innerHTML = renderExportStatus();
    }
    syncExportPolling();
  }

  function syncExportPolling() {
    window.clearTimeout(state.exportTimer);
    state.exportTimer = 0;
    if (state.active && ACTIVE_EXPORTS.has(state.exportJob?.status)) {
      state.exportTimer = window.setTimeout(() => refreshExport().catch(showError), 1500);
    }
  }

  function previewSegmentsForTime(time) {
    const segments = timelineSegments();
    if (!segments.length) return [];
    const safe = Math.max(0, Math.min(Number(time) || 0, timelineDuration()));
    const atEnd = safe >= timelineDuration() - 0.001;
    return segments.filter((item) => safe >= item.from && (safe < item.to || (atEnd && Math.abs(item.to - timelineDuration()) < 0.001)))
      .sort((a, b) => a.track - b.track || a.from - b.from);
  }

  function previewSegmentForTime(time) {
    const active = previewSegmentsForTime(time);
    return active.length ? active[active.length - 1] : null;
  }

  function previewLayersMarkup(time) {
    return previewSegmentsForTime(time).map((segment) => {
      const asset = assetById(segment.clip.asset_id);
      if (!asset) return "";
      const scale = Math.max(0.15, Math.min(1, Number(segment.clip.scale ?? (segment.track ? 0.42 : 1))));
      const x = Math.max(0, Math.min(1, Number(segment.clip.position_x ?? (segment.track ? 0.94 : 0.5))));
      const y = Math.max(0, Math.min(1, Number(segment.clip.position_y ?? (segment.track ? 0.06 : 0.5))));
      const opacity = Math.max(0.05, Math.min(1, Number(segment.clip.opacity ?? 1)));
      const left = (1 - scale) * x * 100;
      const top = (1 - scale) * y * 100;
      return `<video data-editor-preview data-preview-clip-id="${escapeHtml(segment.clip.id)}" src="${escapeHtml(authenticatedMediaUrl(asset.media_url))}" preload="auto" playsinline style="left:${left.toFixed(2)}%;top:${top.toFixed(2)}%;width:${(scale * 100).toFixed(2)}%;height:${(scale * 100).toFixed(2)}%;opacity:${opacity};z-index:${segment.track + 1}"></video>`;
    }).join("");
  }

  function requestVideoPlay(video) {
    if (!state.previewPlaying || video.dataset.playRequested === "1") return;
    video.dataset.playRequested = "1";
    video.play().catch(() => {}).finally(() => { video.dataset.playRequested = "0"; });
  }

  function syncPreviewLayers(time, shouldPlay = state.previewPlaying, force = false) {
    const stack = document.querySelector("[data-preview-stack]");
    if (!stack) return;
    const segments = previewSegmentsForTime(time);
    const key = segments.map((segment) => segment.clip.id).join("|");
    if (force || stack.dataset.layerKey !== key) {
      stack.dataset.layerKey = key;
      stack.innerHTML = previewLayersMarkup(time);
    }
    const segmentMap = new Map(segments.map((segment) => [segment.clip.id, segment]));
    stack.querySelectorAll("[data-editor-preview]").forEach((video) => {
      const segment = segmentMap.get(video.dataset.previewClipId);
      if (!segment) return;
      const clip = segment.clip;
      const desired = Math.min(Number(clip.end) - 0.005, Number(clip.start) + Math.max(0, Number(time) - segment.from) * Math.max(0.5, Number(clip.speed || 1)));
      video.volume = Math.max(0, Math.min(1, Number(clip.volume ?? 1)));
      video.playbackRate = Math.max(0.5, Math.min(2, Number(clip.speed || 1)));
      video.dataset.targetTime = String(Math.max(Number(clip.start), desired));
      if (video.dataset.previewBound !== "1") {
        video.dataset.previewBound = "1";
        video.addEventListener("loadedmetadata", () => {
          const target = Number(video.dataset.targetTime);
          if (Number.isFinite(target)) {
            try { video.currentTime = target; } catch {}
          }
          requestVideoPlay(video);
        });
        video.addEventListener("canplay", () => requestVideoPlay(video));
      }
      if (video.readyState >= 1 && (!shouldPlay || Math.abs(Number(video.currentTime) - desired) > 0.28)) {
        try { video.currentTime = Math.max(Number(clip.start), desired); } catch {}
      }
      if (shouldPlay) requestVideoPlay(video);
      else video.pause();
    });
  }

  function stopPreviewClock() {
    if (state.previewFrame) window.cancelAnimationFrame(state.previewFrame);
    state.previewFrame = 0;
  }

  function startPreviewClock() {
    stopPreviewClock();
    state.previewAnchorTime = state.previewTimelineTime;
    state.previewAnchorNow = window.performance.now();
    const tick = (now) => {
      if (!state.previewPlaying) return stopPreviewClock();
      const duration = timelineDuration();
      state.previewTimelineTime = Math.min(duration, state.previewAnchorTime + Math.max(0, now - state.previewAnchorNow) / 1000);
      if (state.previewTimelineTime >= duration) {
        state.previewPlaying = false;
        syncPreviewLayers(duration, false);
        stopPreviewClock();
      } else {
        syncPreviewLayers(state.previewTimelineTime, true);
        state.previewFrame = window.requestAnimationFrame(tick);
      }
      updatePreviewUi();
    };
    state.previewFrame = window.requestAnimationFrame(tick);
  }

  function seekPreview(time, shouldPlay = state.previewPlaying) {
    state.previewTimelineTime = Math.max(0, Math.min(Number(time) || 0, timelineDuration()));
    const segment = previewSegmentForTime(state.previewTimelineTime);
    if (segment) state.selectedClipId = segment.clip.id;
    state.previewPlaying = Boolean(shouldPlay);
    syncPreviewLayers(state.previewTimelineTime, state.previewPlaying);
    if (state.previewPlaying) startPreviewClock();
    else stopPreviewClock();
    updatePreviewUi();
  }

  function updatePreviewUi() {
    const duration = timelineDuration();
    const current = document.querySelector("[data-preview-current]");
    const scrubber = document.querySelector("[data-preview-scrubber]");
    const toggle = document.querySelector("[data-preview-toggle]");
    const playhead = document.querySelector("[data-timeline-playhead]");
    if (current) current.textContent = formatDuration(state.previewTimelineTime);
    if (scrubber) scrubber.value = String(Math.max(0, Math.min(state.previewTimelineTime, duration)));
    if (toggle) {
      toggle.innerHTML = icon(state.previewPlaying ? "pause" : "play");
      toggle.setAttribute("aria-label", state.previewPlaying ? "暂停" : "播放");
    }
    if (playhead) playhead.style.left = `${54 + state.previewTimelineTime * state.timelineZoom}px`;
  }

  function bindPreviewElement() {
    syncPreviewLayers(state.previewTimelineTime, state.previewPlaying, true);
  }

  function previewStandaloneAsset(assetId) {
    const asset = assetById(assetId);
    if (!asset) return;
    const modal = document.createElement("div");
    modal.className = "video-preview-modal";
    modal.innerHTML = `<div role="dialog" aria-modal="true" aria-label="视频素材预览"><header><strong>${escapeHtml(asset.name)}</strong><button class="video-icon-button" type="button" aria-label="关闭预览" title="关闭" data-preview-close>${icon("close")}</button></header><video src="${escapeHtml(authenticatedMediaUrl(asset.media_url))}" controls autoplay playsinline></video></div>`;
    modal.addEventListener("click", (event) => { if (event.target === modal || event.target.closest("[data-preview-close]")) modal.remove(); });
    document.body.appendChild(modal);
  }

  function timelineTimeFromPointer(event, allowBeyondEnd = false) {
    const canvas = event.target.closest?.("[data-timeline-seek]") || document.querySelector("[data-timeline-seek]");
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    const pointed = Math.max(0, (Number(event.clientX) - rect.left - 54) / state.timelineZoom);
    return allowBeyondEnd ? pointed : Math.min(pointed, timelineDuration());
  }

  function setTimelineZoom(value) {
    const viewport = document.querySelector("[data-timeline-scroll]");
    const oldZoom = state.timelineZoom;
    const anchorTime = Math.max(0, Math.min(state.previewTimelineTime, timelineDuration()));
    const anchorOffset = viewport ? 54 + anchorTime * oldZoom - viewport.scrollLeft : 54;
    state.timelineZoom = Math.max(16, Math.min(180, Math.round(Number(value) || 64)));
    render();
    const nextViewport = document.querySelector("[data-timeline-scroll]");
    if (nextViewport) nextViewport.scrollLeft = Math.max(0, 54 + anchorTime * state.timelineZoom - anchorOffset);
  }

  function fitTimeline() {
    const viewport = document.querySelector("[data-timeline-scroll]");
    const duration = timelineDuration();
    if (!viewport || duration <= 0) return setTimelineZoom(64);
    setTimelineZoom((viewport.clientWidth - 88) / duration);
  }

  function onClick(event) {
    if (event.target.closest("[data-editor-retry]")) return void loadAll();
    const assetPage = event.target.closest("[data-asset-page]");
    if (assetPage && !assetPage.disabled) { state.assetPage = Number(assetPage.dataset.assetPage) || 1; render(); return; }
    const add = event.target.closest("[data-asset-add]");
    if (add) return addAssetToTimeline(add.dataset.assetAdd);
    const preview = event.target.closest("[data-asset-preview]");
    if (preview) return previewStandaloneAsset(preview.dataset.assetPreview);
    const exportPreview = event.target.closest("[data-export-preview]");
    if (exportPreview) return previewStandaloneAsset(exportPreview.dataset.exportPreview);
    const removeAsset = event.target.closest("[data-asset-delete]");
    if (removeAsset) return void deleteAsset(removeAsset.dataset.assetDelete).catch(showError);
    if (event.target.closest("[data-project-new]")) return void newProject().catch(showError);
    if (event.target.closest("[data-project-rename]")) return void renameProject().catch(showError);
    if (event.target.closest("[data-project-delete]")) return void deleteProject().catch(showError);
    if (event.target.closest("[data-project-export]")) return void startExport().catch(showError);
    if (event.target.closest("[data-timeline-undo]")) return undoTimeline();
    if (event.target.closest("[data-timeline-redo]")) return redoTimeline();
    if (event.target.closest("[data-timeline-zoom-out]")) return setTimelineZoom(state.timelineZoom - 12);
    if (event.target.closest("[data-timeline-zoom-in]")) return setTimelineZoom(state.timelineZoom + 12);
    if (event.target.closest("[data-timeline-zoom-fit]")) return fitTimeline();
    if (event.target.closest("[data-clip-duplicate]")) return duplicateSelectedClip();
    if (event.target.closest("[data-trim-to-playhead]")) return trimSelectedToPlayhead(event.target.closest("[data-trim-to-playhead]").dataset.trimToPlayhead);
    if (event.target.closest("[data-timeline-marker-add]")) return addTimelineMarker();
    const marker = event.target.closest("[data-marker-time]");
    if (marker) { seekPreview(Number(marker.dataset.markerTime), false); return; }
    const clipNode = event.target.closest("[data-clip-id]");
    if (clipNode) {
      state.selectedClipId = clipNode.dataset.clipId;
      state.previewTimelineTime = timelineTimeFromPointer(event);
      render();
      return;
    }
    if (event.target.closest("[data-clip-remove]")) {
      return removeSelectedClip();
    }
    if (event.target.closest("[data-clip-split]")) return splitSelectedClip();
    if (event.target.closest("[data-preview-toggle]")) {
      state.previewPlaying = !state.previewPlaying;
      if (state.previewTimelineTime >= timelineDuration()) state.previewTimelineTime = 0;
      if (state.previewPlaying) seekPreview(state.previewTimelineTime, true);
      else {
        stopPreviewClock();
        document.querySelectorAll("[data-editor-preview]").forEach((video) => video.pause());
        updatePreviewUi();
      }
      return;
    }
    if (event.target.closest("[data-timeline-seek]")) seekPreview(timelineTimeFromPointer(event), false);
  }

  function onInput(event) {
    if (event.target.matches("[data-editor-search]")) {
      state.search = event.target.value;
      state.assetPage = 1;
      updateAssetResults();
      return;
    }
    const clip = selectedClip();
    const asset = clip ? assetById(clip.asset_id) : null;
    if (clip && asset && event.target.matches("[data-clip-start], [data-clip-end]")) {
      const startInput = document.querySelector("[data-clip-start]");
      const endInput = document.querySelector("[data-clip-end]");
      const start = Math.max(0, Math.min(Number(startInput.value) || 0, asset.duration - 0.05));
      const end = Math.min(asset.duration, Math.max(Number(endInput.value) || asset.duration, start + 0.05));
      clip.start = Number(start.toFixed(3));
      clip.end = Number(end.toFixed(3));
      startInput.value = String(clip.start);
      endInput.value = String(clip.end);
      markDirty();
      return;
    }
    if (clip && event.target.matches("[data-clip-volume]")) {
      clip.volume = Number(event.target.value);
      const output = document.querySelector("[data-volume-output]");
      if (output) output.textContent = `${Math.round(clip.volume * 100)}%`;
      markDirty();
      return;
    }
    if (clip && event.target.matches("[data-clip-scale], [data-clip-position-x], [data-clip-position-y], [data-clip-opacity]")) {
      const field = event.target.matches("[data-clip-scale]") ? "scale" : event.target.matches("[data-clip-position-x]") ? "position_x" : event.target.matches("[data-clip-position-y]") ? "position_y" : "opacity";
      clip[field] = Number(event.target.value);
      const output = field === "scale" ? document.querySelector("[data-scale-output]") : field === "opacity" ? document.querySelector("[data-opacity-output]") : null;
      if (output) output.textContent = `${Math.round(clip[field] * 100)}%`;
      markDirty();
      syncPreviewLayers(state.previewTimelineTime, false, true);
      return;
    }
    if (clip && event.target.matches("[data-clip-timeline-start]")) {
      clip.timeline_start = Number(Math.max(0, Number(event.target.value) || 0).toFixed(3));
      markDirty();
      return;
    }
    if (event.target.matches("[data-preview-scrubber]")) seekPreview(Number(event.target.value), false);
  }

  function onChange(event) {
    if (event.target.matches("[data-editor-upload]")) return void uploadFiles(event.target.files);
    if (event.target.matches("[data-editor-filter]")) {
      state.filter = event.target.value;
      state.assetPage = 1;
      render();
      return;
    }
    if (event.target.matches("[data-project-select]")) return void switchProject(event.target.value).catch(showError);
    if (event.target.matches("[data-timeline-zoom]")) { setTimelineZoom(event.target.value); return; }
    if (event.target.matches("[data-project-ratio]")) {
      state.project.settings = { ...(state.project.settings || {}), ratio: event.target.value };
      markDirty();
      return;
    }
    if (event.target.matches("[data-project-quality]")) {
      state.project.settings = { ...(state.project.settings || {}), quality: event.target.value };
      markDirty();
      return;
    }
    if (event.target.matches("[data-clip-speed]")) {
      const clip = selectedClip();
      if (!clip) return;
      recordHistory();
      clip.speed = Math.max(0.5, Math.min(2, Number(event.target.value) || 1));
      state.previewTimelineTime = Math.min(state.previewTimelineTime, timelineDuration());
      markDirty();
      render();
      return;
    }
    if (event.target.matches("[data-clip-track]")) {
      const clip = selectedClip();
      if (!clip) return;
      recordHistory();
      const wasOverlay = Number(clip.track || 0) > 0;
      clip.track = Math.max(0, Math.min(VIDEO_TRACKS - 1, Math.trunc(Number(event.target.value) || 0)));
      if (!wasOverlay && clip.track > 0 && Number(clip.scale ?? 1) === 1) {
        clip.scale = 0.42;
        clip.position_x = 0.94;
        clip.position_y = 0.06;
      }
      markDirty();
      render();
      return;
    }
    if (event.target.matches("[data-clip-timeline-start]")) {
      state.previewTimelineTime = Math.min(state.previewTimelineTime, timelineDuration());
      render();
      return;
    }
    if (event.target.matches("[data-clip-start], [data-clip-end]")) {
      state.previewTimelineTime = Math.min(state.previewTimelineTime, timelineDuration());
      render();
    }
  }

  function onDragStart(event) {
    if (event.target.closest("[data-trim-handle]")) {
      event.preventDefault();
      return;
    }
    const asset = event.target.closest("[data-asset-id]");
    const clip = event.target.closest("[data-clip-id]");
    if (asset) {
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData("application/x-vecto-video-asset", asset.dataset.assetId);
    } else if (clip) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-vecto-video-clip", clip.dataset.clipId);
    }
  }

  function onPointerDown(event) {
    const handle = event.target.closest("[data-trim-handle]");
    if (!handle) return;
    const clipNode = handle.closest("[data-clip-id]");
    const clip = state.project?.clips?.find((item) => item.id === clipNode?.dataset.clipId);
    if (!clip) return;
    event.preventDefault();
    event.stopPropagation();
    state.selectedClipId = clip.id;
    state.trimDrag = {
      clipId: clip.id,
      side: handle.dataset.trimHandle,
      startX: Number(event.clientX),
      originalStart: Number(clip.start),
      originalEnd: Number(clip.end),
      before: timelineSnapshot(),
      changed: false,
    };
    document.body.classList.add("video-timeline-is-trimming");
  }

  function onPointerMove(event) {
    const drag = state.trimDrag;
    if (!drag) return;
    const clip = state.project?.clips?.find((item) => item.id === drag.clipId);
    const asset = clip ? assetById(clip.asset_id) : null;
    if (!clip || !asset) return;
    const sourceDelta = (Number(event.clientX) - drag.startX) / state.timelineZoom * Math.max(0.5, Number(clip.speed || 1));
    if (drag.side === "start") clip.start = Number(Math.max(0, Math.min(drag.originalStart + sourceDelta, drag.originalEnd - 0.05)).toFixed(3));
    else clip.end = Number(Math.min(Number(asset.duration), Math.max(drag.originalEnd + sourceDelta, drag.originalStart + 0.05)).toFixed(3));
    drag.changed = Math.abs(clip.start - drag.originalStart) > 0.001 || Math.abs(clip.end - drag.originalEnd) > 0.001;
    const node = document.querySelector(`[data-clip-id="${CSS.escape(clip.id)}"]`);
    if (node) node.style.setProperty("--clip-width", `${Math.max(48, clipDuration(clip) * state.timelineZoom)}px`);
    const startInput = document.querySelector("[data-clip-start]");
    const endInput = document.querySelector("[data-clip-end]");
    if (startInput) startInput.value = String(clip.start);
    if (endInput) endInput.value = String(clip.end);
  }

  function onPointerUp() {
    const drag = state.trimDrag;
    if (!drag) return;
    state.trimDrag = null;
    document.body.classList.remove("video-timeline-is-trimming");
    if (!drag.changed) return;
    recordHistory(drag.before);
    state.previewTimelineTime = Math.min(state.previewTimelineTime, timelineDuration());
    markDirty();
    render();
  }

  function onKeyDown(event) {
    const uploadZone = event.target?.closest?.("[data-editor-drop-zone]");
    if (uploadZone && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      uploadZone.querySelector("[data-editor-upload]")?.click();
      return;
    }
    if (!state.active || event.target?.closest?.("input, select, textarea, [contenteditable='true']")) return;
    const command = event.ctrlKey || event.metaKey;
    if (command && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? redoTimeline() : undoTimeline(); return; }
    if (command && event.key.toLowerCase() === "b") { event.preventDefault(); splitSelectedClip(); return; }
    if (command && event.key.toLowerCase() === "d") { event.preventDefault(); duplicateSelectedClip(); return; }
    if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); removeSelectedClip(); return; }
    if (event.key === " ") { event.preventDefault(); document.querySelector("[data-preview-toggle]")?.click(); return; }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const delta = (event.shiftKey ? 1 : 1 / 30) * (event.key === "ArrowLeft" ? -1 : 1);
      seekPreview(state.previewTimelineTime + delta, false);
      return;
    }
    if (event.shiftKey && event.key.toLowerCase() === "z") { event.preventDefault(); fitTimeline(); }
  }

  function onDragOver(event) {
    if (event.target.closest("[data-timeline-drop], [data-editor-drop-zone]")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = event.dataTransfer.types.includes("Files") ? "copy" : "move";
      event.target.closest("[data-editor-drop-zone]")?.classList.add("is-dragging");
    }
  }

  function onDragLeave(event) {
    const uploadZone = event.target.closest?.("[data-editor-drop-zone]");
    if (uploadZone && !uploadZone.contains(event.relatedTarget)) uploadZone.classList.remove("is-dragging");
  }

  function onDrop(event) {
    const uploadZone = event.target.closest("[data-editor-drop-zone]");
    uploadZone?.classList.remove("is-dragging");
    if (uploadZone && event.dataTransfer.files?.length) {
      event.preventDefault();
      void uploadFiles(event.dataTransfer.files);
      return;
    }
    const timeline = event.target.closest("[data-timeline-drop]");
    if (!timeline) return;
    event.preventDefault();
    const trackNode = event.target.closest("[data-track-index]");
    const track = Math.max(0, Math.min(VIDEO_TRACKS - 1, Number(trackNode?.dataset.trackIndex) || 0));
    const timelineStart = timelineTimeFromPointer(event, true);
    const assetId = event.dataTransfer.getData("application/x-vecto-video-asset");
    if (assetId) return addAssetToTimeline(assetId, { track, timelineStart });
    const clipId = event.dataTransfer.getData("application/x-vecto-video-clip");
    if (!clipId) return;
    placeClip(clipId, track, timelineStart);
  }

  function bindRoot() {
    const host = root();
    if (!host || host.dataset.bound === "1") return;
    host.dataset.bound = "1";
    host.addEventListener("click", onClick);
    host.addEventListener("input", onInput);
    host.addEventListener("change", onChange);
    host.addEventListener("dragstart", onDragStart);
    host.addEventListener("dragover", onDragOver);
    host.addEventListener("dragleave", onDragLeave);
    host.addEventListener("drop", onDrop);
    host.addEventListener("pointerdown", onPointerDown);
    host.addEventListener("focusin", (event) => {
      if (event.target.matches("[data-clip-start], [data-clip-end], [data-clip-volume], [data-clip-timeline-start], [data-clip-scale], [data-clip-position-x], [data-clip-position-y], [data-clip-opacity]")) state.inspectorSnapshot = timelineSnapshot();
    });
    host.addEventListener("focusout", (event) => {
      if (!event.target.matches("[data-clip-start], [data-clip-end], [data-clip-volume], [data-clip-timeline-start], [data-clip-scale], [data-clip-position-x], [data-clip-position-y], [data-clip-opacity]")) return;
      if (state.inspectorSnapshot && state.inspectorSnapshot !== timelineSnapshot()) recordHistory(state.inspectorSnapshot);
      state.inspectorSnapshot = "";
    });
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("keydown", onKeyDown);
    const heading = headingRoot();
    if (heading && heading.dataset.editorBound !== "1") {
      heading.dataset.editorBound = "1";
      heading.addEventListener("click", onClick);
      heading.addEventListener("change", onChange);
    }
  }

  async function consumePendingAsset() {
    const assetId = state.pendingAssetId;
    if (!assetId) return;
    state.pendingAssetId = "";
    if (!assetById(assetId)) await loadAssets(false);
    if (assetById(assetId)) {
      addAssetToTimeline(assetId);
      showMessage("视频已加入当前剪辑项目。");
    }
  }

  function activate({ assetId = "" } = {}) {
    state.active = true;
    if (assetId) state.pendingAssetId = String(assetId);
    bindRoot();
    if (!state.loaded) void loadAll().then(consumePendingAsset).catch(showError);
    else {
      render();
      void loadAssets(true).then(async () => { await consumePendingAsset(); render(); }).catch(showError);
      syncExportPolling();
    }
  }

  function deactivate() {
    state.active = false;
    state.previewPlaying = false;
    stopPreviewClock();
    document.querySelectorAll("[data-editor-preview]").forEach((video) => video.pause());
    window.clearTimeout(state.exportTimer);
    if (state.dirty) void saveProject().catch(() => {});
  }

  window.addEventListener("beforeunload", (event) => {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = "";
  });

  window.VideoEditor = { activate, deactivate, refresh: loadAll };
}());
