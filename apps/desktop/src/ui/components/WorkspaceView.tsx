import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { TabState } from "../model/state";
import type { PaneKind, PaneTab } from "../model/layout";
import { activeTab, makeTab, updateLeafTabState } from "../model/layout";
import type { Settings } from "../model/settings";
import type { TransferJob } from "../model/transfers";
import { listDevices, listSnapshots, type DeviceInfo } from "../api/client";
import { PaneView } from "./panes/PaneView";

const SOURCE_LOCAL = "local";
const SOURCE_SFTP = "sftp";
const SOURCE_QUEUE = "queue";
const SOURCE_NOTES = "notes";
const SOURCE_DEVICE_PREFIX = "device:";
const SOURCE_DEVICE_NONE = "device:none";

function toTab(pane: PaneKind, current: PaneTab): PaneTab {
  if (current.pane === pane) return current;
  const template = makeTab(pane);
  return { ...template, id: current.id, title: current.title };
}

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
  const { t } = useTranslation();
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

  const { serverBaseUrl, token, deviceId, deviceToken } = settings;

  const leaf = tab.root.kind === "leaf" ? tab.root : null;
  const active = leaf ? activeTab(leaf) : makeTab("deviceBrowser");

  const updateActiveTab = useCallback(
    (updater: (t: PaneTab) => PaneTab) => {
      if (!leaf) return;
      onTabChange({
        ...tab,
        root: updateLeafTabState(tab.root, leaf.id, leaf.activeTabId, updater)
      });
    },
    [leaf, onTabChange, tab]
  );

  const [deviceOptions, setDeviceOptions] = useState<DeviceInfo[]>([]);
  const [deviceLoading, setDeviceLoading] = useState(false);

  const refreshDevices = useCallback(async () => {
    if (!serverBaseUrl.trim()) {
      setDeviceOptions([]);
      return;
    }
    setDeviceLoading(true);
    try {
      const ds = await listDevices({ serverBaseUrl, token, deviceId, deviceToken });
      setDeviceOptions(ds);
    } catch {
      try {
        const snaps = await listSnapshots({ serverBaseUrl, token, deviceId, deviceToken });
        const names = Array.from(new Set(snaps.map((s) => s.device_name).filter((x) => x)));
        setDeviceOptions(names.map((name, idx) => ({ id: `snapshot-${idx}`, name, os: "", last_seen_unix: null })));
      } catch {
        setDeviceOptions([]);
      }
    } finally {
      setDeviceLoading(false);
    }
  }, [deviceId, deviceToken, serverBaseUrl, token]);

  useEffect(() => {
    refreshDevices();
  }, [refreshDevices]);

  const deviceNames = useMemo(() => {
    const names = deviceOptions.map((d) => d.name).filter((x) => x);
    if (active.pane === "deviceBrowser" && active.state.deviceName) {
      names.push(active.state.deviceName);
    }
    return Array.from(new Set(names)).sort();
  }, [active, deviceOptions]);

  const sourceValue = useMemo(() => {
    if (active.pane === "localBrowser") return SOURCE_LOCAL;
    if (active.pane === "sftpBrowser") return SOURCE_SFTP;
    if (active.pane === "transferQueue") return SOURCE_QUEUE;
    if (active.pane === "notes") return SOURCE_NOTES;
    if (active.pane === "deviceBrowser") {
      return active.state.deviceName
        ? `${SOURCE_DEVICE_PREFIX}${active.state.deviceName}`
        : SOURCE_DEVICE_NONE;
    }
    return SOURCE_LOCAL;
  }, [active]);

  const onSourceChange = useCallback(
    (value: string) => {
    if (value === SOURCE_LOCAL) {
      updateActiveTab((t) => toTab("localBrowser", t));
      return;
    }
    if (value === SOURCE_SFTP) {
      updateActiveTab((t) => toTab("sftpBrowser", t));
      return;
    }
    if (value === SOURCE_QUEUE) {
      updateActiveTab((t) => toTab("transferQueue", t));
      return;
    }
    if (value === SOURCE_NOTES) {
      updateActiveTab((t) => toTab("notes", t));
      return;
    }
      if (value.startsWith(SOURCE_DEVICE_PREFIX)) {
        const name = value.slice(SOURCE_DEVICE_PREFIX.length);
        updateActiveTab((t) => {
          let next = toTab("deviceBrowser", t);
          if (next.pane !== "deviceBrowser") return next;
          const deviceName = name === "none" ? "" : name;
          return {
            ...next,
            state: {
              ...next.state,
              deviceName,
              snapshotId: "",
              path: ""
            }
          };
        });
      }
    },
    [updateActiveTab]
  );

  return (
    <div className="workspace-inner">
      <div className="pane">
        <div className="pane-titlebar">
          <span className="pane-title">{t("workspace.source.label")}</span>
          <select
            className="pane-select"
            value={sourceValue}
            onChange={(e) => onSourceChange(e.target.value)}
            aria-label={t("workspace.source.aria")}
          >
            <option value={SOURCE_LOCAL}>{t("workspace.source.local")}</option>
            <option value={SOURCE_SFTP}>{t("workspace.source.sftp")}</option>
            <option value={SOURCE_QUEUE}>{t("workspace.source.queue")}</option>
            <option value={SOURCE_NOTES}>{t("workspace.source.notes")}</option>
            <option value={SOURCE_DEVICE_NONE}>{t("workspace.source.serverDevice")}</option>
            {deviceNames.length > 0 ? (
              <optgroup label={t("workspace.source.serverDevicesGroup")}>
                {deviceNames.map((name) => (
                  <option key={name} value={`${SOURCE_DEVICE_PREFIX}${name}`}>
                    {name}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
          <button
            className="pane-btn"
            onClick={refreshDevices}
            disabled={deviceLoading || !serverBaseUrl.trim()}
            title={t("workspace.actions.refreshDevicesTitle")}
          >
            {t("workspace.actions.refreshDevices")}
          </button>
          <span className="pane-spacer" />
        </div>

        <div className="pane-body">
          <PaneView
            tab={active as PaneTab}
            settings={settings}
            onUpdateTab={updateActiveTab}
            transfers={transfers}
            onUpdateTransfer={onUpdateTransfer}
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
            onSetDeviceAuth={onSetDeviceAuth}
          />
        </div>
      </div>
    </div>
  );
}
