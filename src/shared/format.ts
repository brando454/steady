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
