/** Split an unswizzled stream into commands: a new command starts at every byte with the high bit set. */
export function splitCommands(stream: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let start = -1;
  for (let i = 0; i < stream.length; i++) {
    if ((stream[i]! & 0x80) !== 0) {
      if (start >= 0) out.push(stream.subarray(start, i));
      start = i;
    }
  }
  if (start >= 0) out.push(stream.subarray(start));
  return out;
}

/** Group whole commands into chunks of at most maxBytes (an oversized command gets its own chunk). */
export function chunkCommands(commands: Uint8Array[], maxBytes = 1024): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let buf: number[] = [];
  for (const c of commands) {
    if (buf.length > 0 && buf.length + c.length > maxBytes) {
      chunks.push(Uint8Array.from(buf));
      buf = [];
    }
    for (const b of c) buf.push(b);
  }
  if (buf.length > 0) chunks.push(Uint8Array.from(buf));
  return chunks;
}
