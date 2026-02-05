import type { DropZone, LeafNode, PaneKind, SplitDir, PaneTab } from "../../model/layout";
import { activeTab } from "../../model/layout";
import type { Settings } from "../../model/settings";
import type { TransferJob } from "../../model/transfers";
import { PaneView } from "../panes/PaneView";
import { useTranslation } from "react-i18next";

export default function LeafPane(props: {
  node: LeafNode;
  active?: boolean;
  settings: Settings;
  transfers: TransferJob[];
  onActivate?: (leafId: string) => void;
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
    conflictPolicy?: "overwrite" | "skip" | "rename";
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
  onUpdateTransfer: (id: string, updates: Partial<TransferJob>) => void;
  onSetDeviceAuth: (deviceId: string, deviceToken: string) => void;
  draggingLeafId: string | null;
  setDraggingLeafId: (id: string | null) => void;
  onDrop: (sourceLeafId: string, targetLeafId: string, zone: DropZone) => void;
  onSplit: (dir: SplitDir) => void;
  onClose: () => void;
  onSetPane: (pane: PaneKind) => void;
  onSetActiveTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onUpdateActiveTab: (updater: (tab: PaneTab) => PaneTab) => void;
}) {
  const { t } = useTranslation();
  const {
    node,
    active,
    settings,
    transfers,
    onActivate,
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
    draggingLeafId,
    setDraggingLeafId,
    onDrop,
    onSplit,
    onClose,
    onSetPane,
    onUpdateActiveTab
  } = props;

  const dragging = draggingLeafId !== null;
  const isDraggingSelf = draggingLeafId === node.id;
  const canDrop = dragging && !isDraggingSelf;
  const tab = activeTab(node);
  const className = [
    "pane",
    active ? "active" : "",
    canDrop ? "can-drop" : "",
    isDraggingSelf ? "dragging" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={className}
      onMouseDown={() => onActivate?.(node.id)}
      onFocusCapture={() => onActivate?.(node.id)}
    >
      <div className="pane-titlebar">
        <span
          className="drag-handle"
          title={t("pane.dragHandleTitle")}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", node.id);
            setDraggingLeafId(node.id);
          }}
          onDragEnd={() => setDraggingLeafId(null)}
        >
          ::
        </span>
        <select
          className="pane-select"
          value={tab.pane}
          onChange={(e) => onSetPane(e.target.value as PaneKind)}
          aria-label={t("pane.typeAria")}
        >
          <option value="deviceBrowser">{t("pane.types.device")}</option>
          <option value="localBrowser">{t("pane.types.local")}</option>
          <option value="sftpBrowser">{t("pane.types.sftp")}</option>
          <option value="transferQueue">{t("pane.types.queue")}</option>
          <option value="notes">{t("pane.types.notes")}</option>
        </select>

        <div className="pane-spacer" />

        <button
          className="pane-btn icon-only"
          onClick={() => onSplit("row")}
          title={t("pane.splitVertical")}
          aria-label={t("pane.splitVertical")}
        >
          <span className="icon icon-split-vertical" aria-hidden="true" />
        </button>
        <button
          className="pane-btn icon-only"
          onClick={() => onSplit("col")}
          title={t("pane.splitHorizontal")}
          aria-label={t("pane.splitHorizontal")}
        >
          <span className="icon icon-split-horizontal" aria-hidden="true" />
        </button>

        <button
          className="pane-btn danger icon-only"
          onClick={onClose}
          title={t("pane.closePaneTitle")}
          aria-label={t("pane.closePaneTitle")}
        >
          <span className="icon icon-close" aria-hidden="true" />
        </button>
      </div>

      {canDrop ? (
        <div className="drop-overlay" aria-label={t("pane.dropZonesAria")}>
          <DropZoneBox
            zone="left"
            onDrop={(sourceId) => onDrop(sourceId, node.id, "left")}
          />
          <DropZoneBox
            zone="right"
            onDrop={(sourceId) => onDrop(sourceId, node.id, "right")}
          />
          <DropZoneBox
            zone="top"
            onDrop={(sourceId) => onDrop(sourceId, node.id, "top")}
          />
          <DropZoneBox
            zone="bottom"
            onDrop={(sourceId) => onDrop(sourceId, node.id, "bottom")}
          />
          <DropZoneBox
            zone="center"
            onDrop={(sourceId) => onDrop(sourceId, node.id, "center")}
          />
        </div>
      ) : null}

      <div className="pane-body">
        <PaneView
          tab={tab}
          settings={settings}
          onUpdateTab={onUpdateActiveTab}
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
        />
      </div>
    </div>
  );
}

function DropZoneBox(props: { zone: DropZone; onDrop: (sourceLeafId: string) => void }) {
  const { zone, onDrop } = props;
  return (
    <div
      className={`drop-zone drop-${zone}`}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }}
      onDrop={(e) => {
        e.preventDefault();
        const sourceId = e.dataTransfer.getData("text/plain");
        if (sourceId) onDrop(sourceId);
      }}
    />
  );
}
