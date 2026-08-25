import { useCallback, useEffect, useRef, useState } from "react";
import { crmApi, taskItems } from "./api";
import { createSinglePollScheduler, isModulePolicyError, mergeCursorPage, mergePolledItems } from "./runtime-helpers.js";
import type { CrmTask } from "./types";

type TaskPayload = Awaited<ReturnType<typeof crmApi.tasks>>;

function nextCursor(payload: TaskPayload) {
  return Array.isArray(payload) ? "" : String(payload.next_cursor || "");
}

export function useTaskPolling(seed: CrmTask[] | undefined, onPolicyFailure: () => void, enabled = true) {
  const [tasks, setTasks] = useState<CrmTask[]>(seed || []);
  const [pollError, setPollError] = useState(false);
  const [cursor, setCursor] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const failures = useRef(0);
  const mounted = useRef(true);
  const loadedExtraPages = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const payload = await crmApi.tasks("", 50);
      if (!mounted.current) return;
      const incoming = taskItems(payload);
      setTasks((current) => mergePolledItems(current, incoming) as CrmTask[]);
      if (!loadedExtraPages.current) setCursor(nextCursor(payload));
      failures.current = 0;
      setPollError(false);
    } catch (error) {
      if (!mounted.current) return;
      failures.current += 1;
      setPollError(true);
      if (isModulePolicyError(error)) onPolicyFailure();
    }
  }, [onPolicyFailure]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const payload = await crmApi.tasks(cursor, 50);
      if (!mounted.current) return;
      loadedExtraPages.current = true;
      setTasks((current) => mergeCursorPage(current, taskItems(payload)) as CrmTask[]);
      setCursor(nextCursor(payload));
      setPollError(false);
    } catch (error) {
      if (!mounted.current) return;
      setPollError(true);
      if (isModulePolicyError(error)) onPolicyFailure();
    } finally {
      if (mounted.current) setLoadingMore(false);
    }
  }, [cursor, loadingMore, onPolicyFailure]);

  useEffect(() => {
    if (seed) setTasks((current) => mergePolledItems(current, seed) as CrmTask[]);
  }, [seed]);

  useEffect(() => {
    if (!enabled) return;
    mounted.current = true;
    const scheduler = createSinglePollScheduler({
      run: refresh,
      getDelay: () => {
        const base = document.visibilityState === "visible" ? 8_000 : 20_000;
        return Math.min(60_000, base * Math.max(1, 2 ** failures.current));
      },
    });
    scheduler.start();
    const onVisibility = () => { void scheduler.trigger(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      mounted.current = false;
      scheduler.stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, refresh]);

  return { tasks, pollError, refresh, loadMore, hasMore: Boolean(cursor), loadingMore };
}
