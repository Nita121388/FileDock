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
  onEnqueueDownload: (snapshotId: string, path: string) => void;
  onRemoveTransfer: (id: string) => void;
  onDownloadTransfer: (id: string) => Promise<void>;
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
        />
      );
    case "transferQueue":
      return (
        <TransferQueuePane
          transfers={props.transfers}
          onEnqueueDownload={props.onEnqueueDownload}
          onRemove={props.onRemoveTransfer}
          onDownload={props.onDownloadTransfer}
        />
      );
    case "notes":
      return <NotesPane />;
    default:
      return <div />;
  }
}
