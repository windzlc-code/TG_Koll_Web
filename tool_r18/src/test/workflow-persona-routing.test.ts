import { describe, expect, it } from "vitest";
import { shouldUseWorkflowPersonaImage } from "@/lib/persona-image-search";

describe("shouldUseWorkflowPersonaImage", () => {
  const setup = {
    imageWorkflow: {
      provider: "comfyui",
      workflowFile: "persona.json",
    },
    contentTheme: "空服員穿搭與日常",
    personaDescription: "25 歲女性，自拍感生活照",
  } as any;

  it("keeps workflow enabled when person-focused signals coexist with cafe or lifestyle words", () => {
    expect(shouldUseWorkflowPersonaImage("今天在咖啡店自拍了一張制服穿搭照，想記錄下班後的樣子", setup)).toBe(true);
  });

  it("disables workflow for scenery-only content without a visible protagonist", () => {
    expect(shouldUseWorkflowPersonaImage("今天只想拍咖啡店窗邊、桌面和甜點，畫面裡不出現人", setup)).toBe(false);
  });
});
