// Used by the UDP framing only; USB sends no checksum (docs/PROTOCOL.md).
export function sum16(data: Uint8Array): number {
  let s = 0;
  for (const b of data) s = (s + b) & 0xffff;
  return s;
}
