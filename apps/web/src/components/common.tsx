import type React from "react";
import { AlertCircle } from "lucide-react";
import { cx, statusText } from "../lib/utils";

export function StatusPill({ status }: { status?: string }) {
  const raw = String(status || "").toLowerCase();
  const tone = raw.includes("fail") || raw.includes("error") ? "danger" : raw.includes("run") || raw.includes("process") ? "primary" : raw.includes("complete") || raw.includes("done") || raw === "online" ? "success" : raw.includes("cancel") ? "muted" : "default";
  return <span className={cx("pill", "x-pill", `x-pill-${tone}`)}>{statusText(status)}</span>;
}

export function PageTitle({ group, title, desc, right }: { group: string; title: string; desc: string; right?: React.ReactNode }) {
  return (
    <section className="topbar compactTrail x-page-title">
      <div className="titleTrail x-breadcrumb"><span>{group}</span><strong>{title}</strong><p>{desc}</p></div>
      {right ? <div className="topActions x-page-actions">{right}</div> : null}
    </section>
  );
}

export function MetricCard({ icon: Icon, label, value, desc }: { icon: React.ComponentType<{ size?: number }>; label: string; value: string | number; desc: string }) {
  return (
    <div className="metric x-card x-metric-card"><Icon size={22} /><div><span>{label}</span><strong>{value}</strong><p>{desc}</p></div></div>
  );
}

export function EmptyState({ text }: { text: string }) {
  return <div className="emptyPanel x-empty"><AlertCircle size={18} />{text}</div>;
}
