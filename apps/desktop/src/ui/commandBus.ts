export type PaneCommand =
  | { kind: "device.refresh"; paneId: string }
  | { kind: "device.upload"; paneId: string }
  | { kind: "device.toggleHistory"; paneId: string }
  | { kind: "device.viewAll"; paneId: string }
  | { kind: "device.viewHistory"; paneId: string }
  | { kind: "device.up"; paneId: string }
  | { kind: "device.restore"; paneId: string }
  | { kind: "device.cancelRestore"; paneId: string }
  | { kind: "device.queueSelected"; paneId: string }
  | { kind: "device.selectAll"; paneId: string }
  | { kind: "device.clearSelection"; paneId: string }
  | { kind: "queue.runSelected"; paneId: string }
  | { kind: "queue.cancelSelected"; paneId: string }
  | { kind: "queue.removeSelected"; paneId: string }
  | { kind: "queue.selectFailed"; paneId: string }
  | { kind: "queue.selectQueued"; paneId: string }
  | { kind: "queue.clearSelection"; paneId: string };

const COMMAND_EVENT = "filedock-pane-command";

export function emitPaneCommand(cmd: PaneCommand) {
  window.dispatchEvent(new CustomEvent<PaneCommand>(COMMAND_EVENT, { detail: cmd }));
}

export function onPaneCommand(handler: (cmd: PaneCommand) => void) {
  const listener = (event: Event) => {
    const custom = event as CustomEvent<PaneCommand>;
    if (!custom?.detail) return;
    handler(custom.detail);
  };
  window.addEventListener(COMMAND_EVENT, listener);
  return () => window.removeEventListener(COMMAND_EVENT, listener);
}
