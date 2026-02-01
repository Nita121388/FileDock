import { useState } from "react";

import type { TabState } from "../model/state";
import type { LayoutNode } from "../model/layout";
import type { Settings } from "../model/settings";
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
  onTabChange: (tab: TabState) => void;
}) {
  const { tab, settings, onTabChange } = props;
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
