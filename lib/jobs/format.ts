// Small display formatters for the dashboard. Hungarian locale, calm output.

const HU = "hu-HU";

export function formatUsd(usd: number): string {
  return `$${usd.toFixed(usd >= 1 ? 2 : 3)}`;
}

export function formatWords(words: number): string {
  return new Intl.NumberFormat(HU).format(words);
}

export function formatEta(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return undefined;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `~${totalSec} mp`;
  const totalMin = Math.round(totalSec / 60);
  if (totalMin < 60) return `~${totalMin} perc`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return mins ? `~${hours} ó ${mins} p` : `~${hours} óra`;
}

export function formatSpeed(chunksPerMin: number | undefined): string | undefined {
  if (chunksPerMin === undefined || !Number.isFinite(chunksPerMin) || chunksPerMin <= 0) return undefined;
  return `${chunksPerMin.toFixed(chunksPerMin >= 10 ? 0 : 1)} szakasz/perc`;
}

export function formatRelative(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return undefined;
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 10) return "az imént";
  if (diffSec < 60) return `${diffSec} mp-e`;
  const min = Math.round(diffSec / 60);
  if (min < 60) return `${min} perce`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours} órája`;
  const days = Math.round(hours / 24);
  return `${days} napja`;
}

export function formatDate(iso: string | undefined): string {
  if (!iso) return "—";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "—";
  return new Intl.DateTimeFormat(HU, { year: "numeric", month: "short", day: "numeric" }).format(ts);
}
