"use client";

import { useState } from "react";

/** First-run button: builds the screen straight from Kite when no report exists yet. */
export default function BuildScreen() {
  const [state, setState] = useState<{ busy: boolean; authUrl?: string; error?: string }>({ busy: false });

  async function build() {
    setState({ busy: true });
    try {
      const res = await fetch("/api/kite/refresh", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      if (data.status === "auth") {
        window.open(data.authUrl, "_blank");
        setState({ busy: false, authUrl: data.authUrl });
        return;
      }
      window.location.reload();
    } catch (e) {
      setState({ busy: false, error: (e as Error).message });
    }
  }

  return (
    <div style={{ display: "grid", gap: 8, justifyItems: "start" }}>
      <button className="btn primary" disabled={state.busy} onClick={build}>
        {state.busy ? "Building screen from Kite… (first run fetches 2 years of candles)" : "▶ Build screen from Kite"}
      </button>
      {state.authUrl && <div className="muted sm">Kite login needed: <a href={state.authUrl} target="_blank" rel="noreferrer">authorize here</a>, then click Build again.</div>}
      {state.error && <div className="sm neg">{state.error}</div>}
    </div>
  );
}
