import type { PaneKind } from "../../model/layout";
import type { Settings } from "../../model/settings";
import DeviceBrowserPane from "./device/DeviceBrowserPane";
import NotesPane from "./notes/NotesPane";
import TransferQueuePane from "./transfer/TransferQueuePane";

export function PaneView(props: { pane: PaneKind; settings: Settings }) {
  switch (props.pane) {
    case "deviceBrowser":
      return <DeviceBrowserPane settings={props.settings} />;
    case "transferQueue":
      return <TransferQueuePane />;
    case "notes":
      return <NotesPane />;
    default:
      return <div />;
  }
}
