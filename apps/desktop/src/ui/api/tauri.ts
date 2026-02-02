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

export async function cancelRestoreSnapshot(snapshotId: string): Promise<boolean> {
  return await invoke<boolean>("cancel_restore_snapshot", { snapshotId });
}

export type RunFiledockPluginRequest = {
  name: string;
  json: string;
  timeout_secs?: number;
  filedock_path?: string;
  plugin_dirs?: string[];
  run_id?: string;
};

export type RunFiledockPluginResponse = {
  stdout: string;
  stderr: string;
};

export async function runFiledockPlugin(
  req: RunFiledockPluginRequest
): Promise<RunFiledockPluginResponse> {
  return await invoke<RunFiledockPluginResponse>("run_filedock_plugin", { req });
}

export async function cancelFiledockPluginRun(runId: string): Promise<boolean> {
  return await invoke<boolean>("cancel_filedock_plugin_run", { runId });
}

export type CopySnapshotFileToSftpRequest = {
  run_id: string;
  server_base_url: string;
  token?: string;
  device_id?: string;
  device_token?: string;
  snapshot_id: string;
  path: string;
  sftp_conn: unknown;
  remote_path: string;
  runner?: {
    filedock_path?: string;
    plugin_dirs?: string;
    timeout_secs?: number;
  };
  mkdirs?: boolean;
};

export async function copySnapshotFileToSftp(req: CopySnapshotFileToSftpRequest): Promise<void> {
  await invoke("copy_snapshot_file_to_sftp", { req });
}
