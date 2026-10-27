import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { createPortal } from "react-dom";
import { api, messageOf } from "../api";
import type { GlucoseDTO, SessionDTO, SessionExerciseDTO, SetDTO } from "../../shared/types";
import { commitFocusedSetDraft } from "../../shared/logic";
import { exerciseBlocks, restSecondsForRound } from "../../shared/superset";
import { alignToTopOfMain, beginMainScrollHold, reassertMainScroll, rememberMainScroll, restoreArmed, revealCurrentSet, shouldRevealCurrentSet, useRestoreMainScroll } from "../scroll";
import { WorkoutGlucoseView } from "../WorkoutGlucose";
import { Back, Banner, Confirm, TrendArrow, useNav, useNow } from "../ui";

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
  const weight =
    set.weightLb != null
      ? String(set.weightLb)
      : !exercise.isCardio && exercise.lastWeightLb != null
        ? String(exercise.lastWeightLb)
        : "";
  return {
    weight,
    reps: set.reps == null ? "" : String(set.reps),
    minutes,
    note: set.note ?? "",
  };
}

function sanitizeDecimal(raw: string): string {
  let value = raw.replace(/[^\d.]/g, "");
  const dot = value.indexOf(".");
  if (dot >= 0) value = value.slice(0, dot + 1) + value.slice(dot + 1).replace(/\./g, "");
  return value;
}

function commitDecimal(raw: string): string {
  const cleaned = sanitizeDecimal(raw);
  if (cleaned === "" || cleaned === ".") return "";
  const number = Number(cleaned);
  if (!Number.isFinite(number) || number < 0) return "";
  return String(Math.round(number * 10) / 10);
}

function sanitizeInt(raw: string): string {
  return raw.replace(/\D/g, "");
}

function commitInt(raw: string): string {
  const digits = sanitizeInt(raw);
  if (digits === "") return "";
  return String(Number(digits));
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

function weightValue(exercise: SessionExerciseDTO, set: SetDTO, draft: Draft | undefined): string {
  if (exercise.isCardio) {
    if (set.loggedAt) return set.durationSec == null ? "—" : String(Math.round(set.durationSec / 60));
    return draft?.minutes || "—";
  }
  if (set.loggedAt) return set.weightLb == null ? "—" : String(set.weightLb);
  return !draft || draft.weight === "" ? "—" : draft.weight;
}

function repsValue(exercise: SessionExerciseDTO, set: SetDTO, draft: Draft | undefined): string {
  const reps = set.loggedAt ? (set.reps == null ? "" : String(set.reps)) : draft?.reps ?? "";
  if (reps === "") return exercise.measure === "meters" ? "— m" : "x—";
  if (exercise.measure === "meters") return `${reps} m`;
  return exercise.perSide ? `x${reps} /side` : `x${reps}`;
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
  const [logPressed, setLogPressed] = useState(false);
  const logging = useRef(false);
  const [ask, setAsk] = useState<null | "finish" | "discard">(null);
  const patchTimer = useRef<number | null>(null);
  const revealedSession = useRef<string | null>(null);
  const buzzed = useRef(false);
  const glucoseCard = useRef<HTMLElement | null>(null);
  const [glucosePinned, setGlucosePinned] = useState(false);
  const [glucoseReady, setGlucoseReady] = useState(false);
  const sessionKey = `/workout/session/${sessionId}`;

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
    if (!session) return;
    if (session.completedAt) {
      setGlucoseReady(true);
      return;
    }
    let stop = false;
    const load = (first = false) => {
      api<GlucoseDTO>("/api/glucose")
        .then((data) => {
          if (!stop) setGlucose(data);
        })
        .catch(() => undefined)
        .finally(() => {
          if (!stop && first) setGlucoseReady(true);
        });
    };
    load(true);
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
  }, [session?.id, session?.completedAt]);

  useEffect(() => {
    if (!session?.completedAt || !session.glucose?.inProgress) return;
    let stop = false;
    const load = () => {
      api<SessionDTO>(`/api/sessions/${session.id}`)
        .then((data) => {
          if (!stop) setSession(data);
        })
        .catch(() => undefined);
    };
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
  }, [session?.id, session?.completedAt, session?.glucose?.inProgress]);

  useEffect(() => {
    if (!currentId) return;
    const alreadyShown = revealedSession.current === sessionKey;
    if (!alreadyShown) revealedSession.current = sessionKey;
    if (shouldRevealCurrentSet(alreadyShown, restoreArmed(sessionKey))) revealCurrentSet(currentId);
  }, [currentId, sessionKey]);

  useRestoreMainScroll(sessionKey, Boolean(session) && glucoseReady);

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
    if (logging.current || !session || !current) return;
    const active = document.activeElement;
    const focused =
      active instanceof HTMLInputElement
        ? {
            setId: active.dataset.setId || current.set.id,
            label: active.getAttribute("aria-label") ?? "",
            value: active.value,
          }
        : null;
    const members = current.exercise.supersetGroup
      ? session.exercises
          .filter((exercise) => exercise.supersetGroup === current.exercise.supersetGroup)
          .sort((a, b) => (a.supersetOrder ?? 0) - (b.supersetOrder ?? 0) || a.sortOrder - b.sortOrder)
      : [current.exercise];
    const pending = members.flatMap((exercise) => {
      const set = exercise.sets.find((item) => item.setIndex === current.set.setIndex && !item.loggedAt);
      if (!set) return [];
      const base = drafts[set.id];
      if (!base) return [];
      const draft = focused && focused.setId === set.id ? commitFocusedSetDraft(base, focused) : base;
      return [{ exercise, set, draft }];
    });
    if (!pending.length) return;
    const ready = pending.every(({ exercise, draft }) =>
      exercise.isCardio
        ? Number(draft.minutes) > 0
        : draft.weight !== "" && Number.isFinite(Number(draft.weight)) && Number(draft.reps) > 0,
    );
    if (!ready) {
      setError(current.exercise.isCardio ? "Enter the minutes" : "Enter the weight and reps");
      return;
    }
    logging.current = true;
    beginMainScrollHold();
    if (active instanceof HTMLElement) active.blur();
    setDrafts((prev) => {
      const next = { ...prev };
      for (const item of pending) next[item.set.id] = item.draft;
      return next;
    });
    setBusy(true);
    setError(null);
    if (patchTimer.current) window.clearTimeout(patchTimer.current);
    const before = new Set(session.exercises.flatMap((exercise) => exercise.sets.filter((set) => set.isPr).map((set) => set.id)));
    const superset = Boolean(current.exercise.supersetGroup);
    const path = superset ? `/api/sessions/${session.id}/rounds` : `/api/sets/${pending[0].set.id}/log`;
    const body = superset
      ? {
          sets: pending.map(({ set, draft }) => ({
            id: set.id,
            weightLb: Number(draft.weight),
            reps: Number(draft.reps),
          })),
        }
      : current.exercise.isCardio
        ? { minutes: Number(pending[0].draft.minutes), note: pending[0].draft.note }
        : { weightLb: Number(pending[0].draft.weight), reps: Number(pending[0].draft.reps) };
    try {
      const next = await api<SessionDTO>(path, { method: "POST", body: JSON.stringify(body) });
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
        const seconds = restSecondsForRound(pending.map((item) => Number(item.draft.reps)));
        buzzed.current = false;
        setRest({ ends: Date.now() + seconds * 1000 });
      }
      remember(next);
      navigator.vibrate?.(12);
      reassertMainScroll();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      logging.current = false;
      setBusy(false);
      setLogPressed(false);
      reassertMainScroll();
    }
  }

  async function mutate(path: string, method: string, prefer?: string | null, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const next = await api<SessionDTO>(path, { method, body: body == null ? undefined : JSON.stringify(body) });
      remember(next, prefer);
      reassertMainScroll();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
      reassertMainScroll();
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
  const showGlucose = Boolean(reading && session);
  const low = Boolean(glucose?.available && glucose.mgdl != null && glucose.mgdl < 120 && cardioLeft);
  const mgdl = reading?.mgdl;
  const glucoseTone = mgdl == null ? "" : mgdl < 120 ? " low" : mgdl > 180 ? " high" : "";
  const snack = "Under 120 with cardio ahead, grab a quick snack";

  useEffect(() => {
    const card = glucoseCard.current;
    if (!showGlucose || !card) return;
    const root = document.querySelector(".main");
    const scroller = root instanceof HTMLElement ? root : null;
    let stop = false;
    const pinIfClear = () => {
      if (stop) return;
      const edge = scroller ? scroller.getBoundingClientRect().top : 0;
      setGlucosePinned(card.getBoundingClientRect().bottom <= edge + 4);
    };
    const observer = new IntersectionObserver(pinIfClear, {
      root: scroller,
      rootMargin: "-4px 0px 0px 0px",
      threshold: [0, 0.25, 0.5, 0.75, 1],
    });
    observer.observe(card);
    pinIfClear();
    scroller?.addEventListener("scroll", pinIfClear, { passive: true });
    window.addEventListener("resize", pinIfClear);
    return () => {
      stop = true;
      observer.disconnect();
      scroller?.removeEventListener("scroll", pinIfClear);
      window.removeEventListener("resize", pinIfClear);
    };
  }, [showGlucose, session?.id]);

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
      <div className="session-tools">
        <Back to={session.dayId ? `/workout/day/${session.dayId}` : "/workout"} label="Back" />
        {!finished && (
          <button type="button" className="linkish" onClick={() => setAsk("finish")}>
            Finish
          </button>
        )}
      </div>
      <div className="session-title">
        <div>
          <p className="quiet">{finished ? "Finished" : "In progress"}</p>
          <h1>{session.name}</h1>
        </div>
        <div className="timer-chip">
          <i />
          {elapsedLabel(session.startedAt, endMs)}
        </div>
      </div>
      {session.rampNote && <p className="ramp">{session.rampNote}</p>}
      <Banner text={error} />

      {finished && session.glucose && (
        <section className="card">
          <WorkoutGlucoseView summary={session.glucose} />
        </section>
      )}

      {reading && !finished && (
        <section className={`card glucose-card${glucoseTone}`} id="glucose" ref={glucoseCard}>
          <div className="split-head">
            <p className="quiet">Glucose from Nightscout</p>
            <p className="quiet">{reading.minutesAgo === 0 ? "just now" : `${reading.minutesAgo} min ago`}</p>
          </div>
          <p className="glucose-num">
            <strong>{reading.mgdl}</strong>
            <span className="unit">mg/dL</span>
            <TrendArrow arrow={reading.arrow} />
          </p>
          <p className="quiet">{reading.label}</p>
          {!reading.available && reading.reason === "stale" && <p className="quiet">Older than 15 minutes.</p>}
          {low && <p className="snack">{snack}</p>}
        </section>
      )}
      {reading && !finished && createPortal(
        <div className={`glucose-pin${glucosePinned ? " on" : ""}`} aria-hidden={glucosePinned ? undefined : true}>
          <div className="glucose-pin-row">
            <button
              type="button"
              className={`glucose-pill${glucoseTone}`}
              tabIndex={glucosePinned ? 0 : -1}
              onClick={() => {
                const card = document.getElementById("glucose");
                if (card) alignToTopOfMain(card);
              }}
            >
              <strong>{reading.mgdl}</strong>
              <TrendArrow arrow={reading.arrow} />
              <span className="ago">{reading.minutesAgo === 0 ? "now" : `${reading.minutesAgo}m`}</span>
            </button>
            <div className="glucose-pin-name">{session.name}</div>
            <div className="timer-chip slim">
              <i />
              {elapsedLabel(session.startedAt, endMs)}
            </div>
          </div>
        </div>,
        document.body,
      )}

      {exerciseBlocks(session.exercises).map((block) => {
        if (block.kind === "superset") {
          const members = block.exercises;
          const indexes = [...new Set(members.flatMap((exercise) => exercise.sets.map((set) => set.setIndex)))].sort((a, b) => a - b);
          return (
            <section className="card superset-card" key={block.group} data-scroll-anchor={members[0]?.id}>
              <h2 className="ex-name ss-title">{block.title}</h2>
              <div className="ss-identities">
                {members.map((exercise) => (
                  <div key={exercise.id} className="ss-identity" data-scroll-anchor={exercise.id}>
                    <div className="ex-head">
                      <div>
                        <button
                          type="button"
                          className="ex-name"
                          onClick={() => {
                            rememberMainScroll(sessionKey, exercise.id);
                            go(`/exercise/${exercise.exerciseId}?from=${encodeURIComponent(`/workout/session/${session.id}`)}`);
                          }}
                        >
                          {exercise.name}
                        </button>
                        <p className="quiet ss-meta">Last time: {exercise.lastTime}. PR {exercise.prLine}</p>
                      </div>
                      {!finished && (
                        <button
                          type="button"
                          className="pill"
                          onClick={() => {
                            rememberMainScroll(sessionKey, exercise.id);
                            go(`/workout/session/${session.id}/swap/${exercise.id}`);
                          }}
                        >
                          Swap
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              {indexes.map((index) => {
                const roundSets = members.flatMap((exercise) => {
                  const set = exercise.sets.find((item) => item.setIndex === index);
                  return set ? [{ exercise, set }] : [];
                });
                const currentRound = roundSets.some((item) => item.set.id === currentId && !item.set.loggedAt);
                const anyPr = roundSets.some((item) => item.set.isPr || flash.includes(item.set.id));
                return (
                  <div key={index} className={currentRound ? "ss-round now" : "ss-round"}>
                    <div className="set-label">
                      {roundSets.every((item) => item.set.loggedAt) ? `Set ${index} done` : `Set ${index}`}
                      {roundSets.some((item) => flash.includes(item.set.id)) ? <span className="pr fresh">New PR</span> : anyPr && roundSets.some((item) => item.set.isPr) ? <span className="pr">PR</span> : null}
                    </div>
                    {roundSets.map(({ exercise, set }) => {
                      const row = drafts[set.id];
                      const locked = Boolean(set.loggedAt) || finished;
                      const select = () => {
                        if (!locked) setCurrentId(set.id);
                      };
                      return (
                        <div key={set.id} data-set={set.id} className="ss-move">
                          <div className="ss-move-name">
                            <span>{exercise.name}</span>
                            {set.migrated ? <span className="migrated">Migrated</span> : null}
                            {flash.includes(set.id) ? <span className="pr fresh">New PR</span> : set.isPr ? <span className="pr">PR</span> : null}
                          </div>
                          <div className="ss-controls">
                            <MiniStepper
                              label={`${exercise.name} weight`}
                              setId={set.id}
                              value={row?.weight ?? ""}
                              display={weightValue(exercise, set, row)}
                              disabled={locked || !row}
                              decimal
                              placeholder="—"
                              onFocus={select}
                              onCommit={(next) => {
                                if (!row) return;
                                select();
                                changeDraft(exercise, set.id, { ...row, weight: next });
                              }}
                              onStep={(delta, currentValue) => {
                                if (!row) return;
                                select();
                                changeDraft(exercise, set.id, { ...row, weight: stepNumber(currentValue, delta * 5, 5) });
                              }}
                            />
                            <MiniStepper
                              label={exercise.measure === "meters" ? `${exercise.name} meters` : `${exercise.name} reps`}
                              setId={set.id}
                              value={row?.reps ?? ""}
                              display={repsValue(exercise, set, row)}
                              disabled={locked || !row}
                              suffix={exercise.measure === "meters" ? "m" : exercise.perSide ? "/side" : undefined}
                              placeholder="—"
                              onFocus={select}
                              onCommit={(next) => {
                                if (!row) return;
                                select();
                                changeDraft(exercise, set.id, { ...row, reps: next });
                              }}
                              onStep={(delta, currentValue) => {
                                if (!row) return;
                                select();
                                const jump = exercise.measure === "meters" ? 5 : 1;
                                changeDraft(exercise, set.id, { ...row, reps: stepNumber(currentValue, delta * jump, jump) });
                              }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
              {!finished && (
                <div className="row-actions">
                  <button
                    type="button"
                    onClick={() => mutate(`/api/sessions/${session.id}/rounds/remove`, "POST", members[0]?.id, { sessionExerciseId: members[0]?.id })}
                  >
                    Remove set
                  </button>
                  <button
                    type="button"
                    onClick={() => mutate(`/api/sessions/${session.id}/rounds/add`, "POST", members[0]?.id, { sessionExerciseId: members[0]?.id })}
                  >
                    Add set
                  </button>
                </div>
              )}
            </section>
          );
        }
        const exercise = block.exercise;
        return (
        <section className="card" key={exercise.id} data-scroll-anchor={exercise.id}>
          <div className="ex-head">
            <div>
              <button
                type="button"
                className="ex-name"
                onClick={() => {
                  rememberMainScroll(sessionKey, exercise.id);
                  go(`/exercise/${exercise.exerciseId}?from=${encodeURIComponent(`/workout/session/${session.id}`)}`);
                }}
              >
                {exercise.name}
              </button>
              <p className="quiet">
                {exercise.isCardio
                  ? exercise.repsLabel
                  : `Last time: ${exercise.lastTime}. PR ${exercise.prLine}`}
              </p>
            </div>
            {!finished && !exercise.isCardio && (
              <button
                type="button"
                className="pill"
                onClick={() => {
                  rememberMainScroll(sessionKey, exercise.id);
                  go(`/workout/session/${session.id}/swap/${exercise.id}`);
                }}
              >
                Swap
              </button>
            )}
          </div>
          {exercise.notes && <p className="quiet">{exercise.notes}</p>}
          {exercise.sets.map((set) => {
            const row = drafts[set.id];
            const locked = Boolean(set.loggedAt) || finished;
            const select = () => {
              if (!locked) setCurrentId(set.id);
            };
            return (
              <div key={set.id} data-set={set.id} className={set.id === currentId && !set.loggedAt ? "set-row now" : "set-row"}>
                <button type="button" className="set-label" onClick={select}>
                  {set.loggedAt ? `Set ${set.setIndex} done` : `Set ${set.setIndex}`}
                  {flash.includes(set.id) ? <span className="pr fresh">New PR</span> : set.isPr ? <span className="pr">PR</span> : null}
                  {set.migrated ? <span className="migrated">Migrated</span> : null}
                </button>
                <MiniStepper
                  setId={set.id}
                  label={exercise.isCardio ? "minutes" : "weight"}
                  value={exercise.isCardio ? (row?.minutes ?? "") : (row?.weight ?? "")}
                  display={weightValue(exercise, set, row)}
                  disabled={locked || !row}
                  decimal={!exercise.isCardio}
                  placeholder="—"
                  onFocus={select}
                  onCommit={(next) => {
                    if (!row) return;
                    select();
                    if (exercise.isCardio) changeDraft(exercise, set.id, { ...row, minutes: next });
                    else changeDraft(exercise, set.id, { ...row, weight: next });
                  }}
                  onStep={(delta, current) => {
                    if (!row) return;
                    select();
                    if (exercise.isCardio) {
                      changeDraft(exercise, set.id, { ...row, minutes: stepNumber(current, delta, 1) });
                    } else {
                      changeDraft(exercise, set.id, { ...row, weight: stepNumber(current, delta * 5, 5) });
                    }
                  }}
                />
                {!exercise.isCardio && (
                  <MiniStepper
                    setId={set.id}
                    label={exercise.measure === "meters" ? "meters" : "reps"}
                    value={row?.reps ?? ""}
                    display={repsValue(exercise, set, row)}
                    disabled={locked || !row}
                    suffix={exercise.measure === "meters" ? "m" : exercise.perSide ? "/side" : undefined}
                    placeholder="—"
                    onFocus={select}
                    onCommit={(next) => {
                      if (!row) return;
                      select();
                      changeDraft(exercise, set.id, { ...row, reps: next });
                    }}
                    onStep={(delta, current) => {
                      if (!row) return;
                      select();
                      const jump = exercise.measure === "meters" ? 5 : 1;
                      changeDraft(exercise, set.id, { ...row, reps: stepNumber(current, delta * jump, jump) });
                    }}
                  />
                )}
              </div>
            );
          })}
          {!finished && exercise.isCardio && current?.exercise.id === exercise.id && draft && (
            <label className="field">
              <span>Note</span>
              <textarea
                rows={2}
                value={draft.note}
                onChange={(event) => changeDraft(exercise, current.set.id, { ...draft, note: event.target.value })}
              />
            </label>
          )}
          {!finished && (
            <div className="row-actions">
              <button
                type="button"
                onClick={() => {
                  const target = [...exercise.sets].reverse().find((set) => !set.loggedAt) ?? exercise.sets[exercise.sets.length - 1];
                  if (target) void mutate(`/api/sets/${target.id}`, "DELETE");
                }}
              >
                Remove set
              </button>
              <button type="button" onClick={() => mutate(`/api/session-exercises/${exercise.id}/sets`, "POST")}>
                Add set
              </button>
            </div>
          )}
        </section>
        );
      })}

      {!finished && (
        <button type="button" className="ghost" onClick={() => setAsk("discard")}>
          Discard workout
        </button>
      )}

      {!finished && createPortal(
        <div className="log-dock">
          <div className="dock-rest">
            {rest ? (
              <RestBar rest={rest} buzzed={buzzed} onChange={setRest} />
            ) : (
              <>
                <span className="quiet">Rest</span>
                <strong className="rest-time">—</strong>
              </>
            )}
          </div>
          {current && draft ? (
            <button
              type="button"
              className={logPressed ? "primary dock-log pressed" : "primary dock-log"}
              disabled={busy}
              onPointerDown={(event) => {
                event.preventDefault();
                setLogPressed(true);
              }}
              onPointerUp={() => void logCurrent()}
              onPointerCancel={() => setLogPressed(false)}
              onClick={() => void logCurrent()}
            >
              {current.exercise.isCardio ? "Log cardio" : `Log set ${current.set.setIndex}`}
            </button>
          ) : (
            <button type="button" className="primary dock-log" onClick={() => setAsk("finish")}>
              Finish
            </button>
          )}
        </div>,
        document.body,
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

function MiniStepper({
  label,
  setId,
  value,
  display,
  disabled,
  decimal,
  suffix,
  placeholder,
  onFocus,
  onCommit,
  onStep,
}: {
  label: string;
  setId?: string;
  value: string;
  display: string;
  disabled?: boolean;
  decimal?: boolean;
  suffix?: string;
  placeholder?: string;
  onFocus?: () => void;
  onCommit: (next: string) => void;
  onStep: (delta: number, current: string) => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const clean = decimal ? sanitizeDecimal : sanitizeInt;
  const commit = decimal ? commitDecimal : commitInt;

  function finish(next: string) {
    const saved = commit(next);
    setText(saved);
    if (saved !== value) onCommit(saved);
  }

  return (
    <div className="mini-step">
      <button type="button" aria-label={`Decrease ${label}`} disabled={disabled} onClick={() => onStep(-1, commit(text))}>
        −
      </button>
      <input
        aria-label={label}
        data-set-id={setId}
        inputMode={decimal ? "decimal" : "numeric"}
        pattern="[0-9]*"
        enterKeyHint="done"
        placeholder={placeholder}
        value={text}
        disabled={disabled}
        hidden={disabled}
        onChange={(event) => setText(clean(event.target.value))}
        onFocus={(event) => {
          onFocus?.();
          event.currentTarget.select();
        }}
        onBlur={() => finish(text)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
      />
      {disabled ? <strong>{display}</strong> : null}
      {suffix && !disabled ? <span className="mini-unit">{suffix}</span> : null}
      <button type="button" aria-label={`Increase ${label}`} disabled={disabled} onClick={() => onStep(1, commit(text))}>
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
    <>
      <span className="quiet">{left === 0 ? "Rest done" : "Rest"}</span>
      <strong className="rest-time">{left === 0 ? "0:00" : clock(left)}</strong>
      <span className="rest-links">
        <button type="button" onClick={() => onChange({ ends: Math.max(rest.ends, Date.now()) + 30_000 })}>
          +30
        </button>
        <button type="button" onClick={() => onChange(null)}>
          Skip
        </button>
      </span>
    </>
  );
}
