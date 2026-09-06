import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/**/*.test.ts", "apps/**/*.test.mjs", "packages/**/*.test.ts", "scripts/**/*.test.mjs"],
  },
});
