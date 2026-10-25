import type { GlucoseDTO } from "./types";

export function glucoseStatusText(reading: GlucoseDTO): string {
  if (reading.available) {
    const when = reading.minutesAgo === 0 ? "just now" : `${reading.minutesAgo} min ago`;
    return `${reading.mgdl} mg/dL · ${when}`;
  }
  if (reading.reason === "stale" && reading.mgdl != null) {
    const when = reading.minutesAgo === 0 ? "just now" : `${reading.minutesAgo ?? 0} min ago`;
    return `${reading.mgdl} mg/dL · ${when}. Older than 15 minutes.`;
  }
  if (reading.reason === "not_configured") {
    const missing = reading.detail || "NIGHTSCOUT_URL or NIGHTSCOUT_TOKEN";
    return missing.includes(" and ") ? `${missing} aren't set on the server` : `${missing} isn't set on the server`;
  }
  if (reading.reason?.startsWith("http_")) return `Nightscout returned HTTP ${reading.reason.slice("http_".length)}`;
  if (reading.reason === "timeout") return "Nightscout timed out";
  if (reading.reason === "network") {
    return reading.detail ? `Couldn't reach Nightscout (${reading.detail})` : "Couldn't reach Nightscout";
  }
  if (reading.reason === "bad_payload") return "Nightscout's reply wasn't a reading";
  return "Nightscout isn't available";
}
