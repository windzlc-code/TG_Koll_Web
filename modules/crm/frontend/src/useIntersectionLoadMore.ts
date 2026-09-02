import { useEffect, useRef } from "react";

type IntersectionLoadMoreOptions = {
  enabled: boolean;
  loading: boolean;
  onLoadMore: () => void | Promise<void>;
};

export function useIntersectionLoadMore({ enabled, loading, onLoadMore }: IntersectionLoadMoreOptions) {
  const sentinelRef = useRef<HTMLSpanElement>(null);
  const onLoadMoreRef = useRef(onLoadMore);
  const supported = typeof window !== "undefined" && "IntersectionObserver" in window;

  useEffect(() => { onLoadMoreRef.current = onLoadMore; }, [onLoadMore]);
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!enabled || loading || !supported || !sentinel) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void onLoadMoreRef.current();
    }, { root: null, rootMargin: "240px 0px", threshold: 0.01 });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [enabled, loading, supported]);

  return { sentinelRef, supported };
}
