import { FAKE_EMAIL_DOMAIN } from "./firebase-config.js";

export function toFakeEmail(userId) {
  return userId.trim().toLowerCase().replace(/\s+/g, "") + "@" + FAKE_EMAIL_DOMAIN;
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function escapeHtml(s) {
  return (s || "")
    .toString()
    .replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[c]));
}

export function kpiPercent(k) {
  const raw = k.lowerIsBetter ? (k.target / Math.max(k.current, 0.0001)) * 100 : (k.current / k.target) * 100;
  return Math.max(0, Math.min(120, raw));
}

export function statusColor(pct) {
  if (pct >= 100) return "var(--moss)";
  if (pct >= 75) return "var(--brass)";
  return "var(--rule-red)";
}

export function statusLabel(pct) {
  if (pct >= 100) return "On Target";
  if (pct >= 75) return "On Track";
  return "At Risk";
}

export function weightedScore(kpis) {
  if (!kpis || kpis.length === 0) return 0;
  const totalWeight = kpis.reduce((s, k) => s + Number(k.weight), 0) || 1;
  const weighted = kpis.reduce((s, k) => s + kpiPercent(k) * Number(k.weight), 0);
  return Math.round(weighted / totalWeight);
}

export function fmtVal(n, unit) {
  if (unit === "BDT") return "৳" + Number(n).toLocaleString("en-IN");
  return `${n}${unit === "%" ? "%" : " " + unit}`;
}
