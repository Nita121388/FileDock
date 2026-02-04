import type { OpenDialogOptions, SaveDialogOptions } from "@tauri-apps/plugin-dialog";
import { isTauri } from "../util/tauriEnv";

export async function openDialog(options: OpenDialogOptions) {
  if (!isTauri()) return null;
  const mod = await import("@tauri-apps/plugin-dialog");
  return mod.open(options);
}

export async function saveDialog(options: SaveDialogOptions) {
  if (!isTauri()) return null;
  const mod = await import("@tauri-apps/plugin-dialog");
  return mod.save(options);
}
