import { isTauri } from "../util/tauriEnv";

type UnlistenFn = () => void | Promise<void>;

function assertTauri() {
  if (!isTauri()) {
    throw new Error("Tauri API is unavailable in web preview.");
  }
}

async function getInvoke() {
  assertTauri();
  const mod = await import("@tauri-apps/api/core");
  return mod.invoke;
}

async function getListen() {
  assertTauri();
  const mod = await import("@tauri-apps/api/event");
  return mod.listen;
}

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
    const listen = await getListen();
    unlisten = await listen<RestoreSnapshotProgress>("filedock_restore_progress", (e) => {
      if (e.payload.snapshot_id !== req.snapshot_id) return;
      onProgress(e.payload);
    });
  }

  try {
    const invoke = await getInvoke();
    return await invoke<RestoreSnapshotResponse>("restore_snapshot_to_folder", { req });
  } finally {
    if (unlisten) await unlisten();
  }
}

export async function cancelRestoreSnapshot(snapshotId: string): Promise<boolean> {
  const invoke = await getInvoke();
  return await invoke<boolean>("cancel_restore_snapshot", { snapshotId });
}

export type LocalDirEntry = {
  name: string;
  path: string;
  kind: "file" | "dir";
  size?: number | null;
  mtime_unix?: number | null;
};

export async function listLocalDir(path: string): Promise<LocalDirEntry[]> {
  const invoke = await getInvoke();
  return await invoke<LocalDirEntry[]>("list_local_dir", { path });
}

export type PushFolderSnapshotRequest = {
  server_base_url: string;
  token?: string;
  device_id?: string;
  device_token?: string;
  device_name: string;
  folder: string;
  note?: string;
  concurrency?: number;
};

export type PushFolderSnapshotResponse = {
  snapshot_id?: string | null;
  stdout: string;
  stderr: string;
};

export async function pushFolderSnapshot(
  req: PushFolderSnapshotRequest
): Promise<PushFolderSnapshotResponse> {
  const invoke = await getInvoke();
  return await invoke<PushFolderSnapshotResponse>("push_folder_snapshot", { req });
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
  const invoke = await getInvoke();
  return await invoke<RunFiledockPluginResponse>("run_filedock_plugin", { req });
}

export async function cancelFiledockPluginRun(runId: string): Promise<boolean> {
  const invoke = await getInvoke();
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
  const invoke = await getInvoke();
  await invoke("copy_snapshot_file_to_sftp", { req });
}

export type ImportSftpFileToSnapshotRequest = {
  run_id: string;
  server_base_url: string;
  token?: string;
  device_id?: string;
  device_token?: string;
  dst_device_name: string;
  dst_device_id?: string;
  dst_base_snapshot_id?: string;
  dst_root_path?: string;
  dst_path: string;
  conflict_policy?: "overwrite" | "skip" | "rename";
  note?: string;
  delete_remote?: boolean;
  sftp_conn: unknown;
  remote_path: string;
  runner?: {
    filedock_path?: string;
    plugin_dirs?: string;
    timeout_secs?: number;
  };
};

export type ImportSftpProgress = {
  run_id: string;
  phase: string;
  done_bytes?: number | null;
  total_bytes?: number | null;
  pct?: number | null;
};

export async function importSftpFileToSnapshot(
  req: ImportSftpFileToSnapshotRequest,
  onProgress?: (p: ImportSftpProgress) => void
): Promise<void> {
  let unlisten: UnlistenFn | null = null;
  if (onProgress) {
    const listen = await getListen();
    unlisten = await listen<ImportSftpProgress>("filedock_import_progress", (e) => {
      if (e.payload.run_id !== req.run_id) return;
      onProgress(e.payload);
    });
  }

  try {
    const invoke = await getInvoke();
    await invoke("import_sftp_file_to_snapshot", { req });
  } finally {
    if (unlisten) await unlisten();
  }
}
