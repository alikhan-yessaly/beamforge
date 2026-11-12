import { defineConfig } from "vitest/config";

export default defineConfig({
  base: process.env.BEAMFORGE_BASE || "/",
  esbuild: { jsx: "automatic", jsxImportSource: "preact" },
  test: { include: ["tests/**/*.test.ts"] },
});
