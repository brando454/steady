import { useEffect, useRef, useState } from "react";
import { api, messageOf } from "../api";
import type { WeightDTO } from "../../shared/types";
import { reassertMainScroll } from "../scroll";
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
      reassertMainScroll();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
      reassertMainScroll();
    }
  }

  const change =
    data?.change == null
      ? null
      : Math.abs(data.change) < 0.05
        ? "No change this week"
        : data.change > 0
          ? `Up ${data.change.toFixed(1)} lb this week`
          : `Down ${Math.abs(data.change).toFixed(1)} lb this week`;

  return (
    <>
      <h1>Weight</h1>
      <Banner text={error} />
      {data && (
        <>
          <section className="card">
            <div className="split-head">
              <div>
                <p className="quiet">7-day average</p>
                {data.average == null ? (
                  <p className="quiet">Log a few mornings to see your average</p>
                ) : (
                  <p className="figure">{data.average.toFixed(1)} lb</p>
                )}
              </div>
              {change && <p className="quiet">{change}</p>}
            </div>
            <TrendChart
              points={data.points.map((point) => ({ date: point.date, dot: point.weightLb, line: point.average }))}
              target={data.target}
              dotLabel="Daily weigh-in"
              lineLabel="7-day average"
            />
            <p className="quiet">Dots are daily weigh-ins and the line is the 7-day average, so one salty dinner doesn&apos;t look like a trend.</p>
          </section>
          <section className="card">
            <h2>This week&apos;s call</h2>
            <p className="quiet">{data.hint.text}</p>
          </section>
        </>
      )}
      {!data && !error && <p className="quiet">Loading…</p>}
      <div className="save-row">
        <label className="field">
          <span>This morning</span>
          <input inputMode="decimal" value={weight} onChange={(event) => setWeight(event.target.value)} />
        </label>
        <button type="button" className="primary" disabled={busy || weight.trim() === ""} onClick={() => void save()}>
          Save
        </button>
      </div>
    </>
  );
}
