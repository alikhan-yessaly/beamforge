// Frame a job: trace its bounding box with the laser off, then return to the start.
// Smooth, LightBurn-style (Motion.frame): one write of queued rapids. Software STOP cannot halt it.
import { type JobBounds, placeJob } from "./jobRunner";
import type { Motion, Vec2 } from "./motion";

export async function frameJob(
  motion: Motion,
  bounds: JobBounds,
  speedMmS: number,
  onProgress?: (p: Vec2) => void,
  onStart?: (p: Vec2) => void,
): Promise<void> {
  const start = await motion.position();
  const { min, max } = placeJob(bounds, start);
  onStart?.(start);
  await motion.frame(min, max, speedMmS, onProgress);
}
