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
      <h1>History</h1>
      <Banner text={error} />
      {!items && !error && <p className="quiet">Loading…</p>}
      {items && items.length === 0 && <p className="quiet">No workouts yet.</p>}
      {items?.map((item) => (
        <button key={item.id} type="button" className="hist" onClick={() => go(`/workout/session/${item.id}`)}>
          <strong>{item.name}</strong>
          <div className="quiet">
            {item.weekday} · {item.dateLabel}
          </div>
          <div className="quiet">
            {item.durationLabel}
            {item.prCount > 0 ? ` · ${item.prCount} PR${item.prCount === 1 ? "" : "s"}` : ""}
          </div>
        </button>
      ))}
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
          <p className="kicker">Best set</p>
          <h1>{data.name}</h1>
          <p className="hero-sm">{data.best?.label ?? "—"}</p>
          {data.best?.e1rm != null && <p className="quiet">Estimated 1RM {data.best.e1rm} lb</p>}
          {data.best?.dateLabel && <p className="quiet">{data.best.dateLabel}</p>}
          <section className="card">
            {data.series.length === 0 ? (
              <p className="quiet">No sets logged yet.</p>
            ) : (
              <TrendChart
                points={data.series.map((point) => ({ date: point.date, dot: point.value, line: null }))}
                dotLabel={data.chartLabel}
              />
            )}
          </section>
          <h2>Recent sessions</h2>
          {data.sessions.length === 0 && <p className="quiet">Nothing yet.</p>}
          {data.sessions.map((session) => (
            <section className="card" key={session.sessionId}>
              <button type="button" className="ex-name" onClick={() => go(`/workout/session/${session.sessionId}`)}>
                {session.dateLabel}
              </button>
              <p className="quiet">{session.workoutName}</p>
              <ul className="sets">
                {session.sets.map((set, index) => (
                  <li key={`${session.sessionId}-${index}`}>
                    <span>{set.label}</span>
                    {set.isPr && <span className="pr">PR</span>}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </>
  );
}
