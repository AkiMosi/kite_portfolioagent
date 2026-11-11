"use client";

import { useState, type ReactNode } from "react";

export const CAT = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)", "var(--c5)", "var(--c6)", "var(--c7)", "var(--c8)"];

/** Wrapper that shows a tooltip near the pointer for any child calling show()/hide(). */
export function useTip() {
  const [tip, setTip] = useState<{ x: number; y: number; body: ReactNode } | null>(null);
  const show = (e: React.MouseEvent, body: ReactNode) => {
    const box = (e.currentTarget as Element).closest(".chart")!.getBoundingClientRect();
    setTip({ x: e.clientX - box.left, y: e.clientY - box.top, body });
  };
  const hide = () => setTip(null);
  const el = tip && (
    <div className="tip" style={{ left: tip.x + 12, top: tip.y + 12 }}>{tip.body}</div>
  );
  return { show, hide, el };
}

export type Slice = { label: string; value: number; color: string; sub?: string };

export function Donut({ data, total, center }: { data: Slice[]; total: number; center: ReactNode }) {
  const { show, hide, el } = useTip();
  const R = 78, r = 54, c = 100;
  let a0 = -Math.PI / 2;
  const arcs = data.map((d) => {
    const frac = d.value / total;
    const a1 = a0 + frac * Math.PI * 2 - (data.length > 1 ? 0.025 : 0);
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (rad: number, a: number) => `${(c + rad * Math.cos(a)).toFixed(3)} ${(c + rad * Math.sin(a)).toFixed(3)}`;
    const path = `M ${p(R, a0)} A ${R} ${R} 0 ${large} 1 ${p(R, a1)} L ${p(r, a1)} A ${r} ${r} 0 ${large} 0 ${p(r, a0)} Z`;
    const out = { d, path, frac };
    a0 += frac * Math.PI * 2;
    return out;
  });
  return (
    <div className="chart donut">
      <svg viewBox="0 0 200 200" role="img" aria-label="Allocation donut">
        {arcs.map(({ d, path, frac }) => (
          <path key={d.label} d={path} fill={d.color} className="mark" onMouseMove={(e) => show(e, <><b>{d.label}</b><div>{(frac * 100).toFixed(1)}% {d.sub ?? ""}</div></>)} onMouseLeave={hide} />
        ))}
      </svg>
      <div className="donut-c">{center}</div>
      {el}
    </div>
  );
}

export type Bar = { label: string; value: number; sub?: string; color?: string };

/** Horizontal bars; with diverging=true bars grow left/right of a zero line. */
export function HBars({ data, diverging, fmt, color = "var(--c1)" }: { data: Bar[]; diverging?: boolean; fmt: (n: number) => string; color?: string }) {
  const { show, hide, el } = useTip();
  const max = Math.max(1e-9, ...data.map((d) => Math.abs(d.value)));
  return (
    <div className="chart hbars">
      {data.map((d) => {
        const w = (Math.abs(d.value) / max) * (diverging ? 50 : 100);
        const neg = d.value < 0;
        return (
          <div className="hrow" key={d.label} onMouseMove={(e) => show(e, <><b>{d.label}</b><div>{fmt(d.value)} {d.sub ?? ""}</div></>)} onMouseLeave={hide}>
            <span className="hl">{d.label}</span>
            <span className="htrack">
              {diverging && <i className="zero" />}
              <i className="hfill" style={{ width: `${Math.max(w, 1)}%`, left: diverging ? (neg ? `${50 - w}%` : "50%") : 0, background: d.color ?? (diverging ? (neg ? "var(--neg)" : "var(--pos)") : color) }} />
            </span>
            <span className={"hv " + (diverging ? (neg ? "neg" : "pos") : "")}>{fmt(d.value)}</span>
          </div>
        );
      })}
      {el}
    </div>
  );
}

export type Pt = { label: string; x: number; y: number; r?: number; color: string; tip: ReactNode };

export function Scatter({ pts, xDom, yDom, xLabel, yLabel, xMid, yMid, quad }: {
  pts: Pt[]; xDom: [number, number]; yDom: [number, number]; xLabel: string; yLabel: string; xMid?: number; yMid?: number; quad?: [string, string, string, string];
}) {
  const { show, hide, el } = useTip();
  const W = 560, H = 340, L = 44, B = 36, T = 12, Rr = 12;
  const sx = (v: number) => L + ((v - xDom[0]) / (xDom[1] - xDom[0])) * (W - L - Rr);
  const sy = (v: number) => T + (1 - (v - yDom[0]) / (yDom[1] - yDom[0])) * (H - T - B);
  const ticks = (d: [number, number]) => { const n = 4; return Array.from({ length: n + 1 }, (_, i) => d[0] + ((d[1] - d[0]) * i) / n); };
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${yLabel} versus ${xLabel}`}>
        {ticks(yDom).map((t) => (<g key={"y" + t}><line x1={L} x2={W - Rr} y1={sy(t)} y2={sy(t)} className="grid" /><text x={L - 6} y={sy(t) + 4} textAnchor="end" className="ax">{Math.round(t)}</text></g>))}
        {ticks(xDom).map((t) => (<text key={"x" + t} x={sx(t)} y={H - B + 16} textAnchor="middle" className="ax">{Math.round(t)}</text>))}
        {xMid != null && <line x1={sx(xMid)} x2={sx(xMid)} y1={T} y2={H - B} className="mid" />}
        {yMid != null && <line x1={L} x2={W - Rr} y1={sy(yMid)} y2={sy(yMid)} className="mid" />}
        {quad && (<>
          <text x={W - Rr - 4} y={T + 14} textAnchor="end" className="quad">{quad[0]}</text>
          <text x={L + 4} y={T + 14} className="quad">{quad[1]}</text>
          <text x={L + 4} y={H - B - 6} className="quad">{quad[2]}</text>
          <text x={W - Rr - 4} y={H - B - 6} textAnchor="end" className="quad">{quad[3]}</text>
        </>)}
        <text x={(L + W) / 2} y={H - 4} textAnchor="middle" className="axl">{xLabel}</text>
        <text transform={`translate(11 ${(T + H - B) / 2}) rotate(-90)`} textAnchor="middle" className="axl">{yLabel}</text>
        {pts.map((p) => (
          <g key={p.label} onMouseMove={(e) => show(e, p.tip)} onMouseLeave={hide} className="mark">
            <circle cx={sx(p.x)} cy={sy(p.y)} r={p.r ?? 7} fill={p.color} fillOpacity={0.85} className="dot" />
            <text x={sx(p.x)} y={sy(p.y) - (p.r ?? 7) - 3} textAnchor="middle" className="dl">{p.label}</text>
          </g>
        ))}
      </svg>
      {el}
    </div>
  );
}

/** One stacked segmented bar with a legend row. */
export function Stacked({ data }: { data: Slice[] }) {
  const { show, hide, el } = useTip();
  const tot = data.reduce((a, b) => a + b.value, 0) || 1;
  return (
    <div className="chart">
      <div className="stack">
        {data.filter((d) => d.value > 0).map((d) => (
          <i key={d.label} style={{ flex: d.value, background: d.color }} onMouseMove={(e) => show(e, <><b>{d.label}</b><div>{d.value} holdings</div></>)} onMouseLeave={hide} />
        ))}
      </div>
      <div className="legend">{data.map((d) => (<span key={d.label}><i style={{ background: d.color }} />{d.label} <b>{d.value}</b> <em>{((d.value / tot) * 100).toFixed(0)}%</em></span>))}</div>
      {el}
    </div>
  );
}

/** 52-week range track with the price marker and optional SMA ticks. */
export function RangeBar({ lo, hi, price, marks = [] }: { lo: number; hi: number; price: number; marks?: { v: number; label: string }[] }) {
  const pos = (v: number) => `${Math.max(0, Math.min(100, ((v - lo) / (hi - lo || 1)) * 100))}%`;
  return (
    <span className="range" title={`52w ${lo} – ${hi}, now ${price}`}>
      <i className="rtrack" />
      {marks.map((m) => (<i key={m.label} className="rtick" style={{ left: pos(m.v) }} title={`${m.label} ${m.v}`} />))}
      <i className="rdot" style={{ left: pos(price) }} />
    </span>
  );
}
