import { useEffect, useState } from "react";
import { api, messageOf } from "../api";
import type { SessionDTO } from "../../shared/types";
import { Back, Banner, useNav } from "../ui";

export function SwapScreen({ sessionId, sxId }: { sessionId: string; sxId: string }) {
  const { go } = useNav();
  const [session, setSession] = useState<SessionDTO | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [custom, setCustom] = useState("");
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

  async function apply(nextScope: "today" | "default") {
    if (!exercise) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/sessions/${sessionId}/swap`, {
        method: "POST",
        body: JSON.stringify({
          sessionExerciseId: sxId,
          exerciseId: custom.trim() ? undefined : picked ?? exercise.swaps[0]?.id,
          customName: custom.trim() || undefined,
          scope: nextScope,
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
      <p className="quiet">Rack&apos;s taken?</p>
      <h1>Swap {exercise?.name ?? "exercise"}</h1>
      <Banner text={error} />
      {!session && !error && <p className="quiet">Loading…</p>}
      {exercise && (
        <>
          <section className="card swap-list">
            {exercise.swaps.map((swap, index) => (
              <button
                key={swap.id}
                type="button"
                className={!custom.trim() && (picked === swap.id || (picked == null && index === 0)) ? "swap-opt on" : "swap-opt"}
                onClick={() => {
                  setPicked(swap.id);
                  setCustom("");
                }}
              >
                <strong>{swap.name}</strong>
                <small className="quiet">{swap.id === exercise.swaps[0]?.id ? "Closest match" : exercise.muscles}</small>
              </button>
            ))}
            <input value={custom} onChange={(event) => setCustom(event.target.value)} placeholder="Or type any exercise" />
          </section>
          <section className="card">
            <div className="split">
              <button type="button" className="primary" disabled={busy || (!picked && !custom.trim() && exercise.swaps.length === 0)} onClick={() => void apply("today")}>
                Just today
              </button>
              <button type="button" className="secondary" disabled={busy || (!picked && !custom.trim() && exercise.swaps.length === 0)} onClick={() => void apply("default")}>
                Make it the default
              </button>
            </div>
            <p className="quiet">Sets, reps, and targets carry over, and your history keeps each exercise separate.</p>
          </section>
        </>
      )}
    </>
  );
}
