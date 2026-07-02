import { describe, expect, it } from "vitest";
import { getEpisodeMediaKind, getMediaExtension, isVideoMediaUrl, parseDataUrlMedia } from "@/lib/media-utils";

describe("media utils", () => {
  it("detects image media as image", () => {
    expect(getEpisodeMediaKind("data:image/png;base64,abc")).toBe("image");
  });

  it("detects video media as video", () => {
    expect(isVideoMediaUrl("data:video/mp4;base64,abc")).toBe(true);
    expect(isVideoMediaUrl("https://cdn.example.com/demo.webm")).toBe(true);
    expect(getEpisodeMediaKind("data:video/mp4;base64,abc")).toBe("video");
  });

  it("returns none when missing media", () => {
    expect(getEpisodeMediaKind(undefined)).toBe("none");
  });

  it("parses data URLs and infers the right extension for images and videos", () => {
    expect(parseDataUrlMedia("data:image/png;base64,abc")).toEqual({
      mimeType: "image/png",
      base64: "abc",
    });
    expect(getMediaExtension("data:image/png;base64,abc")).toBe("png");
    expect(getMediaExtension("data:video/mp4;base64,abc")).toBe("mp4");
    expect(getMediaExtension("https://cdn.example.com/demo.mov?token=1")).toBe("mov");
  });
});
