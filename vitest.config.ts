import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["server/**/*.test.ts", "shared/**/*.test.ts", "bin/**/*.test.ts"],
    environment: "node",
  },
});
