function chartStep(span: number): number {
  const rough = span / 3;
  if (rough <= 2.5) return 2;
  if (rough <= 7) return 5;
  return Math.max(5, Math.round(rough / 5) * 5);
}

function roundTick(value: number): number {
  return Math.round(value);
}

/** Y range for a small trend chart. At least ±3 around a single value, with distinct rounded ticks. */
export function chartScale(values: number[]): { yMin: number; yMax: number; ticks: number[] } {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const mid = (lo + hi) / 2;
  const half = Math.max((hi - lo) / 2, 3);
  const rawMin = mid - half * 1.2;
  const rawMax = mid + half * 1.2;
  const step = chartStep(rawMax - rawMin);
  const first = Math.ceil((rawMin - 1e-9) / step) * step;
  const last = Math.floor((rawMax + 1e-9) / step) * step;
  const ticks: number[] = [];
  for (let tick = first; tick <= last + step * 0.001; tick += step) ticks.push(roundTick(tick));
  const used = ticks.length >= 3 ? ticks : [roundTick(mid) - step, roundTick(mid), roundTick(mid) + step];
  const pad = step * 0.45;
  return { yMin: used[0] - pad, yMax: used[used.length - 1] + pad, ticks: used };
}

export function trimNum(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function formatPerformance(
  weightLb: number | null,
  reps: number | null,
  measure: string,
  perSide: boolean,
): string {
  if (measure === "cardio") return "Cardio";
  const side = perSide ? " / side" : "";
  if (measure === "meters") {
    const load = weightLb && weightLb > 0 ? `${trimNum(weightLb)} lb` : "Bodyweight";
    const distance = reps == null ? "—" : `${trimNum(reps)} m`;
    return `${load} × ${distance}`;
  }
  if (!(weightLb && weightLb > 0)) {
    if (reps == null) return "—";
    return `${trimNum(reps)} reps${side}`;
  }
  return `${trimNum(weightLb)} lb × ${reps == null ? "—" : trimNum(reps)}${side}`;
}

export function prescriptionLine(
  name: string,
  sets: number,
  repsLabel: string,
  isCardio: boolean,
  notes: string | null,
): string {
  if (isCardio) return notes?.trim() || name;
  return `${name} · ${sets}×${repsLabel}`;
}
