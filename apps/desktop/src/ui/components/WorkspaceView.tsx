import { useState } from "react";

import type { TabState } from "../model/state";
import type { LayoutNode } from "../model/layout";
import type { Settings } from "../model/settings";
import type { TransferJob } from "../model/transfers";
import {
  addLeafTab,
  closeLeaf,
  closeLeafTab,
  moveLeaf,
  updateLeafTabState,
  setLeafActiveTab,
  setLeafPane,
  splitLeaf,
  updateSplitRatio,
  type DropZone
} from "../model/layout";
import SplitNodeView from "./layout/SplitNodeView";
import LeafPane from "./layout/LeafPane";

export function WorkspaceView(props: {
  tab: TabState;
  settings: Settings;
  transfers: TransferJob[];
  onEnqueueDownload: (snapshotId: string, path: string, conn?: import("../model/transfers").Conn) => void;
  onEnqueueSftpDownload: (job: {
    runner?: import("../model/transfers").PluginRunConfig;
    conn: import("../model/transfers").SftpConn;
    remotePath: string;
    localPath: string;
  }) => void;
  onEnqueueSftpUpload: (job: {
    runner?: import("../model/transfers").PluginRunConfig;
    conn: import("../model/transfers").SftpConn;
    localPath: string;
    remotePath: string;
    mkdirs?: boolean;
  }) => void;
  onEnqueueSnapshotToSftp: (job: {
    src: import("../model/transfers").Conn;
    snapshotId: string;
    snapshotPath: string;
    runner?: import("../model/transfers").PluginRunConfig;
    conn: import("../model/transfers").SftpConn;
    remotePath: string;
    mkdirs?: boolean;
  }) => void;
  onEnqueueSftpToSnapshot: (job: {
    runner?: import("../model/transfers").PluginRunConfig;
    conn: import("../model/transfers").SftpConn;
    remotePath: string;
    dst: import("../model/transfers").Conn;
    dstDeviceName: string;
    dstDeviceId?: string;
    dstPath: string;
    dstBaseSnapshotId?: string;
    conflictPolicy?: "overwrite" | "skip" | "rename";
  }) => void;
  onEnqueueCopy: (job: {
    src: import("../model/transfers").Conn;
    srcSnapshotId: string;
    srcPath: string;
    dst: import("../model/transfers").Conn;
    dstDeviceName: string;
    dstDeviceId?: string;
    dstPath: string;
    dstBaseSnapshotId?: string;
    conflictPolicy?: "overwrite" | "skip" | "rename";
  }) => void;
  onEnqueueCopyFolder: (job: {
    src: import("../model/transfers").Conn;
    srcSnapshotId: string;
    srcDirPath: string;
    dst: import("../model/transfers").Conn;
    dstDeviceName: string;
    dstDeviceId?: string;
    dstDirPath: string;
    dstBaseSnapshotId?: string;
    conflictPolicy?: "overwrite" | "skip" | "rename";
  }) => void;
  onRemoveTransfer: (id: string) => void;
  onRunTransfer: (id: string) => Promise<void>;
  onCancelTransfer: (id: string) => void;
  onUpdateTransfer: (id: string, updates: Partial<TransferJob>) => void;
  onSetDeviceAuth: (deviceId: string, deviceToken: string) => void;
  onTabChange: (tab: TabState) => void;
}) {
  const {
    tab,
    settings,
    transfers,
    onEnqueueDownload,
    onEnqueueSftpDownload,
    onEnqueueSftpUpload,
    onEnqueueSnapshotToSftp,
    onEnqueueSftpToSnapshot,
    onEnqueueCopy,
    onEnqueueCopyFolder,
    onRemoveTransfer,
    onRunTransfer,
    onCancelTransfer,
    onUpdateTransfer,
    onSetDeviceAuth,
    onTabChange
  } = props;
  const [draggingLeafId, setDraggingLeafId] = useState<string | null>(null);

  const onRootChange = (root: LayoutNode) => {
    onTabChange({ ...tab, root });
  };

  const onDrop = (sourceLeafId: string, targetLeafId: string, zone: DropZone) => {
    onRootChange(moveLeaf(tab.root, sourceLeafId, targetLeafId, zone));
  };

  const renderNode = (node: LayoutNode): JSX.Element => {
    if (node.kind === "leaf") {
      return (
        <LeafPane
          node={node}
          settings={settings}
          transfers={transfers}
          onEnqueueDownload={onEnqueueDownload}
          onEnqueueSftpDownload={onEnqueueSftpDownload}
          onEnqueueSftpUpload={onEnqueueSftpUpload}
          onEnqueueSnapshotToSftp={onEnqueueSnapshotToSftp}
          onEnqueueSftpToSnapshot={onEnqueueSftpToSnapshot}
          onEnqueueCopy={onEnqueueCopy}
          onEnqueueCopyFolder={onEnqueueCopyFolder}
          onRemoveTransfer={onRemoveTransfer}
          onRunTransfer={onRunTransfer}
          onCancelTransfer={onCancelTransfer}
          onUpdateTransfer={onUpdateTransfer}
          onSetDeviceAuth={onSetDeviceAuth}
          draggingLeafId={draggingLeafId}
          setDraggingLeafId={setDraggingLeafId}
          onDrop={onDrop}
          onSplit={(dir) => onRootChange(splitLeaf(tab.root, node.id, dir))}
          onClose={() => onRootChange(closeLeaf(tab.root, node.id))}
          onSetPane={(pane) => onRootChange(setLeafPane(tab.root, node.id, pane))}
          onAddTab={(pane) => onRootChange(addLeafTab(tab.root, node.id, pane))}
          onSetActiveTab={(tabId) => onRootChange(setLeafActiveTab(tab.root, node.id, tabId))}
          onCloseTab={(tabId) => onRootChange(closeLeafTab(tab.root, node.id, tabId))}
          onUpdateActiveTab={(updater) =>
            onRootChange(updateLeafTabState(tab.root, node.id, node.activeTabId, updater))
          }
        />
      );
    }

    return (
      <SplitNodeView
        node={node}
        render={renderNode}
        onResize={(ratio) => onRootChange(updateSplitRatio(tab.root, node.id, ratio))}
      />
    );
  };

  return <div className="workspace-inner">{renderNode(tab.root)}</div>;
}
