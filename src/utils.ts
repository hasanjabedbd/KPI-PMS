import { FAKE_EMAIL_DOMAIN } from "./firebase";

export interface KpiItem {
  id: string;
  title: string;
  target: number;
  current: number;
  unit: string;
  frequency?: string;
  weight: number;
  lowerIsBetter?: boolean;
  deadline?: string;
  effectiveMonth?: string; // YYYY-MM (e.g. "2026-10")
}

export interface KraObjective {
  id: string;
  text: string;
}

export interface KraItem {
  id: string;
  title: string;
  objectives: KraObjective[];
}

export interface CompetencyItem {
  id: string;
  title: string;
  rating: number; // 1 to 5 scale (1=20%, 2=40%, 3=60%, 4=80%, 5=100%)
  weight: number; // default 1 (equal weight) or custom weight
  note?: string;
  effectiveMonth?: string; // YYYY-MM (e.g. "2026-10")
}

export type AppraisalWorkflowStatus = "draft" | "self_submitted" | "manager_reviewed" | "hr_approved";

export const APPRAISAL_WORKFLOW_LABELS: Record<
  AppraisalWorkflowStatus,
  { label: string; color: string; bg: string }
> = {
  draft: { label: "Draft / In Progress", color: "#605e5c", bg: "#f3f2f1" },
  self_submitted: { label: "Self-Appraisal Submitted", color: "#0078d4", bg: "#eff6fc" },
  manager_reviewed: { label: "Manager Evaluated", color: "#038387", bg: "#e6f4f1" },
  hr_approved: { label: "HR Approved & Finalized", color: "#107c10", bg: "#dff6dd" },
};

export const APPRAISAL_RECOMMENDATIONS: string[] = [
  "Pending Decision",
  "Increment & Promotion (Top Star)",
  "Standard Annual/Cycle Increment",
  "Performance Bonus / Incentive",
  "Coaching & Skill Development",
  "PIP (Performance Improvement Plan)",
];

export interface QualitativeAssessment {
  quantWeight: number; // default 80
  qualWeight: number;  // default 20
  mode: "competencies" | "direct";
  directScorePct: number; // 0 to 100
  competencies: CompetencyItem[];
  strengths?: string;
  improvements?: string;
  evaluatedBy?: string;
  evaluatedAt?: string;
  effectiveMonth?: string; // YYYY-MM (e.g. "2026-10")
  workflowStatus?: AppraisalWorkflowStatus;
  recommendation?: string;
  selfAppraisalNote?: string;
  selfSubmittedAt?: string;
  employeeAcknowledged?: boolean;
  acknowledgedAt?: string;
}

export interface UserProfile {
  _uid?: string;
  userId: string;
  name: string;
  role: "hr" | "manager" | "dept_head" | "employee";
  dept: string;
  employeeCode?: string;
  title?: string;
  factory?: string;
  managerUserId?: string;
  appraisalCycle?: string;
  purpose?: string;
  kras?: KraItem[];
  kpis?: KpiItem[];
  qualitative?: QualitativeAssessment;
  qualitativeByMonth?: Record<string, QualitativeAssessment>;
  lastUpdate?: string;
  createdAt?: string;
  authSecret?: string;
  passwordUpdatedAt?: string;
  resetRequestedAt?: string;
}

export interface WorkLogEntry {
  kpiId: string;
  kpiTitle: string;
  unit: string;
  quantity: number;
  notes: string;
}

export interface WorkLogDoc {
  userId: string;
  userUid: string;
  userName: string;
  dept: string;
  date: string;      // Work Date (selected by employee)
  logDate?: string;  // Log Date (auto-assigned by system on submission)
  entries: WorkLogEntry[];
  submittedAt: string;
}

export function getLogDate(log: WorkLogDoc): string {
  if (log.logDate) return log.logDate;
  if (log.submittedAt && log.submittedAt.length >= 10) return log.submittedAt.slice(0, 10);
  return log.date;
}

export interface SystemSettings {
  kpiUnits: string[];
  offices: string[];
  cycles: string[];
  frequencies: string[];
  competencies: string[];
  defaultQuantWeight: number;
}

export const RATING_SCALE: Record<number, { label: string; shortLabel: string; pct: number; color: string }> = {
  1: { label: "1 — Unsatisfactory (20%)", shortLabel: "Unsatisfactory", pct: 20, color: "#a4262c" },
  2: { label: "2 — Developing (40%)", shortLabel: "Developing", pct: 40, color: "#ca5010" },
  3: { label: "3 — Meets Expectations (60%)", shortLabel: "Meets Expectations", pct: 60, color: "#0078d4" },
  4: { label: "4 — Exceeds Expectations (80%)", shortLabel: "Exceeds Expectations", pct: 80, color: "#038387" },
  5: { label: "5 — Role Model / Exceptional (100%)", shortLabel: "Role Model", pct: 100, color: "#107c10" },
};

export interface PerformanceStatus {
  label: string;
  color: string;
  bg: string;
}

export function getPerformanceBand(score: number): PerformanceStatus {
  if (score >= 80) {
    return { label: "Excellent", color: "#107c10", bg: "#dff6dd" };
  }
  if (score >= 50) {
    return { label: "Good", color: "#0078d4", bg: "#eff6fc" };
  }
  return { label: "Needs Improvement", color: "#a4262c", bg: "#fed9cc" };
}

export interface AppraisalBreakdown {
  quantWeight: number;
  qualWeight: number;
  quantRawPct: number;
  qualRawPct: number;
  quantPoints: number;
  qualPoints: number;
  totalScore: number;
  band: PerformanceStatus;
  isQualEvaluated: boolean;
  mode: "competencies" | "direct";
  effectiveMonth?: string;
}

export function filterKpisByEffectiveMonth(kpis: KpiItem[] | undefined, targetMonth?: string): KpiItem[] {
  const list = kpis || [];
  if (!targetMonth || targetMonth === "ALL" || targetMonth === "all") return list;
  return list.filter((k) => !k.effectiveMonth || k.effectiveMonth === targetMonth);
}

export function computeQualitativeRawPct(qual?: QualitativeAssessment, targetMonth?: string): number {
  if (!qual) return 0;
  const isMonthFiltered = Boolean(targetMonth && targetMonth !== "ALL" && targetMonth !== "all");
  if (qual.mode === "direct") {
    if (isMonthFiltered && qual.effectiveMonth && qual.effectiveMonth !== targetMonth) {
      return 0;
    }
    return Math.max(0, Math.min(100, Math.round(Number(qual.directScorePct) || 0)));
  }
  const allComps = qual.competencies || [];
  const comps = isMonthFiltered
    ? allComps.filter((c) => !c.effectiveMonth || c.effectiveMonth === targetMonth)
    : allComps;
  if (comps.length === 0) return 0;
  const totalWeight = comps.reduce((s, c) => s + (Number(c.weight) || 1), 0) || 1;
  const weightedSum = comps.reduce((s, c) => {
    const rating = Math.max(1, Math.min(5, Number(c.rating) || 3));
    const pct = (rating / 5) * 100;
    return s + pct * (Number(c.weight) || 1);
  }, 0);
  return Math.round(weightedSum / totalWeight);
}

export function computeAppraisalBreakdown(u: UserProfile, targetMonth?: string): AppraisalBreakdown {
  const quantWeight = 80;
  const qualWeight = 20;
  const isMonthFiltered = Boolean(targetMonth && targetMonth !== "ALL" && targetMonth !== "all");

  const activeKpis = filterKpisByEffectiveMonth(u.kpis, targetMonth);
  const activeQual =
    isMonthFiltered && targetMonth && u.qualitativeByMonth?.[targetMonth]
      ? u.qualitativeByMonth[targetMonth]
      : u.qualitative;

  const quantRawPct = weightedScore(activeKpis);
  const qualRawPct = computeQualitativeRawPct(activeQual, targetMonth);

  const quantPoints = Number(((quantRawPct * quantWeight) / 100).toFixed(1));
  const qualPoints = Number(((qualRawPct * qualWeight) / 100).toFixed(1));
  const totalScore = Math.round(quantPoints + qualPoints);

  const activeComps = activeQual?.competencies
    ? isMonthFiltered
      ? activeQual.competencies.filter((c) => !c.effectiveMonth || c.effectiveMonth === targetMonth)
      : activeQual.competencies
    : [];

  const isQualEvaluated = Boolean(
    activeQual &&
      ((activeQual.mode === "competencies" && activeComps.length > 0) ||
        (activeQual.mode === "direct" &&
          (!isMonthFiltered || !activeQual.effectiveMonth || activeQual.effectiveMonth === targetMonth) &&
          Number(activeQual.directScorePct) > 0))
  );

  return {
    quantWeight,
    qualWeight,
    quantRawPct,
    qualRawPct,
    quantPoints,
    qualPoints,
    totalScore,
    band: getPerformanceBand(totalScore),
    isQualEvaluated,
    mode: activeQual?.mode || "competencies",
    effectiveMonth: targetMonth || activeQual?.effectiveMonth,
  };
}

export function isMonthFinalized(u?: UserProfile | null, targetMonth?: string): boolean {
  if (!u || !targetMonth || targetMonth === "ALL" || targetMonth === "all") return false;
  const monthQual = u.qualitativeByMonth?.[targetMonth];
  if (monthQual && monthQual.workflowStatus === "hr_approved") return true;
  if (
    u.qualitative &&
    u.qualitative.effectiveMonth === targetMonth &&
    u.qualitative.workflowStatus === "hr_approved"
  ) {
    return true;
  }
  return false;
}

export function isMonthLockedForRole(
  u?: UserProfile | null,
  targetMonth?: string,
  viewerRole?: string
): boolean {
  if (viewerRole === "hr") return false;
  return isMonthFinalized(u, targetMonth);
}

export const MONTH_SHORT_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export interface YearlyMonthRow {
  monthKey: string; // e.g. "2026-01"
  monthLabel: string; // e.g. "Jan 2026"
  hasEvaluation: boolean;
  isEvaluated: boolean;
  kpiCount: number;
  quantPoints: number;
  quantRawPct: number;
  qualPoints: number;
  qualRawPct: number;
  totalScore: number;
  band: PerformanceStatus;
  workflowStatus: AppraisalWorkflowStatus;
  recommendation: string;
  isLocked: boolean;
  isFinalized: boolean;
}

export interface YearlyAppraisalSummary {
  year: string;
  evaluatedMonthsCount: number;
  finalizedMonthsCount: number;
  latestRecommendation: string;
  avgQuantPoints: number;
  avgQualPoints: number;
  avgQuantRawPct: number;
  avgQualRawPct: number;
  avgTotalScore: number;
  band: PerformanceStatus;
  months: YearlyMonthRow[];
}

export function computeYearlyAppraisalSummary(u: UserProfile, yearStr?: string): YearlyAppraisalSummary {
  const year = (yearStr || today().slice(0, 4)).slice(0, 4);
  const allKpis = u.kpis || [];
  const months: YearlyMonthRow[] = [];

  for (let m = 1; m <= 12; m++) {
    const mm = m < 10 ? `0${m}` : `${m}`;
    const monthKey = `${year}-${mm}`;
    const monthLabel = `${MONTH_SHORT_NAMES[m - 1]} ${year}`;

    const monthSpecificKpis = allKpis.filter((k) => k.effectiveMonth === monthKey);
    const ongoingKpis = allKpis.filter((k) => !k.effectiveMonth);
    const qualForMonth =
      u.qualitativeByMonth?.[monthKey] ||
      (u.qualitative?.effectiveMonth === monthKey ? u.qualitative : undefined);

    const hasQualActivity = Boolean(
      qualForMonth &&
        ((qualForMonth.mode === "competencies" &&
          (qualForMonth.competencies || []).some(
            (c) => !c.effectiveMonth || c.effectiveMonth === monthKey
          )) ||
          (qualForMonth.mode === "direct" && Number(qualForMonth.directScorePct) > 0) ||
          qualForMonth.workflowStatus === "hr_approved" ||
          qualForMonth.workflowStatus === "manager_reviewed" ||
          qualForMonth.workflowStatus === "self_submitted")
    );

    const hasMonthData = monthSpecificKpis.length > 0 || hasQualActivity;

    const br = computeAppraisalBreakdown(u, monthKey);
    const wfStatus: AppraisalWorkflowStatus = qualForMonth?.workflowStatus || "draft";
    const rec = qualForMonth?.recommendation || "Pending Decision";
    const finalized = isMonthFinalized(u, monthKey);

    months.push({
      monthKey,
      monthLabel,
      hasEvaluation: hasMonthData,
      isEvaluated: hasMonthData,
      kpiCount: monthSpecificKpis.length || (hasMonthData ? ongoingKpis.length : 0),
      quantPoints: hasMonthData ? br.quantPoints : 0,
      quantRawPct: hasMonthData ? br.quantRawPct : 0,
      qualPoints: hasMonthData ? br.qualPoints : 0,
      qualRawPct: hasMonthData ? br.qualRawPct : 0,
      totalScore: hasMonthData ? br.totalScore : 0,
      band: getPerformanceBand(hasMonthData ? br.totalScore : 0),
      workflowStatus: wfStatus,
      recommendation: rec,
      isLocked: finalized,
      isFinalized: finalized,
    });
  }

  let evaluatedRows = months.filter((r) => r.hasEvaluation);

  if (evaluatedRows.length === 0 && (allKpis.length > 0 || u.qualitative)) {
    const fallbackBr = computeAppraisalBreakdown(u);
    const defaultM = (u.qualitative?.effectiveMonth || today().slice(0, 7)).slice(5, 7);
    const idx = Math.max(0, Math.min(11, (Number(defaultM) || 1) - 1));
    const finalized = u.qualitative?.workflowStatus === "hr_approved";
    months[idx] = {
      ...months[idx],
      hasEvaluation: true,
      isEvaluated: true,
      kpiCount: allKpis.length,
      quantPoints: fallbackBr.quantPoints,
      quantRawPct: fallbackBr.quantRawPct,
      qualPoints: fallbackBr.qualPoints,
      qualRawPct: fallbackBr.qualRawPct,
      totalScore: fallbackBr.totalScore,
      band: fallbackBr.band,
      workflowStatus: u.qualitative?.workflowStatus || "draft",
      recommendation: u.qualitative?.recommendation || "Pending Decision",
      isLocked: finalized,
      isFinalized: finalized,
    };
    evaluatedRows = [months[idx]];
  }

  const count = evaluatedRows.length;
  const finalizedMonthsCount = months.filter((r) => r.isFinalized).length;
  const latestWithRec = [...evaluatedRows]
    .reverse()
    .find((r) => r.recommendation && r.recommendation !== "Pending Decision");
  const latestRecommendation =
    latestWithRec?.recommendation ||
    u.qualitative?.recommendation ||
    "Pending Decision";

  const avgQuantPoints =
    count > 0
      ? Number((evaluatedRows.reduce((s, r) => s + r.quantPoints, 0) / count).toFixed(1))
      : 0;
  const avgQualPoints =
    count > 0
      ? Number((evaluatedRows.reduce((s, r) => s + r.qualPoints, 0) / count).toFixed(1))
      : 0;
  const avgTotalScore = count > 0 ? Math.round(avgQuantPoints + avgQualPoints) : 0;
  const avgQuantRawPct = Math.round((avgQuantPoints / 80) * 100);
  const avgQualRawPct = Math.round((avgQualPoints / 20) * 100);

  return {
    year,
    evaluatedMonthsCount: count,
    finalizedMonthsCount,
    latestRecommendation,
    avgQuantPoints,
    avgQualPoints,
    avgQuantRawPct,
    avgQualRawPct,
    avgTotalScore,
    band: getPerformanceBand(avgTotalScore),
    months,
  };
}

export function toFakeEmail(userId: string): string {
  return userId.trim().toLowerCase().replace(/\s+/g, "") + "@" + FAKE_EMAIL_DOMAIN;
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function escapeHtml(s: unknown): string {
  return (s || "")
    .toString()
    .replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c] || c));
}

export function kpiPercent(k: KpiItem): number {
  const target = Number(k.target) || 1;
  const current = Number(k.current) || 0;
  const raw = k.lowerIsBetter
    ? (target / Math.max(current, 0.0001)) * 100
    : (current / target) * 100;
  return Math.max(0, Math.min(120, raw));
}

export function statusColor(pct: number): string {
  if (pct >= 80) return "#107c10";
  if (pct >= 50) return "#0078d4";
  return "#a4262c";
}

export function statusLabel(pct: number): string {
  if (pct >= 80) return "Excellent";
  if (pct >= 50) return "Good";
  return "Needs Improvement";
}

export function weightedScore(kpis?: KpiItem[]): number {
  if (!kpis || kpis.length === 0) return 0;
  const totalWeight = kpis.reduce((s, k) => s + Number(k.weight), 0) || 1;
  const weighted = kpis.reduce((s, k) => s + kpiPercent(k) * Number(k.weight), 0);
  return Math.round(weighted / totalWeight);
}

export function fmtVal(n: number | string, unit: string): string {
  const num = Number(n) || 0;
  if (unit === "BDT") return "৳" + num.toLocaleString("en-IN");
  return `${num}${unit === "%" ? "%" : " " + unit}`;
}

export interface DeadlineStatus {
  date: string;
  label: string;
  color: string;
  isOverdue: boolean;
  isDueSoon: boolean;
  isMet: boolean;
}

export function getDeadlineStatus(k: KpiItem): DeadlineStatus | null {
  const rawDate = (k.deadline || "").trim();
  if (!rawDate) return null;

  const pct = kpiPercent(k);
  if (pct >= 100) {
    return {
      date: rawDate,
      label: "Met",
      color: "#107c10",
      isOverdue: false,
      isDueSoon: false,
      isMet: true,
    };
  }

  const todayStr = today();
  const targetMs = new Date(rawDate + "T00:00:00").getTime();
  const todayMs = new Date(todayStr + "T00:00:00").getTime();
  if (isNaN(targetMs) || isNaN(todayMs)) {
    return {
      date: rawDate,
      label: rawDate,
      color: "#605e5c",
      isOverdue: false,
      isDueSoon: false,
      isMet: false,
    };
  }

  const diffDays = Math.round((targetMs - todayMs) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) {
    return {
      date: rawDate,
      label: `Overdue (${Math.abs(diffDays)}d)`,
      color: "#a4262c",
      isOverdue: true,
      isDueSoon: false,
      isMet: false,
    };
  }
  if (diffDays === 0) {
    return {
      date: rawDate,
      label: "Due Today",
      color: "#ca5010",
      isOverdue: false,
      isDueSoon: true,
      isMet: false,
    };
  }
  if (diffDays <= 7) {
    return {
      date: rawDate,
      label: `Due in ${diffDays}d`,
      color: "#ca5010",
      isOverdue: false,
      isDueSoon: true,
      isMet: false,
    };
  }
  return {
    date: rawDate,
    label: `Due in ${diffDays}d`,
    color: "#605e5c",
    isOverdue: false,
    isDueSoon: false,
    isMet: false,
  };
}
