import { describe, expect, it } from "vitest";
import { browserInfo, browserName } from "../src/app/env";

const CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const EDGE_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";
const SAFARI_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
const FIREFOX = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1";

describe("browserName", () => {
  it("tells the common browsers apart", () => {
    expect(browserName(CHROME_MAC)).toBe("Chrome");
    expect(browserName(EDGE_WIN)).toBe("Edge");
    expect(browserName(SAFARI_MAC)).toBe("Safari");
    expect(browserName(FIREFOX)).toBe("Firefox");
  });
});

describe("browserInfo", () => {
  it("needs navigator.serial for USB", () => {
    expect(browserInfo({ userAgent: CHROME_MAC, serial: {} }, false)).toEqual({ serial: true, mobile: false, name: "Chrome" });
    expect(browserInfo({ userAgent: SAFARI_MAC }, false).serial).toBe(false);
  });
  it("spots phones, and iPads that say Macintosh only by touch", () => {
    expect(browserInfo({ userAgent: IPHONE, maxTouchPoints: 5 }, true).mobile).toBe(true);
    expect(browserInfo({ userAgent: CHROME_MAC, maxTouchPoints: 0 }, false).mobile).toBe(false);
    expect(browserInfo({ userAgent: SAFARI_MAC, maxTouchPoints: 5 }, true).mobile).toBe(true);
    // A touch-screen Windows laptop is still a computer.
    expect(browserInfo({ userAgent: EDGE_WIN, maxTouchPoints: 10 }, true).mobile).toBe(false);
  });
});
