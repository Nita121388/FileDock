import type { OpenDialogOptions, SaveDialogOptions } from "@tauri-apps/plugin-dialog";
import { isTauri } from "../util/tauriEnv";

export async function openDialog(options: OpenDialogOptions) {
  if (!isTauri()) return null;
  try {
    const mod = await import("@tauri-apps/plugin-dialog");
    return await mod.open(options);
  } catch (err) {
    console.error("[dialog] open failed", err);
    throw err;
  }
}

export async function saveDialog(options: SaveDialogOptions) {
  if (!isTauri()) return null;
  try {
    const mod = await import("@tauri-apps/plugin-dialog");
    return await mod.save(options);
  } catch (err) {
    console.error("[dialog] save failed", err);
    throw err;
  }
}
