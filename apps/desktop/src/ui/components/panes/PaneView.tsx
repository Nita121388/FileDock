import type { PaneKind, PaneTab } from "../../model/layout";
import type { Settings } from "../../model/settings";
import type { TransferJob } from "../../model/transfers";
import DeviceBrowserPane from "./device/DeviceBrowserPane";
import NotesPane from "./notes/NotesPane";
import TransferQueuePane from "./transfer/TransferQueuePane";

export function PaneView(props: {
  tab: PaneTab;
  settings: Settings;
  onSetPane: (pane: PaneKind) => void;
  onUpdateTab: (updater: (tab: PaneTab) => PaneTab) => void;
  transfers: TransferJob[];
  onEnqueueDownload: (snapshotId: string, path: string, conn?: import("../../model/transfers").Conn) => void;
  onEnqueueCopy: (job: {
    src: import("../../model/transfers").Conn;
    srcSnapshotId: string;
    srcPath: string;
    dst: import("../../model/transfers").Conn;
    dstDeviceName: string;
    dstDeviceId?: string;
    dstPath: string;
  }) => void;
  onRemoveTransfer: (id: string) => void;
  onRunTransfer: (id: string) => Promise<void>;
  onCancelTransfer: (id: string) => void;
  onSetDeviceAuth: (deviceId: string, deviceToken: string) => void;
}) {
  switch (props.tab.pane) {
    case "deviceBrowser":
      return (
        <DeviceBrowserPane
          settings={props.settings}
          tab={props.tab}
          onTabChange={(next) => props.onUpdateTab(() => next)}
          onEnqueueDownload={props.onEnqueueDownload}
          onSetDeviceAuth={props.onSetDeviceAuth}
          onEnqueueCopy={props.onEnqueueCopy}
        />
      );
    case "transferQueue":
      return (
        <TransferQueuePane
          transfers={props.transfers}
          onEnqueueDownload={props.onEnqueueDownload}
          onRemove={props.onRemoveTransfer}
          onRun={props.onRunTransfer}
          onCancel={props.onCancelTransfer}
        />
      );
    case "notes":
      return <NotesPane />;
    default:
      return <div />;
  }
}
