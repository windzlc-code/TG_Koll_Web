/* Collector proxy product UI for product admin. Depends on admin.js helpers. */
(function () {
  if (typeof api !== "function" || typeof el !== "function") return;
function applyCollectorProxyPublicConfig(config = {}, message = "") {
  adminState.collectorProxyConfig = config;
  if (el("rtCollectorProxyProvider")) el("rtCollectorProxyProvider").value = config.provider || "proxycheap";
  setCollectorProxyMaskedInput("rtCollectorProxyApiKey", config.api_key_configured, config.api_key_masked);
  setCollectorProxyMaskedInput("rtCollectorProxyApiSecret", config.api_secret_configured, config.api_secret_masked);
  const advanced = document.querySelector(".collector-proxy-advanced");
  if (advanced) advanced.open = !(config.api_key_configured && config.api_secret_configured);
  const chip = el("collectorProxyStateChip");
  const state = String(config.state || "");
  const displayStatus = collectorProxyDisplayStatus(config);
  if (chip) {
    chip.textContent = displayStatus.label;
    chip.dataset.state = displayStatus.state || "unconfigured";
  }
  if (el("collectorProxyProductSummary")) {
    el("collectorProxyProductSummary").textContent = collectorProxyProductSummary(config) || (Array.isArray(config.products) && config.products.length ? `已保存 ${config.products.length} 个代理产品。` : "尚未读取代理产品信息。");
  }
  const detail = message || displayStatus.detail || `当前状态：${displayStatus.label}。`;
  setMsg("collectorProxyConfigMsg", detail, collectorProxyMessageHealthy(detail, displayStatus));
  if (config.traffic_cache) adminState.collectorProxyLastTraffic = config.traffic_cache;
  const traffic = adminState.collectorProxyLastTraffic || {};
  const products = Array.isArray(config.products) ? config.products : [];
  renderCollectorProxyProductCards(products.filter((item) => !collectorProxyProductExhausted(item, traffic)));
}

function collectorProxyMessageHealthy(message, displayStatus = {}) {
  const text = String(message || "");
  if (/失败|不可用|待更新|未通过|请更新|没有识别/.test(text)) return false;
  if (/连接健康|检测通过|连接正常|已启用公开 Reader|已添加产品|已自动清理/.test(text)) return true;
  const state = String(displayStatus.state || "");
  return state === "active" || state === "ready";
}

function collectorProxyProductExhausted(item, traffic = {}) {
  const id = String(item?.proxy_id || item?.id || "").trim();
  const rows = Array.isArray(traffic?.products) ? traffic.products : [];
  const row = rows.find((entry) => String(entry?.id || "") === id) || item?.product || item;
  const total = Number(row?.bandwidth_total_gb ?? 0);
  if (!(total > 0)) return false;
  const remaining = row?.bandwidth_remaining_gb == null
    ? total - Number(row?.bandwidth_used_gb || 0)
    : Number(row.bandwidth_remaining_gb);
  return remaining <= 0.05;
}

function collectorProxyFormPayload() {
  return {
    provider: "proxycheap",
    api_key: "",
    api_secret: "",
    proxy_id: String(el("rtCollectorProxyProductSelect")?.value || "").trim(),
  };
}

async function loadCollectorProxyConfig() {
  const config = await api("/api/admin/collector-proxy/config");
  applyCollectorProxyPublicConfig(config || {});
  await discoverCollectorProxyProducts({ quiet: true }).catch(() => null);
  return config;
}

function renderCollectorProxyProducts(products = [], selectedId = "") {
  const select = el("rtCollectorProxyProductSelect");
  if (!select) return;
  const selected = String(selectedId || select.value || "").trim();
  select.replaceChildren(new Option(products.length ? "请选择代理产品" : "未识别到有效产品", ""));
  products.forEach((product) => {
    const id = String(product.id || product.proxy_id || "").trim();
    if (!id) return;
    if (collectorProxyProductExhausted(product, adminState.collectorProxyLastTraffic || {})) return;
    const total = Number(product.bandwidth_total_gb || product.product?.bandwidth_total_gb || 0);
    const status = product.status || product.product?.status || "-";
    const network = product.network_type || product.product?.network_type || "-";
    select.add(new Option(`${id} · ${status} · ${network} · ${total} GB`, id));
  });
  if (selected && ![...select.options].some((option) => option.value === selected)) {
    select.add(new Option(`产品 ${selected}`, selected));
  }
  if (selected) select.value = selected;
  adminState.collectorProxyProducts = products;
}

function renderCollectorProxyProductCards(products = []) {
  const host = el("collectorProxyProductCards");
  if (!host) return;
  const items = Array.isArray(products) ? products : [];
  if (!items.length) {
    host.innerHTML = "";
    return;
  }
  const selectedId = String(adminState.collectorProxySelectedId || items[0]?.proxy_id || "").trim();
  const selected = items.find((item) => String(item.proxy_id || "") === selectedId) || items[0];
  const tabs = items.map((item) => {
    const id = String(item.proxy_id || "").trim();
    const active = selected && String(selected.proxy_id) === id;
    const state = collectorProxyDisplayStatus(item).state;
    return `<div class="collector-proxy-product-tab-group" data-active="${active ? "true" : "false"}">
      <button type="button" class="collector-proxy-product-tab" data-proxy-id="${escapeHtml(id)}" aria-selected="${active ? "true" : "false"}">
        <span class="collector-proxy-product-tab-dot" data-state="${escapeHtml(state)}"></span>
        <span>${escapeHtml(id)}</span>
      </button>
      <button type="button" class="collector-proxy-product-tab-delete" data-delete-proxy-id="${escapeHtml(id)}" aria-label="删除产品 ${escapeHtml(id)}">×</button>
    </div>`;
  }).join("");
  const product = selected?.product && typeof selected.product === "object" ? selected.product : {};
  const check = selected?.last_check && typeof selected.last_check === "object" ? selected.last_check : {};
  const displayStatus = collectorProxyDisplayStatus(selected || {});
  const state = displayStatus.state;
  const statusText = displayStatus.label;
  const checkText = check.ok
    ? `连接健康 · 出口 ${check.exit_ip || "-"} · ${check.latency_ms ?? "-"} ms`
    : (displayStatus.detail || (selected?.connection_configured ? "连接已保存，待检测" : "尚未填写连接串"));
  const connectionValue = selected?.connection_configured ? (selected.connection || "") : "";
  const trafficRole = selected?.traffic_role === "sticky" || selected?.mode === "sticky" ? "sticky" : "dynamic";
  host.innerHTML = `
    <div class="collector-proxy-product-tabs">${tabs}</div>
    <section class="collector-proxy-product-panel" data-proxy-id="${escapeHtml(String(selected?.proxy_id || ""))}">
      <div class="collector-proxy-product-panel-head">
        <strong>产品 ${escapeHtml(String(selected?.proxy_id || ""))}</strong>
        <span>${escapeHtml([product.status, product.network_type, product.proxy_type, product.bandwidth_total_gb != null ? `${product.bandwidth_total_gb} GB` : ""].filter(Boolean).join(" · "))}</span>
      </div>
      <label class="collector-proxy-product-field">连接串
        <input class="collector-proxy-product-connection" type="text" value="${escapeHtml(connectionValue)}" placeholder="http://user:password@host:port" autocomplete="off" autocapitalize="none" spellcheck="false" data-saved="${selected?.connection_configured ? "true" : "false"}" data-mask="${escapeHtml(connectionValue)}">
      </label>
      <div class="collector-proxy-product-actions">
        <button type="button" class="ghost collector-proxy-product-test" data-test-proxy-id="${escapeHtml(String(selected?.proxy_id || ""))}">检测连接</button>
        <div class="collector-proxy-traffic-role" aria-label="代理用途">
          <span>用途</span>
          <button type="button" class="${trafficRole === "dynamic" ? "is-active" : ""}" data-traffic-role="dynamic" data-traffic-role-proxy-id="${escapeHtml(String(selected?.proxy_id || ""))}" aria-pressed="${trafficRole === "dynamic" ? "true" : "false"}">动态 IP</button>
          <button type="button" class="${trafficRole === "sticky" ? "is-active" : ""}" data-traffic-role="sticky" data-traffic-role-proxy-id="${escapeHtml(String(selected?.proxy_id || ""))}" aria-pressed="${trafficRole === "sticky" ? "true" : "false"}">粘性 IP</button>
        </div>
        <label class="switch collector-proxy-product-reader"><input type="checkbox" data-reader-proxy-id="${escapeHtml(String(selected?.proxy_id || ""))}" ${selected?.public_reader_enabled ? "checked" : ""} ${trafficRole === "sticky" ? "disabled" : ""}> 公开 Reader</label>
        <span class="collector-proxy-product-status" data-state="${escapeHtml(state)}">${escapeHtml(statusText)}</span>
      </div>
      <div class="collector-proxy-product-check" data-state="${escapeHtml(state)}">${escapeHtml(checkText)}</div>
    </section>`;
}

async function discoverCollectorProxyProducts({ quiet = false } = {}) {
  if (!quiet) setMsg("collectorProxyConfigMsg", "正在自动识别代理产品...");
  const result = await api("/api/admin/collector-proxy/products", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(collectorProxyFormPayload()),
  });
  if (result.traffic) adminState.collectorProxyLastTraffic = result.traffic;
  const products = Array.isArray(result.products) ? result.products : [];
  renderCollectorProxyProducts(products, adminState.collectorProxyConfig?.provider_proxy_id || "");
  const configuredProducts = Array.isArray(result.config?.products) ? result.config.products : [];
  const missingEndpoints = configuredProducts.filter((item) => !item?.connection_configured).length;
  const removed = Array.isArray(result.removed_ids) ? result.removed_ids.filter(Boolean) : [];
  const cleaned = removed.length ? `已自动清理 ${removed.length} 个流量用尽的产品。` : "";
  const syncMessage = products.length
    ? `API 已同步 ${products.length} 个可用代理产品${missingEndpoints ? `；${missingEndpoints} 个已保存产品未返回主机和端口，请从供应商“Setup Credentials”复制当前连接串。` : "。"}${cleaned ? ` ${cleaned}` : ""}`
    : (cleaned || "没有识别到有效代理产品。");
  if (result.config) applyCollectorProxyPublicConfig(result.config, quiet ? undefined : syncMessage);
  else if (!quiet) setMsg("collectorProxyConfigMsg", products.length ? `已识别 ${products.length} 个有效代理产品。` : "没有识别到有效代理产品。", products.length > 0);
  if (result.traffic) renderCollectorProxyTraffic(result.traffic, result.warning || null);
  return products;
}

async function addCollectorProxyManualProduct() {
  const proxyId = String(el("rtCollectorProxyProductSelect")?.value || "").trim();
  if (!/^\d{1,20}$/.test(proxyId)) {
    setMsg("collectorProxyConfigMsg", "请先在下拉框选择要添加的代理产品。", false);
    return;
  }
  const result = await api("/api/admin/collector-proxy/manual-products", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ proxy_id: proxyId }),
  });
  if (result.config) {
    adminState.collectorProxySelectedId = result.added_id || proxyId;
    applyCollectorProxyPublicConfig(result.config, result.exists ? `产品 ${proxyId} 已在列表中。` : `已添加产品 ${proxyId}。`);
  }
}

async function deleteCollectorProxyManualProduct(proxyId) {
  const result = await api(`/api/admin/collector-proxy/manual-products/${encodeURIComponent(proxyId)}`, { method: "DELETE" });
  if (result.config) {
    if (String(adminState.collectorProxySelectedId || "") === String(proxyId)) adminState.collectorProxySelectedId = "";
    applyCollectorProxyPublicConfig(result.config, `已删除产品 ${proxyId}。`);
  }
}

async function testCollectorProxyProduct(proxyId, connection) {
  const result = await api(`/api/admin/collector-proxy/products/${encodeURIComponent(proxyId)}/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ connection: connection || "" }),
  });
  if (result.config) {
    adminState.collectorProxySelectedId = proxyId;
    applyCollectorProxyPublicConfig(
      result.config,
      result.ok
        ? `产品 ${proxyId} 连接健康。出口 ${result.result?.exit_ip || "-"}，${result.result?.latency_ms ?? "-"} ms`
        : `产品 ${proxyId} 检测失败。`,
    );
  }
}

async function toggleCollectorProxyProductReader(proxyId, enabled) {
  const result = await api(`/api/admin/collector-proxy/products/${encodeURIComponent(proxyId)}/reader`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: Boolean(enabled) }),
  });
  if (result.config) {
    adminState.collectorProxySelectedId = proxyId;
    applyCollectorProxyPublicConfig(result.config, enabled ? `产品 ${proxyId} 已启用公开 Reader。` : `产品 ${proxyId} 已关闭公开 Reader。`);
  }
}

async function setCollectorProxyProductTrafficRole(proxyId, role) {
  const result = await api(`/api/admin/collector-proxy/products/${encodeURIComponent(proxyId)}/traffic-role`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role }),
  });
  if (result.config) {
    adminState.collectorProxySelectedId = proxyId;
    applyCollectorProxyPublicConfig(result.config, `产品 ${proxyId} 已设为${role === "sticky" ? "粘性 IP" : "动态 IP"}。`);
  }
  if (result.traffic) renderCollectorProxyTraffic(result.traffic, result.config?.traffic_warning || null);
}

function bindCollectorProxyConfigPanel() {
  if (document.body.dataset.collectorProxyConfigBound === "true") return;
  document.body.dataset.collectorProxyConfigBound = "true";
  const bindAction = (buttonId, pendingText, action) => {
    el(buttonId)?.addEventListener("click", async () => {
      const button = el(buttonId);
      const label = button?.querySelector("[data-action-label]");
      const original = label?.textContent || "";
      if (button) button.disabled = true;
      if (label) label.textContent = pendingText;
      setMsg("collectorProxyConfigMsg", pendingText);
      try {
        await action();
      } catch (error) {
        setMsg("collectorProxyConfigMsg", getErrorMessage(error), false);
      } finally {
        if (button) button.disabled = false;
        if (label && original) label.textContent = original;
      }
    });
  };
  bindAction("btnDiscoverCollectorProxyProducts", "识别中", () => discoverCollectorProxyProducts());
  bindAction("btnApplyCollectorProxyManual", "添加中", addCollectorProxyManualProduct);
  ["rtCollectorProxyApiKey", "rtCollectorProxyApiSecret"].forEach((inputId) => {
    el(inputId)?.addEventListener("input", (event) => {
      const input = event.currentTarget;
      if (String(input.value || "").includes("•")) return;
      input.dataset.collectorProxySaved = "false";
      input.classList.remove("is-saved-runtime-secret");
    });
  });
  el("collectorProxyProductCards")?.addEventListener("click", (event) => {
    const tab = event.target.closest(".collector-proxy-product-tab[data-proxy-id]");
    const del = event.target.closest("[data-delete-proxy-id]");
    const test = event.target.closest("[data-test-proxy-id]");
    const trafficRole = event.target.closest("[data-traffic-role][data-traffic-role-proxy-id]");
    if (trafficRole) {
      event.preventDefault();
      const id = String(trafficRole.dataset.trafficRoleProxyId || "").trim();
      const role = String(trafficRole.dataset.trafficRole || "").trim();
      if (id && ["dynamic", "sticky"].includes(role) && trafficRole.getAttribute("aria-pressed") !== "true") {
        void setCollectorProxyProductTrafficRole(id, role).catch((error) => setMsg("collectorProxyConfigMsg", getErrorMessage(error), false));
      }
      return;
    }
    if (del) {
      event.preventDefault();
      const id = String(del.dataset.deleteProxyId || "").trim();
      if (id) void deleteCollectorProxyManualProduct(id).catch((error) => setMsg("collectorProxyConfigMsg", getErrorMessage(error), false));
      return;
    }
    if (test) {
      event.preventDefault();
      const id = String(test.dataset.testProxyId || "").trim();
      const connectionInput = el("collectorProxyProductCards")?.querySelector(".collector-proxy-product-connection");
      const connection = connectionInput?.dataset.saved === "true" ? "" : String(connectionInput?.value || "").trim();
      if (id) void testCollectorProxyProduct(id, connection).catch((error) => setMsg("collectorProxyConfigMsg", getErrorMessage(error), false));
      return;
    }
    if (tab) {
      const id = String(tab.dataset.proxyId || "").trim();
      if (!id) return;
      adminState.collectorProxySelectedId = id;
      renderCollectorProxyProductCards(adminState.collectorProxyConfig?.products || []);
    }
  });
  el("collectorProxyProductCards")?.addEventListener("change", (event) => {
    const reader = event.target.closest("[data-reader-proxy-id]");
    if (!reader) return;
    const id = String(reader.dataset.readerProxyId || "").trim();
    if (id) void toggleCollectorProxyProductReader(id, reader.checked).catch((error) => {
      reader.checked = !reader.checked;
      setMsg("collectorProxyConfigMsg", getErrorMessage(error), false);
    });
  });
  el("collectorProxyProductCards")?.addEventListener("focusin", (event) => {
    const input = event.target.closest(".collector-proxy-product-connection");
    if (input?.dataset.saved === "true") input.select();
  });
  el("collectorProxyProductCards")?.addEventListener("input", (event) => {
    const input = event.target.closest(".collector-proxy-product-connection");
    if (!input || String(input.value || "") === String(input.dataset.mask || "")) return;
    input.dataset.saved = "false";
  });
}

function initCollectorProxyAdminMerge() {
  if (typeof bindCollectorProxyConfigPanel === "function") bindCollectorProxyConfigPanel();
  if (typeof loadCollectorProxyConfig === "function") void loadCollectorProxyConfig().catch(() => null);
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initCollectorProxyAdminMerge);
else initCollectorProxyAdminMerge();
})();
