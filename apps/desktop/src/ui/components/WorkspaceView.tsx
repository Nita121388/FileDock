import { useCallback, useState } from "react";

import type { TabState } from "../model/state";
import type { LayoutNode, PaneKind, PaneTab, SplitDir } from "../model/layout";
import {
  activeTab,
  closeLeaf,
  closeLeafTab,
  moveLeaf,
  setLeafActiveTab,
  setLeafPane,
  splitRoot,
  updateLeafTabState,
  updateSplitRatio
} from "../model/layout";
import type { Settings } from "../model/settings";
import type { TransferJob } from "../model/transfers";
import LeafPane from "./layout/LeafPane";
import SplitNodeView from "./layout/SplitNodeView";

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
  onActivateLeaf?: (leafId: string) => void;
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
    onTabChange,
    onActivateLeaf
  } = props;

  const [draggingLeafId, setDraggingLeafId] = useState<string | null>(null);

  const updateRoot = useCallback(
    (updater: (root: LayoutNode) => LayoutNode) => {
      onTabChange({ ...tab, root: updater(tab.root) });
    },
    [onTabChange, tab]
  );

  const renderNode = useCallback(
    (node: LayoutNode): JSX.Element => {
      if (node.kind === "split") {
        return (
          <SplitNodeView
            node={node}
            render={renderNode}
            onResize={(ratio) => updateRoot((root) => updateSplitRatio(root, node.id, ratio))}
          />
        );
      }

      const paneTab = activeTab(node);
      return (
        <LeafPane
          node={node}
          settings={settings}
          transfers={transfers}
          onActivate={(leafId) => onActivateLeaf?.(leafId)}
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
          onDrop={(sourceLeafId, targetLeafId, zone) =>
            updateRoot((root) => moveLeaf(root, sourceLeafId, targetLeafId, zone))
          }
          onSplit={(dir: SplitDir) =>
            updateRoot((root) => splitRoot(root, dir, paneTab.pane))
          }
          onClose={() => updateRoot((root) => closeLeaf(root, node.id))}
          onSetPane={(pane: PaneKind) => updateRoot((root) => setLeafPane(root, node.id, pane))}
          onSetActiveTab={(tabId: string) => updateRoot((root) => setLeafActiveTab(root, node.id, tabId))}
          onCloseTab={(tabId: string) => updateRoot((root) => closeLeafTab(root, node.id, tabId))}
          onUpdateActiveTab={(updater: (tab: PaneTab) => PaneTab) =>
            updateRoot((root) => updateLeafTabState(root, node.id, node.activeTabId, updater))
          }
        />
      );
    },
    [
      draggingLeafId,
      onActivateLeaf,
      onCancelTransfer,
      onEnqueueCopy,
      onEnqueueCopyFolder,
      onEnqueueDownload,
      onEnqueueSftpDownload,
      onEnqueueSftpToSnapshot,
      onEnqueueSftpUpload,
      onEnqueueSnapshotToSftp,
      onRemoveTransfer,
      onRunTransfer,
      onSetDeviceAuth,
      onUpdateTransfer,
      settings,
      transfers,
      updateRoot
    ]
  );

  return (
    <div className="workspace-inner">{renderNode(tab.root)}</div>
  );
}
