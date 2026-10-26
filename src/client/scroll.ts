import { useEffect } from "react";

type Mark = { top: number; anchor?: string };

const marks = new Map<string, Mark>();
const armed = new Set<string>();

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
  const main = document.querySelector(".main");
  if (!(main instanceof HTMLElement)) return;
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

function escapeAttr(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}

export function restoreArmedScroll(key: string) {
  const id = scrollKey(key);
  const mark = marks.get(id);
  marks.delete(id);
  armed.delete(id);
  if (!mark) return;
  const main = document.querySelector(".main");
  if (!(main instanceof HTMLElement)) return;
  main.scrollTop = mark.top;
  if (mark.anchor) {
    const node = main.querySelector(`[data-scroll-anchor="${escapeAttr(mark.anchor)}"]`);
    if (node instanceof HTMLElement) {
      const mainBox = main.getBoundingClientRect();
      const box = node.getBoundingClientRect();
      const visible = box.top >= mainBox.top + 8 && box.bottom <= mainBox.bottom - 8;
      if (!visible) {
        node.style.scrollMarginTop = "64px";
        node.scrollIntoView({ block: "nearest" });
      }
    }
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
