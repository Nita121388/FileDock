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
  splitLeaf,
  updateLeafTabState,
  updateSplitRatio
} from "../model/layout";
import type { Settings } from "../model/settings";
import type { TransferJob } from "../model/transfers";
import LeafPane from "./layout/LeafPane";
import SplitNodeView from "./layout/SplitNodeView";
import type { NoticeLevel } from "./NoticeCenter";

export function WorkspaceView(props: {
  tab: TabState;
  activeLeafId: string | null;
  settings: Settings;
  transfers: TransferJob[];
  onNotify: (level: NoticeLevel, message: string, title?: string, autoCloseMs?: number) => void;
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
  onOpenTerminal: (tab: PaneTab) => void;
  onTabChange: (tab: TabState) => void;
  onActivateLeaf?: (leafId: string) => void;
}) {
  const {
    tab,
    activeLeafId,
    settings,
    transfers,
    onNotify,
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
    onOpenTerminal,
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
      const isActive = activeLeafId === node.id;
      return (
        <LeafPane
          node={node}
          active={isActive}
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
          onOpenTerminal={onOpenTerminal}
          onNotify={onNotify}
          draggingLeafId={draggingLeafId}
          setDraggingLeafId={setDraggingLeafId}
          onDrop={(sourceLeafId, targetLeafId, zone) =>
            updateRoot((root) => moveLeaf(root, sourceLeafId, targetLeafId, zone))
          }
          onSplit={(dir: SplitDir) =>
            updateRoot((root) => splitLeaf(root, node.id, dir, paneTab.pane))
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
      onOpenTerminal,
      onUpdateTransfer,
      onNotify,
      settings,
      transfers,
      updateRoot
    ]
  );

  const single = tab.root.kind === "leaf";
  return (
    <div className={single ? "workspace-inner single" : "workspace-inner"}>{renderNode(tab.root)}</div>
  );
}
