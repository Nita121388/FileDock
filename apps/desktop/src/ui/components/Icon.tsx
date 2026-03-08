type IconName =
  | "backup"
  | "close"
  | "delete"
  | "download"
  | "folderOpen"
  | "folderPlus"
  | "help"
  | "move"
  | "moon"
  | "plus"
  | "refresh"
  | "rename"
  | "save"
  | "settings"
  | "sun"
  | "terminal"
  | "up"
  | "viewAdd";

export default function Icon(props: { name: IconName; className?: string }) {
  const { name, className } = props;
  const classes = className ? `icon-svg ${className}` : "icon-svg";

  switch (name) {
    case "backup":
      return (
        <svg className={classes} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3.5 11.5h9a1.5 1.5 0 0 0 0-3 4.5 4.5 0 0 0-8.7-1.6A3 3 0 0 0 3.5 11.5Z" />
          <path d="M8 11V5.5" />
          <path d="m5.75 7.75 2.25-2.25 2.25 2.25" />
        </svg>
      );
    case "close":
      return (
        <svg className={classes} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="m4 4 8 8" />
          <path d="m12 4-8 8" />
        </svg>
      );
    case "delete":
      return (
        <svg className={classes} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3.5 4.5h9" />
          <path d="M6 4.5V3.4c0-.5.4-.9.9-.9h2.2c.5 0 .9.4.9.9v1.1" />
          <path d="M5 6.5v5.2c0 .7.6 1.3 1.3 1.3h3.4c.7 0 1.3-.6 1.3-1.3V6.5" />
          <path d="M6.8 7.2v4.1" />
          <path d="M9.2 7.2v4.1" />
        </svg>
      );
    case "download":
      return (
        <svg className={classes} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 3.25v6.5" />
          <path d="m5.75 7.5 2.25 2.25 2.25-2.25" />
          <path d="M3.5 11.75h9" />
        </svg>
      );
    case "folderOpen":
      return (
        <svg className={classes} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M2.75 5.25h3l1.1-1.5h2.4c.5 0 .9.4.9.9v.6" />
          <path d="M2.75 5.75h10.5l-1.1 5.1c-.1.6-.7 1-1.3 1H4.2c-.6 0-1.1-.4-1.2-1l-.25-1.4" />
        </svg>
      );
    case "folderPlus":
      return (
        <svg className={classes} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M2.75 5h3l1.1-1.5h6.15c.7 0 1.25.55 1.25 1.25v5.5c0 .7-.55 1.25-1.25 1.25H2.75c-.7 0-1.25-.55-1.25-1.25v-4c0-.7.55-1.25 1.25-1.25Z" />
          <path d="M8 6.5v3" />
          <path d="M6.5 8h3" />
        </svg>
      );
    case "help":
      return (
        <svg className={classes} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="5.75" />
          <path d="M6.6 6.2A1.8 1.8 0 0 1 8.1 5.2c1 0 1.8.7 1.8 1.6 0 .8-.5 1.2-1.1 1.6-.5.3-.8.6-.8 1.2" />
          <path d="M8 11.6h.01" />
        </svg>
      );
    case "move":
      return (
        <svg className={classes} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 3v10" />
          <path d="m5.75 5.25 2.25-2.25 2.25 2.25" />
          <path d="m5.75 10.75 2.25 2.25 2.25-2.25" />
          <path d="M3 8h10" />
          <path d="m5.25 5.75-2.25 2.25 2.25 2.25" />
          <path d="m10.75 5.75 2.25 2.25-2.25 2.25" />
        </svg>
      );
    case "moon":
      return (
        <svg className={classes} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M10.9 2.8a5.3 5.3 0 1 0 2.3 9.9A5.8 5.8 0 0 1 10.9 2.8Z" />
        </svg>
      );
    case "plus":
      return (
        <svg className={classes} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 3.25v9.5" />
          <path d="M3.25 8h9.5" />
        </svg>
      );
    case "refresh":
      return (
        <svg className={classes} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M12.25 6a4.5 4.5 0 1 0 1 3" />
          <path d="M12.25 3.75V6h-2.25" />
        </svg>
      );
    case "rename":
      return (
        <svg className={classes} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="m10.9 3.1 2 2a1 1 0 0 1 0 1.4l-6.7 6.7-3 .6.6-3 6.7-6.7a1 1 0 0 1 1.4 0Z" />
          <path d="m9.9 4.1 2 2" />
        </svg>
      );
    case "save":
      return (
        <svg className={classes} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3.25 2.75h7.9l1.6 1.6v8.9H3.25Z" />
          <path d="M5 2.75v3h4v-3" />
          <path d="M5.25 12h5.5v-3h-5.5Z" />
        </svg>
      );
    case "settings":
      return (
        <svg className={classes} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M6.4 2.9h3.2l.5 1.3 1.4.6 1.3-.5 1.6 2.8-1 .9v1.6l1 .9-1.6 2.8-1.3-.5-1.4.6-.5 1.3H6.4l-.5-1.3-1.4-.6-1.3.5-1.6-2.8 1-.9V8.3l-1-.9 1.6-2.8 1.3.5 1.4-.6.5-1.3Z" />
          <circle cx="8" cy="8" r="1.9" />
        </svg>
      );
    case "sun":
      return (
        <svg className={classes} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="2.6" />
          <path d="M8 1.75v1.5" />
          <path d="M8 12.75v1.5" />
          <path d="M3.58 3.58 4.64 4.64" />
          <path d="m11.36 11.36 1.06 1.06" />
          <path d="M1.75 8h1.5" />
          <path d="M12.75 8h1.5" />
          <path d="m11.36 4.64 1.06-1.06" />
          <path d="M3.58 12.42 4.64 11.36" />
        </svg>
      );
    case "terminal":
      return (
        <svg className={classes} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="2.25" y="3" width="11.5" height="10" rx="1.5" />
          <path d="m4.75 6 1.75 1.75L4.75 9.5" />
          <path d="M8 9.75h3.25" />
        </svg>
      );
    case "up":
      return (
        <svg className={classes} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 12.75V3.25" />
          <path d="m4.75 6.5 3.25-3.25 3.25 3.25" />
        </svg>
      );
    case "viewAdd":
      return (
        <svg className={classes} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="2.25" y="2.75" width="11.5" height="10.5" rx="1.5" />
          <path d="M8 2.75v10.5" opacity="0.55" />
          <path d="M2.25 8h11.5" opacity="0.55" />
          <path d="M12 12.75v-3.5" />
          <path d="M10.25 11h3.5" />
        </svg>
      );
  }

  return null;
}
