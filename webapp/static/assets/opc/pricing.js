(() => {
  const page = document.querySelector("#pricingSubscription");
  const preview = document.querySelector("#homePricingLayout");
  if (!page && !preview) return;
  const ADMIN_CONTEXT_STORAGE_KEY = "vecto-admin-console-context";
  const ADMIN_WORKSPACE_STORAGE_KEY = "vecto-admin-workspace-user-id";
  const pricingParams = new URLSearchParams(window.location.search || "");
  const requestedWorkspace = String(
    pricingParams.get("admin_workspace_user_id") || pricingParams.get("manage_user_id") || "",
  ).trim();
  const explicitAdminContext = pricingParams.get("admin_console") === "1";
  const requestedAdminContext = explicitAdminContext || Boolean(requestedWorkspace);
  const billingSessionContext = (() => {
    try {
      if (requestedAdminContext) sessionStorage.setItem(ADMIN_CONTEXT_STORAGE_KEY, "1");
      const admin = requestedAdminContext || sessionStorage.getItem(ADMIN_CONTEXT_STORAGE_KEY) === "1";
      if (admin && requestedWorkspace) sessionStorage.setItem(ADMIN_WORKSPACE_STORAGE_KEY, requestedWorkspace);
      else if (explicitAdminContext) sessionStorage.removeItem(ADMIN_WORKSPACE_STORAGE_KEY);
      return {
        admin,
        workspaceUserId: admin
          ? requestedWorkspace || (explicitAdminContext ? "" : String(sessionStorage.getItem(ADMIN_WORKSPACE_STORAGE_KEY) || "").trim())
          : "",
      };
    } catch {
      return { admin: false, workspaceUserId: "" };
    }
  })();

  const state = {
    catalog: null,
    user: null,
    summary: null,
    summaryStatus: "idle",
    orders: [],
    ordersStatus: "idle",
    pendingCount: null,
    selected: null,
    orderAttempt: null,
  };
  const list = (value) => Array.isArray(value) ? value : [];
  const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const escapeHtml = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[character]));
  const money = (value) => `NT$${Number(value || 0).toLocaleString("zh-TW", { maximumFractionDigits: 2 })}`;
  const skuOf = (item) => String(item?.sku || "").trim();
  const newOrderKey = () => `pricing-${Date.now()}-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;

  function orderPayload(form) {
    const renewalId = String(form.elements.renewal_subscription_id?.value || "");
    return {
      sku: skuOf(state.selected),
      quantity: Number(form.elements.quantity.value || 1),
      renewal_subscription_ids: renewalId ? [renewalId] : [],
      note: String(form.elements.note.value || "").trim(),
    };
  }

  function orderAttemptFor(payload) {
    const fingerprint = JSON.stringify(payload);
    if (!state.orderAttempt || state.orderAttempt.fingerprint !== fingerprint) {
      state.orderAttempt = { fingerprint, idempotencyKey: newOrderKey() };
    }
    return state.orderAttempt;
  }

  function pendingCountFrom(payload) {
    const rawCount = payload?.pending_count;
    const explicit = rawCount === null || rawCount === undefined || rawCount === "" ? Number.NaN : Number(rawCount);
    if (Number.isInteger(explicit) && explicit >= 0) return explicit;
    const items = list(payload?.items);
    return items.length < 100
      ? items.filter((order) => String(order?.status || "") === "pending").length
      : null;
  }

  function orderStatusKnown() {
    return state.ordersStatus === "ready" && Number.isInteger(state.pendingCount);
  }

  function submissionBlockReason(item = state.selected) {
    if (!orderStatusKnown()) {
      return "申請狀態暫時無法讀取，為避免重複提交，請稍後重新整理再試。";
    }
    if (item?.kind === "subscription" && state.summaryStatus !== "ready") {
      return "訂閱資料暫時無法讀取，為避免錯誤開通或續費，請稍後重新整理再試。";
    }
    return "";
  }

  function adminConsoleContextActive() {
    return billingSessionContext.admin;
  }

  function publicPricingUrl(sku = "") {
    const url = new URL("/subscription.html", window.location.origin);
    if (sku) url.searchParams.set("product", sku);
    if (adminConsoleContextActive()) {
      url.searchParams.set("admin_console", "1");
      if (billingSessionContext.workspaceUserId) {
        url.searchParams.set("admin_workspace_user_id", billingSessionContext.workspaceUserId);
      }
    }
    return `${url.pathname}${url.search}`;
  }

  function billingAccountUrl() {
    if (!adminConsoleContextActive()) return "/console.html?view=billing";
    const params = new URLSearchParams({ view: "billing" });
    if (billingSessionContext.workspaceUserId) {
      params.set("manage_user_id", billingSessionContext.workspaceUserId);
    }
    return `/admin-console.html?${params.toString()}`;
  }

  function redirectToSelectedLogin(returnUrl) {
    if (adminConsoleContextActive()) {
      window.location.assign(`/admin?return_url=${encodeURIComponent(returnUrl)}`);
      return;
    }
    document.body.dataset.loginRedirect = returnUrl;
    document.querySelector(".header-login")?.click();
  }

  async function request(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (adminConsoleContextActive()) {
      headers.set("X-Admin-Console", "1");
      if (billingSessionContext.workspaceUserId) {
        headers.set("X-Admin-Workspace-User-ID", billingSessionContext.workspaceUserId);
      }
    }
    const response = await fetch(path, { credentials: "include", ...options, headers });
    const text = await response.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { detail: text || `HTTP ${response.status}` }; }
    if (!response.ok) throw { ...payload, status: response.status };
    return payload;
  }

  function renderPreview(catalog) {
    const layout = document.querySelector("#homePricingLayout");
    const packages = document.querySelector("#homePackageGrid");
    if (!layout || !packages) return;
    const subscription = object(catalog.subscription);
    const actions = list(catalog.actions).filter((item) => item.implemented !== false).slice(0, 5);
    layout.innerHTML = `<article class="subscription-card">
      <span class="pricing-label">Vecto Vanguard OPC</span>
      <h3>${escapeHtml(subscription.name || "月度訂閱方案")}</h3>
      <p class="price"><span>NT$</span>${Number(subscription.price_ntd || 0).toLocaleString("zh-TW")}<small>/ 月</small></p>
      <ul>${list(subscription.features).map((feature) => `<li>${escapeHtml(feature)}</li>`).join("")}</ul>
      <div class="catalog-purchase"><a class="button button-primary" href="${publicPricingUrl()}">查看完整方案</a></div>
    </article>
    <div class="credit-panel" aria-label="算力計價標準">
      <h3>算力點官方計價</h3>
      <div class="unit-price"><span>1 點</span><strong>${money(catalog.point_unit_ntd || 10)}</strong></div>
      <div class="usage-grid">${actions.map((item) => `<span>${escapeHtml(item.name)}</span><strong>${escapeHtml(item.points)} 點 / ${escapeHtml(item.unit)}</strong>`).join("")}</div>
    </div>`;
    packages.innerHTML = list(catalog.packages).map((item) => `<article>
      <span>${escapeHtml(item.name)}</span><h3>${Number(item.total_points || 0).toLocaleString("zh-TW")} 點</h3>
      <p>${money(item.price_ntd)}</p><small>${item.bonus_points ? `含 ${Number(item.bonus_points).toLocaleString("zh-TW")} 點加贈` : "算力點永久有效"}</small>
      <div class="catalog-purchase"><a class="button button-primary" href="${publicPricingUrl(skuOf(item))}">查看方案</a></div>
    </article>`).join("");
  }

  function renderPage(catalog) {
    const subscription = object(catalog.subscription);
    const features = list(subscription.features);
    document.querySelector("#pricingFactSubscription").textContent = money(subscription.price_ntd);
    document.querySelector("#pricingFactAccounts").textContent = `${Number(subscription.threads_accounts || 3)} 帳號`;
    document.querySelector("#pricingFactImages").textContent = `${Number(subscription.monthly_free_images || 10)} 張`;
    document.querySelector("#pricingFactPoint").textContent = `1 點 = ${money(catalog.point_unit_ntd || 10)}`;

    document.querySelector("#pricingSubscription").innerHTML = `<article class="pricing-subscription-card">
      <div class="pricing-subscription-main"><span class="pricing-label">Vecto Vanguard OPC</span><h3>${escapeHtml(subscription.name)}</h3>
        <div class="pricing-subscription-price">${money(subscription.price_ntd)} <small>/ 月</small></div>
        <button class="button button-primary" type="button" data-purchase-sku="${escapeHtml(skuOf(subscription))}">申請開通或續費</button>
      </div>
      <div class="pricing-subscription-details"><strong>每套方案包含</strong><ul class="pricing-subscription-features">
        ${features.map((feature) => `<li>${escapeHtml(feature)}</li>`).join("")}
        <li>每週期 ${Number(subscription.monthly_free_images || 10)} 張免費 AI 圖片</li>
        <li>${Number(subscription.threads_accounts || 3)} 個 Threads 帳號容量</li>
      </ul></div>
    </article>`;

    document.querySelector("#pricingActions").innerHTML = list(catalog.actions).map((item) => `<div class="pricing-action-row">
      <strong>${escapeHtml(item.name)}</strong><strong>${escapeHtml(item.points)} 點 / ${escapeHtml(item.unit)}</strong>
      <span class="pricing-action-state ${item.implemented !== false ? "is-live" : ""}">${item.implemented !== false ? "已接入扣費" : "僅價格目錄"}</span>
    </div>`).join("");

    document.querySelector("#pricingPackages").innerHTML = list(catalog.packages).map((item, index) => {
      const bonuses = [item.bonus_points ? `加贈 ${Number(item.bonus_points).toLocaleString("zh-TW")} 點` : "", item.bonus_images ? `加贈 ${Number(item.bonus_images)} 張永久圖片` : ""].filter(Boolean);
      return `<article class="pricing-package-card">
        <span class="pricing-label">${escapeHtml(item.name)}</span><h3>${escapeHtml(item.name)}</h3>
        <div class="pricing-package-points">${Number(item.total_points || 0).toLocaleString("zh-TW")} 點</div>
        <p class="pricing-package-price">${money(item.price_ntd)}</p><p class="pricing-package-copy">${escapeHtml(bonuses.join("，") || "無加贈，算力點永久有效")}</p>
        <button class="button button-primary" type="button" data-purchase-sku="${escapeHtml(skuOf(item))}">申請購買</button>
      </article>`;
    }).join("");
  }

  function activeSubscriptions() {
    return list(state.summary?.subscriptions).filter((item) => ["active", "scheduled"].includes(String(item.status || "active")));
  }

  function renderAccount() {
    const host = document.querySelector("#pricingAccountBar");
    if (!host) return;
    if (!state.user) {
      host.innerHTML = `<div><span>申請狀態</span><strong>登入後即可在線提交方案申請，管理員批准後才會生效</strong></div><button class="button button-primary" type="button" data-open-login>帳號登入</button>`;
      host.querySelector("[data-open-login]")?.addEventListener("click", () => document.querySelector(".header-login")?.click());
      return;
    }
    const points = state.summaryStatus === "ready"
      ? `${Number(state.summary?.points || 0).toLocaleString("zh-TW")} 點算力`
      : "算力暫時無法讀取";
    const applicationState = !orderStatusKnown()
      ? `申請狀態暫時無法讀取 · ${points}`
      : state.pendingCount
        ? `待管理員批准 ${state.pendingCount} 項 · ${points}`
        : `${points} · 可在線提交方案申請`;
    host.innerHTML = `<div><span>目前帳號</span><strong>${escapeHtml(state.user.username || "已登入")} · ${escapeHtml(applicationState)}</strong></div><a class="button button-primary" href="${billingAccountUrl()}">查看申請與帳戶明細</a>`;
  }

  function closeOrder() {
    const modal = document.querySelector("#pricingOrderModal");
    modal?.classList.remove("is-open");
    modal?.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
  }

  function openLoginForProduct(sku) {
    redirectToSelectedLogin(publicPricingUrl(sku));
  }

  function openOrder(sku) {
    if (!state.user) {
      openLoginForProduct(sku);
      return;
    }
    const subscription = object(state.catalog.subscription);
    const item = skuOf(subscription) === sku ? { ...subscription, kind: "subscription" } : list(state.catalog.packages).find((candidate) => skuOf(candidate) === sku);
    if (!item) return;
    if (state.orderAttempt && skuOf(state.selected) !== skuOf(item)) state.orderAttempt = null;
    state.selected = item;
    const form = document.querySelector("#pricingOrderForm");
    form.reset();
    form.quantity.value = "1";
    const submit = form.querySelector("button[type='submit']");
    const blockReason = submissionBlockReason(item);
    submit.disabled = Boolean(blockReason);
    submit.textContent = "提交申請";
    document.querySelector("#pricingOrderDescription").textContent = `在線申請「${item.name}」，目前單價 ${money(item.price_ntd)}。管理員將按送出時的價格快照審核。`;
    const renewalField = document.querySelector("#pricingRenewalField");
    const renewalSelect = form.elements.renewal_subscription_id;
    const subscriptions = state.summaryStatus === "ready" ? activeSubscriptions() : [];
    renewalField.hidden = item.kind !== "subscription";
    renewalSelect.disabled = item.kind === "subscription" && state.summaryStatus !== "ready";
    renewalSelect.innerHTML = renewalSelect.disabled
      ? '<option value="">訂閱資料暫時無法讀取</option>'
      : `<option value="">開通新訂閱</option>${subscriptions.map((entry) => `<option value="${escapeHtml(entry.id)}">續費 ${escapeHtml(entry.plan_sku || entry.id)}</option>`).join("")}`;
    document.querySelector("#pricingOrderStatus").textContent = blockReason;
    const modal = document.querySelector("#pricingOrderModal");
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    window.setTimeout(() => form.elements.quantity.focus(), 30);
  }

  async function loadAccount() {
    try {
      state.user = await request("/api/auth/me");
    } catch (error) {
      if (error.status !== 401) console.warn("Unable to load billing account", error);
      state.user = null;
      state.summary = null;
      state.summaryStatus = "idle";
      state.orders = [];
      state.ordersStatus = "idle";
      state.pendingCount = null;
      renderAccount();
      return;
    }
    state.summaryStatus = "loading";
    state.ordersStatus = "loading";
    state.pendingCount = null;
    const [summaryResult, ordersResult] = await Promise.allSettled([
      request("/api/billing/summary"),
      request("/api/billing/orders?limit=100"),
    ]);
    if (summaryResult.status === "fulfilled") {
      state.summary = summaryResult.value;
      state.summaryStatus = "ready";
    } else {
      state.summaryStatus = "error";
      console.warn("Unable to load billing summary", summaryResult.reason);
    }
    if (ordersResult.status === "fulfilled") {
      state.orders = list(ordersResult.value?.items);
      state.pendingCount = pendingCountFrom(ordersResult.value);
      state.ordersStatus = Number.isInteger(state.pendingCount) ? "ready" : "error";
      if (state.ordersStatus === "error") console.warn("Billing applications response has no exact pending count");
    } else {
      state.ordersStatus = "error";
      state.pendingCount = null;
      console.warn("Unable to load billing applications", ordersResult.reason);
    }
    renderAccount();
  }

  document.addEventListener("click", (event) => {
    const purchase = event.target.closest("[data-purchase-sku]");
    if (purchase) openOrder(String(purchase.dataset.purchaseSku || ""));
    if (event.target.closest("[data-close-order]") || event.target.id === "pricingOrderModal") closeOrder();
  });

  document.querySelector("#pricingOrderForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.selected) return;
    const form = event.currentTarget;
    const submit = form.querySelector("button[type='submit']");
    const status = document.querySelector("#pricingOrderStatus");
    const blockReason = submissionBlockReason();
    if (blockReason) {
      submit.disabled = true;
      status.textContent = blockReason;
      return;
    }
    submit.disabled = true;
    status.textContent = "正在提交線上申請";
    const payload = orderPayload(form);
    const attempt = orderAttemptFor(payload);
    let submitted = false;
    try {
      const result = await request("/api/billing/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, idempotency_key: attempt.idempotencyKey }),
      });
      const order = object(result.order);
      if (!order.id || String(order.status || "") !== "pending") {
        throw { detail: "申請已送出，但伺服器未回傳待審批狀態，請在帳戶明細確認。" };
      }
      submitted = true;
      state.orderAttempt = null;
      submit.textContent = "已提交，待批准";
      status.textContent = `申請已提交，等待管理員批准：${order.id}。批准前不會開通或增加算力。`;
      const url = new URL(window.location.href);
      url.searchParams.delete("product");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
      await loadAccount();
    } catch (error) {
      if (error.status === 401) {
        closeOrder();
        openLoginForProduct(skuOf(state.selected));
      } else {
        status.textContent = error.detail || "線上申請提交失敗";
      }
    } finally {
      if (!submitted) submit.disabled = false;
    }
  });

  const comparisonTable = document.querySelector(".pricing-comparison-table");
  const comparisonTierButtons = [...document.querySelectorAll("[data-comparison-tier]")];
  comparisonTierButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const tier = String(button.dataset.comparisonTier || "advanced");
      if (comparisonTable) comparisonTable.dataset.mobileTier = tier;
      comparisonTierButtons.forEach((candidate) => {
        candidate.setAttribute("aria-pressed", String(candidate === button));
      });
    });
  });

  Promise.all([request("/api/billing/catalog"), loadAccount()])
    .then(([catalog]) => {
      state.catalog = object(catalog.catalog || catalog.data || catalog);
      renderPreview(state.catalog);
      if (page) renderPage(state.catalog);
      const product = new URLSearchParams(window.location.search).get("product");
      if (product && page) window.setTimeout(() => openOrder(product), 80);
    })
    .catch((error) => {
      document.querySelectorAll(".pricing-public-loading").forEach((node) => { node.textContent = error.detail || "目前無法讀取方案，請稍後重試。"; });
      if (preview) {
        preview.innerHTML = '<div class="catalog-loading">目前無法讀取方案，請稍後重試。</div>';
        const packageGrid = document.querySelector("#homePackageGrid");
        if (packageGrid) packageGrid.innerHTML = '<div class="catalog-loading">目前無法讀取算力方案。</div>';
      }
    });
})();
