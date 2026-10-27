import { addDays, civilDate, wallTimeToUtc, TZ } from "./time";

/** The next America/Boise (or given zone) midnight after `now`. */
export function nextCivilMidnight(now: Date, timeZone = TZ): Date {
  return wallTimeToUtc(addDays(civilDate(now, timeZone), 1), "00:00", timeZone);
}

export function msUntilNextCivilMidnight(now: Date, timeZone = TZ): number {
  return Math.max(1, nextCivilMidnight(now, timeZone).getTime() - now.getTime());
}

/**
 * The food date tracks today until the person picks a different day.
 * An empty field is today. A picked day stays put across midnight.
 */
export function foodDateAfterRollover(
  viewed: string,
  following: boolean,
  now: Date,
  timeZone = TZ,
): { date: string; following: boolean; rolled: boolean } {
  const today = civilDate(now, timeZone);
  if (!following) return { date: viewed, following: false, rolled: false };
  return { date: today, following: true, rolled: viewed !== "" && viewed !== today };
}

/** Yesterday's cached payload must not be shown as today. */
export function cacheForCivilDay<T extends { date: string }>(cached: T | null | undefined, today: string): T | null {
  if (!cached || cached.date !== today) return null;
  return cached;
}

export type WidgetDayTotals = {
  date: string;
  caloriesEaten: number;
  caloriesTarget: number;
  caloriesLeft: number;
  proteinEaten: number;
  proteinTarget: number;
  carbsEaten: number;
  carbsTarget: number;
  fatEaten: number;
  fatTarget: number;
};

/** A widget snapshot from another civil day shows an empty new day, keeping the targets. */
export function widgetTotalsForDay(snapshot: WidgetDayTotals, today: string): WidgetDayTotals {
  if (snapshot.date === today) return snapshot;
  return {
    ...snapshot,
    date: today,
    caloriesEaten: 0,
    caloriesLeft: snapshot.caloriesTarget,
    proteinEaten: 0,
    carbsEaten: 0,
    fatEaten: 0,
  };
}

/** Refresh at the earlier of the poll interval and the next civil midnight. */
export function widgetRefreshAt(now: Date, intervalMs: number, timeZone = TZ): Date {
  const midnight = nextCivilMidnight(now, timeZone);
  const poll = new Date(now.getTime() + intervalMs);
  return poll.getTime() < midnight.getTime() ? poll : midnight;
}
