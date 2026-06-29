import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The client modules read browser globals (location/localStorage) at import
    // time, so run tests in a light DOM environment rather than bare Node.
    environment: "happy-dom",
    include: ["test/**/*.test.ts"],
    // The hub reaping tests drive a real (short) liveness window with wall-clock
    // sleeps; under parallel-file load the default 5s can be starved, so give a
    // wider margin to keep them from flaking without masking a genuine hang.
    testTimeout: 15_000,
  },
});
