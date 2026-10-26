import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { chartScale } from "../shared/format";

type Go = (to: string, opts?: { replace?: boolean; restoreScroll?: boolean; keepScroll?: boolean }) => void;
type NavValue = { path: string; go: Go };
export const NavContext = createContext<NavValue>({ path: "/", go: () => {} });
export function useNav() {
  return useContext(NavContext);
}

export type ToastInput = { text: string; undo?: () => void };
const ToastContext = createContext<(toast: ToastInput) => void>(() => {});
export function useToast() {
  return useContext(ToastContext);
}

export function Providers({
  path,
  go,
  children,
}: {
  path: string;
  go: Go;
  children: ReactNode;
}) {
  const [toast, setToast] = useState<(ToastInput & { id: number }) | null>(null);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast((current) => (current?.id === toast.id ? null : current)), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  return (
    <NavContext.Provider value={{ path, go }}>
      <ToastContext.Provider value={(next) => setToast({ ...next, id: Date.now() })}>
        {children}
        {toast && (
          <div className="toast" role="status">
            <span>{toast.text}</span>
            {toast.undo && (
              <button
                type="button"
                onClick={() => {
                  toast.undo?.();
                  setToast(null);
                }}
              >
                Undo
              </button>
            )}
          </div>
        )}
      </ToastContext.Provider>
    </NavContext.Provider>
  );
}

export function TrendArrow({ arrow }: { arrow?: string | null }) {
  if (!arrow || arrow === "·") return null;
  const rotation = arrow.includes("↗") ? -45 : arrow.includes("↘") ? 45 : arrow.includes("↑") ? -90 : arrow.includes("↓") ? 90 : 0;
  const twin = arrow.includes("↑↑") || arrow.includes("↓↓");
  const mark = (key: string) => (
    <svg key={key} viewBox="0 0 24 24" style={{ transform: `rotate(${rotation}deg)` }} aria-hidden="true">
      <path d="M4 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
  return (
    <span className={twin ? "trend twin" : "trend"}>
      {mark("a")}
      {twin ? mark("b") : null}
    </span>
  );
}

export function Ring({
  consumed,
  target,
  center,
  caption,
}: {
  consumed: number;
  target: number;
  center: string;
  caption: string;
}) {
  const radius = 46;
  const circ = 2 * Math.PI * radius;
  const pct = target > 0 ? Math.max(0, Math.min(1, consumed / target)) : 0;
  const dash = circ * pct;
  return (
    <div className="ring-wrap">
      <svg viewBox="0 0 112 112" className="ring" aria-hidden="true">
        <circle cx="56" cy="56" r={radius} className="ring-track" />
        {pct > 0 && (
          <circle
            cx="56"
            cy="56"
            r={radius}
            className="ring-value"
            strokeDasharray={`${dash} ${circ - dash}`}
            transform="rotate(-90 56 56)"
          />
        )}
      </svg>
      <div className="ring-center">
        <strong>{center}</strong>
        <span>{caption}</span>
      </div>
    </div>
  );
}

export function Macro({ name, value, target, unit }: { name: string; value: number; target: number; unit: string }) {
  const pct = target > 0 ? Math.max(0, Math.min(100, (value / target) * 100)) : 0;
  return (
    <div className="macro">
      <div className="macro-top">
        <span>{name}</span>
        <span>
          {Math.round(value)} <span className="quiet">/ {Math.round(target)} {unit}</span>
        </span>
      </div>
      <div className="track" role="meter" aria-label={name} aria-valuemin={0} aria-valuemax={target} aria-valuenow={Math.round(value)}>
        <div className="fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function TrendChart({
  points,
  target,
  dotLabel,
  lineLabel,
}: {
  points: { date: string; dot: number | null; line: number | null }[];
  target?: number | null;
  dotLabel: string;
  lineLabel?: string;
}) {
  const values = points.flatMap((point) => [point.dot, point.line].filter((value): value is number => value != null));
  if (target != null) values.push(target);
  if (values.length === 0) return <p className="quiet">Nothing to chart yet.</p>;
  const width = 320;
  const height = 176;
  const pad = { l: 38, r: 8, t: 12, b: 26 };
  const { yMin, yMax, ticks } = chartScale(values);
  const xAt = (index: number) =>
    pad.l + (points.length <= 1 ? (width - pad.l - pad.r) / 2 : (index / (points.length - 1)) * (width - pad.l - pad.r));
  const yAt = (value: number) => pad.t + (1 - (value - yMin) / (yMax - yMin)) * (height - pad.t - pad.b);
  const lineParts: string[] = [];
  let command = "";
  points.forEach((point, index) => {
    if (point.line == null) {
      if (command) lineParts.push(command);
      command = "";
      return;
    }
    command += `${command ? "L" : "M"}${xAt(index).toFixed(1)},${yAt(point.line).toFixed(1)}`;
  });
  if (command) lineParts.push(command);
  const short = (iso: string) => {
    const [year, month, day] = iso.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  };
  return (
    <div className="chart-block">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${dotLabel}${lineLabel ? `, ${lineLabel}` : ""}`}>
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={pad.l} x2={width - pad.r} y1={yAt(tick)} y2={yAt(tick)} className="grid-line" />
            <text x={pad.l - 6} y={yAt(tick) + 4} className="axis" textAnchor="end">
              {tick.toFixed(tick >= 20 ? 0 : 1)}
            </text>
          </g>
        ))}
        {target != null && (
          <line x1={pad.l} x2={width - pad.r} y1={yAt(target)} y2={yAt(target)} className="target-line" />
        )}
        {lineParts.map((part) => (
          <path key={part} d={part} className="avg-line" />
        ))}
        {points.map((point, index) =>
          point.dot == null ? null : <circle key={point.date} cx={xAt(index)} cy={yAt(point.dot)} r="3.5" className="dot" />,
        )}
        <text x={xAt(0)} y={height - 6} className="axis">
          {short(points[0].date)}
        </text>
        <text x={xAt(points.length - 1)} y={height - 6} className="axis" textAnchor="end">
          {short(points[points.length - 1].date)}
        </text>
      </svg>
      <div className="legend">
        <span><i className="swatch dot-swatch" /> {dotLabel}</span>
        {lineLabel && <span><i className="swatch line-swatch" /> {lineLabel}</span>}
        {target != null && <span><i className="swatch dash-swatch" /> Target</span>}
      </div>
    </div>
  );
}

export function Back({ to, label = "Back" }: { to: string; label?: string }) {
  const { go } = useNav();
  return (
    <button type="button" className="back" onClick={() => go(to, { restoreScroll: true })}>
      {label}
    </button>
  );
}

export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

export function Banner({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p className="banner" role="alert">
      {text}
    </p>
  );
}

export function Confirm({
  title,
  body,
  confirmLabel,
  danger,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return createPortal(
    <div className="sheet-back" role="presentation" onClick={onCancel}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="confirm-title">{title}</h2>
        <p>{body}</p>
        <div className="split">
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className={danger ? "primary danger" : "primary"} disabled={busy} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
