// Pull the job streams that LightBurn sent out of a serialtrace log and save each one as an .rd file.
// The wire bytes are already swizzled, so a job's TX writes concatenated are exactly an .rd file.
// Usage: npm run extract-job -- captures/lightburn-job.log [--out tests/fixtures] [--magic 0x88]
// A job starts at the first non-query TX after a "# MARK <name>" line and ends at the write whose last command is D7.
// Each job is saved as <out>/<name>.rd, where <name> is the marker's first word.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { splitCommands } from "../src/protocol/chunk";
import { unswizzle } from "../src/protocol/swizzle";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const file = args.find((a, i) => !a.startsWith("--") && !["--out", "--magic"].includes(args[i - 1] ?? ""));
if (!file) {
  console.error("usage: npm run extract-job -- captures/lightburn-job.log [--out tests/fixtures] [--magic 0x88]");
  process.exit(2);
}
const out = opt("--out") ?? "tests/fixtures";
const magic = Number(opt("--magic") ?? "0x88");

let mark = "";
let parts: Uint8Array[] | null = null;
let saved = 0;

for (const line of readFileSync(file, "utf8").split("\n")) {
  if (line.startsWith("# MARK ")) {
    mark = line.slice(7).split(/\s+/)[0] ?? "";
    parts = null;
    continue;
  }
  const m = line.match(/^[\d.]+ TX \d+ \d+\s+(.*)$/);
  if (!m || !mark) continue;
  const wire = Uint8Array.from(m[1]!.split(" ").filter(Boolean).map((h) => parseInt(h, 16)));
  const cmds = splitCommands(unswizzle(wire, magic));
  const isQuery = cmds.every((c) => c[0] === 0xda && c[1] === 0x00);
  if (!parts) {
    // A job starts with its reference-point command (D8 10 absolute, D8 12 current position).
    if (isQuery || !(cmds[0]?.[0] === 0xd8 && (cmds[0][1] ?? 0) >= 0x10)) continue;
    parts = [];
  }
  parts.push(wire);
  if (cmds.at(-1)?.[0] === 0xd7) {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const rd = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      rd.set(p, o);
      o += p.length;
    }
    mkdirSync(out, { recursive: true });
    const path = join(out, `${mark}.rd`);
    writeFileSync(path, rd);
    console.log(`${path}: ${total} bytes in ${parts.length} writes`);
    saved++;
    parts = null;
    mark = "";
  }
}
if (saved === 0) console.error("no job found");
