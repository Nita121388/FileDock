import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type RestoreSnapshotRequest = {
  server_base_url: string;
  token?: string;
  device_id?: string;
  device_token?: string;
  snapshot_id: string;
  dest_dir: string;
  concurrency?: number;
};

export type RestoreSnapshotProgress = {
  snapshot_id: string;
  path: string;
  done_files: number;
  total_files: number;
  done_bytes: number;
  total_bytes: number;
};

export type RestoreSnapshotResponse = {
  snapshot_id: string;
  dest_dir: string;
  total_files: number;
  total_bytes: number;
};

export async function restoreSnapshotToFolder(
  req: RestoreSnapshotRequest,
  onProgress?: (p: RestoreSnapshotProgress) => void
): Promise<RestoreSnapshotResponse> {
  let unlisten: UnlistenFn | null = null;
  if (onProgress) {
    unlisten = await listen<RestoreSnapshotProgress>("filedock_restore_progress", (e) => {
      if (e.payload.snapshot_id !== req.snapshot_id) return;
      onProgress(e.payload);
    });
  }

  try {
    return await invoke<RestoreSnapshotResponse>("restore_snapshot_to_folder", { req });
  } finally {
    if (unlisten) await unlisten();
  }
}

