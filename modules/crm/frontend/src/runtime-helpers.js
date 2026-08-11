// Small framework-free helpers used by the React runtime and executable tests.

export function recordKey(item) {
  return String(item?.task_id || item?.id || "");
}

export function mergeCursorPage(existing, incoming, reset = false) {
  const result = [];
  const seen = new Set();
  const source = reset ? incoming : [...existing, ...incoming];
  for (const item of source) {
    const key = recordKey(item);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    result.push(item);
  }
  return result;
}

export function mergePolledItems(existing, incoming) {
  const incomingById = new Map(incoming.map((item) => [recordKey(item), item]));
  const result = incoming.slice();
  const seen = new Set(incoming.map(recordKey).filter(Boolean));
  for (const oldItem of existing) {
    const key = recordKey(oldItem);
    if (key && incomingById.has(key)) continue;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    result.push(oldItem);
  }
  return result;
}

export function isModulePolicyError(error) {
  const status = Number(error?.status || 0);
  const code = String(error?.body?.code || error?.code || "");
  return status === 403 || status === 423 || code.startsWith("crm_module_") || code === "crm_account_disabled";
}

export function createSinglePollScheduler({ run, getDelay, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null;
  let inFlight = null;
  let rerun = false;
  let stopped = false;

  const clearScheduled = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  const schedule = () => {
    if (stopped || inFlight) return;
    clearScheduled();
    timer = setTimer(() => { void trigger(); }, getDelay());
  };

  const trigger = () => {
    if (stopped) return Promise.resolve();
    clearScheduled();
    if (inFlight) {
      rerun = true;
      return inFlight;
    }
    inFlight = Promise.resolve().then(run).finally(() => {
      inFlight = null;
      if (stopped) return;
      if (rerun) {
        rerun = false;
        void trigger();
      } else {
        schedule();
      }
    });
    return inFlight;
  };

  return {
    start: schedule,
    trigger,
    stop() {
      stopped = true;
      rerun = false;
      clearScheduled();
    },
  };
}
