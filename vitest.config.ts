import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The client modules read browser globals (location/localStorage) at import
    // time, so run tests in a light DOM environment rather than bare Node.
    environment: "happy-dom",
    include: ["test/**/*.test.ts"],
  },
});
