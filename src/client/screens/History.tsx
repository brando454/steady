import { useEffect, useState } from "react";
import { api, messageOf } from "../api";
import type { ExerciseHistoryDTO, HistoryItem } from "../../shared/types";
import { Back, Banner, TrendChart, useNav } from "../ui";

export function HistoryScreen() {
  const { go } = useNav();
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    api<HistoryItem[]>("/api/history")
      .then((data) => {
        if (!stop) setItems(data);
      })
      .catch((err) => {
        if (!stop) setError(messageOf(err));
      });
    return () => {
      stop = true;
    };
  }, []);

  return (
    <>
      <Back to="/workout" label="This week" />
      <p className="quiet">Recent sessions</p>
      <h1>History</h1>
      <Banner text={error} />
      {!items && !error && <p className="quiet">Loading…</p>}
      {items && items.length === 0 && <p className="quiet">No workouts yet.</p>}
      {items && items.length > 0 && (
        <section className="card list-card">
          {items.map((item) => (
            <button key={item.id} type="button" className="meal-row" onClick={() => go(`/workout/session/${item.id}`)}>
              <span>
                <span className="meal-name">{item.name}</span>
                <small className="quiet">
                  {item.weekday} · {item.dateLabel}
                </small>
              </span>
              <small className="quiet meal-side">
                {item.durationLabel}
                {item.prCount > 0 ? ` · ${item.prCount} PR${item.prCount === 1 ? "" : "s"}` : ""}
              </small>
            </button>
          ))}
        </section>
      )}
    </>
  );
}

export function ExerciseScreen({ exerciseId, from }: { exerciseId: string; from: string | null }) {
  const { go } = useNav();
  const [data, setData] = useState<ExerciseHistoryDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const back = from && from.startsWith("/") ? from : "/history";

  useEffect(() => {
    let stop = false;
    api<ExerciseHistoryDTO>(`/api/exercises/${encodeURIComponent(exerciseId)}/history`)
      .then((next) => {
        if (!stop) setData(next);
      })
      .catch((err) => {
        if (!stop) setError(messageOf(err));
      });
    return () => {
      stop = true;
    };
  }, [exerciseId]);

  return (
    <>
      <Back to={back} label="Back" />
      <Banner text={error} />
      {!data && !error && <p className="quiet">Loading…</p>}
      {data && (
        <>
          <p className="quiet">History</p>
          <h1>{data.name}</h1>
          <section className="card">
            <div className="split-head">
              <div>
                <p className="quiet">Best set</p>
                <p className="figure">{data.best?.label ?? "—"}</p>
              </div>
              {data.best?.dateLabel && <p className="quiet">{data.best.dateLabel}</p>}
            </div>
            {data.best?.e1rm != null && <p className="quiet">Estimated 1RM {data.best.e1rm} lb</p>}
            {data.series.length === 0 ? (
              <p className="quiet">No sets logged yet.</p>
            ) : (
              <TrendChart
                points={data.series.map((point) => ({ date: point.date, dot: point.value, line: null }))}
                dotLabel={data.chartLabel}
              />
            )}
            <p className="quiet">Top set each session.</p>
          </section>
          <section className="card list-card">
            {data.sessions.length === 0 && <p className="quiet">Nothing yet.</p>}
            {data.sessions.map((session) => {
              const top = session.sets[0];
              const pr = session.sets.some((set) => set.isPr);
              return (
                <button key={session.sessionId} type="button" className="meal-row" onClick={() => go(`/workout/session/${session.sessionId}`)}>
                  <span>
                    <span className="meal-name">{top?.label ?? session.workoutName}</span>
                    <small className="quiet">{session.dateLabel}</small>
                  </span>
                  <small className="quiet meal-side">{pr ? "PR" : session.workoutName}</small>
                </button>
              );
            })}
          </section>
        </>
      )}
    </>
  );
}
