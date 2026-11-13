import { describe, expect, it } from "vitest";
import { formatDiagnostics } from "../src/app/diagnostics";

describe("formatDiagnostics", () => {
  const base = {
    build: { version: "0.1.0", id: "abc", time: "2026-11-13T00:00:00Z" },
    browser: { name: "Chrome", serial: true, mobile: false },
    userAgent: "UA",
    lang: "en",
    connection: { kind: "usb", state: "disconnected", problem: "busy", message: "Could not connect: busy" },
    machine: { name: "Shop laser", bedW: 600, bedH: 400, class: "desktop-60" },
    objects: 2,
    layers: 1,
    log: [{ time: "10:00:00", kind: "error", text: "boom" }],
  };

  it("lists build, browser, connection, machine and the log", () => {
    const s = formatDiagnostics(base);
    expect(s).toContain("build: 0.1.0 (abc");
    expect(s).toContain("problem busy");
    expect(s).toContain('class="desktop-60"');
    expect(s).toContain("bedW=600");
    expect(s).toContain("10:00:00 error: boom");
  });

  it("leaves out what the owner named", () => {
    expect(formatDiagnostics(base)).not.toContain("Shop laser");
  });
});
