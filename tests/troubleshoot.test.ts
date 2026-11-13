import { describe, expect, it } from "vitest";
import { classifyConnError } from "../src/app/troubleshoot";
import { explainOpenError } from "../src/transport/webSerial";

const named = (name: string) => Object.assign(new Error("x"), { name });

describe("classifyConnError", () => {
  it("keeps the Web Serial reason through explainOpenError", () => {
    expect(classifyConnError(explainOpenError(named("NotFoundError")), "usb")).toBe("no-port");
    expect(classifyConnError(explainOpenError(named("InvalidStateError")), "usb")).toBe("busy");
    expect(classifyConnError(explainOpenError(named("NetworkError")), "usb")).toBe("busy");
  });
  it("sorts the rest", () => {
    expect(classifyConnError(named("NotSupportedError"), "usb")).toBe("no-serial");
    expect(classifyConnError(new Error("boom"), "bridge")).toBe("bridge");
    expect(classifyConnError("boom", "usb")).toBe("other");
  });
});
