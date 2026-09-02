import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { crmApi, taskItems } from "./api";
import { createSinglePollScheduler, isModulePolicyError, mergeCursorPage, mergePolledItems } from "./runtime-helpers.js";
import type { CrmTask } from "./types";

type TaskPayload = Awaited<ReturnType<typeof crmApi.tasks>>;

function nextCursor(payload: TaskPayload, requestedCursor = "") {
  if (Array.isArray(payload) || payload.has_more === false) return "";
  const next = String(payload.next_cursor || "");
  return requestedCursor && next === requestedCursor ? "" : next;
}

export function useTaskPolling(seed: CrmTask[] | undefined, onPolicyFailure: () => void, enabled = true, seedPage?: { next_cursor?: string | null; has_more?: boolean }) {
  const [tasks, setTasks] = useState<CrmTask[]>(seed || []);
  const [pollError, setPollError] = useState(false);
  const [cursor, setCursor] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const [paginationStarted, setPaginationStarted] = useState(false);
  const failures = useRef(0);
  const mounted = useRef(true);
  const loadedExtraPages = useRef(false);
  const loadMoreInFlight = useRef(false);

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
    if (!cursor || loadMoreInFlight.current) return;
    const requestedCursor = cursor;
    loadMoreInFlight.current = true;
    setLoadingMore(true);
    setLoadMoreError(false);
    setPaginationStarted(true);
    try {
      const payload = await crmApi.tasks(requestedCursor, 50);
      if (!mounted.current) return;
      loadedExtraPages.current = true;
      setTasks((current) => mergeCursorPage(current, taskItems(payload)) as CrmTask[]);
      setCursor(nextCursor(payload, requestedCursor));
    } catch (error) {
      if (!mounted.current) return;
      setLoadMoreError(true);
      if (isModulePolicyError(error)) onPolicyFailure();
    } finally {
      loadMoreInFlight.current = false;
      if (mounted.current) setLoadingMore(false);
    }
  }, [cursor, onPolicyFailure]);

  useLayoutEffect(() => {
    if (seed) setTasks((current) => mergePolledItems(current, seed) as CrmTask[]);
    if (seedPage) setCursor(seedPage.has_more === false ? "" : String(seedPage.next_cursor || ""));
  }, [seed, seedPage?.has_more, seedPage?.next_cursor]);

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

  return { tasks, pollError, refresh, loadMore, hasMore: Boolean(cursor), loadingMore, loadMoreError, paginationStarted };
}
