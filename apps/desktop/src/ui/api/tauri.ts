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
  conflict_policy?: "overwrite" | "skip" | "rename";
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
  // Path to a local folder or file (file backup is handled by the backend).
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

export async function renameLocalPath(path: string, newName: string): Promise<void> {
  const invoke = await getInvoke();
  await invoke<void>("local_rename", { path, newName });
}

export async function moveLocalPath(from: string, to: string): Promise<void> {
  const invoke = await getInvoke();
  await invoke<void>("local_move", { from, to });
}

export async function deleteLocalPath(path: string): Promise<void> {
  const invoke = await getInvoke();
  await invoke<void>("local_delete", { path });
}

export async function copyLocalFile(from: string, to: string): Promise<void> {
  const invoke = await getInvoke();
  await invoke<void>("local_copy", { from, to });
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

export type AgentInitRequest = {
  profile: string;
  folder: string;
  server_base_url: string;
  device_name?: string;
  interval_secs?: number;
  heartbeat_secs?: number;
  keep_bootstrap_token?: boolean;
  no_default_excludes?: boolean;
  token?: string;
  device_id?: string;
  device_token?: string;
};

export type AgentInitSummary = {
  profile: string;
  config_path: string;
  state_path: string;
  server: string;
  device_name: string;
  folder: string;
  exclude?: string[];
  ignore_file?: string | null;
  default_excludes_applied?: boolean;
  auth_mode: string;
  device_registered: boolean;
  device_id?: string | null;
  kept_bootstrap_token: boolean;
};

export type AgentInstallRequest = {
  profile: string;
  dry_run?: boolean;
  mode?: "daemon" | "scheduled";
};

export type AgentInstallSummary = {
  profile: string;
  config_path: string;
  service_manager: string;
  service_name: string;
  service_path?: string | null;
  dry_run: boolean;
  installed: boolean;
  enabled?: boolean | null;
  running?: boolean | null;
  note?: string | null;
  preview?: string | null;
};

export type AgentUninstallRequest = {
  profile: string;
  delete_config?: boolean;
};

export type AgentUninstallSummary = {
  profile: string;
  config_path: string;
  service_manager: string;
  service_name: string;
  service_path?: string | null;
  removed_service: boolean;
  removed_config: boolean;
  note?: string | null;
};

export type AgentServiceStatus = {
  manager: string;
  name: string;
  path?: string | null;
  installed: boolean;
  enabled?: boolean | null;
  running?: boolean | null;
  note?: string | null;
};

export type AgentServerStatus = {
  ok: boolean;
  auth_mode: string;
  device_id?: string | null;
  last_seen_unix?: number | null;
  snapshot_count?: number | null;
  latest_snapshot_id?: string | null;
  latest_snapshot_created_unix?: number | null;
  error?: string | null;
};

export type AgentStatusSummary = {
  profile: string;
  config_path: string;
  config_exists: boolean;
  state_path: string;
  state_exists: boolean;
  server?: string | null;
  folder?: string | null;
  device_name?: string | null;
  auth_mode?: string | null;
  service: AgentServiceStatus;
  server_status?: AgentServerStatus | null;
};

export async function agentInit(req: AgentInitRequest): Promise<AgentInitSummary> {
  const invoke = await getInvoke();
  return await invoke<AgentInitSummary>("agent_init", { req });
}

export async function agentInstall(req: AgentInstallRequest): Promise<AgentInstallSummary> {
  const invoke = await getInvoke();
  return await invoke<AgentInstallSummary>("agent_install", { req });
}

export async function agentStatus(profile: string): Promise<AgentStatusSummary> {
  const invoke = await getInvoke();
  return await invoke<AgentStatusSummary>("agent_status", { profile });
}

export async function agentUninstall(req: AgentUninstallRequest): Promise<AgentUninstallSummary> {
  const invoke = await getInvoke();
  return await invoke<AgentUninstallSummary>("agent_uninstall", { req });
}

export type TerminalStartRequest = {
  kind: "local" | "ssh";
  cols?: number;
  rows?: number;
  cwd?: string;
  conn?: unknown;
};

export type TerminalStartResponse = {
  session_id: string;
};

export type TerminalOutput = {
  session_id: string;
  data: string;
};

export type TerminalExit = {
  session_id: string;
};

export async function startTerminal(req: TerminalStartRequest): Promise<TerminalStartResponse> {
  const invoke = await getInvoke();
  return await invoke<TerminalStartResponse>("terminal_start", { req });
}

export async function writeTerminal(sessionId: string, data: string): Promise<void> {
  const invoke = await getInvoke();
  await invoke("terminal_write", { sessionId, data });
}

export async function resizeTerminal(sessionId: string, cols: number, rows: number): Promise<void> {
  const invoke = await getInvoke();
  await invoke("terminal_resize", { sessionId, cols, rows });
}

export async function closeTerminal(sessionId: string): Promise<void> {
  const invoke = await getInvoke();
  await invoke("terminal_close", { sessionId });
}

export async function listenTerminalOutput(
  handler: (payload: TerminalOutput) => void
): Promise<UnlistenFn> {
  const listen = await getListen();
  return await listen<TerminalOutput>("filedock_terminal_output", (e) => handler(e.payload));
}

export async function listenTerminalExit(
  handler: (payload: TerminalExit) => void
): Promise<UnlistenFn> {
  const listen = await getListen();
  return await listen<TerminalExit>("filedock_terminal_exit", (e) => handler(e.payload));
}
