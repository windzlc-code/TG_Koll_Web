import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../plugins/sentiment/scrapers/concurrency.js";

describe("scraper concurrency utilities", () => {
  it("runs keyword jobs with a bounded concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
      return value * 2;
    });

    expect(results).toEqual([2, 4, 6, 8, 10]);
    expect(maxActive).toBe(2);
  });
});
