import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createTask: vi.fn(),
  waitOutputs: vi.fn(),
  resolveConfig: vi.fn(),
  readRuntimeConfig: vi.fn(),
}));

vi.mock("@/runtime/node/runninghub-client", () => ({
  createRunningHubAiAppTask: vi.fn(),
  createRunningHubStandardModelTask: mocks.createTask,
  getRunningHubAiAppCallDemo: vi.fn(),
  resolveRunningHubConfig: mocks.resolveConfig,
  waitRunningHubOpenApiV2TaskOutputs: mocks.waitOutputs,
  waitRunningHubTaskOutputs: vi.fn(),
}));

vi.mock("@/runtime/node/config", () => ({
  readRuntimeApiConfig: mocks.readRuntimeConfig,
}));

import { generateRunningHubNewPersonaStandardImage } from "@/runtime/node/runninghub-persona-image";

describe("RunningHub persona image channel routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveConfig.mockReturnValue({ apiKey: "test-key", baseUrl: "https://example.com" });
    mocks.readRuntimeConfig.mockReturnValue({
      newPersonaRunningHubPersonaTextToImageEndpoint: "/persona-text-to-image",
      newPersonaRunningHubTweetImageToImageEndpoint: "/tweet-image-to-image",
    });
    mocks.createTask.mockResolvedValue({ taskId: "task-1" });
    mocks.waitOutputs.mockResolvedValue([{ url: "https://example.com/output.png" }]);
  });

  it("uses only the persona text-to-image endpoint for standard persona images", async () => {
    const result = await generateRunningHubNewPersonaStandardImage({
      prompt: "character reference sheet, three views",
      mode: "text-to-image",
      aspectRatio: "1:1",
    });

    expect(result.ok).toBe(true);
    expect(mocks.createTask).toHaveBeenCalledWith(
      expect.anything(),
      "/persona-text-to-image",
      expect.not.objectContaining({ imageUrls: expect.anything() }),
    );
  });

  it("reserves the tweet image-to-image endpoint for explicit reference edits", async () => {
    const result = await generateRunningHubNewPersonaStandardImage({
      prompt: "replace the background",
      mode: "image-to-image",
      aspectRatio: "1:1",
      referenceImage: "data:image/png;base64,cmVmZXJlbmNl",
    });

    expect(result.ok).toBe(true);
    expect(mocks.createTask).toHaveBeenCalledWith(
      expect.anything(),
      "/tweet-image-to-image",
      expect.objectContaining({ imageUrls: ["data:image/png;base64,cmVmZXJlbmNl"] }),
    );
  });
});
