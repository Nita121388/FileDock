export type NoticeLevel = "info" | "warning" | "error";

export type NoticeItem = {
  id: string;
  level: NoticeLevel;
  title: string;
  message: string;
};

export default function NoticeCenter(props: {
  notices: NoticeItem[];
  onDismiss: (id: string) => void;
}) {
  const { notices, onDismiss } = props;

  if (notices.length === 0) return null;

  return (
    <div className="notice-stack" role="status" aria-live="polite">
      {notices.map((notice) => (
        <div key={notice.id} className={`notice ${notice.level}`}>
          <div className="notice-main">
            <div className="notice-title">{notice.title}</div>
            <div className="notice-message">{notice.message}</div>
          </div>
          <button className="notice-close" onClick={() => onDismiss(notice.id)} aria-label="Close">
            x
          </button>
        </div>
      ))}
    </div>
  );
}
