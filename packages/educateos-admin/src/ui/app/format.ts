// How numbers are shown. Figures from Cloudflare's sampled (adaptive) datasets are estimates, and
// are labelled so: a leading "≈" and an "estimated" note beside them.

/** A count, compacted: 1,234 or 1.2M. */
export function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: value >= 100_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

/** A count from sampled data. */
export function estimate(value: number, sampled: boolean): string {
  return sampled ? `≈ ${formatCount(value)}` : formatCount(value);
}

/** Bytes as KB, MB or GB. */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value)} ${units[unit]}`;
}

/** US dollars from billionths (the AI guard ledger's unit, ADR-0008), to the cent. */
export function formatUsdNanos(nanos: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Math.ceil(nanos / 10_000_000) / 100);
}

/** A share as a percentage. */
export function formatPercent(part: number, whole: number): string {
  if (whole === 0) return "0%";
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format((part / whole) * 100)}%`;
}

/** A timestamp in the operator's locale. */
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}
