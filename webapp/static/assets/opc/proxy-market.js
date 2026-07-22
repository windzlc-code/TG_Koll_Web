(() => {
  "use strict";

  const FILTER_KEYS = [
    "country",
    "region",
    "city",
    "isp",
    "proxy_type",
    "ip_type",
    "health_status",
    "use_case",
    "tag",
    "availability",
    "min_price_cents",
    "max_price_cents",
    "valid_for_days",
    "sort",
  ];
  const UNAVAILABLE_VALUES = new Set(["unavailable", "sold_out", "out_of_stock", "exhausted", "disabled", "inactive"]);
  const LIMITED_VALUES = new Set(["limited", "low", "low_stock"]);
  const elements = {
    form: document.querySelector("#marketFilterForm"),
    reset: document.querySelector("#marketFilterReset"),
    grid: document.querySelector("#marketCatalogGrid"),
    empty: document.querySelector("#marketEmptyState"),
    status: document.querySelector("#marketCatalogStatus"),
    resultSummary: document.querySelector("#marketResultSummary"),
    catalogCount: document.querySelector("#marketCatalogCount"),
    regionCount: document.querySelector("#marketRegionCount"),
    quotaSummary: document.querySelector("#marketQuotaSummary"),
    accountBar: document.querySelector("#marketAccountBar"),
    accountLabel: document.querySelector("#marketAccountLabel"),
    accountMessage: document.querySelector("#marketAccountMessage"),
    loginButton: document.querySelector("[data-market-login]"),
    pagination: document.querySelector("#marketPagination"),
    pageSummary: document.querySelector("#marketPageSummary"),
    success: document.querySelector("#marketClaimSuccess"),
    successCopy: document.querySelector("#marketClaimSuccessCopy"),
  };

  const state = {
    authenticated: false,
    account: null,
    quota: null,
    items: [],
    page: 1,
    pageSize: 12,
    total: 0,
    totalPages: 1,
    catalogRequest: 0,
    catalogRendered: false,
    catalogReadMarked: false,
    claimKeys: new Map(),
  };

  function asObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function dataRoot(payload) {
    const source = asObject(payload);
    return asObject(source.data && !Array.isArray(source.data) ? source.data : source);
  }

  function firstValue(source, keys, fallback = "") {
    const object = asObject(source);
    for (const key of keys) {
      if (object[key] !== undefined && object[key] !== null && object[key] !== "") return object[key];
    }
    return fallback;
  }

  function finiteNumber(value, fallback = null) {
    if (value === "" || value === null || value === undefined) return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function redactSensitive(value, fallback = "未標示") {
    const text = String(value ?? "").trim();
    if (!text) return fallback;
    return text
      .replace(/\b(?:https?|socks5?):\/\/\S+/gi, "受保護節點")
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "•••.•••.•••.•••")
      .replace(/\b(?:[a-f0-9]{0,4}:){2,}[a-f0-9]{0,4}\b/gi, "••••:••••")
      .replace(/\b(?:[\w-]+\.)+[a-z]{2,}:\d{2,5}\b/gi, "受保護節點")
      .slice(0, 120);
  }

  function normalizedCode(value) {
    return String(value ?? "").trim().toLowerCase();
  }

  function humanize(value, labels = {}) {
    const code = normalizedCode(value);
    if (!code) return "未標示";
    if (labels[code]) return labels[code];
    return redactSensitive(code.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()));
  }

  function safeReturnUrl() {
    const path = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    return path.startsWith("/") && !path.startsWith("//") ? path : "/proxy-market.html";
  }

  function prepareLoginReturn() {
    document.body.dataset.loginRedirect = safeReturnUrl();
  }

  function publicSessionHeaders() {
    const headers = new Headers();
    try {
      if (sessionStorage.getItem("vecto-admin-console-context") === "1") {
        headers.set("X-Admin-Console", "1");
        const workspaceUserId = String(sessionStorage.getItem("vecto-admin-workspace-user-id") || "").trim();
        if (workspaceUserId) headers.set("X-Admin-Workspace-User-ID", workspaceUserId);
      }
    } catch {}
    return headers;
  }

  function proxyPoolTarget(value) {
    const fallback = "/console.html?view=accounts&browser_panel=proxies";
    let target;
    try {
      target = new URL(String(value || fallback), window.location.origin);
      if (
        target.origin !== window.location.origin
        || !["/console.html", "/admin-console.html"].includes(target.pathname)
      ) {
        target = new URL(fallback, window.location.origin);
      }
    } catch {
      target = new URL(fallback, window.location.origin);
    }
    try {
      const adminContext = sessionStorage.getItem("vecto-admin-console-context") === "1";
      const workspaceUserId = String(sessionStorage.getItem("vecto-admin-workspace-user-id") || "").trim();
      if (adminContext || workspaceUserId) {
        target.pathname = "/admin-console.html";
        if (workspaceUserId) target.searchParams.set("manage_user_id", workspaceUserId);
      }
    } catch {}
    return `${target.pathname}${target.search}${target.hash}`;
  }

  function openLogin() {
    prepareLoginReturn();
    const opener = document.querySelector("[data-open-login]");
    if (opener instanceof HTMLElement) {
      opener.click();
      return;
    }
    window.location.assign(`/login.html?return_url=${encodeURIComponent(safeReturnUrl())}`);
  }

  async function api(path, options = {}) {
    const headers = publicSessionHeaders();
    new Headers(options.headers || {}).forEach((value, key) => headers.set(key, value));
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    const response = await fetch(path, {
      credentials: "include",
      cache: "no-store",
      ...options,
      headers,
    });
    const raw = await response.text();
    let payload = {};
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = { detail: raw };
      }
    }
    if (!response.ok) {
      const error = new Error(errorMessage(payload, `請求失敗（HTTP ${response.status}）`));
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  function errorMessage(payload, fallback) {
    const source = asObject(payload);
    const detail = source.detail;
    if (typeof detail === "string" && detail.trim()) return redactSensitive(detail, fallback);
    if (detail && typeof detail === "object") {
      return redactSensitive(detail.message || detail.detail || fallback, fallback);
    }
    return redactSensitive(source.message || fallback, fallback);
  }

  function readFiltersFromUrl() {
    const query = new URLSearchParams(window.location.search);
    FILTER_KEYS.forEach((key) => {
      const field = elements.form?.elements?.[key];
      if (field) field.value = query.has(key) ? (query.get(key) || "") : (key === "availability" ? "available" : "");
    });
    const pageSize = [12, 24, 48].includes(Number(query.get("page_size"))) ? Number(query.get("page_size")) : 12;
    if (elements.form?.elements?.page_size) elements.form.elements.page_size.value = String(pageSize);
    state.page = Math.max(1, Math.floor(finiteNumber(query.get("page"), 1)));
    state.pageSize = pageSize;
  }

  function catalogParams() {
    const params = new URLSearchParams();
    FILTER_KEYS.forEach((key) => {
      const value = String(elements.form?.elements?.[key]?.value || "").trim();
      if (value) params.set(key, value);
    });
    state.pageSize = [12, 24, 48].includes(Number(elements.form?.elements?.page_size?.value))
      ? Number(elements.form.elements.page_size.value)
      : 12;
    params.set("page", String(state.page));
    params.set("page_size", String(state.pageSize));
    return params;
  }

  function syncUrl(params) {
    const next = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
    window.history.replaceState({}, "", next);
    prepareLoginReturn();
  }

  function setCatalogLoading() {
    elements.grid.hidden = false;
    elements.grid.setAttribute("aria-busy", "true");
    elements.grid.innerHTML = "";
    for (let index = 0; index < 3; index += 1) {
      const skeleton = document.createElement("div");
      skeleton.className = "proxy-card-skeleton";
      skeleton.setAttribute("aria-hidden", "true");
      elements.grid.append(skeleton);
    }
    elements.empty.hidden = true;
    elements.pagination.hidden = true;
    elements.status.textContent = "";
    elements.resultSummary.textContent = "正在讀取目錄";
  }

  function catalogEnvelope(payload) {
    const source = asObject(payload);
    const root = dataRoot(payload);
    const items = Array.isArray(root.items) ? root.items : Array.isArray(source.items) ? source.items : [];
    const pagination = asObject(root.pagination || source.pagination);
    const total = finiteNumber(firstValue(root, ["total", "total_items", "count"], firstValue(pagination, ["total", "total_items"], items.length)), items.length);
    const page = Math.max(1, Math.floor(finiteNumber(firstValue(root, ["page", "current_page"], pagination.page), state.page)));
    const pageSize = Math.max(1, Math.floor(finiteNumber(firstValue(root, ["page_size", "per_page"], firstValue(pagination, ["page_size", "per_page"], state.pageSize)), state.pageSize)));
    const totalPages = Math.max(1, Math.ceil(total / pageSize), Math.floor(finiteNumber(firstValue(root, ["total_pages", "pages"], firstValue(pagination, ["total_pages", "pages"], 1)), 1)));
    return { root, items, total, page, pageSize, totalPages };
  }

  function displayLocation(item) {
    const country = redactSensitive(firstValue(item, ["country_name", "country"], ""), "");
    const region = redactSensitive(firstValue(item, ["region_name", "region", "state"], ""), "");
    const city = redactSensitive(firstValue(item, ["city_name", "city"], ""), "");
    return [city, region, country].filter(Boolean).slice(0, 2).join(" · ") || "全球節點";
  }

  function itemAvailability(item) {
    const raw = normalizedCode(firstValue(item, ["availability", "stock_status", "status"], ""));
    const stock = finiteNumber(firstValue(item, ["stock", "remaining", "available_count"], null), null);
    if (item.claimable === false || item.available === false || stock === 0 || UNAVAILABLE_VALUES.has(raw)) {
      return { code: "unavailable", label: "暫不可用", claimable: false };
    }
    if (LIMITED_VALUES.has(raw) || (stock !== null && stock > 0 && stock <= 5)) {
      return { code: "limited", label: "少量可用", claimable: true };
    }
    return { code: "available", label: "可領取", claimable: true };
  }

  function itemId(item) {
    return String(firstValue(item, ["id", "item_id", "catalog_item_id", "sku"], "")).trim();
  }

  function itemUseCase(item) {
    const cases = Array.isArray(item.use_cases) ? item.use_cases : [];
    return firstValue(item, ["use_case", "recommended_use_case", "purpose"], cases[0] || "");
  }

  function textElement(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = text;
    return node;
  }

  function createMeta(label, value) {
    const wrapper = document.createElement("div");
    const term = document.createElement("dt");
    const detail = document.createElement("dd");
    term.textContent = label;
    detail.textContent = value;
    detail.title = value;
    wrapper.append(term, detail);
    return wrapper;
  }

  function renderCard(item, index) {
    const availability = itemAvailability(item);
    const article = document.createElement("article");
    article.className = `proxy-card is-${availability.code}`;

    const top = document.createElement("div");
    top.className = "proxy-card-top";
    const countryFallback = redactSensitive(firstValue(item, ["country_name", "country"], "GL"), "GL").replace(/\s+/g, "").slice(0, 2);
    const countryCode = redactSensitive(firstValue(item, ["country_code", "country_iso", "iso_code"], countryFallback), countryFallback).slice(0, 3);
    top.append(
      textElement("span", "proxy-country-code", countryCode),
      textElement("span", "proxy-availability", availability.label),
    );

    const heading = document.createElement("div");
    heading.className = "proxy-card-heading";
    const headingCopy = document.createElement("div");
    const ipType = humanize(firstValue(item, ["ip_type", "network_type"], ""), {
      static_residential: "靜態住宅",
      residential: "住宅",
      datacenter: "機房代理",
      mobile: "行動網路",
    });
    headingCopy.append(
      textElement("span", "proxy-card-kicker", ipType),
      textElement("h3", "", displayLocation(item)),
    );
    const protocol = humanize(firstValue(item, ["proxy_type", "protocol"], "proxy"));
    heading.append(headingCopy, textElement("span", "proxy-card-protocol", protocol));

    const meta = document.createElement("dl");
    meta.className = "proxy-card-meta";
    const isp = redactSensitive(firstValue(item, ["isp_name", "isp", "carrier"], ""), "供應商未標示");
    const useCase = humanize(itemUseCase(item), {
      social: "社群營運",
      automation: "自動化",
      data_collection: "資料採集",
      ecommerce: "電商",
      general: "一般用途",
    });
    const latency = finiteNumber(firstValue(item, ["latency_ms", "latency"], null), null);
    const quality = redactSensitive(firstValue(item, ["quality_tier", "quality", "grade"], ""), "標準");
    const health = humanize(firstValue(item, ["health_status"], "pending"), {
      healthy: "健康",
      pending: "待檢測",
      failed: "異常",
    });
    const expiresAt = finiteNumber(firstValue(item, ["expires_at"], 0), 0);
    const expiry = expiresAt > 0
      ? new Date(expiresAt * 1000).toLocaleDateString("zh-TW")
      : "長期有效";
    const priceCents = Math.max(0, finiteNumber(firstValue(item, ["display_price_cents"], 0), 0));
    const currency = redactSensitive(firstValue(item, ["currency"], "TWD"), "TWD").toUpperCase();
    const price = `${currency} ${(priceCents / 100).toLocaleString("zh-TW", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
    const maskedHost = redactSensitive(firstValue(item, ["masked_host"], ""), "受保護");
    meta.append(
      createMeta("節點地址", maskedHost),
      createMeta("網路供應商", isp),
      createMeta("建議用途", useCase),
      createMeta("健康狀態", health),
      createMeta("參考延遲", latency !== null && latency > 0 ? `${Math.round(latency)} ms` : "待量測"),
      createMeta("有效期限", expiry),
      createMeta("參考價格", price),
      createMeta("線路品質", quality),
    );

    const footer = document.createElement("div");
    footer.className = "proxy-card-footer";
    const note = textElement("p", "proxy-card-note", "連線地址與憑據僅在加入代理池後受保護管理。");
    const button = document.createElement("button");
    button.className = "proxy-claim-button";
    button.type = "button";
    button.dataset.claimIndex = String(index);
    button.textContent = availability.claimable ? "添加到代理池" : "暫不可領取";
    button.disabled = !availability.claimable || !itemId(item);
    footer.append(note, button);

    article.append(top, heading, meta, footer);
    return article;
  }

  function renderCatalog() {
    elements.grid.replaceChildren();
    elements.grid.setAttribute("aria-busy", "false");
    elements.empty.hidden = state.items.length !== 0;
    elements.grid.hidden = state.items.length === 0;

    state.items.forEach((item, index) => elements.grid.append(renderCard(asObject(item), index)));

    const start = state.total ? (state.page - 1) * state.pageSize + 1 : 0;
    const end = Math.min(state.total, start + state.items.length - 1);
    elements.resultSummary.textContent = state.total
      ? `共 ${state.total.toLocaleString()} 筆，顯示 ${start}-${end}`
      : "目前沒有符合條件的節點";
    elements.catalogCount.textContent = `${state.total.toLocaleString()} 個`;
    renderPagination();
  }

  function renderPagination() {
    const previous = elements.pagination.querySelector('[data-page-action="previous"]');
    const next = elements.pagination.querySelector('[data-page-action="next"]');
    previous.disabled = state.page <= 1;
    next.disabled = state.page >= state.totalPages;
    elements.pageSummary.textContent = `第 ${state.page} / ${state.totalPages} 頁`;
    elements.pagination.hidden = state.totalPages <= 1;
  }

  function facetValues(root, key) {
    const facets = asObject(root.facets || root.filters || root.filter_options);
    const pluralKeys = { country: "countries", region: "regions", city: "cities", isp: "isps" };
    const raw = facets[key] || facets[pluralKeys[key] || `${key}s`];
    if (Array.isArray(raw)) {
      return raw.map((entry) => typeof entry === "object" ? firstValue(entry, ["value", "name", "label"], "") : entry);
    }
    return [];
  }

  function updateFacetSelect(id, values, emptyLabel) {
    const select = document.querySelector(`#${id}`);
    if (!(select instanceof HTMLSelectElement)) return;
    const selected = select.value;
    const unique = [...new Set(values.map((value) => redactSensitive(value, "")).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = emptyLabel;
    const options = unique.slice(0, 120).map((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      return option;
    });
    select.replaceChildren(empty, ...options);
    if (unique.includes(selected)) select.value = selected;
  }

  function updateFacets(root, items) {
    const sources = {
      marketCountryOptions: ["country", ["country_name", "country"], "全部國家"],
      marketRegionOptions: ["region", ["region_name", "region", "state"], "全部區域"],
      marketCityOptions: ["city", ["city_name", "city"], "全部城市"],
      marketIspOptions: ["isp", ["isp_name", "isp", "carrier"], "全部 ISP"],
      marketUseCaseOptions: ["use_cases", ["use_case", "recommended_use_case", "purpose"], "全部情境"],
      marketTagOptions: ["tags", ["tag"], "全部標籤"],
    };
    Object.entries(sources).forEach(([id, [facetKey, itemKeys, emptyLabel]]) => {
      const values = facetValues(root, facetKey);
      items.forEach((item) => {
        const direct = firstValue(item, itemKeys, "");
        if (direct) values.push(direct);
        if (facetKey === "use_cases" && Array.isArray(item.use_cases)) values.push(...item.use_cases);
        if (facetKey === "tags" && Array.isArray(item.tags)) values.push(...item.tags);
      });
      updateFacetSelect(id, values, emptyLabel);
    });
  }

  function regionCount(root, items) {
    const stats = asObject(root.stats);
    const explicit = finiteNumber(firstValue(root, ["region_count", "locations_count", "country_count"], firstValue(stats, ["regions", "region_count"], null)), null);
    if (explicit !== null) return explicit;
    return new Set(items.map((item) => displayLocation(asObject(item))).filter((value) => value !== "全球節點")).size;
  }

  async function markCatalogRead() {
    if (!state.authenticated || state.catalogReadMarked) return;
    state.catalogReadMarked = true;
    try {
      await api("/api/proxy-market/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "catalog" }),
      });
      try {
        localStorage.setItem("vecto-proxy-market-read", String(Date.now()));
      } catch {}
      if ("BroadcastChannel" in window) {
        const channel = new BroadcastChannel("vecto-proxy-market");
        channel.postMessage({ scope: "catalog", readAt: Date.now() });
        channel.close();
      }
      window.dispatchEvent(new CustomEvent("vecto:proxy-market-read"));
    } catch {
      state.catalogReadMarked = false;
      // Read tracking must never block public catalog browsing.
    }
  }

  async function loadCatalog({ scroll = false, preserveOnError = false, throwOnError = false } = {}) {
    const requestId = ++state.catalogRequest;
    const requestedPage = state.page;
    setCatalogLoading();
    const params = catalogParams();
    syncUrl(params);
    try {
      const payload = await api(`/api/proxy-market/catalog?${params.toString()}`);
      if (requestId !== state.catalogRequest) return;
      const envelope = catalogEnvelope(payload);
      if (requestedPage > envelope.totalPages) {
        state.page = envelope.totalPages;
        return loadCatalog({ scroll, preserveOnError, throwOnError });
      }
      state.items = envelope.items.map(asObject);
      state.total = envelope.total;
      state.page = envelope.page;
      state.pageSize = envelope.pageSize;
      state.totalPages = envelope.totalPages;
      updateFacets(envelope.root, state.items);
      elements.regionCount.textContent = `${regionCount(envelope.root, state.items).toLocaleString()} 個`;
      renderCatalog();
      state.catalogRendered = true;
      void markCatalogRead();
      if (scroll) document.querySelector("#catalog")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      if (requestId !== state.catalogRequest) return;
      if (preserveOnError) {
        renderCatalog();
        if (throwOnError) throw error;
        return;
      }
      state.items = [];
      state.total = 0;
      elements.grid.replaceChildren();
      elements.grid.hidden = true;
      elements.grid.setAttribute("aria-busy", "false");
      elements.empty.hidden = false;
      elements.status.textContent = error.message || "目錄暫時無法讀取，請稍後再試。";
      elements.resultSummary.textContent = "目錄讀取失敗";
      elements.catalogCount.textContent = "暫不可用";
      elements.regionCount.textContent = "暫不可用";
      if (throwOnError) throw error;
    }
  }

  function quotaFromMe(root) {
    const quota = asObject(root.quota || root.claim_quota || root.proxy_quota || root.usage);
    const remaining = finiteNumber(firstValue(quota, ["remaining", "available", "remaining_claims"], firstValue(root, ["remaining", "remaining_claims", "quota_remaining", "available_claims", "claims_remaining"], null)), null);
    const limit = finiteNumber(firstValue(quota, ["limit", "total", "monthly_limit", "claim_limit"], firstValue(root, ["quota_limit", "claim_limit"], null)), null);
    const used = finiteNumber(firstValue(quota, ["used", "claimed", "used_claims"], firstValue(root, ["claims_used", "claimed_count"], null)), null);
    return { remaining, limit, used };
  }

  function renderAccount() {
    elements.accountBar.classList.toggle("is-authenticated", state.authenticated);
    if (!state.authenticated) {
      elements.accountLabel.textContent = "游客瀏覽";
      elements.accountMessage.textContent = "目錄可直接查看；登入後可領取可用節點。";
      elements.quotaSummary.textContent = "登入後查看";
      return;
    }
    const name = redactSensitive(firstValue(state.account, ["display_name", "full_name", "username"], "已登入帳號"));
    const quota = state.quota || {};
    elements.accountLabel.textContent = "目前帳號";
    if (quota.remaining !== null && quota.limit !== null) {
      elements.accountMessage.textContent = `${name}，本期剩餘 ${quota.remaining} / ${quota.limit} 個領取額度。`;
      elements.quotaSummary.textContent = `${quota.remaining} / ${quota.limit}`;
    } else if (quota.remaining !== null) {
      elements.accountMessage.textContent = `${name}，目前可領取 ${quota.remaining} 個節點。`;
      elements.quotaSummary.textContent = `${quota.remaining} 個`;
    } else {
      elements.accountMessage.textContent = `${name}，可從目錄將可用節點加入代理池。`;
      elements.quotaSummary.textContent = "帳號可用";
    }
  }

  async function loadMe({ preserveOnError = false, throwOnError = false } = {}) {
    let failure = null;
    try {
      const payload = await api("/api/proxy-market/me");
      const root = dataRoot(payload);
      if (root.authenticated === false) throw Object.assign(new Error("Unauthorized"), { status: 401 });
      state.authenticated = true;
      state.account = asObject(root.user || root.account || root.me || root);
      state.quota = quotaFromMe(root);
      if (state.catalogRendered) void markCatalogRead();
    } catch (error) {
      failure = error;
      if (!preserveOnError || [401, 403].includes(error.status)) {
        state.authenticated = false;
        state.account = null;
        state.quota = null;
      }
      if (![401, 403].includes(error.status)) {
        elements.accountMessage.textContent = "登入狀態暫時無法確認；目錄仍可正常瀏覽。";
        elements.quotaSummary.textContent = "暫不可用";
      }
    }
    renderAccount();
    if (failure && throwOnError) throw failure;
  }

  function claimKey(id) {
    if (!state.claimKeys.has(id)) {
      const token = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      state.claimKeys.set(id, `proxy-market:${id}:${token}`.slice(0, 128));
    }
    return state.claimKeys.get(id);
  }

  function showSuccess(item, payload) {
    const location = displayLocation(item);
    const root = dataRoot(payload);
    const target = String(firstValue(root, ["proxy_list_url", "proxy_pool_url"], "")).trim();
    const poolLink = elements.success.querySelector("[data-proxy-pool-link]");
    if (poolLink) poolLink.href = proxyPoolTarget(target);
    elements.successCopy.textContent = `${location}節點已安全加入；現在可以前往 Web 控制台進行綁定與連線檢查。`;
    elements.success.hidden = false;
    elements.success.querySelector("[data-close-success]")?.focus({ preventScroll: true });
  }

  function applyClaimLocally(id) {
    const itemIndex = state.items.findIndex((item) => itemId(item) === id);
    if (itemIndex >= 0) {
      state.items.splice(itemIndex, 1);
      state.total = Math.max(0, state.total - 1);
    }
    state.totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
    state.page = Math.min(state.page, state.totalPages);
    if (state.quota) {
      if (state.quota.remaining !== null) state.quota.remaining = Math.max(0, state.quota.remaining - 1);
      if (state.quota.used !== null) state.quota.used += 1;
    }
    renderCatalog();
    renderAccount();
  }

  async function claimItem(index, button) {
    const item = state.items[index];
    const id = itemId(item);
    if (!item || !id || button.disabled) return;
    if (!state.authenticated) {
      openLogin();
      return;
    }

    const original = button.textContent;
    button.disabled = true;
    button.textContent = "正在添加";
    elements.status.textContent = "";
    let payload;
    try {
      payload = await api(`/api/proxy-market/items/${encodeURIComponent(id)}/claim`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": claimKey(id),
        },
        body: JSON.stringify({ idempotency_key: claimKey(id) }),
      });
    } catch (error) {
      if ([401, 403].includes(error.status)) {
        state.authenticated = false;
        renderAccount();
        openLogin();
      } else {
        elements.status.textContent = error.message || "添加失敗，請稍後再試。";
        if (error.status && error.status < 500) state.claimKeys.delete(id);
        button.disabled = false;
        button.textContent = original;
      }
      return;
    }

    state.claimKeys.delete(id);
    applyClaimLocally(id);
    showSuccess(item, payload);
    if ("BroadcastChannel" in window) {
      try {
        const channel = new BroadcastChannel("vecto-proxy-market");
        channel.postMessage({ scope: "proxy_pool", changedAt: Date.now() });
        channel.close();
      } catch {}
    }
    const refreshResults = await Promise.allSettled([
      loadMe({ preserveOnError: true, throwOnError: true }),
      loadCatalog({ preserveOnError: true, throwOnError: true }),
    ]);
    if (refreshResults.some((result) => result.status === "rejected")) {
      elements.status.textContent = "代理已成功添加，但最新状态刷新失败，请稍后手动刷新。";
    }
  }

  function clearFilters() {
    elements.form.reset();
    if (elements.form.elements.page_size) elements.form.elements.page_size.value = "12";
    state.page = 1;
    void loadCatalog({ scroll: true });
  }

  elements.form?.addEventListener("submit", (event) => {
    event.preventDefault();
    state.page = 1;
    void loadCatalog({ scroll: true });
  });

  elements.reset?.addEventListener("click", clearFilters);
  document.querySelectorAll("[data-clear-filters]").forEach((button) => button.addEventListener("click", clearFilters));
  elements.loginButton?.addEventListener("click", openLogin);
  document.querySelectorAll("[data-close-success]").forEach((button) => {
    button.addEventListener("click", () => {
      elements.success.hidden = true;
    });
  });

  elements.grid?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-claim-index]");
    if (!(button instanceof HTMLButtonElement)) return;
    const index = Number(button.dataset.claimIndex);
    if (!Number.isInteger(index) || index < 0 || index >= state.items.length) return;
    void claimItem(index, button);
  });

  elements.pagination?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-page-action]");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return;
    const delta = button.dataset.pageAction === "next" ? 1 : -1;
    state.page = Math.min(state.totalPages, Math.max(1, state.page + delta));
    void loadCatalog({ scroll: true });
  });

  window.addEventListener("popstate", () => {
    readFiltersFromUrl();
    void loadCatalog();
  });

  readFiltersFromUrl();
  prepareLoginReturn();
  void Promise.all([loadMe(), loadCatalog()]);
})();
