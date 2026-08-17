import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      reportsDirectory: "test-output/vitest/coverage",
    },
    include: ["tests/**/*.spec.ts"],
  },
});
