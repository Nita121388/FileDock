import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex } from "@noble/hashes/utils";

export const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;

export type ChunkRef = { hash: string; size: number };
export type FileChunkRef = ChunkRef & { offset: number };

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

export async function chunkFile(
  file: File,
  chunkSize?: number,
  onProgress?: (doneBytes: number, totalBytes: number) => void
): Promise<FileChunkRef[]> {
  const out: FileChunkRef[] = [];
  const total = file.size;
  const cs = chunkSize ?? DEFAULT_CHUNK_SIZE;
  let offset = 0;
  while (offset < total) {
    const end = Math.min(offset + cs, total);
    const chunkBuf = new Uint8Array(await file.slice(offset, end).arrayBuffer());
    const hash = bytesToHex(blake3(chunkBuf));
    out.push({ hash, size: end - offset, offset });
    offset = end;
    onProgress?.(offset, total);
  }
  return out;
}
