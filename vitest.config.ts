import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The slot engine is pure; it needs no DOM and no Remix runtime.
    environment: "node",
    include: ["app/**/*.test.ts"],
  },
});
