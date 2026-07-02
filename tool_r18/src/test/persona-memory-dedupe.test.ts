import { beforeEach, describe, expect, it } from "vitest";
import { addSummariesToMemory, getPersonaMemory } from "@/lib/persona-memory";

describe("persona memory dedupe", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("stores the same memory summary only once", () => {
    addSummariesToMemory("persona-dedupe", [
      "published memory should only be stored once after a successful publish",
      "published memory should only be stored once after a successful publish",
    ]);

    expect(getPersonaMemory("persona-dedupe").entries).toHaveLength(1);
  });
});
