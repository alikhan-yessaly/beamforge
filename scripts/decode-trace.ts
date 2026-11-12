// Decode a serialtrace log (tools/serialtrace) into named Ruida commands.
// Usage: npm run decode-trace -- captures/lightburn.log [--magic 0x88] [--all] [--from ms] [--to ms]
// By default memory reads (DA 00 …) and their replies are summarised, so the actions stand out.
import { readFileSync } from "node:fs";
import { splitCommands } from "../src/protocol/chunk";
import { formatCommand } from "../src/protocol/names";
import { decodeInt35 } from "../src/protocol/numbers";
import { unswizzle } from "../src/protocol/swizzle";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const file = args.find((a, i) => !a.startsWith("--") && !["--magic", "--from", "--to"].includes(args[i - 1] ?? ""));
if (!file) {
  console.error("usage: npm run decode-trace -- captures/lightburn.log [--magic 0x88] [--all] [--from ms] [--to ms]");
  process.exit(2);
}
const magic = Number(opt("--magic") ?? "0x88");
const all = args.includes("--all");
const from = Number(opt("--from") ?? "-Infinity");
const to = Number(opt("--to") ?? "Infinity");

const hex = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(" ");
const addr = (c: Uint8Array) => `${hex([c[2] ?? 0])} ${hex([c[3] ?? 0])}`;

let reads = 0;
let readAddrs = new Set<string>();
let lastT = 0;
const flushReads = () => {
  if (reads > 0) console.log(`         … ${reads} memory reads (${[...readAddrs].join(", ")})`);
  reads = 0;
  readAddrs = new Set();
};

for (const line of readFileSync(file, "utf8").split("\n")) {
  if (line.startsWith("#")) {
    flushReads();
    console.log(line);
    continue;
  }
  const m = line.match(/^([\d.]+) (TX|RX|OPEN|CLOSE) (\d+) (\d+)\s*(.*)$/);
  if (!m) continue;
  const t = Number(m[1]);
  if (t < from || t > to) continue;
  const dir = m[2]!;
  if (dir === "OPEN" || dir === "CLOSE") {
    if (all) console.log(`${t.toFixed(0).padStart(8)} ${dir} ${m[5]}`);
    continue;
  }
  const wire = Uint8Array.from(m[5]!.split(" ").filter(Boolean).map((h) => parseInt(h, 16)));
  const cmds = splitCommands(unswizzle(wire, magic));
  for (const c of cmds) {
    const isRead = (dir === "TX" && c[0] === 0xda && c[1] === 0x00) || (dir === "RX" && c[0] === 0xda && c[1] === 0x01);
    if (isRead && !all) {
      if (dir === "TX") {
        reads++;
        readAddrs.add(addr(c));
      }
      continue;
    }
    if (t - lastT > 1500) flushReads();
    flushReads();
    let extra = "";
    if (dir === "RX" && c[0] === 0xda && c[1] === 0x01 && c.length >= 9) extra = `  = ${decodeInt35(c, 4)}`;
    if (c[0] === 0xd9 && c.length >= 13) extra = `  opt=${hex([c[2]!])} x=${decodeInt35(c, 3) / 1000} y=${decodeInt35(c, 8) / 1000} mm`;
    if (c[0] === 0xd9 && c.length >= 8 && c.length < 13) extra = `  opt=${hex([c[2]!])} v=${decodeInt35(c, 3) / 1000} mm`;
    if (c[0] === 0x88 && c.length >= 11) extra = `  x=${decodeInt35(c, 1) / 1000} y=${decodeInt35(c, 6) / 1000} mm`;
    console.log(`${t.toFixed(0).padStart(8)} ${dir} ${formatCommand(c)}${extra}`);
    lastT = t;
  }
}
flushReads();
