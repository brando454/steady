import { useEffect, useState } from "react";
import { api, formatInt, formatQty, messageOf } from "../api";
import type { SessionDTO, TodayDTO } from "../../shared/types";
import { Banner, Macro, Ring, useNav } from "../ui";

export function TodayScreen() {
  const { go } = useNav();
  const [today, setToday] = useState<TodayDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let stop = false;
    api<TodayDTO>("/api/today")
      .then((data) => {
        if (!stop) setToday(data);
      })
      .catch((err) => {
        if (!stop) setError(messageOf(err));
      });
    return () => {
      stop = true;
    };
  }, []);

  async function start(dayId: string) {
    setBusy(true);
    setError(null);
    try {
      const session = await api<SessionDTO>("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ dayId }),
      });
      go(`/workout/session/${session.id}`);
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  }

  if (!today) {
    return (
      <>
        <Banner text={error} />
        {!error && <p className="quiet">Loading today…</p>}
      </>
    );
  }

  const over = today.left.calories < 0;
  const suggestion = today.suggestion;
  const startLabel =
    suggestion?.status === "in_progress" ? "Resume workout" : suggestion?.status === "done" ? "Start again" : "Start workout";

  return (
    <>
      <div className="top">
        <span>{today.dateLabel}</span>
        <button type="button" className="linkish" onClick={() => go("/settings")}>
          Settings
        </button>
      </div>
      <h1>{today.greeting}</h1>
      <Banner text={error} />
      <section className="card overview">
        <Ring
          consumed={today.totals.calories}
          target={today.targets.calories}
          center={formatInt(Math.abs(today.left.calories))}
          caption={over ? "kcal over" : "kcal left"}
        />
        <div className="macro-stack">
          <Macro name="Protein" value={today.totals.protein} target={today.targets.protein} unit="g" />
          <Macro name="Carbs" value={today.totals.carbs} target={today.targets.carbs} unit="g" />
          <Macro name="Fat" value={today.totals.fat} target={today.targets.fat} unit="g" />
        </div>
      </section>

      {suggestion ? (
        <section className="card">
          <h2>{suggestion.name}</h2>
          {suggestion.rampNote && <p className="quiet">{suggestion.rampNote}</p>}
          <p className="quiet">{suggestion.summary}</p>
          <button type="button" className="primary" disabled={busy} onClick={() => start(suggestion.dayId)}>
            {startLabel}
          </button>
        </section>
      ) : (
        <section className="card">
          <h2>All five days are done.</h2>
          <button type="button" className="secondary" onClick={() => go("/workout")}>
            This week
          </button>
        </section>
      )}

      <section className="card">
        <h2>Meals</h2>
        {today.meals.length === 0 && <p className="quiet">No meals yet.</p>}
        {today.meals.map((meal) => (
          <button key={meal.id} type="button" className="meal-row" onClick={() => go(`/food?edit=${meal.id}&date=${meal.date}`)}>
            <span>
              <span className="meal-name">{meal.name}</span>
              <small className="quiet">{meal.timeLabel}</small>
            </span>
            <small className="quiet meal-side">
              {formatInt(meal.calories)} kcal, {formatQty(meal.protein)} g protein
            </small>
          </button>
        ))}
      </section>
    </>
  );
}
