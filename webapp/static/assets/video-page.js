(() => {
  const MODULES = [
    { id: "digital_human_video", label: "数字人口播视频" },
    { id: "ecommerce_short_video", label: "广告 / 种草视频" },
    { id: "video_language_replace", label: "视频语种更换" },
    { id: "video_subject_replace", label: "视频模特 / 商品替换" },
    { id: "ecommerce_image", label: "电商广告图" },
    { id: "subject_replace", label: "人物 / 商品替换" },
    { id: "poster_translate", label: "电商图语种切换" },
    { id: "subject_generate", label: "主体生成" },
  ];

  const params = new URLSearchParams(window.location.search);
  const requested = String(params.get("video_module") || "");
  let activeModule = MODULES.some((item) => item.id === requested) ? requested : MODULES[0].id;

  function syncRoute(moduleId) {
    const url = new URL(window.location.href);
    url.searchParams.set("video_module", moduleId);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }

  function syncActive() {
    document.querySelectorAll("[data-video-module]").forEach((button) => {
      const isActive = button.dataset.videoModule === activeModule;
      button.classList.toggle("is-active", isActive);
      if (isActive) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
  }

  function renderMenu() {
    const host = document.getElementById("videoModuleMenu");
    if (!host) return;
    const groups = [
      { label: "视频生成", items: MODULES.slice(0, 4) },
      { label: "图片素材", items: MODULES.slice(4) },
    ];
    host.innerHTML = groups.map((group) => `<div class="module-accordion video-module-group">
      <div class="video-module-group-label">${group.label}</div>
      ${group.items.map((item) => `
        <div class="module-accordion-item">
          <button type="button" class="module-trigger" data-video-module="${item.id}">
            <span class="module-trigger-text"><span>${item.label}</span></span>
          </button>
        </div>`).join("")}
    </div>`).join("");
    syncActive();
  }

  function setMobileNavOpen(open) {
    document.body.classList.toggle("mobile-nav-open", open);
    const toggle = document.getElementById("mobileNavToggle");
    const backdrop = document.getElementById("consoleNavBackdrop");
    if (toggle) toggle.setAttribute("aria-expanded", open ? "true" : "false");
    if (backdrop) backdrop.hidden = !open;
  }

  function bind() {
    document.getElementById("mobileNavToggle")?.addEventListener("click", () => {
      setMobileNavOpen(!document.body.classList.contains("mobile-nav-open"));
    });
    document.getElementById("mobileNavClose")?.addEventListener("click", () => setMobileNavOpen(false));
    document.getElementById("consoleNavBackdrop")?.addEventListener("click", () => setMobileNavOpen(false));
    document.getElementById("videoModuleMenu")?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-video-module]");
      if (!button) return;
      const moduleId = String(button.dataset.videoModule || "");
      if (!MODULES.some((item) => item.id === moduleId)) return;
      activeModule = moduleId;
      syncRoute(moduleId);
      syncActive();
      window.VideoWorkbench?.selectModule?.(moduleId);
      setMobileNavOpen(false);
    });
  }

  function revealAdminBanner() {
    const meta = document.querySelector('meta[name="admin-workspace-user-id"]');
    const workspaceId = String(meta?.content || "").trim();
    const banner = document.getElementById("adminWorkspaceBanner");
    if (!banner || !workspaceId) return;
    banner.hidden = false;
  }

  bind();
  renderMenu();
  revealAdminBanner();
  syncRoute(activeModule);
  window.VideoWorkbench?.activate?.({ moduleId: activeModule });
})();
