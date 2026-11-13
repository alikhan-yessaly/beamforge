// Job-order benchmark: plans each test drawing (tests/fixtures/orderScenes.ts) and prints the estimated job time,
// travel time and travel length, and how long planning took. `npx tsx scripts/bench-order.ts`
import { estimate } from "../src/job/estimate";
import { type JobOrder, planToolpath } from "../src/job/plan";
import { scenes } from "../tests/fixtures/orderScenes";

const MOTION = [
  { name: "default profile (100 mm/s, 2000 mm/s²)", travelSpeed: 100, accel: 2000 },
  { name: "fast travel (400 mm/s, 4000 mm/s²)", travelSpeed: 400, accel: 4000 },
];
const orders: JobOrder[] = (process.argv[2]?.split(",") as JobOrder[] | undefined) ?? ["auto"];

for (const m of MOTION) {
  console.log(`\n## ${m.name}`);
  console.log("scene | order | contours | total s | travel s | travel m | moves | plan ms");
  for (const s of scenes()) {
    const n = s.doc.objects[0]!.paths.length;
    for (const order of orders) {
      const t0 = performance.now();
      const tp = planToolpath(s.doc, { start: { x: 0, y: 0 }, innerFirst: true, order, motion: m });
      const ms = performance.now() - t0;
      const e = estimate(tp, m);
      const moves = tp.segments.filter((g) => !g.cut).length;
      console.log(`${s.name} | ${tp.order} | ${n} | ${e.total.toFixed(1)} | ${e.travelTime.toFixed(1)} | ${(e.travelLength / 1000).toFixed(2)} | ${moves} | ${ms.toFixed(0)}`);
    }
  }
}
