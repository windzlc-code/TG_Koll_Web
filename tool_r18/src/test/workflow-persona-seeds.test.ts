import { describe, expect, it } from "vitest";

import { WORKFLOW_PERSONA_SEEDS } from "@/lib/workflow-personas";

describe("workflow persona seed classification", () => {
  it("marks female workflow personas as girl personas so workflow image generation uses the girl prompt path", () => {
    const expectedGirlIds = new Set([
      "workflow-persona-jinjunya",
      "workflow-persona-xiangwanwan",
      "workflow-persona-xiaomii",
      "workflow-persona-f1",
      "workflow-persona-cute-jp",
      "workflow-persona-yoga",
      "workflow-persona-aunt50",
    ]);

    const actualGirlIds = new Set(
      WORKFLOW_PERSONA_SEEDS.filter((seed) => seed.setup.isGirlPersona).map((seed) => seed.id),
    );

    expect(actualGirlIds).toEqual(expectedGirlIds);
  });

  it("routes Jin Junya through direct ComfyUI execution to match the original workflow environment", () => {
    const jinjunya = WORKFLOW_PERSONA_SEEDS.find((seed) => seed.id === "workflow-persona-jinjunya");

    expect(jinjunya?.setup.imageWorkflow).toMatchObject({
      provider: "comfyui",
      executionProvider: "comfyui",
      workflowFile: "人设1 金君雅.json",
    });
  });

  it("routes every workflow persona through direct ComfyUI execution", () => {
    for (const seed of WORKFLOW_PERSONA_SEEDS) {
      expect(seed.setup.imageWorkflow?.executionProvider, seed.id).toBe("comfyui");
    }
  });

  it("does not force Jin Junya bunny ears or harsh flash selfie as the default style", () => {
    const jinjunya = WORKFLOW_PERSONA_SEEDS.find((seed) => seed.id === "workflow-persona-jinjunya");
    const workflow = jinjunya?.setup.imageWorkflow;
    const combined = [
      jinjunya?.setup.personaAppearance,
      workflow?.promptSuffix,
      workflow?.visualAnchorAddendum,
    ].join("\n");

    expect(combined).toContain("no default bunny-ear headband");
    expect(combined).toContain("no default harsh flash selfie");
    expect(combined).not.toContain("wearing a fluffy white bunny-ear headband");
    expect(combined).not.toContain("harsh direct flash selfie");
  });
});
