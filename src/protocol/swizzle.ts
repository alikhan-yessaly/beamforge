export const DEFAULT_MAGIC = 0x88;

// Candidate magics from the EduTech card table; order = detection preference.
export const KNOWN_MAGICS = [
  0x88, 0x11, 0x38, 0x83, 0x33, 0x16, 0x34, 0x77, 0x75, 0x99, 0x13, 0x60, 0x76, 0x10, 0xa1, 0x1a,
] as const;

export function swizzleByte(b: number, magic: number): number {
  b &= 0xff;
  b ^= (b >> 7) & 0xff;
  b ^= (b << 7) & 0xff;
  b ^= (b >> 7) & 0xff;
  b ^= magic;
  return (b + 1) & 0xff;
}

export function unswizzleByte(b: number, magic: number): number {
  b = (b - 1) & 0xff;
  b ^= magic;
  b ^= (b >> 7) & 0xff;
  b ^= (b << 7) & 0xff;
  b ^= (b >> 7) & 0xff;
  return b & 0xff;
}

export function swizzle(data: Uint8Array, magic: number = DEFAULT_MAGIC): Uint8Array {
  return data.map((b) => swizzleByte(b, magic));
}

export function unswizzle(data: Uint8Array, magic: number = DEFAULT_MAGIC): Uint8Array {
  return data.map((b) => unswizzleByte(b, magic));
}
