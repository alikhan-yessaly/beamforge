// What this browser can do for BeamForge: drive the laser over Web Serial, and whether it is a phone or tablet.

export interface BrowserInfo {
  /** Web Serial is available, so USB connections work. */
  serial: boolean;
  /** A touch-first device (phone, tablet): the workspace is made for a mouse and a wide screen. */
  mobile: boolean;
  /** A readable browser name for messages and diagnostics. */
  name: string;
}

/** Browser name from a user agent string; order matters (Edge and Opera also say Chrome, Chrome also says Safari). */
export function browserName(ua: string): string {
  if (/Edg\//.test(ua)) return "Edge";
  if (/OPR\//.test(ua)) return "Opera";
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/Chrome\//.test(ua) || /CriOS\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua)) return "Safari";
  return "Unknown browser";
}

export function browserInfo(nav: { userAgent: string; maxTouchPoints?: number } & Partial<{ serial: unknown }>, coarsePointer: boolean): BrowserInfo {
  const ua = nav.userAgent;
  // iPadOS Safari calls itself a Mac; real Macs have no touch points.
  const ipad = /Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/.test(ua) || ipad || (coarsePointer && !/Macintosh|Windows NT|X11|CrOS/.test(ua));
  return { serial: "serial" in nav && !!nav.serial, mobile, name: browserName(ua) };
}

let cached: BrowserInfo | null = null;
/** This browser's info (read once). */
export function currentBrowser(): BrowserInfo {
  if (!cached) {
    const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
    cached = typeof navigator === "undefined" ? { serial: false, mobile: false, name: "Unknown browser" } : browserInfo(navigator as Navigator & { serial?: unknown }, coarse);
  }
  return cached;
}
