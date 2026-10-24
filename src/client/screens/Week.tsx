import { useEffect, useState } from "react";
import { api, messageOf } from "../api";
import type { SessionDTO, WeekDTO } from "../../shared/types";
import { Back, Banner, useNav } from "../ui";

export function WeekScreen({ dayId }: { dayId?: string }) {
  const { go } = useNav();
  const [week, setWeek] = useState<WeekDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
            <p className="kicker">{day.suggested ? "Suggested" : day.status === "done" ? `Done ${day.doneWeekday ?? ""}`.trim() : "This week"}</p>
            <h1>{day.name}</h1>
            <p className="quiet">{day.summary}</p>
            {week.rampNote && <p className="ramp">{week.rampNote}</p>}
            <ul className="lines card">
              {day.exercises.map((exercise) => (
                <li key={exercise.name}>
                  <strong>{exercise.name}</strong>
                  <div className="quiet">{exercise.detail}</div>
                </li>
              ))}
            </ul>
            <button type="button" className="primary" disabled={busy} onClick={() => start(day.id)}>
              {day.status === "in_progress" ? "Resume workout" : day.status === "done" ? "Start again" : "Start workout"}
            </button>
          </>
        )}
      </>
    );
  }

  return (
    <>
      <div className="top">
        <span>{week.rangeLabel}</span>
        <strong>
          {week.doneCount} of {week.total}
        </strong>
      </div>
      <h1>This week</h1>
      <Banner text={error} />
      <div className="progress" aria-hidden="true">
        {week.days.map((item) => (
          <i key={item.id} className={item.status === "done" ? "on" : ""} />
        ))}
      </div>
      {week.rampNote && <p className="ramp">{week.rampNote}</p>}
      <p className="quiet">The week starts Monday. Unfinished days roll off and don&apos;t pile up.</p>
      {week.days.map((item) => (
        <button
          key={item.id}
          type="button"
          className={item.suggested ? "day suggested" : "day"}
          onClick={() => go(`/workout/day/${item.id}`)}
        >
          <strong>{item.name}</strong>
          <div className="status">
            {item.status === "done"
              ? `Done ${item.doneWeekday ?? ""}`.trim()
              : item.status === "in_progress"
                ? "In progress"
                : item.suggested
                  ? "Suggested"
                  : "Not started"}
          </div>
        </button>
      ))}
      <div className="stack">
        <button type="button" className="secondary" onClick={() => go("/history")}>
          History
        </button>
      </div>
    </>
  );
}
