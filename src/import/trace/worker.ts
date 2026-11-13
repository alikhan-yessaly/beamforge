// Web worker: traces pictures off the main thread for the import dialog's live preview.
import type { Rgba } from "../types";
import { type TraceSettings, traceImage } from "./pipeline";

self.onmessage = (e: MessageEvent<{ id: number; img: Rgba; settings: TraceSettings }>) => {
  const { id, img, settings } = e.data;
  try {
    (self as unknown as Worker).postMessage({ id, result: traceImage(img, settings) });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
