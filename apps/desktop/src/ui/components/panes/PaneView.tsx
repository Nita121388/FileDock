import type { PaneTab } from "../../model/layout";
import type { Settings } from "../../model/settings";
import type { TransferJob } from "../../model/transfers";
import DeviceBrowserPane from "./device/DeviceBrowserPane";
import LocalBrowserPane from "./local/LocalBrowserPane";
import NotesPane from "./notes/NotesPane";
import SftpBrowserPane from "./sftp/SftpBrowserPane";
import TerminalPane from "./terminal/TerminalPane";
import TransferQueuePane from "./transfer/TransferQueuePane";
import type { NoticeLevel } from "../NoticeCenter";

export function PaneView(props: {
  tab: PaneTab;
  settings: Settings;
  onNotify: (level: NoticeLevel, message: string, title?: string, autoCloseMs?: number) => void;
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
  onEnqueueSnapshotToSftp: (job: {
    src: import("../../model/transfers").Conn;
    snapshotId: string;
    snapshotPath: string;
    runner?: import("../../model/transfers").PluginRunConfig;
    conn: import("../../model/transfers").SftpConn;
    remotePath: string;
    mkdirs?: boolean;
  }) => void;
  onEnqueueSftpToSnapshot: (job: {
    runner?: import("../../model/transfers").PluginRunConfig;
    conn: import("../../model/transfers").SftpConn;
    remotePath: string;
    dst: import("../../model/transfers").Conn;
    dstDeviceName: string;
    dstDeviceId?: string;
    dstPath: string;
    dstBaseSnapshotId?: string;
    dstRootPath?: string;
    conflictPolicy?: "overwrite" | "skip" | "rename";
    note?: string;
    deleteSource?: boolean;
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
  onOpenTerminal: (tab: import("../../model/layout").PaneTab) => void;
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
          onEnqueueSftpToSnapshot={props.onEnqueueSftpToSnapshot}
        />
      );
    case "localBrowser":
      return (
        <LocalBrowserPane
          paneId={props.tab.id}
          tab={props.tab}
          settings={props.settings}
          onNotify={props.onNotify}
          onTabChange={(next) => props.onUpdateTab(() => next)}
        />
      );
    case "sftpBrowser":
      return (
        <SftpBrowserPane
          paneId={props.tab.id}
          tab={props.tab}
          settings={props.settings}
          onTabChange={(next) => props.onUpdateTab(() => next)}
          onEnqueueSftpDownload={props.onEnqueueSftpDownload}
          onEnqueueSftpUpload={props.onEnqueueSftpUpload}
          onEnqueueSftpToSnapshot={props.onEnqueueSftpToSnapshot}
          onEnqueueSnapshotToSftp={props.onEnqueueSnapshotToSftp}
          onOpenTerminal={props.onOpenTerminal}
        />
      );
    case "terminal":
      return (
        <TerminalPane
          tab={props.tab}
          onTabChange={(next) => props.onUpdateTab(() => next)}
        />
      );
    case "transferQueue":
      return (
        <TransferQueuePane
          paneId={props.tab.id}
          transfers={props.transfers}
          onUpdateTransfer={props.onUpdateTransfer}
          onEnqueueDownload={props.onEnqueueDownload}
          onEnqueueSftpDownload={props.onEnqueueSftpDownload}
          onEnqueueSftpUpload={props.onEnqueueSftpUpload}
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
