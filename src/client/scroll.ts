import { useEffect } from "react";

type Mark = { top: number; anchor?: string };
type Hold = { top: number; generation: number; until: number };

const marks = new Map<string, Mark>();
const armed = new Set<string>();

let generation = 0;
let hold: Hold | null = null;
let pinnedTop: { top: number; generation: number } | null = null;
let frame = 0;
let detachHold: (() => void) | null = null;
let applyingHold = false;

export function scrollKey(to: string): string {
  try {
    return new URL(to, "http://steady.local").pathname || "/";
  } catch {
    return to.split("?")[0] || "/";
  }
}

export function noteScroll(key: string, top: number, anchor?: string) {
  marks.set(scrollKey(key), { top, anchor });
}

export function rememberMainScroll(key: string, anchor?: string) {
  const main = mainEl();
  if (!main) return;
  noteScroll(key, main.scrollTop, anchor);
}

/** Keep a saved position only when this navigation is a return. */
export function armRestore(key: string): boolean {
  const id = scrollKey(key);
  if (!marks.has(id)) return false;
  armed.add(id);
  return true;
}

export function restoreArmed(key: string): boolean {
  return armed.has(scrollKey(key));
}

export function dropScroll(key: string) {
  const id = scrollKey(key);
  marks.delete(id);
  armed.delete(id);
}

/**
 * Bring the active set on screen the first time a session is shown.
 * Logging, adding, or editing a set must not move `.main` again.
 * A return from swap or history restores its own saved position instead.
 */
export function shouldRevealCurrentSet(sessionAlreadyShown: boolean, restoring: boolean): boolean {
  return !sessionAlreadyShown && !restoring;
}

/** A real jump back to the top, not a small nudge or an intentional scroll downward. */
export function jumpedToTop(previous: number, current: number): boolean {
  if (previous < 80) return false;
  if (current >= previous - 1) return false;
  return current < 24 || current < previous * 0.25;
}

/** Pixels to add to `.main.scrollTop` so `node` sits inside the scroller. */
export function revealDelta(args: {
  mainTop: number;
  mainBottom: number;
  nodeTop: number;
  nodeBottom: number;
  topGap?: number;
  bottomMargin?: number;
}): number {
  const topGap = args.topGap ?? 8;
  const bottomMargin = args.bottomMargin ?? 0;
  if (args.nodeTop >= args.mainTop + topGap && args.nodeBottom <= args.mainBottom - bottomMargin) return 0;
  if (args.nodeTop < args.mainTop + topGap) return args.nodeTop - args.mainTop - topGap;
  return args.nodeBottom - (args.mainBottom - bottomMargin);
}

function mainEl(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const main = document.querySelector(".main");
  return main instanceof HTMLElement ? main : null;
}

function escapeAttr(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}

function nudgeMain(node: HTMLElement, topGap: number, bottomMargin: number) {
  const main = mainEl();
  if (!main) return;
  const mainBox = main.getBoundingClientRect();
  const box = node.getBoundingClientRect();
  const delta = revealDelta({
    mainTop: mainBox.top,
    mainBottom: mainBox.bottom,
    nodeTop: box.top,
    nodeBottom: box.bottom,
    topGap,
    bottomMargin,
  });
  if (delta !== 0) main.scrollTop += delta;
}

export function revealCurrentSet(setId: string) {
  if (typeof document === "undefined") return;
  const node = document.querySelector(`[data-set="${escapeAttr(setId)}"]`);
  if (node instanceof HTMLElement) nudgeMain(node, 8, 154);
}

export function alignToTopOfMain(node: HTMLElement, margin = 8) {
  releaseMainScrollHold();
  const main = mainEl();
  if (!main) return;
  const delta = node.getBoundingClientRect().top - main.getBoundingClientRect().top - margin;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  main.scrollTo({ top: main.scrollTop + delta, behavior: reduce ? "auto" : "smooth" });
}

export function centerInMain(node: HTMLElement) {
  const main = mainEl();
  if (!main) return;
  const mainBox = main.getBoundingClientRect();
  const box = node.getBoundingClientRect();
  const delta = box.top - (mainBox.top + mainBox.height * 0.35);
  if (Math.abs(delta) < 12) return;
  main.scrollTop += delta;
}

function applyHold() {
  const main = mainEl();
  if (!hold || !main || hold.generation !== generation || applyingHold) return;
  if (Date.now() > hold.until) return;
  if (!jumpedToTop(hold.top, main.scrollTop)) return;
  applyingHold = true;
  main.scrollTop = hold.top;
  applyingHold = false;
}

function pump() {
  if (frame) return;
  const step = () => {
    frame = 0;
    if (!hold || hold.generation !== generation || Date.now() > hold.until) {
      if (hold && (hold.generation !== generation || Date.now() > hold.until)) {
        hold = null;
        detachHold?.();
        detachHold = null;
      }
      return;
    }
    applyHold();
    frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
}

function watchHold(main: HTMLElement) {
  detachHold?.();
  let tracking = false;
  let originX = 0;
  let originY = 0;
  const onScroll = () => applyHold();
  const onDown = (event: PointerEvent) => {
    const element = event.target instanceof Element ? event.target : null;
    if (element?.closest("button, a, input, textarea, select")) {
      tracking = false;
      return;
    }
    tracking = true;
    originX = event.clientX;
    originY = event.clientY;
  };
  const onMove = (event: PointerEvent) => {
    if (!tracking) return;
    if (Math.hypot(event.clientX - originX, event.clientY - originY) > 12) releaseMainScrollHold();
  };
  main.addEventListener("scroll", onScroll, { passive: true });
  main.addEventListener("pointerdown", onDown, true);
  main.addEventListener("pointermove", onMove, true);
  detachHold = () => {
    main.removeEventListener("scroll", onScroll);
    main.removeEventListener("pointerdown", onDown, true);
    main.removeEventListener("pointermove", onMove, true);
  };
}

/** Remember `.main` and put it back if iOS or a re-render throws it to the top. */
export function beginMainScrollHold(ms = 2000, captured?: number) {
  const main = mainEl();
  if (!main) return;
  const top = captured ?? main.scrollTop;
  if (top <= 1) return;
  pinnedTop = { top, generation };
  hold = { top, generation, until: Date.now() + ms };
  watchHold(main);
  applyHold();
  pump();
}

export function scrollHoldGeneration(): number {
  return generation;
}

/** Navigation that intentionally moves the scroller cancels a log/save hold. */
export function releaseMainScrollHold() {
  generation += 1;
  hold = null;
  pinnedTop = null;
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  detachHold?.();
  detachHold = null;
}

/** After a save commits, undo a jump to the top using the position from the tap. */
export function reassertMainScroll() {
  const pin = pinnedTop;
  const main = mainEl();
  if (!pin || !main || pin.generation !== generation || pin.top <= 1) return;
  if (!hold || hold.generation !== generation) {
    hold = { top: pin.top, generation: pin.generation, until: Date.now() + 800 };
    watchHold(main);
    pump();
  } else {
    hold.until = Math.max(hold.until, Date.now() + 800);
    pump();
  }
  if (jumpedToTop(pin.top, main.scrollTop)) {
    applyingHold = true;
    main.scrollTop = pin.top;
    applyingHold = false;
  }
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (pin.generation !== generation || !jumpedToTop(pin.top, main.scrollTop)) return;
      main.scrollTop = pin.top;
    });
  });
}

export function restoreArmedScroll(key: string) {
  const id = scrollKey(key);
  const mark = marks.get(id);
  marks.delete(id);
  armed.delete(id);
  if (!mark) return;
  const main = mainEl();
  if (!main) return;
  main.scrollTop = mark.top;
  if (mark.anchor) {
    const node = main.querySelector(`[data-scroll-anchor="${escapeAttr(mark.anchor)}"]`);
    if (node instanceof HTMLElement) nudgeMain(node, 64, 8);
  }
  main.dispatchEvent(new Event("scroll"));
}

/** Restore after the screen has its data in the DOM, on the next frame so layout can settle. */
export function useRestoreMainScroll(key: string, ready: boolean) {
  useEffect(() => {
    if (!ready || !restoreArmed(key)) return;
    let cancelled = false;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        if (!cancelled) restoreArmedScroll(key);
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(outer);
      if (inner) cancelAnimationFrame(inner);
    };
  }, [key, ready]);
}
