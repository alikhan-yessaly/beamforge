import { decodeInt35 } from "./numbers";

export interface MemoryReply {
  addr: number;
  /** 5 raw 7-bit data bytes. */
  data: Uint8Array;
  value: number;
}

/** Parse unswizzled controller output into DA 01 replies; leftover/unknown bytes are returned in `rest`. */
export function decodeReplies(bytes: Uint8Array): { replies: MemoryReply[]; rest: Uint8Array } {
  const replies: MemoryReply[] = [];
  let i = 0;
  while (i < bytes.length && bytes[i] === 0xda && bytes[i + 1] === 0x01) {
    let j = i + 1;
    while (j < bytes.length && (bytes[j]! & 0x80) === 0) j++;
    const body = bytes.subarray(i, j);
    if (body.length < 9) break;
    replies.push({
      addr: (body[2]! << 7) | body[3]!,
      data: body.slice(4, 9),
      value: decodeInt35(body, 4),
    });
    i = j;
  }
  return { replies, rest: bytes.subarray(i) };
}
