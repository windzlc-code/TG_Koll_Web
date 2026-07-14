(() => {
  const page = document.querySelector("#pricingSubscription");
  const preview = document.querySelector("#homePricingLayout");
  if (!page && !preview) return;

  const state = { catalog: null, user: null, summary: null, selected: null };
  const list = (value) => Array.isArray(value) ? value : [];
  const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const escapeHtml = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[character]));
  const money = (value) => `NT$${Number(value || 0).toLocaleString("zh-TW", { maximumFractionDigits: 2 })}`;
  const skuOf = (item) => String(item?.sku || "").trim();

  async function request(path, options = {}) {
    const response = await fetch(path, { credentials: "include", ...options });
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
      <div class="catalog-purchase"><a class="button button-primary" href="/pricing.html">查看完整方案</a></div>
    </article>
    <div class="credit-panel" aria-label="算力計價標準">
      <h3>算力點官方計價</h3>
      <div class="unit-price"><span>1 點</span><strong>${money(catalog.point_unit_ntd || 10)}</strong></div>
      <div class="usage-grid">${actions.map((item) => `<span>${escapeHtml(item.name)}</span><strong>${escapeHtml(item.points)} 點 / ${escapeHtml(item.unit)}</strong>`).join("")}</div>
    </div>`;
    packages.innerHTML = list(catalog.packages).map((item, index) => `<article class="${index === 1 ? "featured" : ""}">
      <span>${escapeHtml(item.name)}</span><h3>${Number(item.total_points || 0).toLocaleString("zh-TW")} 點</h3>
      <p>${money(item.price_ntd)}</p><small>${item.bonus_points ? `含 ${Number(item.bonus_points).toLocaleString("zh-TW")} 點加贈` : "算力點永久有效"}</small>
      <div class="catalog-purchase"><a class="button button-primary" href="/pricing.html?product=${encodeURIComponent(skuOf(item))}">查看方案</a></div>
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
      return `<article class="pricing-package-card ${index === 1 ? "is-featured" : ""}">
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
      host.innerHTML = `<div><span>購買狀態</span><strong>登入後即可提交線下付款申請</strong></div><button class="button button-primary" type="button" data-open-login>帳號登入</button>`;
      host.querySelector("[data-open-login]")?.addEventListener("click", () => document.querySelector(".header-login")?.click());
      return;
    }
    const points = Number(state.summary?.points || 0).toLocaleString("zh-TW");
    host.innerHTML = `<div><span>目前帳號</span><strong>${escapeHtml(state.user.username || "已登入")} · ${points} 點算力</strong></div><a class="button button-primary" href="/console.html?view=billing">查看帳戶明細</a>`;
  }

  function closeOrder() {
    const modal = document.querySelector("#pricingOrderModal");
    modal?.classList.remove("is-open");
    modal?.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
  }

  function openLoginForProduct(sku) {
    const target = `/pricing.html?product=${encodeURIComponent(sku)}`;
    document.body.dataset.loginRedirect = target;
    document.querySelector(".header-login")?.click();
  }

  function openOrder(sku) {
    if (!state.user) {
      openLoginForProduct(sku);
      return;
    }
    const subscription = object(state.catalog.subscription);
    const item = skuOf(subscription) === sku ? { ...subscription, kind: "subscription" } : list(state.catalog.packages).find((candidate) => skuOf(candidate) === sku);
    if (!item) return;
    state.selected = item;
    const form = document.querySelector("#pricingOrderForm");
    form.reset();
    form.quantity.value = "1";
    document.querySelector("#pricingOrderDescription").textContent = `申請「${item.name}」，目前單價 ${money(item.price_ntd)}。管理員將按送出時的價格快照審核。`;
    const renewalField = document.querySelector("#pricingRenewalField");
    const renewalSelect = form.elements.renewal_subscription_id;
    const subscriptions = activeSubscriptions();
    renewalField.hidden = item.kind !== "subscription";
    renewalSelect.innerHTML = `<option value="">開通新訂閱</option>${subscriptions.map((entry) => `<option value="${escapeHtml(entry.id)}">續費 ${escapeHtml(entry.plan_sku || entry.id)}</option>`).join("")}`;
    document.querySelector("#pricingOrderStatus").textContent = "";
    const modal = document.querySelector("#pricingOrderModal");
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    window.setTimeout(() => form.elements.quantity.focus(), 30);
  }

  async function loadAccount() {
    try {
      state.user = await request("/api/auth/me");
      state.summary = await request("/api/billing/summary");
    } catch (error) {
      if (error.status !== 401) console.warn("Unable to load billing account", error);
      state.user = null;
      state.summary = null;
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
    submit.disabled = true;
    status.textContent = "正在提交付款申請";
    const idempotencyKey = `pricing-${Date.now()}-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
    const renewalId = String(form.elements.renewal_subscription_id?.value || "");
    try {
      const result = await request("/api/billing/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sku: skuOf(state.selected),
          quantity: Number(form.elements.quantity.value || 1),
          renewal_subscription_ids: renewalId ? [renewalId] : [],
          payer_name: String(form.elements.payer_name.value || "").trim(),
          payment_reference: String(form.elements.payment_reference.value || "").trim(),
          paid_at: form.elements.paid_at.value ? Math.floor(new Date(form.elements.paid_at.value).getTime() / 1000) : 0,
          proof_path: String(form.elements.proof_path.value || "").trim(),
          note: String(form.elements.note.value || "").trim(),
          idempotency_key: idempotencyKey,
        }),
      });
      status.textContent = `付款申請已建立：${result.order?.id || "等待管理員審核"}`;
      const url = new URL(window.location.href);
      url.searchParams.delete("product");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
      await loadAccount();
    } catch (error) {
      if (error.status === 401) {
        closeOrder();
        openLoginForProduct(skuOf(state.selected));
      } else {
        status.textContent = error.detail || "付款申請提交失敗";
      }
    } finally {
      submit.disabled = false;
    }
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
