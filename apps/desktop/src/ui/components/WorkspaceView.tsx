import { useState } from "react";

import type { TabState } from "../model/state";
import type { LayoutNode } from "../model/layout";
import { closeLeaf, moveLeaf, setLeafPane, splitLeaf, updateSplitRatio, type DropZone } from "../model/layout";
import SplitNodeView from "./layout/SplitNodeView";
import LeafPane from "./layout/LeafPane";

export function WorkspaceView(props: { tab: TabState; onTabChange: (tab: TabState) => void }) {
  const { tab, onTabChange } = props;
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
          draggingLeafId={draggingLeafId}
          setDraggingLeafId={setDraggingLeafId}
          onDrop={onDrop}
          onSplit={(dir) => onRootChange(splitLeaf(tab.root, node.id, dir))}
          onClose={() => onRootChange(closeLeaf(tab.root, node.id))}
          onSetPane={(pane) => onRootChange(setLeafPane(tab.root, node.id, pane))}
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
