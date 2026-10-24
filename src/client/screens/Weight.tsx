import { useEffect, useRef, useState } from "react";
import { api, messageOf } from "../api";
import type { WeightDTO } from "../../shared/types";
import { Banner, TrendChart } from "../ui";

export function WeightScreen() {
  const [data, setData] = useState<WeightDTO | null>(null);
  const [weight, setWeight] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seeded = useRef(false);

  useEffect(() => {
    let stop = false;
    api<WeightDTO>("/api/weights")
      .then((next) => {
        if (stop) return;
        setData(next);
        if (!seeded.current) {
          seeded.current = true;
          if (next.today != null) setWeight(String(next.today));
        }
      })
      .catch((err) => {
        if (!stop) setError(messageOf(err));
      });
    return () => {
      stop = true;
    };
  }, []);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const next = await api<WeightDTO>("/api/weights", {
        method: "POST",
        body: JSON.stringify({ weightLb: Number(weight) }),
      });
      setData(next);
      if (next.today != null) setWeight(String(next.today));
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  const change =
    data?.change == null ? null : `${data.change > 0 ? "+" : ""}${data.change.toFixed(1)} lb vs the prior 7 days`;

  return (
    <>
      <p className="kicker">7-day average</p>
      <h1>{data?.average == null ? "—" : data.average.toFixed(1)}</h1>
      <p className="quiet">{data ? `lb · ${data.count} weigh-in${data.count === 1 ? "" : "s"}` : "Loading…"}</p>
      <Banner text={error} />
      {data && (
        <section className="card">
          <TrendChart
            points={data.points.map((point) => ({ date: point.date, dot: point.weightLb, line: point.average }))}
            target={data.target}
            dotLabel="Weigh-in"
            lineLabel="7-day average"
          />
          {change && <p>{change}</p>}
          <p className={`hint ${data.hint.tone}`}>{data.hint.text}</p>
        </section>
      )}
      <label className="field">
        <span>Today&apos;s weight</span>
        <input className="hero-input" inputMode="decimal" value={weight} onChange={(event) => setWeight(event.target.value)} />
      </label>
      <button type="button" className="primary" disabled={busy || weight.trim() === ""} onClick={() => void save()}>
        Save
      </button>
    </>
  );
}
