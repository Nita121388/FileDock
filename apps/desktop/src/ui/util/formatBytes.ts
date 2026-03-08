const FORMAT_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatBytes(size?: number | null): string {
  if (!size || size <= 0) return "0 B";
  let value = size;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < FORMAT_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const fixed = unitIndex === 0 ? 0 : value < 10 ? 1 : 0;
  return `${value.toFixed(fixed)} ${FORMAT_UNITS[unitIndex]}`;
}
