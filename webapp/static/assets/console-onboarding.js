(() => {
  "use strict";

  const ONBOARDING_VERSION = "2026.08";
  const ONBOARDING_RELEASE_EPOCH = Date.parse("2026-08-16T16:00:00Z") / 1000;
  const STORAGE_PREFIX = "vecto-console-onboarding";
  const BEACON_LABEL = "查看此功能的新手提示";

  const steps = [
    {
      id: "personas",
      title: "先建立你的人设",
      eyebrow: "第 1 步 · 我的⼈设",
      message: "补充名称、定位和头像，后续生成内容与账号运营都会沿用这套人设。",
      targetSelector: "[data-persona-open-create]",
      entrySelector: '[data-module="personas"]',
    },
    {
      id: "accounts",
      title: "添加并检查平台账号",
      eyebrow: "第 2 步 · 账号管理",
      message: "添加 Threads 或 Instagram 账号，完成登录、代理与两步验证检查。",
      targetSelector: "[data-account-pool-add], [data-persona-manage-account]",
      entrySelector: '[data-workspace-module="accounts"]',
      beaconAnchorSelector: "strong",
    },
    {
      id: "tweet_generation",
      title: "生成第一批推文",
      eyebrow: "第 3 步 · 推文生成",
      message: "选择人设与内容方向，生成草稿后可继续编辑、配图并保存。",
      targetSelector: "[data-persona-generate-posts]",
      entrySelector: '[data-module="tweet_generation"]',
    },
    {
      id: "publishing",
      title: "把内容交给任务流程",
      eyebrow: "第 4 步 · 任务",
      message: "选择发布账号与执行方式，确认后任务会进入队列并由浏览器自动执行。",
      targetSelector: "[data-persona-publish-submit], [data-persona-run-automation]",
      entrySelector: '[data-module="publishing"]',
    },
    {
      id: "persona_dashboard",
      title: "回到看板查看结果",
      eyebrow: "第 5 步 · 人设看板",
      message: "查看内容、发布和互动数据，确认结果后再调整下一轮运营计划。",
      targetSelector: "#btnPersonaDashboardSync",
      entrySelector: '[data-view="persona_dashboard"], [data-workspace-view="persona_dashboard"]',
    },
  ];

  const runtime = {
    user: null,
    storageKey: "",
    eligible: false,
    guided: false,
    currentStep: 0,
    host: null,
    edgeLauncher: null,
    homeLauncher: null,
    observer: null,
    syncFrame: 0,
    cardPositionFrame: 0,
  };

  function storageKey(userId) {
    return `${STORAGE_PREFIX}:${ONBOARDING_VERSION}:${String(userId || "guest")}`;
  }

  function readProgress() {
    if (!runtime.storageKey) return {};
    try {
      return JSON.parse(window.localStorage.getItem(runtime.storageKey) || "{}") || {};
    } catch {
      return {};
    }
  }

  function writeProgress(status, step = runtime.currentStep) {
    if (!runtime.storageKey) return;
    try {
      window.localStorage.setItem(runtime.storageKey, JSON.stringify({
        version: ONBOARDING_VERSION,
        status,
        step,
        updatedAt: Date.now(),
      }));
    } catch {}
  }

  function visibleElement(elements) {
    return elements.find((element) => {
      if (element.hidden || !element.getClientRects().length) return false;
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0
        && rect.height > 0
        && rect.right > 0
        && rect.bottom > 0
        && rect.left < document.documentElement.clientWidth
        && rect.top < document.documentElement.clientHeight;
    }) || null;
  }

  function renderedElement(elements) {
    return elements.find((element) => {
      if (element.hidden || !element.getClientRects().length) return false;
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }) || null;
  }

  function matchingTargets(selector) {
    return Array.from(document.querySelectorAll(selector)).filter((element) => (
      element instanceof HTMLElement && !element.classList.contains("console-onboarding-beacon")
    ));
  }

  function stepTargets(step) {
    return matchingTargets(step.targetSelector);
  }

  function stepEntryTargets(step) {
    return matchingTargets(step.entrySelector);
  }

  function activeStepTarget(step) {
    return renderedElement(stepTargets(step));
  }

  function activeEntryTarget(step) {
    return renderedElement(stepEntryTargets(step));
  }

  function guideTarget(step) {
    return activeStepTarget(step) || activeEntryTarget(step);
  }

  function clearFocus() {
    document.querySelectorAll(".is-onboarding-focus").forEach((element) => {
      element.classList.remove("is-onboarding-focus");
    });
  }

  function releaseBeaconHost(host) {
    if (!(host instanceof HTMLElement) || host.querySelector(":scope > .console-onboarding-beacon")) return;
    host.classList.remove("has-onboarding-beacon");
    if (host.dataset.onboardingPositioned === "true") {
      host.style.removeProperty("position");
      delete host.dataset.onboardingPositioned;
    }
  }

  function removeBeacon(beacon) {
    const host = beacon.parentElement;
    beacon.remove();
    releaseBeaconHost(host);
  }

  function syncBeacons() {
    if (!runtime.eligible) return;
    const progress = readProgress();
    if (!runtime.guided && ["dismissed", "completed"].includes(progress.status)) {
      removeBeacons();
      return;
    }
    steps.forEach((step, index) => {
      const target = activeStepTarget(step);
      const beaconHost = target?.parentElement || null;
      document.querySelectorAll(`.console-onboarding-beacon[data-target-id="${step.id}"]`).forEach((beacon) => {
        if (!beaconHost || beacon.parentElement !== beaconHost) removeBeacon(beacon);
      });
      stepTargets(step).forEach((candidate) => {
        if (candidate !== target) delete candidate.dataset.onboardingTarget;
      });
      if (!target || !beaconHost) return;
      target.dataset.onboardingTarget = step.id;
      beaconHost.classList.add("has-onboarding-beacon");
      if (window.getComputedStyle(beaconHost).position === "static") {
        beaconHost.dataset.onboardingPositioned = "true";
        beaconHost.style.position = "relative";
      }
      const beaconAnchor = step.beaconAnchorSelector
        ? target.querySelector(step.beaconAnchorSelector) || target
        : target;
      const targetRect = beaconAnchor.getBoundingClientRect();
      const hostRect = beaconHost.getBoundingClientRect();
      const beaconLeft = targetRect.right - hostRect.left - 2;
      const beaconTop = targetRect.top - hostRect.top + 2;
      const existing = beaconHost.querySelector(`:scope > .console-onboarding-beacon[data-target-id="${step.id}"]`);
      if (existing) {
        existing.style.setProperty("--onboarding-beacon-left", `${beaconLeft}px`);
        existing.style.setProperty("--onboarding-beacon-top", `${beaconTop}px`);
        return;
      }
      const beacon = document.createElement("button");
      beacon.type = "button";
      beacon.className = "console-onboarding-beacon";
      beacon.dataset.step = String(index);
      beacon.dataset.targetId = step.id;
      beacon.style.setProperty("--onboarding-beacon-left", `${beaconLeft}px`);
      beacon.style.setProperty("--onboarding-beacon-top", `${beaconTop}px`);
      beacon.setAttribute("aria-label", `${BEACON_LABEL}：${step.title}`);
      beacon.title = step.title;
      beacon.innerHTML = '<span aria-hidden="true">!</span>';
      beacon.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openReminder(index);
      });
      beaconHost.appendChild(beacon);
    });
  }

  function scheduleBeaconSync() {
    if (runtime.syncFrame) return;
    runtime.syncFrame = window.requestAnimationFrame(() => {
      runtime.syncFrame = 0;
      syncBeacons();
      syncLaunchers();
      scheduleCardPosition();
    });
  }

  function removeBeacons() {
    document.querySelectorAll(".console-onboarding-beacon").forEach(removeBeacon);
    document.querySelectorAll(".has-onboarding-beacon").forEach((element) => {
      element.classList.remove("has-onboarding-beacon");
      if (element.dataset.onboardingPositioned === "true") {
        element.style.removeProperty("position");
        delete element.dataset.onboardingPositioned;
      }
    });
    document.querySelectorAll("[data-onboarding-target]").forEach((element) => {
      delete element.dataset.onboardingTarget;
    });
  }

  function resumeStep() {
    const progress = readProgress();
    const step = progress.status === "active" ? Number(progress.step || 0) : 0;
    return Math.max(0, Math.min(step, steps.length - 1));
  }

  function launchReminder() {
    runtime.eligible = true;
    openReminder(resumeStep());
  }

  function ensureEdgeLauncher() {
    if (runtime.edgeLauncher?.isConnected) return runtime.edgeLauncher;
    const launcher = document.createElement("button");
    launcher.id = "consoleOnboardingEdgeLauncher";
    launcher.className = "console-onboarding-edge-launcher";
    launcher.type = "button";
    launcher.setAttribute("aria-label", "打开新手提示");
    launcher.title = "新手提示";
    launcher.innerHTML = '<span aria-hidden="true">!</span>';
    launcher.addEventListener("click", launchReminder);
    document.body.appendChild(launcher);
    runtime.edgeLauncher = launcher;
    return launcher;
  }

  function ensureHomeLauncher() {
    const toolbar = document.getElementById("personaDashboardToolbarActions");
    if (!toolbar) return null;
    if (runtime.homeLauncher?.isConnected) return runtime.homeLauncher;
    const launcher = document.createElement("button");
    launcher.id = "consoleOnboardingHomeLauncher";
    launcher.className = "console-onboarding-home-launcher";
    launcher.type = "button";
    launcher.setAttribute("aria-label", "重新查看新手教程");
    launcher.title = "重新查看新手教程";
    launcher.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M4 5.5c2.7-.9 5.3-.4 8 1.3v12c-2.7-1.7-5.3-2.2-8-1.3z"></path>
        <path d="M20 5.5c-2.7-.9-5.3-.4-8 1.3v12c2.7-1.7 5.3-2.2 8-1.3z"></path>
      </svg>
      <span>教程</span>`;
    launcher.addEventListener("click", launchReminder);
    toolbar.insertBefore(launcher, document.getElementById("btnPersonaDashboardSync"));
    runtime.homeLauncher = launcher;
    return launcher;
  }

  function syncLaunchers() {
    if (!runtime.eligible) return;
    const homeLauncher = ensureHomeLauncher();
    if (homeLauncher) homeLauncher.hidden = false;
    const homeLauncherVisible = Boolean(homeLauncher && visibleElement([homeLauncher]));
    ensureEdgeLauncher().hidden = homeLauncherVisible;
  }

  function ensureHost() {
    if (runtime.host?.isConnected) return runtime.host;
    const host = document.createElement("div");
    host.id = "consoleOnboardingSurface";
    host.className = "console-onboarding-surface";
    host.setAttribute("aria-live", "polite");
    host.addEventListener("click", handleSurfaceAction);
    document.body.appendChild(host);
    runtime.host = host;
    return host;
  }

  function closeCard({ keepFocus = false } = {}) {
    const host = ensureHost();
    host.replaceChildren();
    if (!keepFocus) clearFocus();
    runtime.guided = false;
  }

  function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum);
  }

  function positionCard(step = steps[runtime.currentStep] || steps[0]) {
    const card = runtime.host?.querySelector(".console-onboarding-card");
    if (!card) return;
    const target = guideTarget(step);
    const margin = 10;
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const cardRect = card.getBoundingClientRect();
    let left = viewportWidth - cardRect.width - margin;
    let top = viewportHeight - cardRect.height - margin;
    let placement = "floating";
    if (target) {
      const targetRect = target.getBoundingClientRect();
      const desktopSidebarTarget = viewportWidth > 820
        && targetRect.right < 340
        && viewportWidth - targetRect.right > cardRect.width + (margin * 2);
      if (desktopSidebarTarget) {
        left = targetRect.right + margin;
        top = clamp(targetRect.top, margin, viewportHeight - cardRect.height - margin);
        placement = "right";
      } else {
        left = clamp(
          targetRect.left + (targetRect.width / 2) - (cardRect.width / 2),
          margin,
          viewportWidth - cardRect.width - margin,
        );
        const fitsAbove = targetRect.top - cardRect.height - margin >= margin;
        top = fitsAbove
          ? targetRect.top - cardRect.height - margin
          : clamp(targetRect.bottom + margin, margin, viewportHeight - cardRect.height - margin);
        placement = fitsAbove ? "top" : "bottom";
      }
    }
    card.dataset.placement = placement;
    card.style.setProperty("--onboarding-card-left", `${Math.round(left)}px`);
    card.style.setProperty("--onboarding-card-top", `${Math.round(top)}px`);
  }

  function scheduleCardPosition(step = steps[runtime.currentStep] || steps[0]) {
    if (runtime.cardPositionFrame) window.cancelAnimationFrame(runtime.cardPositionFrame);
    runtime.cardPositionFrame = window.requestAnimationFrame(() => {
      runtime.cardPositionFrame = 0;
      positionCard(step);
    });
  }

  function openReminder(index = 0) {
    const step = steps[index] || steps[0];
    runtime.currentStep = steps.indexOf(step);
    runtime.guided = false;
    clearFocus();
    guideTarget(step)?.classList.add("is-onboarding-focus");
    const host = ensureHost();
    host.innerHTML = `
      <section class="console-onboarding-card is-reminder" role="dialog" aria-modal="false" aria-labelledby="consoleOnboardingTitle">
        <button type="button" class="console-onboarding-close" data-onboarding-close aria-label="关闭提示">×</button>
        <div class="console-onboarding-kicker">提示 ${runtime.currentStep + 1}/${steps.length}</div>
        <h2 id="consoleOnboardingTitle">${step.title}</h2>
        <p>${step.message}</p>
        <div class="console-onboarding-actions">
          <button type="button" class="is-quiet" data-onboarding-close>稍后</button>
          <button type="button" class="is-secondary" data-onboarding-jump>前往</button>
          <button type="button" class="is-primary" data-onboarding-start>开始</button>
        </div>
        <button type="button" class="console-onboarding-dismiss" data-onboarding-dismiss>不再提示</button>
      </section>`;
    scheduleCardPosition(step);
  }

  function waitForStepTarget(step, timeoutMs = 2400) {
    const startedAt = window.performance.now();
    return new Promise((resolve) => {
      const inspect = () => {
        const target = activeStepTarget(step);
        if (target || window.performance.now() - startedAt >= timeoutMs) {
          resolve(target);
          return;
        }
        window.setTimeout(inspect, 80);
      };
      inspect();
    });
  }

  function focusStepTarget(step, target) {
    if (!target) return;
    clearFocus();
    target.classList.add("is-onboarding-focus");
    target.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    scheduleBeaconSync();
    scheduleCardPosition(step);
  }

  function navigateToStep(index, { render = true } = {}) {
    const step = steps[index] || steps[0];
    runtime.currentStep = steps.indexOf(step);
    clearFocus();
    const target = activeStepTarget(step);
    if (target) {
      focusStepTarget(step, target);
    } else {
      activeEntryTarget(step)?.click();
      waitForStepTarget(step).then((nextTarget) => {
        focusStepTarget(step, nextTarget || activeEntryTarget(step));
      });
    }
    if (render) renderGuideStep(runtime.currentStep);
  }

  function renderGuideStep(index = 0) {
    const step = steps[index] || steps[0];
    runtime.currentStep = steps.indexOf(step);
    runtime.guided = true;
    writeProgress("active", runtime.currentStep);
    const last = runtime.currentStep === steps.length - 1;
    const host = ensureHost();
    host.innerHTML = `
      <section class="console-onboarding-card is-guide" role="dialog" aria-modal="false" aria-labelledby="consoleOnboardingTitle">
        <button type="button" class="console-onboarding-close" data-onboarding-exit aria-label="关闭教程">×</button>
        <div class="console-onboarding-step-head">
          <div class="console-onboarding-kicker">${step.eyebrow}</div>
          <strong>${runtime.currentStep + 1}/${steps.length}</strong>
        </div>
        <h2 id="consoleOnboardingTitle">${step.title}</h2>
        <p>${step.message}</p>
        <div class="console-onboarding-actions">
          ${runtime.currentStep > 0 ? '<button type="button" class="is-quiet" data-onboarding-prev>上一步</button>' : '<button type="button" class="is-quiet" data-onboarding-exit>退出</button>'}
          <button type="button" class="is-primary" ${last ? "data-onboarding-complete" : "data-onboarding-next"}>${last ? "完成教程" : "下一步"}</button>
        </div>
      </section>`;
    scheduleCardPosition(step);
  }

  function startGuide(index = 0) {
    runtime.eligible = true;
    navigateToStep(Math.max(0, Math.min(index, steps.length - 1)));
    syncBeacons();
  }

  function exitGuide() {
    writeProgress("dismissed", runtime.currentStep);
    closeCard();
    removeBeacons();
    syncLaunchers();
  }

  function renderCompletionNotice() {
    runtime.guided = false;
    clearFocus();
    const host = ensureHost();
    host.innerHTML = `
      <section class="console-onboarding-card is-completion" role="dialog" aria-modal="false" aria-labelledby="consoleOnboardingCompleteTitle">
        <button type="button" class="console-onboarding-close" data-onboarding-close aria-label="关闭完成提示">×</button>
        <div class="console-onboarding-kicker">教程完成</div>
        <h2 id="consoleOnboardingCompleteTitle">已完成全部提示</h2>
        <p>以后可在首页标题栏的“教程”按钮重新查看。</p>
        <div class="console-onboarding-actions">
          <button type="button" class="is-quiet" data-onboarding-close>知道了</button>
          <button type="button" class="is-primary" data-onboarding-locate>查看位置</button>
        </div>
      </section>`;
    scheduleCardPosition(steps[steps.length - 1]);
  }

  function locateHomeLauncher() {
    const homeStep = steps[steps.length - 1];
    activeEntryTarget(homeStep)?.click();
    closeCard();
    window.setTimeout(() => {
      const launcher = ensureHomeLauncher();
      if (!launcher) return;
      launcher.hidden = false;
      launcher.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
      launcher.classList.add("is-located");
      launcher.focus({ preventScroll: true });
      window.setTimeout(() => launcher.classList.remove("is-located"), 1600);
    }, 220);
  }

  function completeGuide() {
    writeProgress("completed", steps.length - 1);
    removeBeacons();
    syncLaunchers();
    runtime.homeLauncher?.classList.add("is-complete");
    window.setTimeout(() => runtime.homeLauncher?.classList.remove("is-complete"), 700);
    renderCompletionNotice();
  }

  function handleSurfaceAction(event) {
    const action = event.target.closest("button");
    if (!action) return;
    if (action.hasAttribute("data-onboarding-close")) {
      closeCard();
      return;
    }
    if (action.hasAttribute("data-onboarding-dismiss") || action.hasAttribute("data-onboarding-exit")) {
      exitGuide();
      return;
    }
    if (action.hasAttribute("data-onboarding-jump")) {
      navigateToStep(runtime.currentStep, { render: false });
      closeCard();
      return;
    }
    if (action.hasAttribute("data-onboarding-start")) {
      startGuide(runtime.currentStep);
      return;
    }
    if (action.hasAttribute("data-onboarding-prev")) {
      navigateToStep(runtime.currentStep - 1);
      return;
    }
    if (action.hasAttribute("data-onboarding-next")) {
      navigateToStep(runtime.currentStep + 1);
      return;
    }
    if (action.hasAttribute("data-onboarding-locate")) {
      locateHomeLauncher();
      return;
    }
    if (action.hasAttribute("data-onboarding-complete")) completeGuide();
  }

  function isNewUser(user) {
    if (!user || user.is_admin || user.acting_admin) return false;
    return Number(user.created_at || 0) >= ONBOARDING_RELEASE_EPOCH;
  }

  function observeNavigation() {
    runtime.observer?.disconnect();
    runtime.observer = new MutationObserver(scheduleBeaconSync);
    runtime.observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", scheduleBeaconSync, { passive: true });
    window.addEventListener("scroll", () => scheduleCardPosition(), { passive: true, capture: true });
  }

  async function loadCurrentUser() {
    const response = await window.fetch("/api/me", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error("console onboarding identity unavailable");
    return response.json();
  }

  function waitForConsoleReady() {
    if (document.body.classList.contains("is-console-ready")) return Promise.resolve();
    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        if (!document.body.classList.contains("is-console-ready")) return;
        observer.disconnect();
        resolve();
      });
      observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    });
  }

  async function init() {
    await waitForConsoleReady();
    const user = await loadCurrentUser();
    if (user.is_admin || user.acting_admin) return;
    runtime.user = user;
    runtime.storageKey = storageKey(user.id);
    runtime.eligible = isNewUser(user);
    if (!runtime.eligible) return;
    observeNavigation();
    syncLaunchers();
    syncBeacons();
  }

  window.VectoConsoleOnboarding = Object.freeze({
    open: () => openReminder(0),
    start: (step = 0) => startGuide(Number(step) || 0),
    close: () => closeCard(),
    steps: steps.map(({ id, title }) => ({ id, title })),
  });

  init().catch(() => {});
})();
