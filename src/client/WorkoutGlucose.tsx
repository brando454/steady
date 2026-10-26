import { glucoseBand, sparklinePaths, type WorkoutGlucose } from "../shared/workoutGlucose";

function text(value: number | null): string {
  return value == null ? "—" : String(value);
}

function label(summary: WorkoutGlucose): string {
  const n = (value: number | null) => (value == null ? "missing" : `${value} mg/dL`);
  const state = summary.unavailable ? "unavailable" : summary.inProgress ? "in progress" : "complete";
  return `Workout glucose ${state}. Start ${n(summary.startMgdl)}, end ${n(summary.endMgdl)}, average ${n(summary.averageMgdl)}, lowest during ${n(summary.lowDuringMgdl)}, lowest in the two hours after ${n(summary.lowAfterMgdl)}.`;
}

function Sparkline({ summary }: { summary: WorkoutGlucose }) {
  if (summary.points.length === 0 || summary.windowMinutes <= 0) return null;
  const width = 280;
  const height = 36;
  const values = summary.points.map((point) => point.mgdl);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max(8, (max - min) * 0.2);
  const yMin = min - pad;
  const yMax = max + pad || yMin + 1;
  const xAt = (minute: number) => Math.max(0, Math.min(width, (minute / summary.windowMinutes) * width));
  const yAt = (mgdl: number) => 2 + (1 - (mgdl - yMin) / (yMax - yMin)) * (height - 4);
  const shade = xAt(summary.workoutMinutes);
  const groups = sparklinePaths(summary.points);
  return (
    <svg className="wg-spark" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <rect x="0" y="0" width={shade} height={height} className="wg-shade" />
      {groups.map((group) => {
        if (group.length === 1) {
          const point = group[0];
          return <circle key={`${point.minute}-${point.mgdl}`} cx={xAt(point.minute)} cy={yAt(point.mgdl)} r="2.2" className="wg-dot" />;
        }
        const d = group
          .map((point, index) => `${index === 0 ? "M" : "L"}${xAt(point.minute).toFixed(1)},${yAt(point.mgdl).toFixed(1)}`)
          .join("");
        return <path key={d} d={d} className="wg-line" />;
      })}
    </svg>
  );
}

export function WorkoutGlucoseView({ summary }: { summary: WorkoutGlucose }) {
  if (summary.unavailable && !summary.inProgress) {
    return <p className="quiet">Glucose unavailable</p>;
  }
  const band = glucoseBand(summary.lowAfterMgdl);
  const tone = band === "low" ? " low" : band === "high" ? " high" : "";
  const after = summary.lowAfterMgdl;
  return (
    <div className="wg" aria-label={label(summary)}>
      <div className="wg-head">
        <p className="quiet">Glucose</p>
        {summary.inProgress && <p className="quiet">In progress</p>}
      </div>
      <Sparkline summary={summary} />
      <div className="wg-stats">
        <div className="wg-stat">
          <span className="k">Start</span>
          <span className="v">{text(summary.startMgdl)}</span>
        </div>
        <div className="wg-stat">
          <span className="k">End</span>
          <span className="v">{text(summary.endMgdl)}</span>
        </div>
        <div className="wg-stat">
          <span className="k">Avg</span>
          <span className="v">{text(summary.averageMgdl)}</span>
        </div>
        <div className="wg-stat">
          <span className="k">Low</span>
          <span className="v">{text(summary.lowDuringMgdl)}</span>
        </div>
        <div className="wg-stat after">
          <span className="k">2h low</span>
          {after == null ? (
            <span className="v">—</span>
          ) : (
            <span className={`glucose-pill${tone}`}>{after}</span>
          )}
        </div>
      </div>
    </div>
  );
}
