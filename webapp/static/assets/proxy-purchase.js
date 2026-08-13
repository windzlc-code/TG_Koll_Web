(() => {
  "use strict";

  const PENDING_STORAGE_KEY = "vecto.proxyPurchase.pending.v1";
  const embedded = new URLSearchParams(window.location.search).get("embedded") === "1";
  if (embedded) document.documentElement.classList.add("is-embedded-proxy-purchase");
  const state = { options: null, quote: null, order: null, quoteSeq: 0, polling: 0, pollAttempt: 0, busy: false };
  const byId = (id) => document.getElementById(id);

  function errorMessage(error, fallback = "请求失败，请稍后重试") {
    const detail = error?.detail;
    const code = String(error?.code || detail?.code || "");
    if (code === "INSUFFICIENT_CASH_BACKED_POINTS") return "可用算力点不足，暂时无法购买。";
    if (Array.isArray(detail)) return detail.map((item) => item?.msg || String(item)).join("；");
    if (detail && typeof detail === "object") return String(detail.message || detail.detail || fallback);
    return String(detail || error?.message || fallback);
  }

  async function api(path, options = {}) {
    const response = await fetch(path, { credentials: "include", cache: "no-store", ...options });
    const raw = await response.text();
    let payload = {};
    try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = { detail: raw }; }
    if (response.status === 401) {
      location.assign(`/?login=1&return_url=${encodeURIComponent(`${location.pathname}${location.search}`)}`);
      throw { detail: "登录状态已过期，正在前往登录页", status: 401 };
    }
    if (!response.ok) {
      if (payload && typeof payload === "object") payload.status = response.status;
      throw payload;
    }
    return payload;
  }

  function readPendingRequest() {
    try {
      const value = JSON.parse(sessionStorage.getItem(PENDING_STORAGE_KEY) || "null");
      if (value?.quoteId && value?.idempotencyKey) return value;
    } catch {}
    return null;
  }

  function storePendingRequest(value) {
    try { sessionStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify(value)); } catch {}
    return value;
  }

  function clearPendingRequest() {
    try { sessionStorage.removeItem(PENDING_STORAGE_KEY); } catch {}
  }

  function ensurePendingRequest(quote) {
    const existing = readPendingRequest();
    if (existing?.quoteId === quote?.id) return existing;
    return storePendingRequest({
      quoteId: String(quote?.id || ""),
      idempotencyKey: globalThis.crypto?.randomUUID?.() || `proxy-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      createdAt: Date.now(),
      submitted: false,
    });
  }

  function setAlert(message = "") {
    const node = byId("pageAlert");
    node.textContent = message;
    node.hidden = !message;
  }

  function setBusy(busy, label = "") {
    state.busy = Boolean(busy);
    const button = byId("buyButton");
    button.classList.toggle("busy", state.busy);
    button.disabled = state.busy || (!state.quote && !byId("country").value);
    byId("country").disabled = state.busy || !state.options?.configured;
    byId("city").disabled = state.busy || !byId("country").value || !state.options?.cities?.[byId("country").value]?.length;
    byId("cityToggle").disabled = state.busy || !byId("country").value || !state.options?.cities?.[byId("country").value]?.length;
    byId("autoRenew").disabled = state.busy;
    if (label) byId("buyButtonText").textContent = label;
  }

  function countryDisplayName(region = {}) {
    const code = String(region?.code || region?.country || "").trim().toUpperCase();
    if (code === "TW") return "中国台湾";
    if (/^[A-Z]{2}$/.test(code) && typeof Intl.DisplayNames === "function") {
      try {
        const label = new Intl.DisplayNames(["zh-CN"], { type: "region" }).of(code);
        if (label && label.toUpperCase() !== code) return label;
      } catch (_) {}
    }
    return String(region?.name || code || "未知地区");
  }

  function renderOptions(payload) {
    state.options = payload;
    const select = byId("country");
    select.replaceChildren();
    const regions = Array.isArray(payload?.regions) ? payload.regions : [];
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = regions.length ? "请选择代理地区" : "暂无可售地区";
    select.append(placeholder);
    regions.forEach((region) => {
      const option = document.createElement("option");
      option.value = String(region?.code || "");
      option.textContent = countryDisplayName(region);
      if (option.value) select.append(option);
    });
    const serviceNames = {
      "static-residential-ipv4": "静态住宅代理 IP",
      "datacenter-ipv4": "数据中心代理",
      "rotating-residential": "动态住宅代理",
      "rotating-mobile": "动态移动代理",
    };
    const serviceId = String(payload?.service_id || "static-residential-ipv4");
    byId("productName").textContent = serviceNames[serviceId] || "专属代理 IP";
    byId("productIpVersion").textContent = `${payload?.is_unused_proxy ? "全新" : "标准"} ${String(payload?.ip_version || "IPv4")}`;
    byId("productIsp").textContent = payload?.isp_managed ? "后台指定 ISP" : "按地区自动匹配";
    byId("productQuantity").textContent = `${Math.max(1, Number(payload?.quantity || 1))} 个`;
    const ready = Boolean(payload?.configured && payload?.live_purchasing_enabled && regions.length);
    const provider = String(payload?.provider || "Proxy-Cheap").toLowerCase() === "proxycheap"
      ? "Proxy-Cheap"
      : String(payload?.provider || "供应商");
    byId("providerState").textContent = ready ? `${provider} 已连接` : "采购服务尚未开放";
    byId("providerState").classList.toggle("ready", ready);
    select.disabled = !ready;
    if (!ready) setAlert("代理采购当前尚未开放，请联系管理员完成供应商与定价配置。");
  }

  function renderCities() {
    const country = byId("country").value;
    const city = byId("city");
    const items = Array.isArray(state.options?.cities?.[country]) ? state.options.cities[country] : [];
    city.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = items.length ? "由供应商自动分配城市" : "该地区暂无可选城市";
    city.append(placeholder);
    items.forEach((item) => {
      const option = document.createElement("option");
      option.value = String(item?.id || "");
      option.textContent = String(item?.name_zh || item?.name || item?.id || "");
      if (option.value) city.append(option);
    });
    city.required = false;
    city.disabled = !country || items.length === 0;
    byId("cityToggle").disabled = !country || items.length === 0;
    byId("cityToggle").setAttribute("aria-expanded", "false");
    byId("cityPanel").hidden = true;
  }

  function toggleCities() {
    const toggle = byId("cityToggle");
    if (toggle.disabled) return;
    const expanded = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", String(expanded));
    byId("cityPanel").hidden = !expanded;
    if (expanded) byId("city").focus();
  }

  function clearQuote() {
    state.quote = null;
    byId("buyButtonText").textContent = "确认购买";
    byId("buyButton").disabled = state.busy || !byId("country").value;
  }

  async function refreshQuote() {
    const country = byId("country").value;
    const city = byId("city").value;
    const requestSeq = ++state.quoteSeq;
    setAlert("");
    if (!country) { clearQuote(); return null; }
    clearQuote();
    byId("country").disabled = true;
    try {
      const payload = await api("/api/proxy-purchases/quotes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          country,
          city,
          period_months: Math.max(1, Number(state.options?.default_period?.value || 1)),
          auto_renew: byId("autoRenew").checked,
        }),
      });
      if (requestSeq !== state.quoteSeq) return null;
      const quote = payload?.quote;
      if (!quote?.id) throw { detail: "供应商没有返回有效报价" };
      state.quote = quote;
      ensurePendingRequest(quote);
      byId("buyButtonText").textContent = "确认购买";
      byId("buyButton").disabled = state.busy;
      return quote;
    } catch (error) {
      if (requestSeq !== state.quoteSeq) return null;
      clearQuote();
      setAlert(errorMessage(error, "无法获取实时报价"));
      return null;
    } finally {
      if (requestSeq === state.quoteSeq) byId("country").disabled = state.busy || !state.options?.configured;
    }
  }

  function schedulePoll() {
    window.clearTimeout(state.polling);
    const delay = Math.min(3000 * (2 ** state.pollAttempt), 60000);
    state.pollAttempt = Math.min(state.pollAttempt + 1, 6);
    state.polling = window.setTimeout(pollOrder, document.hidden ? Math.max(delay, 30000) : delay);
  }

  function renderOrder(order) {
    if (!order?.id) return;
    state.order = order;
    const panel = byId("orderStatus");
    const status = String(order.status || "pending").toLowerCase();
    const complete = ["active", "completed", "settled", "success"].includes(status);
    const failed = ["failed", "cancelled", "canceled", "released", "refunded"].includes(status);
    const manual = status === "provider_unknown_no_reference"
      || (status === "provider_unknown" && !order.provider_order_id)
      || String(order.error_code || "").toLowerCase() === "provider_unknown_no_reference";
    panel.hidden = false;
    panel.classList.toggle("complete", complete);
    panel.classList.toggle("failed", failed);
    panel.classList.toggle("manual", manual);
    byId("orderStatusTitle").textContent = complete
      ? "购买成功并已加入代理列表"
      : failed ? "订单未能完成"
        : manual ? "订单正在人工核验" : "订单已受理，正在配置";
    byId("orderStatusMessage").textContent = String(order.message || (complete
      ? "现在可以返回控制台选择这条代理。"
      : failed ? "点数预占将按订单结果释放。"
        : manual ? "供应商结果暂时无法自动确认。点数仍保持预占，请勿重复购买；管理员核验后会更新结果。"
          : "配置完成后会自动更新，无需重复购买。"));
    const renewalControl = byId("orderRenewalControl");
    renewalControl.hidden = failed || manual;
    byId("orderRenewal").checked = order.auto_renew === undefined ? byId("autoRenew").checked : Boolean(order.auto_renew);
    if (complete || failed) {
      clearPendingRequest();
      window.clearTimeout(state.polling);
      state.quote = null;
      setBusy(false, complete ? "购买已完成" : "重新获取报价");
      byId("buyButton").disabled = true;
      if (complete && embedded && window.parent !== window) {
        byId("purchaseSuccess").dataset.orderId = String(order.id);
      }
      if (complete) {
        document.querySelector(".purchase-card")?.classList.add("is-success");
        byId("purchaseSuccess").hidden = false;
      }
      return;
    }
    setBusy(true, manual ? "订单人工核验中" : "订单处理中，请勿重复提交");
    window.clearTimeout(state.polling);
    if (!manual) schedulePoll();
  }

  async function pollOrder() {
    if (!state.order?.id) return;
    try {
      const payload = await api(`/api/proxy-purchases/orders/${encodeURIComponent(state.order.id)}`);
      renderOrder(payload?.order);
    } catch (error) {
      byId("orderStatusMessage").textContent = `状态暂时无法刷新：${errorMessage(error)}。系统稍后继续重试。`;
      schedulePoll();
    }
  }

  async function createOrderFromPending(pending) {
    return api("/api/proxy-purchases/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": pending.idempotencyKey },
      body: JSON.stringify({ quote_id: pending.quoteId, idempotency_key: pending.idempotencyKey }),
    });
  }

  async function recoverPendingOrder(pending, { replayIfMissing = true } = {}) {
    setBusy(true, "正在恢复上次购买结果...");
    try {
      const payload = await api(`/api/proxy-purchases/orders/recover?idempotency_key=${encodeURIComponent(pending.idempotencyKey)}`);
      renderOrder(payload?.order);
      return true;
    } catch (error) {
      if (Number(error?.status) !== 404 || !replayIfMissing) throw error;
      const payload = await createOrderFromPending(pending);
      renderOrder(payload?.order);
      return true;
    }
  }

  async function submitOrder(event) {
    event.preventDefault();
    const country = String(byId("country").value || "").trim();
    if (state.busy || !country) return;
    setAlert("");
    setBusy(true, "正在检测...");
    let quote = state.quote;
    if (!quote?.id) {
      quote = await refreshQuote();
      if (!quote?.id) {
        setBusy(false, "确认购买");
        return;
      }
    }
    state.quote = quote;
    setBusy(true, "正在安全预占算力点...");
    const pending = storePendingRequest({ ...ensurePendingRequest(quote), submitted: true });
    try {
      const payload = await createOrderFromPending(pending);
      renderOrder(payload?.order);
    } catch (error) {
      const uncertain = error instanceof TypeError || Number(error?.status) >= 500 || !Number.isFinite(Number(error?.status));
      if (uncertain) {
        try {
          await recoverPendingOrder(pending, { replayIfMissing: true });
          return;
        } catch (recoveryError) {
          setBusy(true, "订单结果待恢复");
          setAlert(`${errorMessage(recoveryError, "暂时无法确认订单结果")}。本次请求已安全保留，请刷新页面恢复，切勿重复选择新报价购买。`);
          return;
        }
      }
      clearPendingRequest();
      state.quote = null;
      setBusy(false, "请重新获取报价");
      byId("buyButton").disabled = true;
      setAlert(errorMessage(error, "订单创建失败"));
    }
  }

  async function updateRenewal() {
    const control = byId("orderRenewal");
    if (!state.order?.id || control.disabled) return;
    const enabled = control.checked;
    control.disabled = true;
    try {
      const payload = await api(`/api/proxy-purchases/orders/${encodeURIComponent(state.order.id)}/renewal`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (payload?.order) state.order = payload.order;
      byId("orderStatusMessage").textContent = enabled ? "平台托管自动续费已开启。" : "平台托管自动续费已关闭。";
    } catch (error) {
      control.checked = !enabled;
      setAlert(errorMessage(error, "自动续费设置失败"));
    } finally {
      control.disabled = false;
    }
  }

  async function init() {
    byId("purchaseForm").addEventListener("submit", submitOrder);
    byId("country").addEventListener("change", () => {
      renderCities();
      clearQuote();
      setAlert("");
    });
    byId("cityToggle").addEventListener("click", toggleCities);
    byId("city").addEventListener("change", () => { clearQuote(); setAlert(""); });
    byId("autoRenew").addEventListener("change", () => { clearQuote(); setAlert(""); });
    byId("orderRenewal").addEventListener("change", updateRenewal);
    byId("purchaseSuccessDone").addEventListener("click", () => {
      if (embedded && window.parent !== window) {
        window.parent.postMessage({ type: "vecto:proxy-purchase-complete", orderId: String(state.order?.id || "") }, window.location.origin);
        return;
      }
      location.assign("/console.html");
    });
    try {
      renderOptions(await api("/api/proxy-purchases/options"));
      const pending = readPendingRequest();
      if (pending?.submitted) {
        try {
          await recoverPendingOrder(pending, { replayIfMissing: true });
        } catch (error) {
          if (Number(error?.status) >= 400 && Number(error?.status) < 500) clearPendingRequest();
          setBusy(false, "重新选择地区报价");
          setAlert(errorMessage(error, "上次购买请求无法恢复，请重新获取报价"));
        }
      } else if (pending) {
        clearPendingRequest();
      }
    } catch (error) {
      byId("providerState").textContent = "连接失败";
      setAlert(errorMessage(error, "代理采购服务加载失败"));
    }
  }

  window.addEventListener("DOMContentLoaded", init);
  window.addEventListener("beforeunload", () => window.clearTimeout(state.polling));
})();
