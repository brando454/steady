import { useCallback, useEffect, useState } from "react";
import { api, setLockHandler } from "./api";
import { FoodScreen } from "./screens/Food";
import { ExerciseScreen, HistoryScreen } from "./screens/History";
import { Lock } from "./screens/Lock";
import { SessionScreen } from "./screens/Session";
import { SettingsScreen } from "./screens/Settings";
import { SwapScreen } from "./screens/Swap";
import { TodayScreen } from "./screens/Today";
import { WeekScreen } from "./screens/Week";
import { WeightScreen } from "./screens/Weight";
import { armRestore, beginMainScrollHold, centerInMain, dropScroll, releaseMainScrollHold, scrollHoldGeneration } from "./scroll";
import { Providers } from "./ui";

type Tab = "today" | "workout" | "food" | "weight";

function tabFor(path: string): Tab {
  if (path.startsWith("/food")) return "food";
  if (path.startsWith("/weight")) return "weight";
  if (
    path.startsWith("/workout") ||
    path.startsWith("/history") ||
    path.startsWith("/exercise")
  ) {
    return "workout";
  }
  return "today";
}

function Screen({
  path,
  search,
  onLock,
}: {
  path: string;
  search: URLSearchParams;
  onLock: () => void;
}) {
  const parts = path.split("/").filter(Boolean);
  if (path === "/" || path === "") return <TodayScreen />;
  if (path === "/settings") return <SettingsScreen onLock={onLock} />;
  if (path === "/workout") return <WeekScreen />;
  if (parts[0] === "workout" && parts[1] === "day" && parts[2]) return <WeekScreen dayId={decodeURIComponent(parts[2])} />;
  if (parts[0] === "workout" && parts[1] === "session" && parts[2] && parts[3] === "swap" && parts[4]) {
    return <SwapScreen sessionId={parts[2]} sxId={parts[4]} />;
  }
  if (parts[0] === "workout" && parts[1] === "session" && parts[2]) return <SessionScreen sessionId={parts[2]} />;
  if (path === "/food" || path.startsWith("/food")) return <FoodScreen search={search} />;
  if (path === "/weight") return <WeightScreen />;
  if (path === "/history") return <HistoryScreen />;
  if (parts[0] === "exercise" && parts[1]) {
    return <ExerciseScreen exerciseId={decodeURIComponent(parts[1])} from={search.get("from")} />;
  }
  return <TodayScreen />;
}

export function App() {
  const [loc, setLoc] = useState(() => window.location.pathname + window.location.search);
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    const sync = () => {
      const next = window.location.pathname + window.location.search;
      releaseMainScrollHold();
      setLoc(next);
      if (armRestore(next)) return;
      dropScroll(next);
      document.querySelector(".main")?.scrollTo(0, 0);
    };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  const go = useCallback((to: string, opts?: { replace?: boolean; restoreScroll?: boolean; keepScroll?: boolean }) => {
    const current = window.location.pathname + window.location.search;
    if (current !== to) {
      if (opts?.replace) window.history.replaceState({}, "", to);
      else window.history.pushState({}, "", to);
    }
    setLoc(window.location.pathname + window.location.search);
    if (opts?.keepScroll) return;
    releaseMainScrollHold();
    if (opts?.restoreScroll && armRestore(to)) return;
    dropScroll(to);
    document.querySelector(".main")?.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    const intoView = () => {
      const active = document.activeElement;
      if (
        !(active instanceof HTMLInputElement) &&
        !(active instanceof HTMLTextAreaElement) &&
        !(active instanceof HTMLSelectElement)
      ) {
        return;
      }
      window.setTimeout(() => {
        if (document.activeElement === active) centerInMain(active);
      }, 300);
    };
    const field = (target: EventTarget | null) =>
      target instanceof Element ? target.closest("input, textarea, select") : null;
    const onPointerDown = (event: PointerEvent) => {
      const element = event.target instanceof Element ? event.target : event.target instanceof Node ? event.target.parentElement : null;
      if (!element || field(element) || !element.closest("button")) return;
      beginMainScrollHold();
    };
    const onFocusOut = (event: FocusEvent) => {
      if (!field(event.target)) return;
      const main = document.querySelector(".main");
      const top = main instanceof HTMLElement ? main.scrollTop : 0;
      const generation = scrollHoldGeneration();
      window.setTimeout(() => {
        if (field(document.activeElement) || generation !== scrollHoldGeneration()) return;
        beginMainScrollHold(2000, top);
      }, 0);
    };
    document.addEventListener("focusin", intoView);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusout", onFocusOut, true);
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", intoView);
    return () => {
      document.removeEventListener("focusin", intoView);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusout", onFocusOut, true);
      viewport?.removeEventListener("resize", intoView);
    };
  }, []);

  useEffect(() => {
    setLockHandler(() => setAuthed(false));
    api("/api/auth/me")
      .then(() => setAuthed(true))
      .catch(() => setAuthed(false));
  }, []);

  const url = new URL(loc, "http://steady.local");
  const tab = tabFor(url.pathname);

  if (authed === null) {
    return (
      <div className="boot">
        <p>Steady</p>
      </div>
    );
  }
  if (!authed) return <Lock onUnlock={() => setAuthed(true)} />;

  const tabs: { id: Tab; href: string; label: string }[] = [
    { id: "today", href: "/", label: "Today" },
    { id: "workout", href: "/workout", label: "Workout" },
    { id: "food", href: "/food", label: "Food" },
    { id: "weight", href: "/weight", label: "Weight" },
  ];

  return (
    <Providers path={url.pathname} go={go}>
      <div className="shell">
        <main className="main">
          <Screen path={url.pathname} search={url.searchParams} onLock={() => setAuthed(false)} />
        </main>
        <nav className="tabbar" aria-label="Primary">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              className={tab === item.id ? "tab active" : "tab"}
              aria-current={tab === item.id ? "page" : undefined}
              onClick={() => go(item.href)}
            >
              <i className="bar" />
              {item.label}
            </button>
          ))}
        </nav>
      </div>
    </Providers>
  );
}
