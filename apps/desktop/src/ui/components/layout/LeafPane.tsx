import type { DropZone, LeafNode, PaneKind, SplitDir, PaneTab } from "../../model/layout";
import { activeTab, uid } from "../../model/layout";
import type { Settings } from "../../model/settings";
import type { TransferJob } from "../../model/transfers";
import { PaneView } from "../panes/PaneView";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { NoticeLevel } from "../NoticeCenter";

export default function LeafPane(props: {
  node: LeafNode;
  active?: boolean;
  settings: Settings;
  transfers: TransferJob[];
  onNotify: (level: NoticeLevel, message: string, title?: string, autoCloseMs?: number) => void;
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
  onOpenTerminal: (tab: PaneTab) => void;
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
    onNotify,
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
    onOpenTerminal,
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
  const [isDragOver, setIsDragOver] = useState(false);
  const [dropZone, setDropZone] = useState<DropZone>("center");
  const className = [
    "pane",
    active ? "active" : "",
    isDraggingSelf ? "dragging" : ""
  ]
    .filter(Boolean)
    .join(" ");

  const canOpenSftpTerminal = tab.pane === "sftpBrowser" && !!tab.state.host.trim() && !!tab.state.user.trim();
  const openSftpTerminal = () => {
    if (tab.pane !== "sftpBrowser") return;
    if (!tab.state.host.trim() || !tab.state.user.trim()) return;

    const title = `${tab.state.user}@${tab.state.host}`;
    const terminalTab: PaneTab = {
      id: uid("tab"),
      pane: "terminal",
      title,
      state: {
        mode: "sftp",
        title,
        path: tab.state.path || "/",
        host: tab.state.host,
        port: tab.state.port || 22,
        user: tab.state.user,
        password: tab.state.password,
        keyPath: tab.state.keyPath,
        useAgent: tab.state.useAgent,
        knownHostsPolicy: tab.state.knownHostsPolicy,
        knownHostsPath: tab.state.knownHostsPath,
        basePath: tab.state.basePath
      }
    };

    onOpenTerminal(terminalTab);
  };

  return (
    <div
      className={className}
      onMouseDown={() => onActivate?.(node.id)}
      onFocusCapture={() => onActivate?.(node.id)}
      onDragEnter={(e) => {
        if (!canDrop) return;
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        const y = (e.clientY - rect.top) / Math.max(rect.height, 1);
        const zone = y < 0.3 ? "top" : y > 0.7 ? "bottom" : "center";
        setDropZone(zone);
        setIsDragOver(true);
      }}
      onDragOver={(e) => {
        if (!canDrop) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const rect = e.currentTarget.getBoundingClientRect();
        const y = (e.clientY - rect.top) / Math.max(rect.height, 1);
        const zone = y < 0.3 ? "top" : y > 0.7 ? "bottom" : "center";
        if (zone !== dropZone) {
          setDropZone(zone);
        }
      }}
      onDragLeave={(e) => {
        if (!canDrop) return;
        const next = e.relatedTarget as Node | null;
        if (!next || !e.currentTarget.contains(next)) setIsDragOver(false);
      }}
      onDrop={(e) => {
        if (!canDrop) return;
        e.preventDefault();
        const sourceId = e.dataTransfer.getData("text/plain");
        setIsDragOver(false);
        if (sourceId) onDrop(sourceId, node.id, dropZone);
      }}
    >
      {canDrop && isDragOver ? (
        <div className={`pane-drop-preview preview-${dropZone}`}>
          <div className="drop-half top" />
          <div className="drop-half bottom" />
        </div>
      ) : null}
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
          <option value="terminal">{t("pane.types.terminal")}</option>
          <option value="transferQueue">{t("pane.types.queue")}</option>
          <option value="notes">{t("pane.types.notes")}</option>
        </select>

        <div className="pane-spacer" />

        {tab.pane === "sftpBrowser" ? (
          <button
            className="pane-btn icon-only"
            onClick={openSftpTerminal}
            title={t("pane.openTerminal")}
            aria-label={t("pane.openTerminal")}
            disabled={!canOpenSftpTerminal}
          >
            <span className="icon icon-terminal" aria-hidden="true" />
          </button>
        ) : null}

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

      {canDrop ? null : null}

      <div className="pane-body">
        <PaneView
          tab={tab}
          settings={settings}
          onUpdateTab={onUpdateActiveTab}
          transfers={transfers}
          onNotify={onNotify}
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
        />
      </div>
    </div>
  );
}
