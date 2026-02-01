import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex } from "@noble/hashes/utils";

export const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;

export type ChunkRef = { hash: string; size: number };

export function chunkBytes(data: Uint8Array, chunkSize = DEFAULT_CHUNK_SIZE): ChunkRef[] {
  const out: ChunkRef[] = [];
  let offset = 0;
  while (offset < data.length) {
    const end = Math.min(offset + chunkSize, data.length);
    const chunk = data.subarray(offset, end);
    const hash = bytesToHex(blake3(chunk));
    out.push({ hash, size: end - offset });
    offset = end;
  }
  return out;
}

