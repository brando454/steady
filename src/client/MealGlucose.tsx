import { useState } from "react";
import { glucoseBand } from "../shared/workoutGlucose";
import {
  MEAL_GLUCOSE_AFTER_MIN,
  MEAL_GLUCOSE_BEFORE_MIN,
  mealGlucoseLine,
  mealSparklinePaths,
  type MealGlucose,
} from "../shared/mealGlucose";

function text(value: number | null): string {
  return value == null ? "—" : String(value);
}

function Sparkline({ summary }: { summary: MealGlucose }) {
  const width = 280;
  const height = 44;
  const span = MEAL_GLUCOSE_BEFORE_MIN + MEAL_GLUCOSE_AFTER_MIN;
  const values = summary.points.map((point) => point.mgdl);
  const min = values.length ? Math.min(...values) : 80;
  const max = values.length ? Math.max(...values) : 180;
  const pad = Math.max(8, (max - min) * 0.2);
  const yMin = min - pad;
  const yMax = max + pad || yMin + 1;
  const xAt = (minute: number) => Math.max(0, Math.min(width, ((minute + MEAL_GLUCOSE_BEFORE_MIN) / span) * width));
  const yAt = (mgdl: number) => 2 + (1 - (mgdl - yMin) / (yMax - yMin)) * (height - 4);
  const groups = mealSparklinePaths(summary.points);
  const mealX = xAt(0);
  return (
    <svg className="mg-spark" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <line x1={mealX} y1="0" x2={mealX} y2={height} className="mg-meal" />
      {groups.map((group) => {
        if (group.length === 1) {
          const point = group[0];
          return <circle key={`${point.minute}-${point.mgdl}`} cx={xAt(point.minute)} cy={yAt(point.mgdl)} r="2.2" className="mg-dot" />;
        }
        const d = group
          .map((point, index) => `${index === 0 ? "M" : "L"}${xAt(point.minute).toFixed(1)},${yAt(point.mgdl).toFixed(1)}`)
          .join("");
        return <path key={d} d={d} className="mg-trace" />;
      })}
    </svg>
  );
}

export function MealGlucoseCard({ summary }: { summary: MealGlucose }) {
  const [open, setOpen] = useState(false);
  const line = mealGlucoseLine(summary);
  if (summary.unavailable || (summary.points.length === 0 && summary.atMgdl == null && summary.peakMgdl == null)) {
    return <p className="quiet mg-line">{line}</p>;
  }
  const band = glucoseBand(summary.lowAfterMgdl);
  const tone = band === "low" ? " low" : band === "high" ? " high" : "";
  const rise = summary.riseMgdl == null ? "—" : `${summary.riseMgdl > 0 ? "+" : ""}${summary.riseMgdl}`;
  return (
    <div className="mg">
      <button type="button" className="mg-toggle" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        {line}
      </button>
      {open && (
        <div>
          <Sparkline summary={summary} />
          <div className="mg-stats">
            <div className="mg-stat">
              <span className="k">At meal</span>
              <span className="v">{text(summary.atMgdl)}</span>
            </div>
            <div className="mg-stat">
              <span className="k">Peak</span>
              <span className="v">{text(summary.peakMgdl)}</span>
              <span className="k">{summary.peakMinute == null ? "" : `${summary.peakMinute} min`}</span>
            </div>
            <div className="mg-stat">
              <span className="k">Rise</span>
              <span className="v">{rise}</span>
            </div>
            <div className="mg-stat">
              <span className="k">Low</span>
              {summary.lowAfterMgdl == null ? (
                <span className="v">—</span>
              ) : (
                <span className={`glucose-pill${tone}`}>{summary.lowAfterMgdl}</span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
