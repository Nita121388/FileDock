import type { PaneKind, PaneTab } from "../../model/layout";
import type { Settings } from "../../model/settings";
import DeviceBrowserPane from "./device/DeviceBrowserPane";
import NotesPane from "./notes/NotesPane";
import TransferQueuePane from "./transfer/TransferQueuePane";

export function PaneView(props: {
  tab: PaneTab;
  settings: Settings;
  onSetPane: (pane: PaneKind) => void;
  onUpdateTab: (updater: (tab: PaneTab) => PaneTab) => void;
}) {
  switch (props.tab.pane) {
    case "deviceBrowser":
      return (
        <DeviceBrowserPane
          settings={props.settings}
          tab={props.tab}
          onTabChange={(next) => props.onUpdateTab(() => next)}
        />
      );
    case "transferQueue":
      return <TransferQueuePane />;
    case "notes":
      return <NotesPane />;
    default:
      return <div />;
  }
}
