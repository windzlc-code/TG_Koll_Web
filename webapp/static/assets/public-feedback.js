(() => {
  "use strict";

  const state = { current: null };

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[character]));
  }

  function normalizeMessages(messages, fallback) {
    const values = Array.isArray(messages)
      ? messages.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    const message = String(fallback || "").trim();
    return values.length ? values : [message || "正在处理，请稍候…"];
  }

  function extractError(error, fallback = "操作失败，请稍后重试。") {
    const payload = error?.payload || error?.response || {};
    const detail = payload?.detail;
    const code = String(detail?.code || payload?.code || error?.code || "").trim().toUpperCase();
    const status = Number(error?.status || payload?.status || 0);
    const rawValue = detail?.message || detail || payload?.message || error?.message || "";
    const raw = Array.isArray(rawValue)
      ? rawValue.map((item) => item?.msg || item?.message || item?.detail || String(item || "")).join("；")
      : (typeof rawValue === "object" ? (rawValue.message || rawValue.detail || JSON.stringify(rawValue)) : String(rawValue));
    const text = raw.trim();

    if (code === "INSUFFICIENT_POINTS" || status === 402 || /insufficient[_ ](?:points?|credits?|funds?|quota)|余额不足|额度不足|算力点不足|请充值|please top up|payment required/i.test(text)) {
      return "算力点余额不足：当前余额不足以执行本次生成，请购买算力或续费会员后再试。";
    }
    if (status === 401 || /unauthorized|登录已失效|session.*expired/i.test(text)) return "登录状态已失效：请重新登录后再执行此操作。";
    if (status === 403 || /forbidden|没有权限|无权/i.test(text)) return "权限不足：当前账号没有执行此操作的权限。";
    if (status === 404 || /not found|不存在/i.test(text)) return "请求的内容不存在：请刷新页面后重试。";
    if (status === 413 || /payload too large|request entity too large|文件过大/i.test(text)) return "上传失败：文件大小超过服务器限制，请压缩后重新选择。";
    if (status === 429 || /too many requests|rate limit|请求过于频繁/i.test(text)) return "请求过于频繁：请稍等片刻后再试。";
    if (/failed to fetch|networkerror|network request failed|网络请求失败/i.test(text)) return "网络连接失败：请检查网络后重试。";
    if (/timeout|timed out|超时/i.test(text)) return "处理超时：任务可能仍在后台运行，请稍后查看任务列表。";
    if (/field required|required|缺少必填|必填/i.test(text)) return "提交失败：缺少必填信息，请按页面提示补充后再试。";
    if (/extra inputs are not permitted|extra_forbidden|内部参数/i.test(text)) return "提交失败：请求包含不允许的内部参数，请刷新页面后重试。";
    if (/could not decode image|无法识别.*图|图片.*识别/i.test(text)) return "素材处理失败：参考图片无法识别，请重新选择清晰图片后再试。";
    if (/service is upgrading|正在升级|restarting|重启/i.test(text)) return "生成服务正在维护：模型服务升级或重启中，请稍后再试。";
    if (/runninghub|模型.*调用失败|调用失败/i.test(text)) return "生成服务调用失败：模型服务暂时不可用，请稍后重试。";
    if (text && /[一-鿿]/.test(text)) return text;
    if (text && status >= 500) return "服务器处理失败：生成服务暂时不可用，请稍后重试。";
    if (status === 422) return "提交内容校验失败：请检查必填项、素材格式和参数后重试。";
    if (status >= 400) return `请求失败（HTTP ${status}）：请检查输入内容和素材后重试。`;
    return String(fallback || "操作失败，请稍后重试。");
  }

  function statusIcon(status, busy) {
    if (busy) {
      return `<span class="vecto-public-prompt-spinner" aria-hidden="true"></span>`;
    }
    if (["success", "ok"].includes(String(status || "").toLowerCase())) return `<span class="vecto-public-prompt-icon is-success" aria-hidden="true">✓</span>`;
    if (["error", "failed", "warning", "warn"].includes(String(status || "").toLowerCase())) return `<span class="vecto-public-prompt-icon is-error" aria-hidden="true">!</span>`;
    return `<span class="vecto-public-prompt-icon is-info" aria-hidden="true">i</span>`;
  }

  function closeCurrent(result = null) {
    if (state.current?.isOpen?.()) state.current.close(result);
  }

  function open(options = {}) {
    closeCurrent(null);
    const config = {
      title: "操作提示",
      message: "",
      detail: "",
      status: "info",
      busy: false,
      messages: [],
      showClose: true,
      showConfirm: false,
      showCancel: false,
      confirmText: "确定",
      cancelText: "取消",
      actions: [],
      dismissOnBackdrop: true,
      dismissOnEscape: true,
      ...options,
    };
    const progressMessages = normalizeMessages(config.messages, config.message);
    const host = document.createElement("div");
    host.className = "console-modal vecto-public-prompt";
    host.dataset.publicPromptBusy = config.busy ? "true" : "false";
    host.dataset.publicPromptStatus = String(config.status || "info");
    let progressIndex = 0;
    let progressTimer = 0;
    let closed = false;
    let resolveResult;
    const resultPromise = new Promise((resolve) => { resolveResult = resolve; });

    const stopProgress = () => {
      if (progressTimer) window.clearInterval(progressTimer);
      progressTimer = 0;
    };
    const startProgress = () => {
      stopProgress();
      if (!config.busy || progressMessages.length < 2) return;
      progressTimer = window.setInterval(() => {
        if (closed) return;
        progressIndex = (progressIndex + 1) % progressMessages.length;
        const messageNode = host.querySelector("[data-public-prompt-message]");
        if (messageNode) messageNode.textContent = progressMessages[progressIndex];
      }, 1500);
    };
    const finish = (result = null) => {
      if (closed) return;
      closed = true;
      stopProgress();
      if (state.current?.element === host) state.current = null;
      host.remove();
      resolveResult(result);
    };
    const actionHtml = () => {
      const actions = Array.isArray(config.actions) ? config.actions : [];
      const custom = actions.map((action) => `<button type="button" class="${action?.primary ? "primary" : ""}" data-public-prompt-action="${esc(action?.value || "")}">${esc(action?.text || "")}</button>`).join("");
      const confirm = config.showConfirm ? `<button type="button" class="primary" data-public-prompt-confirm>${esc(config.confirmText)}</button>` : "";
      const cancel = config.showCancel ? `<button type="button" data-public-prompt-cancel>${esc(config.cancelText)}</button>` : "";
      return `${custom}${confirm}${cancel}`;
    };
    const render = () => {
      const message = progressMessages[progressIndex] || String(config.message || "");
      const showClose = Boolean(config.showClose && !config.busy);
      const actions = actionHtml();
      host.dataset.publicPromptBusy = config.busy ? "true" : "false";
      host.dataset.publicPromptStatus = String(config.status || "info");
      host.innerHTML = `
        <div class="console-modal-backdrop" ${config.dismissOnBackdrop && !config.busy ? "data-public-prompt-cancel" : ""}></div>
        <section class="console-modal-dialog vecto-public-prompt-dialog" role="${config.busy ? "alertdialog" : "dialog"}" aria-modal="true" aria-labelledby="vectoPublicPromptTitle">
          <div class="console-modal-head vecto-public-prompt-head">
            <div><span class="vecto-public-prompt-kicker">VECTO 提示</span><strong id="vectoPublicPromptTitle">${esc(config.title)}</strong></div>
            ${showClose ? '<button type="button" class="console-modal-close" data-public-prompt-close aria-label="关闭提示">×</button>' : ""}
          </div>
          <div class="vecto-public-prompt-body" aria-live="${config.busy ? "polite" : "assertive"}">
            <div class="vecto-public-prompt-status">${statusIcon(config.status, config.busy)}<span data-public-prompt-message>${esc(message)}</span><span class="vecto-public-prompt-dots" ${config.busy ? "" : "hidden"}>...</span></div>
            ${config.detail ? `<p class="vecto-public-prompt-detail">${esc(config.detail)}</p>` : ""}
          </div>
          ${actions ? `<div class="console-modal-actions vecto-public-prompt-actions">${actions}</div>` : ""}
        </section>`;
      const focusTarget = host.querySelector("[data-public-prompt-confirm], [data-public-prompt-action], [data-public-prompt-cancel], [data-public-prompt-close]");
      if (focusTarget && !config.busy) window.setTimeout(() => focusTarget.focus(), 0);
    };
    const handle = {
      element: host,
      promise: resultPromise,
      isOpen: () => !closed,
      update(patch = {}) {
        if (closed) return handle;
        const wasBusy = Boolean(config.busy);
        Object.assign(config, patch);
        if (Object.prototype.hasOwnProperty.call(patch, "messages") || Object.prototype.hasOwnProperty.call(patch, "message")) {
          progressIndex = 0;
          const nextMessages = Object.prototype.hasOwnProperty.call(patch, "messages")
            ? config.messages
            : [config.message];
          progressMessages.splice(0, progressMessages.length, ...normalizeMessages(nextMessages, config.message));
        }
        render();
        if (wasBusy !== Boolean(config.busy)) {
          if (config.busy) startProgress();
          else stopProgress();
        }
        return handle;
      },
      close: finish,
    };
    host.addEventListener("click", (event) => {
      if (config.busy) return;
      if (event.target.closest("[data-public-prompt-close], [data-public-prompt-cancel]")) {
        finish(null);
        return;
      }
      const actionButton = event.target.closest("[data-public-prompt-action]");
      if (actionButton) {
        const action = (config.actions || []).find((item) => String(item?.value || "") === String(actionButton.dataset.publicPromptAction || ""));
        try { action?.onSelect?.(); } catch (_) {}
        finish(actionButton.dataset.publicPromptAction || null);
        return;
      }
      if (event.target.closest("[data-public-prompt-confirm]")) finish(true);
    });
    host.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && config.dismissOnEscape && !config.busy) finish(null);
    });
    document.body.appendChild(host);
    state.current = handle;
    render();
    startProgress();
    return handle;
  }

  function confirm(options = {}) {
    const handle = open({
      title: "确认操作",
      showClose: false,
      showConfirm: true,
      showCancel: true,
      confirmText: "确认",
      cancelText: "取消",
      ...options,
    });
    return handle.promise.then((result) => result === true);
  }

  function showError(options = {}) {
    const message = extractError(options.error, options.message || "操作失败，请稍后重试。");
    return open({
      title: options.title || "操作失败",
      message,
      detail: options.detail || "请根据提示处理后重新尝试。",
      status: "error",
      showClose: true,
      showCancel: false,
      showConfirm: false,
      ...options,
      message,
    });
  }

  function showInsufficientPoints(existingHandle = null) {
    const actions = [
      { value: "credits", text: "购买算力", primary: true, onSelect: () => window.location.assign("/pricing.html#packages") },
      { value: "membership", text: "续费 / 购买会员", onSelect: () => window.location.assign("/pricing.html#plans") },
    ];
    const target = existingHandle?.isOpen?.() ? existingHandle : state.current?.isOpen?.() ? state.current : null;
    if (target) {
      return target.update({
        title: "算力点余额不足",
        message: "算力点余额不足：当前余额不足以执行本次生成，请购买算力或续费会员后再试。",
        detail: "充值或续费完成后，请返回当前页面重新点击生成按钮。",
        status: "error",
        busy: false,
        messages: ["算力点余额不足：当前余额不足以执行本次生成，请购买算力或续费会员后再试。"],
        actions,
        showClose: false,
        showConfirm: false,
        showCancel: true,
        cancelText: "稍后处理",
      });
    }
    const handle = open({
      title: "算力点余额不足",
      message: "算力点余额不足：当前余额不足以执行本次生成，请购买算力或续费会员后再试。",
      detail: "充值或续费完成后，请返回当前页面重新点击生成按钮。",
      status: "error",
      messages: ["算力点余额不足：当前余额不足以执行本次生成，请购买算力或续费会员后再试。"],
      actions,
      showClose: false,
      showCancel: true,
      cancelText: "稍后处理",
    });
    handle.promise.finally(() => {}).catch(() => {});
    return handle;
  }

  window.VectoPublicPrompt = { open, confirm, showError, showInsufficientPoints, localizeError: extractError };
  window.addEventListener("vecto:billing-insufficient", () => {
    if (document.body?.classList.contains("video-page")) showInsufficientPoints();
  });
})();
