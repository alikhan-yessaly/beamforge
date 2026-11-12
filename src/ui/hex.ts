/** Parse "DA 00 04 00", "da0004 00" or "0xDA,0x00" into bytes; throws on anything else. */
export function parseHex(text: string): Uint8Array {
  const clean = text.replace(/0x/gi, "").replace(/[\s,]/g, "");
  if (!/^([0-9a-f]{2})+$/i.test(clean)) throw new Error(`Not hex bytes: "${text}"`);
  return Uint8Array.from(clean.match(/../g)!.map((h) => parseInt(h, 16)));
}

export const toHex = (b: ArrayLike<number>) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0").toUpperCase()).join(" ");
