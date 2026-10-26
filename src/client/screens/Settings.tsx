import { useEffect, useState } from "react";
import { api, messageOf } from "../api";
import type { GlucoseDTO, SettingsDTO } from "../../shared/types";
import { glucoseStatusText } from "../../shared/glucose";
import { reassertMainScroll } from "../scroll";
import { Back, Banner, Confirm, useToast } from "../ui";

type Form = {
  displayName: string;
  calories: string;
  protein: string;
  carbs: string;
  fat: string;
  weightLb: string;
  rampStart: string;
  rampWeek1: string;
  rampWeek2: string;
};

function fromSettings(settings: SettingsDTO): Form {
  const week1 = settings.ramp.weeks.find((week) => week.offset === 0)?.percent ?? 70;
  const week2 = settings.ramp.weeks.find((week) => week.offset === 1)?.percent ?? 85;
  return {
    displayName: settings.displayName,
    calories: String(settings.calories),
    protein: String(settings.protein),
    carbs: String(settings.carbs),
    fat: String(settings.fat),
    weightLb: String(settings.weightLb),
    rampStart: settings.ramp.startDate,
    rampWeek1: String(week1),
    rampWeek2: String(week2),
  };
}

export function SettingsScreen({ onLock }: { onLock: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState<Form | null>(null);
  const [samples, setSamples] = useState(false);
  const [rampNote, setRampNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [nightscout, setNightscout] = useState("Checking…");

  useEffect(() => {
    let stop = false;
    api<SettingsDTO>("/api/settings")
      .then((settings) => {
        if (stop) return;
        setForm(fromSettings(settings));
        setSamples(settings.samples);
        setRampNote(settings.rampNote);
      })
      .catch((err) => {
        if (!stop) setError(messageOf(err));
      });
    api<GlucoseDTO>("/api/glucose")
      .then((reading) => {
        if (!stop) setNightscout(glucoseStatusText(reading));
      })
      .catch(() => {
        if (!stop) setNightscout("Couldn't check Nightscout");
      });
    return () => {
      stop = true;
    };
  }, []);

  function patch(partial: Partial<Form>) {
    setForm((current) => (current ? { ...current, ...partial } : current));
  }

  async function save() {
    if (!form) return;
    setBusy(true);
    setError(null);
    try {
      const settings = await api<SettingsDTO>("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          displayName: form.displayName,
          calories: Number(form.calories),
          protein: Number(form.protein),
          carbs: Number(form.carbs),
          fat: Number(form.fat),
          weightLb: Number(form.weightLb),
          rampStart: form.rampStart,
          rampWeek1: Number(form.rampWeek1),
          rampWeek2: Number(form.rampWeek2),
        }),
      });
      setForm(fromSettings(settings));
      setRampNote(settings.rampNote);
      reassertMainScroll();
      toast({ text: "Settings saved" });
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
      reassertMainScroll();
    }
  }

  async function clearSamples() {
    setBusy(true);
    setError(null);
    try {
      await api("/api/samples/clear", { method: "POST" });
      setSamples(false);
      setConfirmClear(false);
      toast({ text: "Sample history cleared" });
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  async function forget() {
    await api("/api/auth/logout", { method: "POST" });
    onLock();
  }

  if (!form) {
    return (
      <>
        <Back to="/" label="Today" />
        <Banner text={error} />
        {!error && <p className="quiet">Loading…</p>}
      </>
    );
  }

  return (
    <>
      <Back to="/" label="Today" />
      <h1>Settings</h1>
      <Banner text={error} />
      <div className="status-row">
        <span>Nightscout</span>
        <p>{nightscout}</p>
      </div>
      {rampNote && <p className="ramp">{rampNote}</p>}
      <label className="field">
        <span>Name</span>
        <input value={form.displayName} onChange={(event) => patch({ displayName: event.target.value })} />
      </label>
      <label className="field">
        <span>Calories</span>
        <input inputMode="numeric" value={form.calories} onChange={(event) => patch({ calories: event.target.value })} />
      </label>
      <label className="field">
        <span>Protein (g)</span>
        <input inputMode="numeric" value={form.protein} onChange={(event) => patch({ protein: event.target.value })} />
      </label>
      <label className="field">
        <span>Carbs (g)</span>
        <input inputMode="numeric" value={form.carbs} onChange={(event) => patch({ carbs: event.target.value })} />
      </label>
      <label className="field">
        <span>Fat (g)</span>
        <input inputMode="numeric" value={form.fat} onChange={(event) => patch({ fat: event.target.value })} />
      </label>
      <label className="field">
        <span>Weight goal (lb)</span>
        <input inputMode="decimal" value={form.weightLb} onChange={(event) => patch({ weightLb: event.target.value })} />
      </label>
      <h2>Return ramp</h2>
      <p className="quiet">A note only. Working weights are not scaled for you.</p>
      <label className="field">
        <span>First ramp week</span>
        <input type="date" value={form.rampStart} onChange={(event) => patch({ rampStart: event.target.value })} />
      </label>
      <div className="macros">
        <label className="field">
          <span>Week 1 %</span>
          <input inputMode="numeric" value={form.rampWeek1} onChange={(event) => patch({ rampWeek1: event.target.value })} />
        </label>
        <label className="field">
          <span>Week 2 %</span>
          <input inputMode="numeric" value={form.rampWeek2} onChange={(event) => patch({ rampWeek2: event.target.value })} />
        </label>
      </div>
      <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
        Save
      </button>
      {samples && (
        <div className="stack">
          <button type="button" className="secondary" onClick={() => setConfirmClear(true)}>
            Clear sample history
          </button>
          <p className="quiet">Sample workouts, meals, and weigh-ins are here so the app isn&apos;t empty. They are not added on a production deploy.</p>
        </div>
      )}
      <div className="stack">
        <button type="button" className="ghost" onClick={() => void forget()}>
          Forget this phone
        </button>
      </div>
      {confirmClear && (
        <Confirm
          title="Clear sample history?"
          body="Sample workouts, meals, and weights are deleted. Anything you logged stays."
          confirmLabel="Clear"
          danger
          busy={busy}
          onCancel={() => setConfirmClear(false)}
          onConfirm={() => void clearSamples()}
        />
      )}
    </>
  );
}
