(() => {
  const MODULES = [
    { id: "digital_human_video", label: "数字人口播视频" },
    { id: "ecommerce_short_video", label: "广告短视频" },
    { id: "video_language_replace", label: "视频语种更换" },
    { id: "video_subject_replace", label: "视频模特 / 商品替换" },
    { id: "ecommerce_image", label: "电商广告图" },
    { id: "subject_replace", label: "人物 / 商品替换" },
    { id: "poster_translate", label: "电商图语种切换" },
    { id: "subject_generate", label: "主体生成" },
  ];
  const STUDIO_MODULE = { id: "video_editor", label: "视频记录与剪辑" };
  const NAV_ITEMS = [...MODULES, STUDIO_MODULE];

  const params = new URLSearchParams(window.location.search);
  const requested = String(params.get("video_module") || "");
  let activeStudioTab = requested === "video_records"
    ? "records"
    : (requested === STUDIO_MODULE.id
      ? (params.get("video_tab") === "records" ? "records" : "editor")
      : (params.get("video_tab") === "editor" ? "editor" : "records"));
  let activeModule = requested === "video_records"
    ? STUDIO_MODULE.id
    : (NAV_ITEMS.some((item) => item.id === requested) ? requested : MODULES[0].id);

  function syncRoute(moduleId, studioTab = activeStudioTab) {
    const url = new URL(window.location.href);
    url.searchParams.set("video_module", moduleId);
    if (moduleId === STUDIO_MODULE.id) url.searchParams.set("video_tab", studioTab);
    else url.searchParams.delete("video_tab");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }

  function syncActive() {
    document.querySelectorAll("[data-video-module]").forEach((button) => {
      const isActive = button.dataset.videoModule === activeModule;
      button.classList.toggle("is-active", isActive);
      if (isActive) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    const studioActive = activeModule === STUDIO_MODULE.id;
    const generating = !studioActive;
    const generationPanel = document.getElementById("videoGenerationPanel");
    const studioPanel = document.getElementById("videoStudioPanel");
    if (generationPanel) {
      generationPanel.hidden = !generating;
      generationPanel.classList.toggle("is-active", generating);
    }
    if (studioPanel) {
      studioPanel.hidden = !studioActive;
      studioPanel.classList.toggle("is-active", studioActive);
    }
    const title = NAV_ITEMS.find((item) => item.id === activeModule)?.label || "视频工作台";
    const viewTitle = document.getElementById("viewTitle");
    const mobileTitle = document.getElementById("mobilePageToolbarTitle");
    if (viewTitle) viewTitle.textContent = title;
    if (mobileTitle) mobileTitle.textContent = title;
  }

  function renderMenu() {
    const host = document.getElementById("videoModuleMenu");
    if (!host) return;
    const groups = [
      { label: "视频生成", items: MODULES.slice(0, 4) },
      { label: "图片素材", items: MODULES.slice(4) },
      { label: "视频资产", items: [STUDIO_MODULE] },
    ];
    host.innerHTML = groups.map((group) => `<section class="video-primary-nav-group" aria-label="${group.label}">
      <div class="video-module-group-label">${group.label}</div>
      ${group.items.map((item) => `
        <div class="video-primary-nav-item">
          <button type="button" class="module-trigger video-primary-nav-button" data-video-module="${item.id}">
            <span class="module-trigger-text"><span>${item.label}</span></span>
          </button>
        </div>`).join("")}
    </section>`).join("");
    syncActive();
  }

  function isGenerationModule(moduleId) {
    return MODULES.some((item) => item.id === moduleId);
  }

  function showStudioTab(tab, options = {}) {
    activeStudioTab = tab === "records" ? "records" : "editor";
    document.querySelectorAll("[data-studio-tab]").forEach((button) => {
      const selected = button.dataset.studioTab === activeStudioTab;
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-selected", selected ? "true" : "false");
      button.tabIndex = selected ? 0 : -1;
    });
    document.querySelectorAll("[data-studio-page]").forEach((panel) => {
      const selected = panel.dataset.studioPage === activeStudioTab;
      panel.hidden = !selected;
      panel.classList.toggle("is-active", selected);
    });
    syncRoute(STUDIO_MODULE.id, activeStudioTab);
    if (activeStudioTab === "records") {
      window.VideoEditor?.deactivate?.();
      window.VideoRecords?.activate?.();
    } else {
      window.VideoRecords?.deactivate?.();
      window.VideoEditor?.activate?.({ assetId: String(options.assetId || "") });
    }
    return true;
  }

  function navigate(moduleId, options = {}) {
    if (moduleId === "video_records") {
      moduleId = STUDIO_MODULE.id;
      options = { ...options, tab: "records" };
    }
    if (!NAV_ITEMS.some((item) => item.id === moduleId)) return false;
    const previous = activeModule;
    const leavingGeneration = isGenerationModule(previous) && !isGenerationModule(moduleId);
    if (leavingGeneration && window.VideoWorkbench?.confirmLeave && !window.VideoWorkbench.confirmLeave()) return false;
    activeModule = moduleId;
    syncActive();
    if (isGenerationModule(moduleId)) {
      syncRoute(moduleId);
      window.VideoRecords?.deactivate?.();
      window.VideoEditor?.deactivate?.();
      if (isGenerationModule(previous)) window.VideoWorkbench?.selectModule?.(moduleId);
      else window.VideoWorkbench?.activate?.({ moduleId });
    } else {
      window.VideoWorkbench?.deactivate?.();
      showStudioTab(options.tab || activeStudioTab, options);
    }
    setMobileNavOpen(false);
    return true;
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
      if (!NAV_ITEMS.some((item) => item.id === moduleId)) return;
      navigate(moduleId);
    });
    document.getElementById("videoStudioTabs")?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-studio-tab]");
      if (!button || activeModule !== STUDIO_MODULE.id) return;
      showStudioTab(button.dataset.studioTab);
    });
    document.getElementById("videoStudioTabs")?.addEventListener("keydown", (event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || activeModule !== STUDIO_MODULE.id) return;
      event.preventDefault();
      const nextTab = activeStudioTab === "records" ? "editor" : "records";
      showStudioTab(nextTab);
      document.querySelector(`[data-studio-tab="${nextTab}"]`)?.focus();
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
  if (activeModule === STUDIO_MODULE.id) {
    syncActive();
    window.VideoWorkbench?.deactivate?.();
    showStudioTab(activeStudioTab);
  } else {
    syncRoute(activeModule);
    window.VideoWorkbench?.activate?.({ moduleId: activeModule });
  }
  window.VideoPage = { navigate, showStudioTab };
})();
