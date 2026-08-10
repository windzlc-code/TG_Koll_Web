import { describe, expect, it } from "vitest";

import {
  instagramMediaPkFromShortcode,
  parseInstagramPostHotMetricPayload,
} from "./sentiment-hot-importer.js";

describe("Instagram published post metric lookup", () => {
  it("converts a published shortcode into the exact media primary key", () => {
    expect(instagramMediaPkFromShortcode("Dbxft0dmYdw")).toBe("3959085035584849776");
  });

  it("keeps the published URL identity while parsing real post metrics", () => {
    const sourceUrl = "https://www.instagram.com/p/Dbxft0dmYdw/";
    const metric = parseInstagramPostHotMetricPayload({
      sourceUrl,
      refreshedAt: "2026-08-08T11:00:00.000Z",
      payload: {
        items: [{
          pk: "3959085035584849776",
          code: "Dbxft0dmYdw",
          caption: { text: "published caption" },
          taken_at: 1786179751,
          like_count: 12,
          comment_count: 3,
          content_views_count: 456,
        }],
      },
    });

    expect(metric).toEqual(expect.objectContaining({
      pk: "3959085035584849776",
      code: "Dbxft0dmYdw",
      sourceUrl,
      likeCount: 12,
      commentCount: 3,
      viewCount: 456,
    }));
  });

  it("does not turn a missing image-post view field into a real zero", () => {
    const metric = parseInstagramPostHotMetricPayload({
      sourceUrl: "https://www.instagram.com/p/ImagePost/",
      refreshedAt: "2026-08-10T11:00:00.000Z",
      payload: {
        items: [{
          pk: "123",
          code: "ImagePost",
          like_count: 2,
          comment_count: 1,
        }],
      },
    });

    expect(metric?.viewCount).toBeUndefined();
  });
});
