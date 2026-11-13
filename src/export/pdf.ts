// Hand-written minimal PDF 1.4: one page, vector paths, one optional-content layer per colour.
import type { ExportPath } from "../import/types";
import { fmtNum, groupLayers, hexParts, layoutExport, splitLayer } from "./svg";

const PT_PER_MM = 72 / 25.4;
/** 0.1 mm stroke, as in the SVG export. */
const LINE_WIDTH_PT = 0.283;

/** PDF text string: literal when plain ASCII, UTF-16BE hex otherwise. */
function pdfString(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return `(${s.replace(/[\\()]/g, "\\$&")})`;
  let hex = "FEFF";
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, "0");
  return `<${hex}>`;
}

const comp = (v: number) => fmtNum(v / 255, 3);

export function writePdf(
  paths: ExportPath[],
  opts: { keepPosition?: boolean; page?: { w: number; h: number }; marginMm?: number; title?: string } = {},
): Uint8Array {
  const lay = layoutExport(paths, opts);
  const wMm = Math.max(lay.w, 1);
  const hMm = Math.max(lay.h, 1);
  const px = (x: number) => fmtNum((x + lay.dx) * PT_PER_MM);
  const py = (y: number) => fmtNum((hMm - (y + lay.dy)) * PT_PER_MM); // PDF is y up

  const subpaths = (list: ExportPath[]): string =>
    list.map((p) => `${p.points.map((q, i) => `${px(q.x)} ${py(q.y)} ${i === 0 ? "m" : "l"}`).join(" ")}${p.closed ? " h" : ""}`).join(" ");

  const layers = groupLayers(paths);
  const content: string[] = [];
  layers.forEach((layer, i) => {
    const { areaFills, fillPaths, strokes } = splitLayer(layer);
    const [r, g, b] = hexParts(layer.color);
    content.push(`/OC /OC${i + 1} BDC`);
    for (const [color, list] of areaFills) {
      const [fr, fg, fb] = hexParts(color);
      content.push(`${comp(fr)} ${comp(fg)} ${comp(fb)} rg`, `${subpaths(list)} f*`);
    }
    if (fillPaths.length) content.push(`${comp(r)} ${comp(g)} ${comp(b)} rg`, `${subpaths(fillPaths)} f*`);
    if (strokes.length) content.push(`${comp(r)} ${comp(g)} ${comp(b)} RG`, `${LINE_WIDTH_PT} w 1 J 1 j`, `${subpaths(strokes)} S`);
    content.push("EMC");
  });
  const stream = content.join("\n");

  // Object numbers: 1 catalog, 2 pages, 3 page, 4 contents, 5 info, 6.. layer groups.
  const ocgRefs = layers.map((_, i) => `${6 + i} 0 R`);
  const bodies: string[] = [
    `<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [${ocgRefs.join(" ")}] /D << /Order [${ocgRefs.join(" ")}] /ON [${ocgRefs.join(" ")}] >> >> >>`,
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmtNum(wMm * PT_PER_MM)} ${fmtNum(hMm * PT_PER_MM)}] /Contents 4 0 R /Resources << /Properties << ${layers.map((_, i) => `/OC${i + 1} ${6 + i} 0 R`).join(" ")} >> >> >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    `<< /Title ${pdfString(opts.title ?? "BeamForge drawing")} /Producer (BeamForge) /Creator (BeamForge) >>`,
    ...layers.map((l) => `<< /Type /OCG /Name ${pdfString(l.name)} >>`),
  ];

  // Everything is ASCII, so string length equals byte length and offsets can be counted directly.
  let file = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets: number[] = [];
  bodies.forEach((body, i) => {
    offsets.push(file.length);
    file += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = file.length;
  file += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) file += `${String(o).padStart(10, "0")} 00000 n \n`;
  file += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  const bytes = new Uint8Array(file.length);
  for (let i = 0; i < file.length; i++) bytes[i] = file.charCodeAt(i) & 255;
  return bytes;
}
