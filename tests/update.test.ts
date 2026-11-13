import { describe, expect, it } from "vitest";
import { newerBuild, parseBuild } from "../src/app/update";

const running = { version: "0.1.0", id: "aaa", time: "2026-11-01T00:00:00Z", notes: "" };

describe("update check", () => {
  it("parses version.json and rejects junk", () => {
    expect(parseBuild({ version: "0.1.0", id: "b", time: "2026-11-02T00:00:00Z", notes: "x" })?.id).toBe("b");
    expect(parseBuild("<!doctype html>")).toBeNull();
    expect(parseBuild({ id: 3 })).toBeNull();
  });
  it("is newer only for a different, later build", () => {
    expect(newerBuild(running, { ...running })).toBeNull();
    expect(newerBuild(running, { ...running, id: "old", time: "2026-10-01T00:00:00Z" })).toBeNull();
    expect(newerBuild(running, { ...running, id: "new", time: "2026-11-05T00:00:00Z" })?.id).toBe("new");
    expect(newerBuild(running, null)).toBeNull();
  });
});
