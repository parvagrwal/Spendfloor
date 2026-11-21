import { useState, type ReactNode } from "react";
import { Check, Copy, ExternalLink, Info, AlertTriangle, ShieldCheck, ShieldX, CircleHelp } from "lucide-react";
import type { ExecutionState, Freshness, VerificationState } from "../lib/types";
import { executionLabel, freshnessLabel, statusLabel } from "../lib/format";

export type Tone = "lime" | "green" | "red" | "amber" | "neutral" | "info";

export function StatusBadge({ tone, children, dot = true }: { tone: Tone; children: ReactNode; dot?: boolean }) {
  return <span className={`badge badge-${tone}`}>{dot && <span className="badge-dot" aria-hidden="true" />}{children}</span>;
}

export function VerificationBadge({ state }: { state: VerificationState }) {
  const tone: Tone = state === "verified" ? "green" : state === "partial" ? "amber" : state === "failed" ? "red" : "neutral";
  return <StatusBadge tone={tone}>{statusLabel(state)}</StatusBadge>;
}

export function ExecutionBadge({ state }: { state: ExecutionState }) {
  const tone: Tone = state === "confirmed" ? "green" : state === "rejected" ? "red" : state === "timed_out" || state === "failed" ? "amber"
    : state === "not_started" || state === "unknown" ? "neutral" : "info";
  return <StatusBadge tone={tone}>{executionLabel(state)}</StatusBadge>;
}

export function FreshnessBadge({ source }: { source: Freshness }) {
  const tone: Tone = source === "Live" ? "green" : source === "Historical" ? "info" : source === "Unavailable" ? "neutral" : "amber";
  return <StatusBadge tone={tone} dot={false}>{freshnessLabel(source)}</StatusBadge>;
}

export function CopyButton({ value, label = "Copy", compact = false }: { value: string | null; label?: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="muted">—</span>;
  return (
    <button
      type="button"
      className={compact ? "icon-button" : "copy-button"}
      aria-label={`${label} to clipboard`}
      title={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? <><Check size={compact ? 14 : 13} aria-hidden="true" />{!compact && " Copied"}</> : <><Copy size={compact ? 14 : 13} aria-hidden="true" />{!compact && ` ${label}`}</>}
    </button>
  );
}

export function MonoId({ value, label = "Identifier", href, short }: { value: string | null; label?: string; href?: string | null; short?: string }) {
  if (!value) return <span className="mono muted">—</span>;
  return (
    <span className="mono-id">
      <span className="mono" title={value}>{short ?? value}</span>
      <CopyButton value={value} label={label} compact />
      {href && <a className="icon-button" href={href} target="_blank" rel="noopener noreferrer" title="Open in explorer" aria-label="Open in explorer"><ExternalLink size={14} aria-hidden="true" /></a>}
    </span>
  );
}

export function PageHeader({ title, subtitle, badge, actions }: { title: string; subtitle: string; badge?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div className="page-header-main">
        <div className="page-header-title-row">
          <h1>{title}</h1>
          {badge}
        </div>
        <p>{subtitle}</p>
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </header>
  );
}

export function SectionHeading({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="section-heading">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function Alert({ tone = "info", title, children }: { tone?: Tone; title: string; children: ReactNode }) {
  const Icon = tone === "red" ? ShieldX : tone === "green" ? ShieldCheck : tone === "amber" ? AlertTriangle : tone === "neutral" ? CircleHelp : Info;
  return (
    <div className={`alert alert-${tone}`} role="status">
      <Icon size={18} aria-hidden="true" />
      <div><strong>{title}</strong><div className="alert-body">{children}</div></div>
    </div>
  );
}

export function EmptyState({ title, children, icon }: { title: string; children: ReactNode; icon?: ReactNode }) {
  return <div className="empty-state">{icon ?? <CircleHelp size={22} aria-hidden="true" />}<strong>{title}</strong><p>{children}</p></div>;
}

export function Skeleton({ height = 18, width = "100%" }: { height?: number; width?: string | number }) {
  return <span className="skeleton" style={{ height, width }} aria-hidden="true" />;
}

export function Metric({ label, value, unit, hint, tone }: { label: string; value: ReactNode; unit?: string; hint?: ReactNode; tone?: Tone }) {
  return (
    <div className={`metric ${tone ? `metric-${tone}` : ""}`}>
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}{unit && <span className="metric-unit">{unit}</span>}</div>
      {hint && <div className="metric-hint">{hint}</div>}
    </div>
  );
}
