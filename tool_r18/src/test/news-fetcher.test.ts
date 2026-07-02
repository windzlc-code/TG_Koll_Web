import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchTrendingTopics, getTodayTrendIntel } from "@/lib/news-fetcher";

describe("news-fetcher daily persona cache", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    vi.setSystemTime(new Date("2026-05-11T08:00:00+08:00"));
    (window as any).electronAPI = {
      news: {
        fetch: vi.fn(async ({ mode }: { mode: string }) => ({
          ok: true,
          text: `${mode} intel`,
        })),
      },
    };
  });

  it("reuses today's persona intel without fetching again", async () => {
    const first = await fetchTrendingTopics(["美食創作者"], "cn", "persona-1", "美食創作者");

    expect(first).toContain("news intel");
    expect((window as any).electronAPI.news.fetch).toHaveBeenCalledTimes(3);
    expect(getTodayTrendIntel("persona-1")?.text).toBe(first);

    const second = await fetchTrendingTopics(["另一個題材"], "cn", "persona-1", "美食創作者");

    expect(second).toBe(first);
    expect((window as any).electronAPI.news.fetch).toHaveBeenCalledTimes(3);
  });

  it("bypassCache forces a new fetch even when today's persona intel exists", async () => {
    await fetchTrendingTopics(["美食創作者"], "cn", "persona-1", "美食創作者");
    await fetchTrendingTopics(["美食創作者"], "cn", "persona-1", "美食創作者", undefined, undefined, { bypassCache: true });

    expect((window as any).electronAPI.news.fetch).toHaveBeenCalledTimes(6);
  });
});
