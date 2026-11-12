// Ruida number types: 7 data bits per byte, high bit clear, big-endian.

const TWO_35 = 2 ** 35;

/** Signed 35-bit value in 5 bytes (micrometers for coordinates). */
export function encodeInt35(v: number): number[] {
  let u = Math.trunc(v);
  if (u < 0) u += TWO_35;
  const out: number[] = [];
  for (let shift = 28; shift >= 0; shift -= 7) out.push(Math.floor(u / 2 ** shift) & 0x7f);
  return out;
}

export function decodeInt35(bytes: ArrayLike<number>, offset = 0): number {
  let u = 0;
  for (let i = 0; i < 5; i++) u = u * 128 + ((bytes[offset + i] ?? 0) & 0x7f);
  return u >= TWO_35 / 2 ? u - TWO_35 : u;
}

/** Signed 14-bit value in 2 bytes. */
export function encodeInt14(v: number): number[] {
  let u = Math.trunc(v);
  if (u < 0) u += 1 << 14;
  return [(u >> 7) & 0x7f, u & 0x7f];
}

export function decodeInt14(bytes: ArrayLike<number>, offset = 0): number {
  const u = (((bytes[offset] ?? 0) & 0x7f) << 7) | ((bytes[offset + 1] ?? 0) & 0x7f);
  return u >= 1 << 13 ? u - (1 << 14) : u;
}
