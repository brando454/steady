import { useState, type FormEvent } from "react";
import { api, messageOf } from "../api";
import { Banner } from "../ui";

export function Lock({ onUnlock }: { onUnlock: () => void }) {
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ passcode }) });
      onUnlock();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="lock">
      <form className="card" onSubmit={submit}>
        <p className="kicker">Steady</p>
        <h1>Enter the passcode</h1>
        <p className="quiet" style={{ margin: "8px 0 12px" }}>
          This phone will stay signed in for about a year.
        </p>
        <Banner text={error} />
        <label className="field">
          <span>Passcode</span>
          <input
            type="password"
            autoFocus
            autoComplete="current-password"
            value={passcode}
            onChange={(event) => setPasscode(event.target.value)}
          />
        </label>
        <button className="primary" type="submit" disabled={busy || passcode.length < 4}>
          Continue
        </button>
      </form>
    </div>
  );
}
