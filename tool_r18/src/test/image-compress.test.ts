import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { compressImage } from "@/lib/image-compress";
import { parseDataUrlMedia } from "@/lib/media-utils";

async function makePngDataUrl(width: number, height: number): Promise<string> {
  const png = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 238, g: 198, b: 176 },
    },
  })
    .png()
    .composite([
      {
        input: await sharp({
          create: {
            width: Math.floor(width * 0.6),
            height: Math.floor(height * 0.55),
            channels: 3,
            background: { r: 92, g: 66, b: 48 },
          },
        }).png().toBuffer(),
        left: Math.floor(width * 0.2),
        top: Math.floor(height * 0.2),
      },
    ])
    .toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

describe("image compression", () => {
  it("compresses image data URLs before chunk upload", async () => {
    const source = await makePngDataUrl(1600, 1600);
    const compressed = await compressImage(source, { targetBytes: 96 * 1024, maxDim: 960, minQuality: 0.24 });
    const parsed = parseDataUrlMedia(compressed);

    expect(parsed?.mimeType).toBe("image/jpeg");
    expect(Buffer.byteLength(parsed?.base64 ?? "", "base64")).toBeLessThanOrEqual(96 * 1024);
    expect(compressed.length).toBeLessThan(source.length);
  });

  it("leaves non-data URLs untouched", async () => {
    await expect(
      compressImage("https://example.com/image.png", { targetBytes: 1024 }),
    ).resolves.toBe("https://example.com/image.png");
  });
});
