import { useState } from "react";
import { formatInt, formatQty } from "./api";
import { SPARK_GAP_MINUTES, sparklinePaths } from "../shared/workoutGlucose";
import type { DayGlucose, DayMarker } from "../shared/mealGlucose";

function caption(marker: DayMarker): string {
  if (marker.kind === "workout") return marker.name;
  const calories = marker.calories ?? 0;
  const carbs = marker.carbs ?? 0;
  const protein = marker.protein ?? 0;
  const fat = marker.fat ?? 0;
  return `${marker.name}. ${formatInt(calories)} kcal, ${formatQty(carbs)} g carbs, ${formatQty(protein)} g protein, ${formatQty(fat)} g fat`;
}

export function DayGlucoseChart({ day }: { day: DayGlucose }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = day.markers.find((marker) => marker.id === selectedId) ?? null;
  if (day.unavailable && day.points.length === 0) {
    return (
      <section className="card day-glucose">
        <h2>Glucose</h2>
        <p className="quiet">Glucose unavailable</p>
      </section>
    );
  }
  const width = 320;
  const height = 112;
  const span = Math.max(day.spanMinutes, 1);
  const values = day.points.map((point) => point.mgdl);
  const min = values.length ? Math.min(...values) : 70;
  const max = values.length ? Math.max(...values) : 180;
  const pad = Math.max(10, (max - min) * 0.18);
  const yMin = min - pad;
  const yMax = max + pad || yMin + 1;
  const xAt = (minute: number) => Math.max(0, Math.min(width, (minute / span) * width));
  const yAt = (mgdl: number) => 8 + (1 - (mgdl - yMin) / (yMax - yMin)) * (height - 16);
  const groups = sparklinePaths(day.points, SPARK_GAP_MINUTES);
  return (
    <section className="card day-glucose" aria-label="Glucose today">
      <h2>Glucose</h2>
      <div className="day-plot">
        <svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
          {groups.map((group) => {
            if (group.length === 1) {
              const point = group[0];
              return <circle key={`${point.minute}-${point.mgdl}`} cx={xAt(point.minute)} cy={yAt(point.mgdl)} r="2" className="day-dot" />;
            }
            const d = group
              .map((point, index) => `${index === 0 ? "M" : "L"}${xAt(point.minute).toFixed(1)},${yAt(point.mgdl).toFixed(1)}`)
              .join("");
            return <path key={d} d={d} className="day-line" />;
          })}
        </svg>
        {day.markers.map((marker) => {
          if (marker.mgdl == null) return null;
          const left = (xAt(marker.minute) / width) * 100;
          const top = (yAt(marker.mgdl) / height) * 100;
          const on = selectedId === marker.id;
          return (
            <button
              key={`${marker.kind}-${marker.id}`}
              type="button"
              className={marker.kind === "workout" ? "day-mark workout" : "day-mark"}
              style={{ left: `${left}%`, top: `${top}%` }}
              aria-pressed={on}
              aria-label={caption(marker)}
              onClick={() => setSelectedId(on ? null : marker.id)}
            />
          );
        })}
      </div>
      {selected && (
        <div className="day-caption">
          <span className="meal-name">{selected.name}</span>
          {selected.kind === "meal" && (
            <span className="quiet">
              {formatInt(selected.calories ?? 0)} kcal · {formatQty(selected.carbs ?? 0)} g carbs · {formatQty(selected.protein ?? 0)} g protein ·{" "}
              {formatQty(selected.fat ?? 0)} g fat
            </span>
          )}
        </div>
      )}
      {day.points.length === 0 && <p className="quiet">No readings yet</p>}
    </section>
  );
}
