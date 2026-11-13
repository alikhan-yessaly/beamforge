// Minimal ZIP reader (stored and deflated entries), enough to look inside CorelDRAW X4+ files. Uses the
// platform's DecompressionStream, so no dependency.

export interface ZipEntry {
  name: string;
  read(): Promise<Uint8Array>;
}

export const isZip = (b: Uint8Array) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(data)]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Entries from the central directory. Throws on files that aren't ZIP archives. */
export function readZip(bytes: Uint8Array): ZipEntry[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a ZIP archive");
  const count = dv.getUint16(eocd + 10, true);
  let at = dv.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count && at + 46 <= bytes.length; n++) {
    if (dv.getUint32(at, true) !== 0x02014b50) break;
    const method = dv.getUint16(at + 10, true);
    const size = dv.getUint32(at + 20, true);
    const nameLen = dv.getUint16(at + 28, true), extraLen = dv.getUint16(at + 30, true), commentLen = dv.getUint16(at + 32, true);
    const local = dv.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));
    entries.push({
      name,
      async read() {
        const lNameLen = dv.getUint16(local + 26, true), lExtraLen = dv.getUint16(local + 28, true);
        const start = local + 30 + lNameLen + lExtraLen;
        const data = bytes.subarray(start, start + size);
        if (method === 0) return data;
        if (method === 8) return inflateRaw(data);
        throw new Error(`Unsupported ZIP compression ${method}`);
      },
    });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
