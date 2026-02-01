import type { LeafNode, PaneKind, SplitDir } from "../../model/layout";
import { PaneView } from "../panes/PaneView";

const PANE_LABELS: Record<PaneKind, string> = {
  deviceBrowser: "Device Browser",
  transferQueue: "Transfer Queue",
  notes: "Notes"
};

export default function LeafPane(props: {
  node: LeafNode;
  onSplit: (dir: SplitDir) => void;
  onClose: () => void;
  onSetPane: (pane: PaneKind) => void;
}) {
  const { node, onSplit, onClose, onSetPane } = props;

  return (
    <div className="pane">
      <div className="pane-titlebar">
        <div className="pane-title">{PANE_LABELS[node.pane]}</div>

        <div className="pane-spacer" />

        <select
          className="pane-select"
          value={node.pane}
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

      <div className="pane-body">
        <PaneView pane={node.pane} />
      </div>
    </div>
  );
}

