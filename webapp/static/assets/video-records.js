(function videoRecordsBootstrap() {
  "use strict";

  const API = "/api/video/editor/assets";
  const ADMIN_WORKSPACE_USER_ID = String(document.querySelector('meta[name="admin-workspace-user-id"]')?.content || "").trim();
  const ADMIN_CONSOLE_SESSION = document.querySelector('meta[name="admin-console-session"]')?.content === "1";
  const state = {
    active: false,
    loading: false,
    loaded: false,
    items: [],
    page: 1,
    pageSize: 12,
    total: 0,
    totalPages: 0,
    sourceType: "generated",
    query: "",
    requestToken: 0,
    searchTimer: 0,
    error: "",
    openActionId: "",
    shareItemId: "",
    shareFile: null,
    shareFilePromise: null,
  };

  const root = () => document.getElementById("videoRecordsRoot");
  const headingRoot = () => document.getElementById("videoStudioHeadingHost");
  const escapeHtml = (value) => String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  const icon = (name, className = "") => window.VideoIcons?.render?.(name, className) || "";
  const brandIcon = (name, className = "") => window.VideoIcons?.renderBrand?.(name, className) || "";

  function mediaUrl(value) {
    const url = new URL(String(value || ""), window.location.origin);
    if (ADMIN_CONSOLE_SESSION) url.searchParams.set("admin_console", "1");
    if (ADMIN_WORKSPACE_USER_ID) url.searchParams.set("admin_workspace_user_id", ADMIN_WORKSPACE_USER_ID);
    return `${url.pathname}${url.search}${url.hash}`;
  }

  async function request(path) {
    const headers = new Headers();
    if (ADMIN_WORKSPACE_USER_ID) headers.set("X-Admin-Workspace-User-ID", ADMIN_WORKSPACE_USER_ID);
    if (ADMIN_CONSOLE_SESSION) headers.set("X-Admin-Console", "1");
    const response = await fetch(path, { credentials: "include", headers });
    const raw = await response.text();
    let payload = {};
    try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = { detail: raw }; }
    if (!response.ok) throw new Error(String(payload.detail || payload.error || "生成记录加载失败"));
    return payload;
  }

  function formatDuration(seconds) {
    const value = Math.max(0, Number(seconds) || 0);
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const secs = Math.floor(value % 60);
    return hours
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
      : `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  function formatBytes(bytes) {
    let value = Math.max(0, Number(bytes) || 0);
    const units = ["B", "KB", "MB", "GB"];
    let index = 0;
    while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
    return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
  }

  function formatDate(timestamp) {
    if (!Number(timestamp)) return "时间未知";
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).format(new Date(Number(timestamp) * 1000));
  }

  function sourceLabel(type) {
    return ({ generated: "AI 生成", export: "剪辑成品", upload: "本地上传" })[type] || "视频";
  }

  const SHARE_PLATFORMS = {
    domestic: [
      { id: "wechat", label: "微信", url: "https://wx.qq.com/" },
      { id: "channels", label: "视频号", url: "https://channels.weixin.qq.com/platform/post/create" },
      { id: "weibo", label: "微博", url: "https://weibo.com/compose/" },
      { id: "qq", label: "QQ", url: "https://im.qq.com/" },
      { id: "douyin", label: "抖音", url: "https://creator.douyin.com/creator-micro/content/upload" },
      { id: "rednote", label: "小红书", url: "https://creator.rednote.com/" },
      { id: "bilibili", label: "哔哩哔哩", url: "https://member.bilibili.com/platform/upload/video/frame" },
    ],
    international: [
      { id: "x", label: "X", url: "https://x.com/compose/post" },
      { id: "facebook", label: "Facebook", url: "https://www.facebook.com/" },
      { id: "instagram", label: "Instagram", url: "https://www.instagram.com/" },
      { id: "tiktok", label: "TikTok", url: "https://www.tiktok.com/tiktokstudio/upload" },
      { id: "youtube", label: "YouTube", url: "https://www.youtube.com/upload" },
      { id: "whatsapp", label: "WhatsApp", url: "https://web.whatsapp.com/" },
      { id: "telegram", label: "Telegram", url: "https://web.telegram.org/" },
      { id: "linkedin", label: "LinkedIn", url: "https://www.linkedin.com/feed/" },
      { id: "reddit", label: "Reddit", url: "https://www.reddit.com/submit" },
    ],
  };

  function pageNumbers() {
    const total = state.totalPages;
    if (total <= 1) return [];
    const values = new Set([1, total, state.page - 2, state.page - 1, state.page, state.page + 1, state.page + 2]);
    return [...values].filter((value) => value >= 1 && value <= total).sort((a, b) => a - b);
  }

  function card(item) {
    const visual = item.thumbnail_url
      ? `<img src="${escapeHtml(mediaUrl(item.thumbnail_url))}" alt="" loading="lazy" />`
      : `<video src="${escapeHtml(mediaUrl(item.media_url))}#t=0.1" preload="metadata" muted></video>`;
    const menuOpen = state.openActionId === item.id;
    return `<article class="video-record-card ${menuOpen ? "has-open-actions" : ""}" data-record-id="${escapeHtml(item.id)}">
      <button class="video-record-visual" type="button" data-record-preview="${escapeHtml(item.id)}" aria-label="预览 ${escapeHtml(item.name)}">
        ${visual}<span class="video-record-play" aria-hidden="true">${icon("play")}</span><span class="video-record-duration">${formatDuration(item.duration)}</span>
      </button>
      <div class="video-record-body">
        <div class="video-record-title"><strong title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</strong>
          <div class="video-record-quick-actions">
            <button class="video-icon-button" type="button" data-record-menu-toggle="${escapeHtml(item.id)}" aria-label="编辑 ${escapeHtml(item.name)}" title="编辑与更多操作" aria-expanded="${menuOpen ? "true" : "false"}" aria-controls="videoRecordActions-${escapeHtml(item.id)}">${icon("edit")}</button>
            <button class="video-icon-button" type="button" data-record-share-toggle="${escapeHtml(item.id)}" aria-label="分享 ${escapeHtml(item.name)}" title="分享到社媒" aria-haspopup="dialog" aria-expanded="false">${icon("share")}</button>
            <div id="videoRecordActions-${escapeHtml(item.id)}" class="video-record-action-menu" aria-label="视频操作" ${menuOpen ? "" : "hidden"}>
              <button type="button" data-record-preview="${escapeHtml(item.id)}" aria-label="预览 ${escapeHtml(item.name)}" title="预览">${icon("eye")}<span>预览</span></button>
              <button type="button" data-record-edit="${escapeHtml(item.id)}" aria-label="剪辑 ${escapeHtml(item.name)}" title="加入剪辑器">${icon("scissors")}<span>剪辑</span></button>
              <a href="${escapeHtml(mediaUrl(item.download_url))}" download aria-label="下载 ${escapeHtml(item.name)}" title="下载原片">${icon("download")}<span>下载</span></a>
            </div>
          </div>
        </div>
        <div class="video-record-meta" title="${escapeHtml(formatDate(item.created_at))} · ${item.width || "?"}×${item.height || "?"} · ${formatBytes(item.size_bytes)}">
          <span>${sourceLabel(item.source_type)}</span><time>${formatDate(item.created_at)}</time><small>${item.width || "?"}×${item.height || "?"} · ${formatBytes(item.size_bytes)}</small>
        </div>
      </div>
    </article>`;
  }

  function renderPagination() {
    if (!state.totalPages) return "";
    const numbers = pageNumbers();
    let previous = 0;
    const buttons = [];
    for (const value of numbers) {
      if (previous && value - previous > 1) buttons.push('<span class="video-record-page-gap">…</span>');
      buttons.push(`<button type="button" data-record-page="${value}" ${value === state.page ? 'class="is-active" aria-current="page"' : ""}>${value}</button>`);
      previous = value;
    }
    return `<nav class="video-record-pagination" aria-label="视频生成记录分页">
      <button class="video-icon-button" type="button" data-record-page="${state.page - 1}" ${state.page <= 1 ? "disabled" : ""} aria-label="上一页" title="上一页">${icon("left")}</button>
      ${buttons.join("")}
      <button class="video-icon-button" type="button" data-record-page="${state.page + 1}" ${state.page >= state.totalPages ? "disabled" : ""} aria-label="下一页" title="下一页">${icon("right")}</button>
      <span>第 ${state.page} / ${state.totalPages} 页，共 ${state.total} 条</span>
    </nav>`;
  }

  function render() {
    const host = root();
    if (!host) return;
    const heading = headingRoot();
    if (heading) heading.innerHTML = `<header class="video-records-hero"><div class="video-records-heading"><span class="video-records-mark" aria-hidden="true">${icon("archive")}</span><div><span class="eyebrow">VIDEO ARCHIVE</span><h2>视频生成记录</h2><p>自动归档已经生成的视频，分页查看、预览、下载，并可直接送入剪辑器。</p></div></div></header>`;
    host.innerHTML = `<div class="video-records-app">
      <section class="video-records-panel" aria-label="视频记录列表">
        <div class="video-records-tools">
          <div><strong>视频记录</strong><span>${state.total} 个可用视频</span></div>
          <div class="video-records-filters">
            <input type="search" value="${escapeHtml(state.query)}" placeholder="搜索视频名称" aria-label="搜索视频生成记录" data-record-search />
            <select aria-label="筛选视频来源" data-record-filter>
              ${[["generated", "AI 生成记录"], ["export", "剪辑成品"], ["", "全部视频"]].map(([value, label]) => `<option value="${value}" ${state.sourceType === value ? "selected" : ""}>${label}</option>`).join("")}
            </select>
            <button class="video-icon-button" type="button" data-record-refresh aria-label="刷新视频记录" title="刷新">${icon("refresh")}</button>
          </div>
        </div>
        ${state.loading ? '<div class="video-records-state"><span class="video-workbench-loader"></span><strong>正在读取视频记录</strong></div>' : ""}
        ${state.error ? `<div class="video-records-state is-error"><strong>记录加载失败</strong><span>${escapeHtml(state.error)}</span><button type="button" data-record-refresh>重试</button></div>` : ""}
        ${!state.loading && !state.error ? `<div class="video-records-grid">${state.items.length ? state.items.map(card).join("") : '<div class="video-records-state"><strong>暂时没有符合条件的视频</strong><span>完成视频生成后，记录会自动保存到这里。</span></div>'}</div>${renderPagination()}` : ""}
      </section>
    </div>`;
  }

  async function load({ sync = false } = {}) {
    const token = ++state.requestToken;
    state.openActionId = "";
    state.loading = true;
    state.error = "";
    render();
    try {
      const params = new URLSearchParams({
        page: String(state.page), page_size: String(state.pageSize), sync_generated: sync ? "true" : "false",
      });
      if (state.sourceType) params.set("source_type", state.sourceType);
      if (state.query.trim()) params.set("q", state.query.trim());
      const payload = await request(`${API}?${params}`);
      if (token !== state.requestToken) return;
      state.items = Array.isArray(payload.items) ? payload.items : [];
      state.page = Number(payload.page) || state.page;
      state.total = Number(payload.total) || 0;
      state.totalPages = Number(payload.total_pages) || 0;
      state.loaded = true;
    } catch (error) {
      if (token !== state.requestToken) return;
      state.error = String(error?.message || error || "加载失败");
      state.items = [];
    } finally {
      if (token === state.requestToken) { state.loading = false; render(); }
    }
  }

  function preview(itemId) {
    const item = state.items.find((entry) => entry.id === itemId);
    if (!item) return;
    const modal = document.createElement("div");
    modal.className = "video-preview-modal";
    modal.innerHTML = `<div role="dialog" aria-modal="true" aria-label="视频生成记录预览"><header><strong>${escapeHtml(item.name)}</strong><button class="video-icon-button" type="button" data-preview-close aria-label="关闭预览" title="关闭">${icon("close")}</button></header><video src="${escapeHtml(mediaUrl(item.media_url))}" controls autoplay playsinline></video></div>`;
    modal.addEventListener("click", (event) => { if (event.target === modal || event.target.closest("[data-preview-close]")) modal.remove(); });
    document.body.appendChild(modal);
  }

  function platformButtons(items) {
    return items.map((platform) => `<button type="button" data-share-platform="${platform.id}" title="下载视频并打开 ${escapeHtml(platform.label)} 发布入口" aria-label="发布到 ${escapeHtml(platform.label)}">${brandIcon(platform.id)}<span>${escapeHtml(platform.label)}</span></button>`).join("");
  }

  function closeShare({ restoreFocus = true } = {}) {
    const itemId = state.shareItemId;
    document.querySelector(".video-share-modal")?.remove();
    if (itemId) root()?.querySelector(`[data-record-share-toggle="${CSS.escape(itemId)}"]`)?.setAttribute("aria-expanded", "false");
    state.shareItemId = "";
    state.shareFile = null;
    state.shareFilePromise = null;
    if (restoreFocus && itemId) root()?.querySelector(`[data-record-share-toggle="${CSS.escape(itemId)}"]`)?.focus();
  }

  function updateShareStatus(message, type = "") {
    const status = document.querySelector("[data-share-status]");
    if (!status) return;
    status.textContent = String(message || "");
    status.dataset.type = type;
  }

  async function prepareShareFile(item) {
    if (state.shareFilePromise) return state.shareFilePromise;
    state.shareFilePromise = (async () => {
      const response = await fetch(mediaUrl(item.media_url), { credentials: "include" });
      if (!response.ok) throw new Error("视频文件读取失败");
      const blob = await response.blob();
      const safeName = String(item.name || "video").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 100) || "video";
      const file = new File([blob], `${safeName}.mp4`, { type: blob.type || "video/mp4" });
      state.shareFile = file;
      return file;
    })();
    return state.shareFilePromise;
  }

  function triggerDownload(item) {
    const link = document.createElement("a");
    link.href = mediaUrl(item.download_url);
    link.download = "";
    link.hidden = true;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  async function nativeShare(item) {
    try {
      const file = state.shareFile || await prepareShareFile(item);
      if (!navigator.share || !navigator.canShare?.({ files: [file] })) {
        triggerDownload(item);
        updateShareStatus("当前浏览器不支持文件分享，已改为下载视频。", "success");
        return;
      }
      await navigator.share({ files: [file], title: item.name, text: `分享视频：${item.name}` });
      updateShareStatus("视频已交给系统分享面板。", "success");
    } catch (error) {
      if (error?.name === "AbortError") return;
      updateShareStatus(String(error?.message || "分享失败，请重试。"), "error");
    }
  }

  function shareToPlatform(item, platformId) {
    const platform = [...SHARE_PLATFORMS.domestic, ...SHARE_PLATFORMS.international].find((entry) => entry.id === platformId);
    if (!platform) return;
    void navigator.clipboard?.writeText?.(item.name)?.catch?.(() => {});
    triggerDownload(item);
    window.open(platform.url, "_blank", "noopener,noreferrer");
    updateShareStatus(`视频已下载，标题已复制；请在 ${platform.label} 完成上传发布。`, "success");
  }

  function openShare(itemId) {
    const item = state.items.find((entry) => entry.id === itemId);
    if (!item) return;
    closeShare({ restoreFocus: false });
    state.shareItemId = itemId;
    const trigger = root()?.querySelector(`[data-record-share-toggle="${CSS.escape(itemId)}"]`);
    trigger?.setAttribute("aria-expanded", "true");
    const modal = document.createElement("div");
    modal.className = "video-share-modal";
    modal.innerHTML = `<div class="video-share-dialog" role="dialog" aria-modal="true" aria-labelledby="videoShareTitle">
      <header><div><span class="eyebrow">SHARE VIDEO</span><strong id="videoShareTitle">分享视频</strong><small title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</small></div><button class="video-icon-button" type="button" data-share-close aria-label="关闭分享面板" title="关闭">${icon("close")}</button></header>
      <button class="video-share-native" type="button" data-share-native disabled>${icon("share")}<span><strong>系统分享视频文件</strong><small>移动端可直接选择已安装的社媒应用</small></span></button>
      <p class="video-share-note">桌面端选择平台时会下载视频、复制标题并打开发布入口；账号登录和最终发布由你确认。</p>
      <section data-share-platform-group="domestic"><h3>国内平台</h3><div class="video-share-platform-grid">${platformButtons(SHARE_PLATFORMS.domestic)}</div></section>
      <section data-share-platform-group="international"><h3>海外平台</h3><div class="video-share-platform-grid">${platformButtons(SHARE_PLATFORMS.international)}</div></section>
      <p class="video-share-status" data-share-status role="status">正在准备视频文件…</p>
    </div>`;
    modal.addEventListener("click", (event) => {
      if (event.target === modal || event.target.closest("[data-share-close]")) { closeShare(); return; }
      if (event.target.closest("[data-share-native]")) { void nativeShare(item); return; }
      const platformButton = event.target.closest("[data-share-platform]");
      if (platformButton) shareToPlatform(item, platformButton.dataset.sharePlatform);
    });
    document.body.appendChild(modal);
    modal.querySelector("[data-share-close]")?.focus();
    void prepareShareFile(item)
      .then(() => {
        modal.querySelector("[data-share-native]")?.removeAttribute("disabled");
        updateShareStatus("视频文件已准备好，可以直接分享。", "success");
      })
      .catch((error) => updateShareStatus(String(error?.message || "视频文件准备失败。"), "error"));
  }

  function bind() {
    const host = root();
    if (!host || host.dataset.bound === "1") return;
    host.dataset.bound = "1";
    host.addEventListener("click", (event) => {
      const page = event.target.closest("[data-record-page]");
      if (page && !page.disabled) { state.page = Number(page.dataset.recordPage) || 1; void load(); return; }
      const menuToggle = event.target.closest("[data-record-menu-toggle]");
      if (menuToggle) {
        const itemId = String(menuToggle.dataset.recordMenuToggle || "");
        state.openActionId = state.openActionId === itemId ? "" : itemId;
        render();
        if (state.openActionId) root()?.querySelector(`[data-record-menu-toggle="${CSS.escape(itemId)}"]`)?.focus();
        return;
      }
      const shareToggle = event.target.closest("[data-record-share-toggle]");
      if (shareToggle) {
        const itemId = String(shareToggle.dataset.recordShareToggle || "");
        state.openActionId = "";
        render();
        openShare(itemId);
        return;
      }
      const item = event.target.closest("[data-record-preview]");
      if (item) { state.openActionId = ""; preview(item.dataset.recordPreview); return; }
      const edit = event.target.closest("[data-record-edit]");
      if (edit) { state.openActionId = ""; window.VideoPage?.showStudioTab?.("editor", { assetId: edit.dataset.recordEdit }); return; }
      if (event.target.closest("[data-record-refresh]")) void load({ sync: true });
    });
    host.addEventListener("change", (event) => {
      if (!event.target.matches("[data-record-filter]")) return;
      state.sourceType = event.target.value;
      state.page = 1;
      state.openActionId = "";
      void load();
    });
    host.addEventListener("input", (event) => {
      if (!event.target.matches("[data-record-search]")) return;
      state.query = event.target.value;
      state.page = 1;
      state.openActionId = "";
      window.clearTimeout(state.searchTimer);
      state.searchTimer = window.setTimeout(() => load(), 300);
    });
    document.addEventListener("click", (event) => {
      if (!state.active || !state.openActionId || event.target.closest(".video-record-quick-actions")) return;
      state.openActionId = "";
      render();
    });
    document.addEventListener("keydown", (event) => {
      if (!state.active || event.key !== "Escape") return;
      if (state.shareItemId) { closeShare(); return; }
      if (state.openActionId) {
        const itemId = state.openActionId;
        state.openActionId = "";
        render();
        root()?.querySelector(`[data-record-menu-toggle="${CSS.escape(itemId)}"]`)?.focus();
      }
    });
  }

  function activate() {
    state.active = true;
    bind();
    if (!state.loaded) void load({ sync: true });
    else { render(); void load(); }
  }

  function deactivate() {
    state.active = false;
    state.requestToken += 1;
    state.openActionId = "";
    window.clearTimeout(state.searchTimer);
    document.querySelector(".video-preview-modal")?.remove();
    closeShare({ restoreFocus: false });
  }

  window.VideoRecords = { activate, deactivate, refresh: load };
}());
