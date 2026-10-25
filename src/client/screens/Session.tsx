import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { api, messageOf } from "../api";
import { formatPerformance } from "../../shared/format";
import type { GlucoseDTO, SessionDTO, SessionExerciseDTO, SetDTO } from "../../shared/types";
import { Back, Banner, Confirm, useNav, useNow } from "../ui";

type Draft = { weight: string; reps: string; minutes: string; note: string };
type Rest = { ends: number };

function elapsedLabel(started: string, endMs: number): string {
  const seconds = Math.max(0, Math.floor((endMs - new Date(started).getTime()) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function clock(total: number): string {
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function fromSet(set: SetDTO, exercise: SessionExerciseDTO): Draft {
  const minutes =
    set.durationSec != null ? String(Math.round(set.durationSec / 60)) : exercise.cardioMin != null ? String(exercise.cardioMin) : "";
  return {
    weight: set.weightLb == null ? "" : String(set.weightLb),
    reps: set.reps == null ? "" : String(set.reps),
    minutes,
    note: set.note ?? "",
  };
}

function firstUnlogged(session: SessionDTO): string | null {
  for (const exercise of session.exercises) {
    const set = exercise.sets.find((item) => !item.loggedAt);
    if (set) return set.id;
  }
  return null;
}

function findSet(session: SessionDTO, id: string | null): { exercise: SessionExerciseDTO; set: SetDTO } | null {
  if (!id) return null;
  for (const exercise of session.exercises) {
    const set = exercise.sets.find((item) => item.id === id);
    if (set) return { exercise, set };
  }
  return null;
}

function stepNumber(current: string, delta: number, emptyPlus: number): string {
  if (current.trim() === "") return delta > 0 ? String(emptyPlus) : "0";
  const next = Number(current) + delta;
  if (!Number.isFinite(next) || next < 0) return "0";
  return String(Math.round(next * 10) / 10);
}

function plannedText(exercise: SessionExerciseDTO, set: SetDTO, draft: Draft | undefined): string {
  if (set.loggedAt) return set.label;
  if (!draft) return "—";
  if (exercise.isCardio) return draft.minutes ? `${draft.minutes} min` : "—";
  const weight = draft.weight === "" ? null : Number(draft.weight);
  const reps = draft.reps === "" ? null : Number(draft.reps);
  return formatPerformance(weight, reps, exercise.measure, exercise.perSide);
}

export function SessionScreen({ sessionId }: { sessionId: string }) {
  const { go } = useNav();
  const now = useNow(1000);
  const [session, setSession] = useState<SessionDTO | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [glucose, setGlucose] = useState<GlucoseDTO | null>(null);
  const [flash, setFlash] = useState<string[]>([]);
  const [rest, setRest] = useState<Rest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<null | "finish" | "discard">(null);
  const patchTimer = useRef<number | null>(null);
  const buzzed = useRef(false);
  const glucoseCard = useRef<HTMLElement | null>(null);
  const [glucosePinned, setGlucosePinned] = useState(false);

  useEffect(() => {
    let stop = false;
    api<SessionDTO>(`/api/sessions/${sessionId}`)
      .then((data) => {
        if (stop) return;
        setSession(data);
        const next: Record<string, Draft> = {};
        for (const exercise of data.exercises) {
          for (const set of exercise.sets) {
            if (!set.loggedAt) next[set.id] = fromSet(set, exercise);
          }
        }
        setDrafts(next);
        setCurrentId(firstUnlogged(data));
      })
      .catch((err) => {
        if (!stop) setError(messageOf(err));
      });
    return () => {
      stop = true;
    };
  }, [sessionId]);

  useEffect(() => {
    document.body.classList.toggle("logging", Boolean(session && !session.completedAt));
    return () => document.body.classList.remove("logging");
  }, [session]);

  useEffect(() => {
    let stop = false;
    const load = () => {
      api<GlucoseDTO>("/api/glucose")
        .then((data) => {
          if (!stop) setGlucose(data);
        })
        .catch(() => undefined);
    };
    load();
    const id = window.setInterval(load, 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stop = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    if (!currentId) return;
    document.querySelector(`[data-set="${currentId}"]`)?.scrollIntoView({ block: "nearest" });
  }, [currentId]);

  useEffect(() => {
    const card = glucoseCard.current;
    if (!card) return;
    let stop = false;
    const safe = document.querySelector(".safe-top")?.getBoundingClientRect().height ?? 0;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (stop) return;
        setGlucosePinned(!entry.isIntersecting);
      },
      { rootMargin: `-${Math.ceil(safe + 4)}px 0px 0px 0px`, threshold: 0 },
    );
    observer.observe(card);
    return () => {
      stop = true;
      observer.disconnect();
    };
  }, [Boolean(glucose && glucose.mgdl != null && (glucose.available || glucose.reason === "stale"))]);

  useEffect(() => {
    return () => {
      if (patchTimer.current) window.clearTimeout(patchTimer.current);
    };
  }, []);

  function remember(next: SessionDTO, prefer?: string | null) {
    setSession(next);
    setDrafts((prev) => {
      const merged: Record<string, Draft> = {};
      for (const exercise of next.exercises) {
        for (const set of exercise.sets) {
          if (set.loggedAt) continue;
          merged[set.id] = prev[set.id] ?? fromSet(set, exercise);
        }
      }
      return merged;
    });
    if (prefer && findSet(next, prefer) && !findSet(next, prefer)?.set.loggedAt) {
      setCurrentId(prefer);
      return;
    }
    setCurrentId((current) => {
      const found = findSet(next, current);
      if (found && !found.set.loggedAt) return current;
      return firstUnlogged(next);
    });
  }

  function changeDraft(exercise: SessionExerciseDTO, setId: string, next: Draft) {
    setDrafts((prev) => ({ ...prev, [setId]: next }));
    if (session?.completedAt) return;
    if (patchTimer.current) window.clearTimeout(patchTimer.current);
    patchTimer.current = window.setTimeout(() => {
      const body = exercise.isCardio
        ? { minutes: next.minutes === "" ? null : Number(next.minutes), note: next.note }
        : {
            weightLb: next.weight === "" ? null : Number(next.weight),
            reps: next.reps === "" ? null : Number(next.reps),
          };
      api(`/api/sets/${setId}`, { method: "PATCH", body: JSON.stringify(body) }).catch(() => undefined);
    }, 450);
  }

  async function logCurrent() {
    if (!session || !current) return;
    const draft = drafts[current.set.id];
    if (!draft) return;
    setBusy(true);
    setError(null);
    if (patchTimer.current) window.clearTimeout(patchTimer.current);
    const before = new Set(session.exercises.flatMap((exercise) => exercise.sets.filter((set) => set.isPr).map((set) => set.id)));
    const body = current.exercise.isCardio
      ? { minutes: Number(draft.minutes), note: draft.note }
      : { weightLb: Number(draft.weight), reps: Number(draft.reps) };
    try {
      const next = await api<SessionDTO>(`/api/sets/${current.set.id}/log`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      const fresh = next.exercises
        .flatMap((exercise) => exercise.sets)
        .filter((set) => set.isPr && !before.has(set.id))
        .map((set) => set.id);
      if (fresh.length) {
        setFlash((items) => [...items, ...fresh]);
        window.setTimeout(() => {
          setFlash((items) => items.filter((id) => !fresh.includes(id)));
        }, 4000);
      }
      if (!current.exercise.isCardio) {
        const reps = Number(draft.reps);
        const seconds = reps <= 6 ? 150 : reps <= 10 ? 90 : 60;
        buzzed.current = false;
        setRest({ ends: Date.now() + seconds * 1000 });
      }
      remember(next);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  async function mutate(path: string, method: string, prefer?: string | null) {
    setBusy(true);
    setError(null);
    try {
      const next = await api<SessionDTO>(path, { method });
      remember(next, prefer);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/sessions/${session.id}/finish`, { method: "POST" });
      go("/workout");
    } catch (err) {
      setError(messageOf(err));
      setAsk(null);
      setBusy(false);
    }
  }

  async function discard() {
    if (!session) return;
    setBusy(true);
    try {
      await api(`/api/sessions/${session.id}`, { method: "DELETE" });
      go("/workout");
    } catch (err) {
      setError(messageOf(err));
      setAsk(null);
      setBusy(false);
    }
  }

  const current = session ? findSet(session, currentId) : null;
  const draft = current ? drafts[current.set.id] : undefined;
  const finished = Boolean(session?.completedAt);
  const cardioLeft = session?.exercises.some((exercise) => exercise.isCardio && exercise.sets.every((set) => !set.loggedAt));
  const reading = glucose && glucose.mgdl != null && (glucose.available || glucose.reason === "stale") ? glucose : null;
  const low = Boolean(glucose?.available && glucose.mgdl != null && glucose.mgdl < 120 && cardioLeft);
  const mgdl = reading?.mgdl;
  const glucoseTone = mgdl == null ? "" : mgdl < 120 ? " low" : mgdl > 180 ? " high" : "";
  const snack = "Before cardio, a low snack handy is a good idea under about 120.";
  const canLog = Boolean(
    draft &&
      (current?.exercise.isCardio
        ? Number(draft.minutes) > 0
        : draft.weight !== "" && Number.isFinite(Number(draft.weight)) && Number(draft.reps) > 0),
  );

  if (!session) {
    return (
      <>
        <Back to="/workout" label="This week" />
        <Banner text={error} />
        {!error && <p className="quiet">Loading workout…</p>}
      </>
    );
  }

  const endMs = session.completedAt ? new Date(session.completedAt).getTime() : now;

  return (
    <>
      <div className="session-top">
        <Back to={session.dayId ? `/workout/day/${session.dayId}` : "/workout"} label="Back" />
        <div className="head-actions">
          {reading && (
            <button type="button" className="chip-mini" onClick={() => document.getElementById("glucose")?.scrollIntoView({ behavior: "smooth" })}>
              {reading.mgdl} {reading.arrow}
            </button>
          )}
          {!finished && (
            <button type="button" className="linkish" onClick={() => setAsk("finish")}>
              Finish
            </button>
          )}
        </div>
      </div>
      <p className="kicker">{finished ? "Finished" : "In progress"}</p>
      <div className="session-top">
        <h1>{session.name}</h1>
        <div className="elapsed">{elapsedLabel(session.startedAt, endMs)}</div>
      </div>
      {session.rampNote && <p className="ramp">{session.rampNote}</p>}
      <Banner text={error} />

      {reading && (
        <section className="card" id="glucose" ref={glucoseCard}>
          <p className="kicker">Glucose</p>
          <p className="glucose-num">
            {reading.mgdl}
            <span>{reading.arrow}</span>
          </p>
          <p className="quiet">
            {reading.label} · {reading.minutesAgo === 0 ? "just now" : `${reading.minutesAgo} min ago`} · mg/dL
          </p>
          {!reading.available && reading.reason === "stale" && <p className="quiet">Older than 15 minutes.</p>}
          {low && <p className="snack">{snack}</p>}
        </section>
      )}
      {reading && (
        <div className={`glucose-pin${glucosePinned ? " on" : ""}`} aria-hidden={glucosePinned ? undefined : true}>
          <div className={`glucose-pin-bar${glucoseTone}`}>
            <button
              type="button"
              className="glucose-pill"
              tabIndex={glucosePinned ? 0 : -1}
              onClick={() => document.getElementById("glucose")?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })}
            >
              <strong>{reading.mgdl}</strong>
              <span className="unit">mg/dL</span>
              {reading.arrow && reading.arrow !== "·" ? <span className="arrow">{reading.arrow}</span> : null}
              <span className="ago">{reading.minutesAgo === 0 ? "now" : `${reading.minutesAgo} min`}</span>
            </button>
            <div className="glucose-pin-time">{elapsedLabel(session.startedAt, endMs)}</div>
          </div>
        </div>
      )}

      {session.exercises.map((exercise) => (
        <section className="card" key={exercise.id}>
          <div className="ex-head">
            <button type="button" className="ex-name" onClick={() => go(`/exercise/${exercise.exerciseId}?from=${encodeURIComponent(`/workout/session/${session.id}`)}`)}>
              {exercise.name}
            </button>
            {!finished && !exercise.isCardio && (
              <button type="button" className="linkish" onClick={() => go(`/workout/session/${session.id}/swap/${exercise.id}`)}>
                Swap
              </button>
            )}
          </div>
          <p className="quiet">{exercise.isCardio ? exercise.repsLabel : `${exercise.setsPlanned}×${exercise.repsLabel}`}</p>
          {!exercise.isCardio && (
            <>
              <p className="quiet">Last time: {exercise.lastTime}</p>
              <p className="pr-line">PR {exercise.prLine}</p>
            </>
          )}
          {exercise.notes && <p className="quiet">{exercise.notes}</p>}
          {low && exercise.isCardio && exercise.sets.every((set) => !set.loggedAt) && <p className="snack">{snack}</p>}
          {exercise.sets.map((set) => (
            <button
              key={set.id}
              type="button"
              data-set={set.id}
              className={set.id === currentId ? "set current" : "set"}
              onClick={() => {
                if (!set.loggedAt && !finished) setCurrentId(set.id);
              }}
            >
              <span>
                Set {set.setIndex}
                <span className="quiet"> · {plannedText(exercise, set, drafts[set.id])}</span>
              </span>
              {flash.includes(set.id) ? <span className="pr fresh">New PR</span> : set.isPr ? <span className="pr">PR</span> : null}
            </button>
          ))}
          {!finished && (
            <div className="row-actions">
              <button type="button" onClick={() => mutate(`/api/session-exercises/${exercise.id}/sets`, "POST")}>
                Add set
              </button>
              <button
                type="button"
                onClick={() => {
                  const target = [...exercise.sets].reverse().find((set) => !set.loggedAt) ?? exercise.sets[exercise.sets.length - 1];
                  if (target) void mutate(`/api/sets/${target.id}`, "DELETE");
                }}
              >
                Remove set
              </button>
            </div>
          )}
        </section>
      ))}

      {!finished && (
        <button type="button" className="ghost" onClick={() => setAsk("discard")}>
          Discard workout
        </button>
      )}

      {!finished && (
        <div className="log-dock">
          {rest && <RestBar rest={rest} buzzed={buzzed} onChange={setRest} />}
          {current && draft ? (
            <>
              <p className="dock-label">
                {current.exercise.isCardio ? current.exercise.name : `Set ${current.set.setIndex} · ${current.exercise.name}`}
              </p>
              {current.exercise.isCardio ? (
                <>
                  <Stepper
                    label="Minutes"
                    value={draft.minutes}
                    onStep={(delta) =>
                      changeDraft(current.exercise, current.set.id, {
                        ...draft,
                        minutes: stepNumber(draft.minutes, delta, 1),
                      })
                    }
                  />
                  <label className="field">
                    <span>Note</span>
                    <textarea
                      rows={2}
                      value={draft.note}
                      onChange={(event) => changeDraft(current.exercise, current.set.id, { ...draft, note: event.target.value })}
                    />
                  </label>
                </>
              ) : (
                <div className="pair">
                  <Stepper
                    label="lb"
                    value={draft.weight === "" ? "—" : draft.weight}
                    onStep={(delta) =>
                      changeDraft(current.exercise, current.set.id, {
                        ...draft,
                        weight: stepNumber(draft.weight, delta * 5, 5),
                      })
                    }
                  />
                  <Stepper
                    label={current.exercise.measure === "meters" ? "m" : current.exercise.perSide ? "reps / side" : "reps"}
                    value={draft.reps === "" ? "—" : draft.reps}
                    onStep={(delta) =>
                      changeDraft(current.exercise, current.set.id, {
                        ...draft,
                        reps: stepNumber(draft.reps, current.exercise.measure === "meters" ? delta * 5 : delta, current.exercise.measure === "meters" ? 5 : 1),
                      })
                    }
                  />
                </div>
              )}
              <div className="stack">
                <button type="button" className="primary" disabled={!canLog || busy} onClick={() => void logCurrent()}>
                  {current.exercise.isCardio ? "Log cardio" : `Log set ${current.set.setIndex}`}
                </button>
              </div>
            </>
          ) : (
            <p>All sets logged. Finish when you&apos;re done.</p>
          )}
        </div>
      )}

      {ask === "finish" && (
        <Confirm
          title="Finish this workout?"
          body="It will count for this week."
          confirmLabel="Finish"
          busy={busy}
          onCancel={() => setAsk(null)}
          onConfirm={() => void finish()}
        />
      )}
      {ask === "discard" && (
        <Confirm
          title="Discard this workout?"
          body="Logged sets in it will be removed."
          confirmLabel="Discard"
          danger
          busy={busy}
          onCancel={() => setAsk(null)}
          onConfirm={() => void discard()}
        />
      )}
    </>
  );
}

function Stepper({ label, value, onStep }: { label: string; value: string; onStep: (delta: number) => void }) {
  return (
    <div className="stepper" aria-label={label}>
      <button type="button" className="step" aria-label={`Decrease ${label}`} onClick={() => onStep(-1)}>
        −
      </button>
      <div className="val">
        <strong>{value}</strong>
        <small>{label}</small>
      </div>
      <button type="button" className="step" aria-label={`Increase ${label}`} onClick={() => onStep(1)}>
        +
      </button>
    </div>
  );
}

function RestBar({
  rest,
  buzzed,
  onChange,
}: {
  rest: Rest;
  buzzed: MutableRefObject<boolean>;
  onChange: (rest: Rest | null) => void;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((value) => value + 1), 250);
    return () => window.clearInterval(id);
  }, []);
  const left = Math.max(0, Math.ceil((rest.ends - Date.now()) / 1000));
  useEffect(() => {
    if (left === 0 && !buzzed.current) {
      buzzed.current = true;
      navigator.vibrate?.(180);
    }
  }, [left, buzzed]);
  return (
    <div className="rest">
      <div>
        <strong>{left === 0 ? "0:00" : clock(left)}</strong>
        <div className="quiet">{left === 0 ? "Rest done" : "Rest"}</div>
      </div>
      <button type="button" onClick={() => onChange({ ends: Math.max(rest.ends, Date.now()) + 30_000 })}>
        +30
      </button>
      <button type="button" onClick={() => onChange(null)}>
        Skip
      </button>
    </div>
  );
}
