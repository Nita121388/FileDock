import type { PaneKind } from "../../model/layout";
import DeviceBrowserPane from "./device/DeviceBrowserPane";
import NotesPane from "./notes/NotesPane";
import TransferQueuePane from "./transfer/TransferQueuePane";

export function PaneView(props: { pane: PaneKind }) {
  switch (props.pane) {
    case "deviceBrowser":
      return <DeviceBrowserPane />;
    case "transferQueue":
      return <TransferQueuePane />;
    case "notes":
      return <NotesPane />;
    default:
      return <div />;
  }
}

