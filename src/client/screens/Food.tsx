import { useEffect, useRef, useState } from "react";
import { api, compressImage, formatInt, formatQty, messageOf } from "../api";
import { createFlightGuard } from "../../shared/flight";
import { usualActionLabel } from "../../shared/logic";
import { timeValue } from "../../shared/time";
import type { FavoriteDTO, FoodDayDTO } from "../../shared/types";
import { alignToTopOfMain, reassertMainScroll } from "../scroll";
import { Banner, Confirm, useNav, useToast } from "../ui";

type FormState = {
  name: string;
  calories: string;
  protein: string;
  carbs: string;
  fat: string;
  note: string;
  photo: string | null;
};

const emptyForm: FormState = { name: "", calories: "", protein: "", carbs: "", fat: "", note: "", photo: null };
const ESTIMATE_TIMEOUT_MS = 40_000;

type MealEstimate = { name: string; calories: number; protein: number; carbs: number; fat: number };

function num(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function fieldNumber(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  if (Number.isInteger(rounded)) return String(rounded);
  return rounded.toFixed(1);
}

export function FoodScreen({ search }: { search: URLSearchParams }) {
  const { go } = useNav();
  const toast = useToast();
  const editId = search.get("edit");
  const [date, setDate] = useState(search.get("date") ?? "");
  const [time, setTime] = useState("");
  const [food, setFood] = useState<FoodDayDTO | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [aiImage, setAiImage] = useState<string | null>(null);
  const [editingFavs, setEditingFavs] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [estimating, setEstimating] = useState(false);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<FavoriteDTO | null>(null);
  const [bringEstimate, setBringEstimate] = useState(0);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const estimateRef = useRef<HTMLElement | null>(null);
  const appliedEdit = useRef<string | null>(null);
  const flight = useRef(createFlightGuard()).current;
  const compressing = useRef<Promise<void> | null>(null);
  const draft = useRef({ note: "", photo: null as string | null, ai: null as string | null });
  draft.current = { note: form.note, photo: form.photo, ai: aiImage };

  useEffect(() => {
    let stop = false;
    const query = date ? `?date=${encodeURIComponent(date)}` : "";
    api<FoodDayDTO>(`/api/meals${query}`)
      .then((data) => {
        if (stop) return;
        setFood(data);
        setDate((current) => current || data.date);
        setTime((current) => current || data.nowTime.slice(0, 5));
      })
      .catch((err) => {
        if (!stop) setError(messageOf(err));
      });
    return () => {
      stop = true;
    };
  }, [date]);

  useEffect(() => {
    if (!food || !editId || appliedEdit.current === editId) return;
    const meal = food.meals.find((item) => item.id === editId);
    if (!meal) return;
    appliedEdit.current = editId;
    setForm({
      name: meal.name,
      calories: String(meal.calories),
      protein: String(meal.protein),
      carbs: String(meal.carbs),
      fat: String(meal.fat),
      note: meal.note ?? "",
      photo: meal.photo,
    });
    setTime(timeValue(new Date(meal.loggedAt)));
    setAiImage(null);
  }, [food, editId]);

  useEffect(() => {
    if (!bringEstimate) return;
    const node = estimateRef.current;
    if (node) alignToTopOfMain(node, 12);
  }, [bringEstimate]);

  function patch(partial: Partial<FormState>) {
    setForm((current) => ({ ...current, ...partial }));
  }

  async function reload() {
    const query = date ? `?date=${encodeURIComponent(date)}` : "";
    const data = await api<FoodDayDTO>(`/api/meals${query}`);
    setFood(data);
  }

  async function onPhoto(file: File) {
    const job = (async () => {
      setError(null);
      try {
        const big = await compressImage(file, 1024, 0.8);
        let thumb = await compressImage(file, 480, 0.6);
        if (thumb.length > 120_000) thumb = await compressImage(file, 360, 0.5);
        draft.current.ai = big;
        setAiImage(big);
        if (thumb.length > 120_000) {
          draft.current.photo = null;
          patch({ photo: null });
          setError("That photo is too big to keep. You can still estimate from it.");
        } else {
          draft.current.photo = thumb;
          patch({ photo: thumb });
        }
      } catch (err) {
        setError(messageOf(err));
      }
    })();
    compressing.current = job;
    try {
      await job;
    } finally {
      if (compressing.current === job) compressing.current = null;
    }
  }

  async function estimate() {
    if (!flight.tryStart()) return;
    setEstimating(true);
    setEstimateError(null);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), ESTIMATE_TIMEOUT_MS);
    try {
      if (compressing.current) await compressing.current;
      if (controller.signal.aborted) throw new DOMException("The estimate took too long.", "AbortError");
      const current = draft.current;
      const result = await api<MealEstimate>("/api/meals/estimate", {
        method: "POST",
        body: JSON.stringify({ note: current.note, imageDataUrl: current.ai ?? current.photo }),
        signal: controller.signal,
      });
      patch({
        name: result.name,
        calories: String(result.calories),
        protein: String(result.protein),
        carbs: String(result.carbs),
        fat: String(result.fat),
      });
    } catch (err) {
      const aborted = err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
      setEstimateError(aborted ? "That took too long." : messageOf(err));
    } finally {
      window.clearTimeout(timer);
      flight.finish();
      setEstimating(false);
    }
  }

  function payload() {
    const calories = num(form.calories);
    const protein = num(form.protein);
    const carbs = num(form.carbs);
    const fat = num(form.fat);
    if (!form.name.trim()) throw new Error("Enter a meal name");
    if (calories == null || protein == null || carbs == null || fat == null) throw new Error("Enter calories, protein, carbs, and fat");
    return {
      name: form.name.trim(),
      calories,
      protein,
      carbs,
      fat,
      note: form.note,
      photo: form.photo,
      date: date || food?.today,
      time: (time || food?.nowTime || "12:00").slice(0, 5),
    };
  }

  async function saveFavorite() {
    setBusy(true);
    setError(null);
    try {
      const body = payload();
      const saved = await api<FavoriteDTO>("/api/favorites", { method: "POST", body: JSON.stringify(body) });
      setLoaded(saved);
      await reload();
      reassertMainScroll();
      toast({ text: "Saved as usual" });
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
      reassertMainScroll();
    }
  }

  async function logMeal() {
    setBusy(true);
    setError(null);
    try {
      const body = payload();
      if (editId) {
        await api(`/api/meals/${editId}`, { method: "PUT", body: JSON.stringify(body) });
        appliedEdit.current = null;
        go(`/food?date=${body.date}`, { replace: true, keepScroll: true });
      } else {
        await api("/api/meals", { method: "POST", body: JSON.stringify(body) });
        setForm(emptyForm);
        setAiImage(null);
        setLoaded(null);
      }
      await reload();
      reassertMainScroll();
      toast({ text: editId ? "Meal updated" : "Meal logged" });
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
      reassertMainScroll();
    }
  }

  function fillFavorite(favorite: FavoriteDTO) {
    if (editId) appliedEdit.current = editId;
    const note = favorite.note ?? "";
    draft.current = { note, photo: null, ai: null };
    setAiImage(null);
    setEstimateError(null);
    setError(null);
    setLoaded(favorite);
    setForm({
      name: favorite.name,
      calories: fieldNumber(favorite.calories),
      protein: fieldNumber(favorite.protein),
      carbs: fieldNumber(favorite.carbs),
      fat: fieldNumber(favorite.fat),
      note,
      photo: null,
    });
    if (editId) {
      const day = date || food?.date || "";
      go(day ? `/food?date=${encodeURIComponent(day)}` : "/food", { replace: true, keepScroll: true });
    }
    setBringEstimate((value) => value + 1);
  }

  async function deleteMeal() {
    if (!removeId) return;
    setBusy(true);
    try {
      await api(`/api/meals/${removeId}`, { method: "DELETE" });
      if (editId === removeId) {
        appliedEdit.current = null;
        setForm(emptyForm);
        setLoaded(null);
        go(`/food?date=${date}`, { replace: true, keepScroll: true });
      }
      setRemoveId(null);
      await reload();
      reassertMainScroll();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
      reassertMainScroll();
    }
  }

  async function deleteFavorite(id: string) {
    setError(null);
    try {
      await api(`/api/favorites/${id}`, { method: "DELETE" });
      await reload();
    } catch (err) {
      setError(messageOf(err));
    }
  }

  const carbs = num(form.carbs);
  const editing = Boolean(editId && appliedEdit.current === editId);

  return (
    <>
      <h1>{editing ? "Edit meal" : "Log a meal"}</h1>
      <Banner text={error} />

      <div className="fav-head">
        <div className="fav-copy">
          <p className="quiet">Your usuals</p>
          {food && food.favorites.length > 0 && (
            <p className="quiet fav-more">{editingFavs ? "Tap one to remove it" : "Swipe for more"}</p>
          )}
        </div>
        <button type="button" className="linkish" onClick={() => setEditingFavs((value) => !value)}>
          {editingFavs ? "Done" : "Edit"}
        </button>
      </div>
      {food && food.favorites.length > 0 ? (
        <div className="favs">
          {food.favorites.map((favorite) =>
            editingFavs ? (
              <button key={favorite.id} type="button" className="chip" onClick={() => void deleteFavorite(favorite.id)}>
                {favorite.name}
              </button>
            ) : (
              <button
                key={favorite.id}
                type="button"
                className={loaded?.id === favorite.id ? "chip on" : "chip"}
                aria-pressed={loaded?.id === favorite.id}
                onClick={() => fillFavorite(favorite)}
              >
                {favorite.name}
              </button>
            ),
          )}
        </div>
      ) : (
        <p className="quiet">No usual meals yet.</p>
      )}

      <div className={estimating ? "photo-note locked" : "photo-note"}>
        <input ref={fileRef} hidden type="file" accept="image/*" disabled={estimating} onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void onPhoto(file);
        }} />
        <button type="button" className="photo-tile" disabled={estimating} onClick={() => fileRef.current?.click()}>
          {form.photo ? <img src={form.photo} alt="" /> : <span>Photo</span>}
        </button>
        <textarea
          value={form.note}
          placeholder="About 1.5 cups jasmine rice, 6 oz beef, light teriyaki"
          disabled={estimating}
          onChange={(event) => {
            draft.current.note = event.target.value;
            patch({ note: event.target.value });
          }}
        />
      </div>
      {form.photo && (
        <button type="button" className="linkish" disabled={estimating} onClick={() => { draft.current.photo = null; draft.current.ai = null; patch({ photo: null }); setAiImage(null); }}>
          Remove photo
        </button>
      )}
      <p className="quiet photo-help">Add a photo, a note, or both. The note fills in what the camera can&apos;t see, like portions or sauce.</p>
      <button
        type="button"
        className={estimating ? "secondary pending" : "secondary"}
        disabled={estimating || !food?.aiConfigured}
        aria-busy={estimating}
        onClick={() => void estimate()}
      >
        {estimating ? (
          <>
            <span className="spinner" aria-hidden="true" />
            Estimating…
          </>
        ) : (
          "Estimate"
        )}
      </button>
      {estimateError && (
        <div className="inline-error" role="alert">
          <p>{estimateError}</p>
          <button type="button" className="linkish" onClick={() => void estimate()}>
            Try again
          </button>
        </div>
      )}
      {food && !food.aiConfigured && <p className="quiet">No AI key is set. Enter the meal yourself.</p>}

      <section className="card" ref={estimateRef}>
        <div className="split-head">
          <h2>{form.name.trim() || "Meal"}</h2>
          <p className="quiet">Estimate, edit anything</p>
        </div>
        <label className="field">
          <span>Name</span>
          <input value={form.name} onChange={(event) => patch({ name: event.target.value })} />
        </label>
        <div className="macros">
          <label className="field">
            <span>Calories</span>
            <input inputMode="decimal" value={form.calories} onChange={(event) => patch({ calories: event.target.value })} />
          </label>
          <label className="field">
            <span>Protein (g)</span>
            <input inputMode="decimal" value={form.protein} onChange={(event) => patch({ protein: event.target.value })} />
          </label>
          <label className="field">
            <span>Carbs (g)</span>
            <input inputMode="decimal" value={form.carbs} onChange={(event) => patch({ carbs: event.target.value })} />
          </label>
          <label className="field">
            <span>Fat (g)</span>
            <input inputMode="decimal" value={form.fat} onChange={(event) => patch({ fat: event.target.value })} />
          </label>
        </div>
      </section>
      <section className="card loop">
        <div>
          <p className="quiet">For Loop</p>
          <strong>{carbs == null ? "—" : `${formatQty(carbs)} g carbs`}</strong>
        </div>
        <p className="quiet">You enter it in Loop</p>
      </section>
      <div className="split">
        <button type="button" className="secondary" disabled={busy || estimating} onClick={() => void saveFavorite()}>
          {usualActionLabel(loaded, {
            name: form.name,
            calories: num(form.calories),
            protein: num(form.protein),
            carbs: num(form.carbs),
            fat: num(form.fat),
            note: form.note,
          })}
        </button>
        <button type="button" className="primary" disabled={busy || estimating} onClick={() => void logMeal()}>
          {editing ? "Save changes" : "Log meal"}
        </button>
      </div>
      {editing && (
        <button type="button" className="ghost" onClick={() => setRemoveId(editId)}>
          Delete meal
        </button>
      )}
      <div className="when">
        <label className="field">
          <span>Date</span>
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        </label>
        <label className="field">
          <span>Time</span>
          <input type="time" value={time} onChange={(event) => setTime(event.target.value.slice(0, 5))} />
        </label>
      </div>

      <section className="card">
        <h2>Logged</h2>
        {food && food.meals.length === 0 && <p className="quiet">Nothing logged for this day.</p>}
        {food?.meals.map((meal) => (
          <div key={meal.id} className="meal-row">
            <button type="button" className="meal-open" onClick={() => go(`/food?edit=${meal.id}&date=${meal.date}`)}>
              <span className="meal-name">{meal.name}</span>
              <small className="quiet">
                {meal.timeLabel} · {formatInt(meal.calories)} kcal, {formatQty(meal.protein)} g protein
              </small>
            </button>
            {meal.photo && <img className="thumb" src={meal.photo} alt="" />}
            <button type="button" className="linkish" onClick={() => setRemoveId(meal.id)}>
              Delete
            </button>
          </div>
        ))}
      </section>

      {removeId && (
        <Confirm
          title="Delete this meal?"
          body="It comes off the day's totals."
          confirmLabel="Delete"
          danger
          busy={busy}
          onCancel={() => setRemoveId(null)}
          onConfirm={() => void deleteMeal()}
        />
      )}
    </>
  );
}
