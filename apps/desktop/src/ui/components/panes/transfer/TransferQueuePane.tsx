import type { TransferJob } from "../../../model/transfers";

export default function TransferQueuePane(props: {
  transfers: TransferJob[];
  onRemove: (id: string) => void;
  onDownload: (id: string) => Promise<void>;
}) {
  const { transfers, onRemove, onDownload } = props;

  return (
    <div className="queue">
      {transfers.length === 0 ? (
        <div className="db-empty">No transfers yet. Queue a file from Device Browser (+Q).</div>
      ) : null}

      {transfers.map((j) => (
        <div key={j.id} className="queue-row">
          <div className="queue-main">
            <div className="queue-title">
              <span className="accent">{j.id}</span>{" "}
              <span className="queue-path">
                {j.snapshotId}:{j.path}
              </span>
            </div>
            <div className="queue-sub">
              <span className={`pill pill-${j.status}`}>{j.status}</span>
              {j.error ? <span className="queue-err">{j.error}</span> : null}
            </div>
          </div>

          <div className="queue-actions">
            <button
              className="db-mini"
              disabled={j.status === "done"}
              onClick={() => onDownload(j.id)}
              title="Download now"
            >
              Download
            </button>
            <button className="db-mini" onClick={() => onRemove(j.id)} title="Remove">
              Remove
            </button>
          </div>
        </div>
      ))}

      <div className="queue-hint">
        Next: drag files between panes to create cross-device transfers.
      </div>
    </div>
  );
}

