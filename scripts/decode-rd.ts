// Usage: npm run decode -- file.rd [--magic 0x88]
import { readFileSync } from "node:fs";
import { formatCommand } from "../src/protocol/names";
import { parseRd } from "../src/protocol/rd";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--magic");
const mi = args.indexOf("--magic");
const magic = mi >= 0 ? Number(args[mi + 1]) : undefined;
if (!file) {
  console.error("usage: npm run decode -- file.rd [--magic 0x88]");
  process.exit(2);
}

const job = parseRd(new Uint8Array(readFileSync(file)), magic);
for (const c of job.commands) console.log(formatCommand(c));
const mm = (um: number) => (um / 1000).toFixed(3);
console.error(`magic=0x${job.magic.toString(16)} commands=${job.commands.length} layers=${job.layerCount}`);
if (job.bbox) {
  const b = job.bbox;
  console.error(`bbox mm: (${mm(b.x0)}, ${mm(b.y0)}) - (${mm(b.x1)}, ${mm(b.y1)})`);
}
if (job.hasForbiddenWrite) console.error("WARNING: contains memory write outside the document-time range");
