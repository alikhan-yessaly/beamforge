import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

function git(args: string): string {
  try {
    return execSync(`git ${args}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };
const time = new Date().toISOString();
/** What this build is: the running page compares its id with /version.json to notice a newer deploy. */
const build = { version: pkg.version, id: git("rev-parse --short=10 HEAD") || time, time, notes: git("log -1 --format=%s") };

export default defineConfig({
  base: process.env.BEAMFORGE_BASE || "/",
  define: { __BUILD__: JSON.stringify(build) },
  esbuild: { jsx: "automatic", jsxImportSource: "preact" },
  plugins: [
    {
      name: "beamforge-version",
      apply: "build",
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify(build) });
      },
    },
  ],
  test: { include: ["tests/**/*.test.ts"] },
});
