import type { DropZone, LeafNode, PaneKind, SplitDir, PaneTab } from "../../model/layout";
import { activeTab, displayTabTitle } from "../../model/layout";
import type { Settings } from "../../model/settings";
import type { TransferJob } from "../../model/transfers";
import { PaneView } from "../panes/PaneView";

const PANE_LABELS: Record<PaneKind, string> = {
  deviceBrowser: "Device Browser",
  transferQueue: "Transfer Queue",
  notes: "Notes"
};

export default function LeafPane(props: {
  node: LeafNode;
  settings: Settings;
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
  onEnqueueCopyFolder: (job: {
    src: import("../../model/transfers").Conn;
    srcSnapshotId: string;
    srcDirPath: string;
    dst: import("../../model/transfers").Conn;
    dstDeviceName: string;
    dstDeviceId?: string;
    dstDirPath: string;
  }) => void;
  onRemoveTransfer: (id: string) => void;
  onRunTransfer: (id: string) => Promise<void>;
  onCancelTransfer: (id: string) => void;
  onSetDeviceAuth: (deviceId: string, deviceToken: string) => void;
  draggingLeafId: string | null;
  setDraggingLeafId: (id: string | null) => void;
  onDrop: (sourceLeafId: string, targetLeafId: string, zone: DropZone) => void;
  onSplit: (dir: SplitDir) => void;
  onClose: () => void;
  onSetPane: (pane: PaneKind) => void;
  onAddTab: (pane: PaneKind) => void;
  onSetActiveTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onUpdateActiveTab: (updater: (tab: PaneTab) => PaneTab) => void;
}) {
  const {
    node,
    settings,
    transfers,
    onEnqueueDownload,
    onEnqueueCopy,
    onEnqueueCopyFolder,
    onRemoveTransfer,
    onRunTransfer,
    onCancelTransfer,
    onSetDeviceAuth,
    draggingLeafId,
    setDraggingLeafId,
    onDrop,
    onSplit,
    onClose,
    onSetPane,
    onAddTab,
    onSetActiveTab,
    onCloseTab,
    onUpdateActiveTab
  } = props;

  const dragging = draggingLeafId !== null;
  const canDrop = dragging && draggingLeafId !== node.id;
  const tab = activeTab(node);

  return (
    <div className="pane">
      <div className="pane-titlebar">
        <span
          className="drag-handle"
          title="Drag to dock/split"
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
        <div className="pane-tabs" role="tablist" aria-label="Pane tabs">
          {node.tabs.map((t) => (
            <button
              key={t.id}
              className={t.id === node.activeTabId ? "pane-tab active" : "pane-tab"}
              onClick={() => onSetActiveTab(t.id)}
              title={displayTabTitle(t as any)}
            >
              <span className="pane-tab-label">{displayTabTitle(t as any)}</span>
              {node.tabs.length > 1 ? (
                <span
                  className="pane-tab-close"
                  title="Close tab"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(t.id);
                  }}
                >
                  x
                </span>
              ) : null}
            </button>
          ))}
          <button className="pane-tab add" onClick={() => onAddTab(tab.pane)} title="New tab">
            +
          </button>
        </div>

        <div className="pane-spacer" />

        <select
          className="pane-select"
          value={tab.pane}
          onChange={(e) => onSetPane(e.target.value as PaneKind)}
          aria-label="Pane type"
        >
          <option value="deviceBrowser">Device Browser</option>
          <option value="transferQueue">Transfer Queue</option>
          <option value="notes">Notes</option>
        </select>

        <button className="pane-btn" onClick={() => onSplit("row")} title="Split vertical">
          Split |
        </button>
        <button className="pane-btn" onClick={() => onSplit("col")} title="Split horizontal">
          Split -
        </button>

        <button className="pane-btn danger" onClick={onClose} title="Close pane">
          Close
        </button>
      </div>

      {canDrop ? (
        <div className="drop-overlay" aria-label="Drop zones">
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
          onSetPane={onSetPane}
          onUpdateTab={onUpdateActiveTab}
          transfers={transfers}
          onEnqueueDownload={onEnqueueDownload}
          onEnqueueCopy={onEnqueueCopy}
          onEnqueueCopyFolder={onEnqueueCopyFolder}
          onRemoveTransfer={onRemoveTransfer}
          onRunTransfer={onRunTransfer}
          onCancelTransfer={onCancelTransfer}
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
