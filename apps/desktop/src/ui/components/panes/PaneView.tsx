import type { PaneKind, PaneTab } from "../../model/layout";
import type { Settings } from "../../model/settings";
import type { TransferJob } from "../../model/transfers";
import DeviceBrowserPane from "./device/DeviceBrowserPane";
import NotesPane from "./notes/NotesPane";
import SftpBrowserPane from "./sftp/SftpBrowserPane";
import TransferQueuePane from "./transfer/TransferQueuePane";

export function PaneView(props: {
  tab: PaneTab;
  settings: Settings;
  onSetPane: (pane: PaneKind) => void;
  onUpdateTab: (updater: (tab: PaneTab) => PaneTab) => void;
  transfers: TransferJob[];
  onUpdateTransfer: (id: string, updates: Partial<TransferJob>) => void;
  onEnqueueDownload: (snapshotId: string, path: string, conn?: import("../../model/transfers").Conn) => void;
  onEnqueueSftpDownload: (job: {
    runner?: import("../../model/transfers").PluginRunConfig;
    conn: import("../../model/transfers").SftpConn;
    remotePath: string;
    localPath: string;
  }) => void;
  onEnqueueSftpUpload: (job: {
    runner?: import("../../model/transfers").PluginRunConfig;
    conn: import("../../model/transfers").SftpConn;
    localPath: string;
    remotePath: string;
    mkdirs?: boolean;
  }) => void;
  onEnqueueCopy: (job: {
    src: import("../../model/transfers").Conn;
    srcSnapshotId: string;
    srcPath: string;
    dst: import("../../model/transfers").Conn;
    dstDeviceName: string;
    dstDeviceId?: string;
    dstPath: string;
    dstBaseSnapshotId?: string;
    conflictPolicy?: "overwrite" | "skip" | "rename";
  }) => void;
  onEnqueueCopyFolder: (job: {
    src: import("../../model/transfers").Conn;
    srcSnapshotId: string;
    srcDirPath: string;
    dst: import("../../model/transfers").Conn;
    dstDeviceName: string;
    dstDeviceId?: string;
    dstDirPath: string;
    dstBaseSnapshotId?: string;
    conflictPolicy?: "overwrite" | "skip" | "rename";
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
          onEnqueueCopyFolder={props.onEnqueueCopyFolder}
        />
      );
    case "sftpBrowser":
      return (
        <SftpBrowserPane
          tab={props.tab}
          onTabChange={(next) => props.onUpdateTab(() => next)}
          onEnqueueSftpDownload={props.onEnqueueSftpDownload}
          onEnqueueSftpUpload={props.onEnqueueSftpUpload}
        />
      );
    case "transferQueue":
      return (
        <TransferQueuePane
          transfers={props.transfers}
          onUpdateTransfer={props.onUpdateTransfer}
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
