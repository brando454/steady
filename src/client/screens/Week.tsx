import { useEffect, useState } from "react";
import { api, messageOf } from "../api";
import type { SessionDTO, WeekDTO } from "../../shared/types";
import { rememberMainScroll, useRestoreMainScroll } from "../scroll";
import { Back, Banner, useNav } from "../ui";

export function WeekScreen({ dayId }: { dayId?: string }) {
  const { go } = useNav();
  const [week, setWeek] = useState<WeekDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const here = dayId ? `/workout/day/${dayId}` : "/workout";
  useRestoreMainScroll(here, Boolean(week));

  useEffect(() => {
    let stop = false;
    api<WeekDTO>("/api/week")
      .then((data) => {
        if (!stop) setWeek(data);
      })
      .catch((err) => {
        if (!stop) setError(messageOf(err));
      });
    return () => {
      stop = true;
    };
  }, []);

  async function start(id: string) {
    rememberMainScroll(here, id);
    setBusy(true);
    setError(null);
    try {
      const session = await api<SessionDTO>("/api/sessions", { method: "POST", body: JSON.stringify({ dayId: id }) });
      go(`/workout/session/${session.id}`);
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  }

  if (!week) {
    return (
      <>
        <Banner text={error} />
        {!error && <p className="quiet">Loading the week…</p>}
      </>
    );
  }

  const day = dayId ? week.days.find((item) => item.id === dayId) : null;
  if (dayId) {
    return (
      <>
        <Back to="/workout" label="This week" />
        <Banner text={error} />
        {!day ? (
          <p>That day isn&apos;t in this week.</p>
        ) : (
          <>
            <p className="quiet">{day.suggested ? "Up next" : day.status === "done" ? `Done ${day.doneWeekday ?? ""}`.trim() : "This week"}</p>
            <h1>{day.name}</h1>
            <p className="quiet">{day.summary}</p>
            {week.rampNote && <p className="ramp">{week.rampNote}</p>}
            <section className="card plan">
              <ul className="lines">
                {day.exercises.map((exercise) => (
                  <li key={exercise.name}>
                    <strong>{exercise.name}</strong>
                    <div className="quiet">{exercise.detail}</div>
                  </li>
                ))}
              </ul>
            </section>
            <button type="button" className="primary plan-start" disabled={busy} onClick={() => start(day.id)}>
              {day.status === "in_progress" ? "Resume workout" : day.status === "done" ? "Start again" : "Start workout"}
            </button>
          </>
        )}
      </>
    );
  }

  const next = week.days.find((item) => item.suggested) ?? week.days.find((item) => item.status !== "done") ?? null;
  const startName = next ? (next.status === "in_progress" ? `Resume ${next.name}` : `Start ${next.name}`) : null;

  return (
    <>
      <div className="top title-row">
        <h1>This week</h1>
        <span>
          {week.doneCount} of {week.total} done
        </span>
      </div>
      <Banner text={error} />
      <div className="progress" aria-hidden="true">
        {week.days.map((item) => (
          <i key={item.id} className={item.status === "done" ? "on" : ""} />
        ))}
      </div>
      {week.rampNote && <p className="quiet ramp-line">{week.rampNote}</p>}
      <section className="card day-list">
        {week.days.map((item) => {
          const status =
            item.status === "done"
              ? `Done ${item.doneWeekday ?? ""}`.trim()
              : item.status === "in_progress"
                ? "In progress"
                : item.suggested
                  ? "Up next"
                  : "";
          return (
            <button
              key={item.id}
              type="button"
              className={item.suggested ? "day-row next" : item.status === "done" ? "day-row done" : "day-row"}
              data-scroll-anchor={item.id}
              onClick={() => {
                rememberMainScroll("/workout", item.id);
                go(`/workout/day/${item.id}`);
              }}
            >
              <span>
                <strong>{item.name}</strong>
                <small className="quiet">{item.summary}</small>
              </span>
              <span className="status">{status}</span>
            </button>
          );
        })}
        <p className="quiet">Tap any day to start it or see its exercises. Order is up to you, and unfinished days roll off when the week ends.</p>
      </section>
      {next && startName && (
        <button type="button" className="primary" disabled={busy} onClick={() => start(next.id)}>
          {startName}
        </button>
      )}
      <div className="history-link" data-scroll-anchor="history">
        <span className="quiet">Recent sessions and PRs</span>
        <button
          type="button"
          className="pill"
          onClick={() => {
            rememberMainScroll("/workout", "history");
            go("/history");
          }}
        >
          History
        </button>
      </div>
    </>
  );
}
