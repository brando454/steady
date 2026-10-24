import { useEffect, useState } from "react";
import { api, messageOf } from "../api";
import type { SessionDTO } from "../../shared/types";
import { Back, Banner, useNav } from "../ui";

export function SwapScreen({ sessionId, sxId }: { sessionId: string; sxId: string }) {
  const { go } = useNav();
  const [session, setSession] = useState<SessionDTO | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [custom, setCustom] = useState("");
  const [scope, setScope] = useState<"today" | "default">("today");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let stop = false;
    api<SessionDTO>(`/api/sessions/${sessionId}`)
      .then((data) => {
        if (!stop) setSession(data);
      })
      .catch((err) => {
        if (!stop) setError(messageOf(err));
      });
    return () => {
      stop = true;
    };
  }, [sessionId]);

  const exercise = session?.exercises.find((item) => item.id === sxId);

  async function apply() {
    if (!exercise) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/sessions/${sessionId}/swap`, {
        method: "POST",
        body: JSON.stringify({
          sessionExerciseId: sxId,
          exerciseId: custom.trim() ? undefined : picked,
          customName: custom.trim() || undefined,
          scope,
        }),
      });
      go(`/workout/session/${sessionId}`, { replace: true });
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  }

  return (
    <>
      <Back to={`/workout/session/${sessionId}`} label="Workout" />
      <p className="kicker">Swap</p>
      <h1>{exercise?.name ?? "Exercise"}</h1>
      {exercise && (
        <p className="quiet">
          {exercise.muscles}. History stays with the exercise you actually do.
        </p>
      )}
      <Banner text={error} />
      {!session && !error && <p className="quiet">Loading…</p>}
      {exercise && (
        <>
          {exercise.swaps.map((swap) => (
            <button
              key={swap.id}
              type="button"
              className={!custom.trim() && picked === swap.id ? "swap-opt on" : "swap-opt"}
              onClick={() => setPicked(swap.id)}
            >
              <strong>{swap.name}</strong>
            </button>
          ))}
          <label className="field">
            <span>Or type any exercise</span>
            <input value={custom} onChange={(event) => setCustom(event.target.value)} placeholder="Exercise name" />
          </label>
          {custom.trim() && <p className="quiet">Using the name you typed.</p>}
          <button type="button" className={scope === "today" ? "choice on" : "choice"} onClick={() => setScope("today")}>
            <input type="radio" name="scope" checked={scope === "today"} onChange={() => setScope("today")} />
            <span>Just today</span>
          </button>
          <button type="button" className={scope === "default" ? "choice on" : "choice"} onClick={() => setScope("default")}>
            <input type="radio" name="scope" checked={scope === "default"} onChange={() => setScope("default")} />
            <span>Make it the default</span>
          </button>
          <div className="stack">
            <button type="button" className="primary" disabled={busy || (!picked && !custom.trim())} onClick={() => void apply()}>
              Use this exercise
            </button>
          </div>
        </>
      )}
    </>
  );
}
