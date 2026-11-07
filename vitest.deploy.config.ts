import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/deploy/**/*.test.mjs"],
    testTimeout: 30_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
