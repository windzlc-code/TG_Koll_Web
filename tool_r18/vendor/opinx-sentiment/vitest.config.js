import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.{js,mjs,cjs,ts,mts,cts}"],
    testTimeout: 10_000
  }
});
