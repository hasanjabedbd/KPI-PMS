# HR Month-End Finalization Lock & Yearly Average Appraisal Reporting

This plan introduces strict governance for finalized appraisal months—automatically locking past finalized months from unauthorized changes by Employees or Line Managers—and adds comprehensive **Yearly Average Performance Reports** (with a Jan–Dec monthly breakdown table) for both individual employees and department-wide Best Employee rankings.

## User Review & Critical Decisions

> [!IMPORTANT]
> All three core workflow rules have been confirmed and will govern the implementation below:

- **Confirmed Decision 1 — HR Month-End Lock Scope**: When HR sets an Effective Month's (`YYYY-MM`) workflow status to **HR Approved & Finalized**, all inputs for that month (Daily Work Logs, Self-Appraisal notes, Quantitative KPI edits, and Qualitative ratings) are **locked for both Employees and Line Managers**. Only **HR** can reopen/unlock a finalized month.
- **Confirmed Decision 2 — Yearly Performance Calculation**: The Yearly Performance Report calculates the **average of all evaluated months** within the selected year (`YYYY`) and includes a **Month-by-Month (Jan–Dec) Appraisal Breakdown Table** alongside the overall yearly composite score.
- **Confirmed Decision 3 — Department Best Employee Ranking Scope**: HR's Department Ranking & Best Employee PDF Report supports switching between **Monthly Ranking (`YYYY-MM`)** and **Yearly Average Ranking (`YYYY`)** to identify both the *Employee of the Month* and the *Employee of the Year*.

---

## 1. Overview & Core Concept

- **What It Does**:
  1. **Month-End Appraisal Lock (`HR Approved & Finalized`)**: Protects historical monthly scores from retroactive tampering once HR finalizes a month's evaluation.
  2. **Yearly Average Performance Dossier & PDF**: Aggregates an employee's monthly evaluations across a calendar year (`YYYY`), displaying each evaluated month's Quantitative (80%), Qualitative (20%), Total Score (100%), Workflow Status, and Recommendation in a 12-month ledger table, and computes the **Annual Average Appraisal Score**.
  3. **Employee of the Year / Yearly Department Ranking**: Extends the HR Ranking Engine so HR can toggle between a single month (`2026-10`) or a full year (`2026`) when viewing dashboard leaderboards and exporting the Best Employee PDF.
- **Target Audience / Persona**:
  - **HR Administrators**: Finalize/lock monthly appraisals, reopen a month if a correction is needed, and generate Monthly or Yearly Best Employee & Individual Appraisal PDFs.
  - **Line Managers**: Evaluate team KPIs and competencies for open months while viewing read-only locked records for HR-finalized months.
  - **Employees**: Submit Daily Work Logs and Self-Appraisals for open months, acknowledge finalized appraisals, and download Monthly or Yearly Performance PDF reports.

---

## 2. User Experience & Visual Design

- **Key User Flows**:
  1. **HR Finalization & Lock Flow**:
     - When HR selects `4. HR Approved & Finalized` (or clicks a quick **"Finalize & Lock Month"** action button) for an employee's Effective Month (`YYYY-MM`), a prominent lock banner appears for that month: `🔒 Month Finalized by HR — Locked for Employee & Line Manager edits`.
     - If an Employee selects aWork Date (`YYYY-MM-DD`) in `Daily Work Report` that belongs to an HR-finalized month (`YYYY-MM`), the form displays a clear lock notice and disables submission for that finalized month.
     - If a Line Manager views a finalized Effective Month (`YYYY-MM`), KPI creation/editing and Qualitative rating controls are disabled with a read-only lock indicator, while HR retains an **"Unlock / Reopen Month"** button.
  2. **Individual Yearly Performance Report Flow**:
     - In the Employee Details Modal, Employee's `My KPIs & Appraisal` view, and Work Report History, users can choose between **Monthly PDF Report (`YYYY-MM`)** and **Yearly Average PDF Report (`YYYY`)**.
     - The Yearly Report displays:
       - **Annual Executive Summary Strip**: Yearly Avg Quantitative (`X / 80 pts`), Yearly Avg Qualitative (`Y / 20 pts`), **Final Yearly Average Score (`Z% · Excellent / Good / Needs Improvement`)**, and Total Evaluated Months (`N / 12 months`).
       - **12-Month (Jan–Dec) Appraisal Progression Table**: Month name, Quantitative Score, Qualitative Score, Total Monthly Score, Performance Band, Workflow Status, and Management Recommendation.
       - **Detailed KPI & Competency Summary** for the year.
  3. **HR Department Best Employee Ranking (Monthly vs. Yearly)**:
     - In the HR Dashboard Ranking Card, HR can toggle between **`Monthly Ranking`** (select `YYYY-MM`) and **`Yearly Average Ranking`** (select `YYYY`, e.g., `2026`).
     - Rank #1 is crowned **`★ BEST EMPLOYEE OF THE MONTH`** or **`★ BEST EMPLOYEE OF THE YEAR`** based on the selected mode, both on-screen and in the exported PDF.

- **Visual Identity & Theme**:
  - *Aesthetic Direction*: High-density enterprise SaaS ledger with crisp 1px structural borders (`#e1dfdd`), clean white/off-white surfaces (`#ffffff` / `#f8f9fa`), and zero nested card clutter.
  - *Color Palette & Semantic States*:
    - Primary Brand Blue (`#0078d4`) for Quantitative metrics and primary actions.
    - Teal (`#038387`) for Qualitative behavioral metrics.
    - Forest Green (`#107c10` on `#dff6dd`) for `Excellent (≥80%)` and `HR Approved & Locked` states.
    - Amber (`#ca5010` on `#fff4ce`) for warnings and pending evaluations.
    - Crimson (`#a4262c` on `#fde7e9`) for `Needs Improvement (<50%)` or blocked actions on locked months.
  - *Typography & Tabular Discipline*: Clean sans-serif UI hierarchy paired with strict monospace tabular figures (`tabular-nums`) for all scores, weights, dates, and rank numbers so columns align vertically.

---

## 3. Key Product Decisions & Trade-Offs

- **Decision 1: Granular Month-Level Locking vs. Global Account Locking**
  - *Chosen Approach*: Lock is applied per **Effective Month (`YYYY-MM`)** stored in `qualitativeByMonth[month].workflowStatus === "hr_approved"`.
  - *Why*: If October (`2026-10`) is finalized by HR, the Employee and Line Manager must immediately be able to log work and set KPIs for November (`2026-11`) while October remains strictly locked.
- **Decision 2: Yearly Average Over Evaluated Months Only**
  - *Chosen Approach*: Compute the annual average across only the months in `YYYY` that have active KPI data or a completed evaluation (`evaluatedMonths.length`), while showing all 12 calendar months (`Jan`–`Dec`) in the progression table (`— Not Evaluated` for future/empty months).
  - *Why*: Prevents an employee who joined mid-year or when the current month is October from having their annual average artificially dragged down by future months (Nov–Dec) that haven't occurred yet.

---

## 4. Technical Architecture & Data Strategy

### Architecture & Component Diagram

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     Firestore User & WorkLog State Store                     │
│  • kpis[] (with effectiveMonth: "YYYY-MM")                                   │
│  • qualitativeByMonth["YYYY-MM"] (workflowStatus: "hr_approved" = LOCKED)    │
└───────────────────┬──────────────────────────────────────┬───────────────────┘
                    │                                      │
                    ▼                                      ▼
┌────────────────────────────────────────┐  ┌──────────────────────────────────┐
│   Month-End Lock Enforcement Engine    │  │   Yearly Aggregation Engine      │
│  • isMonthLockedForUser(u, month, role)│  │  • computeYearlyAppraisalSummary │
│  • Blocks Employee WorkLog if date's   │  │    Iterates Jan..Dec ("YYYY-01"  │
│    month ("YYYY-MM") is HR-finalized   │  │    to "YYYY-12")                 │
│  • Blocks Line Manager KPI & Qual      │  │  • Averages evaluated months:    │
│    edits for HR-finalized months       │  │    Quant Avg + Qual Avg = Total  │
│  • Allows HR to Finalize or Unlock     │  │  • Feeds Individual Yearly PDF   │
│    any month at any time               │  │    & Dept Yearly Ranking PDF     │
└────────────────────────────────────────┘  └──────────────────────────────────┘
```

### Interactive Component & State Mapping

1. **Month Lock Helper (`isMonthFinalized(u, monthStr)` & `canEditMonth(u, monthStr, viewerRole)`)**:
   - Checks whether `u.qualitativeByMonth?.[monthStr]?.workflowStatus === "hr_approved"` (or `u.qualitative?.effectiveMonth === monthStr && u.qualitative?.workflowStatus === "hr_approved"`).
   - Returns `isLocked = true` for `employee` and `manager` roles when finalized; `hr` always retains lock/unlock toggle control.
   - Note: Even when a month is locked by HR, the Employee can still click **"✓ Acknowledge & Sign Off Appraisal"** once to record their digital acknowledgment without altering any scores.
2. **Daily Work Report Lock Guard**:
   - Extracts `worklogMonth = (worklogDate || today()).slice(0, 7)`.
   - If `isMonthFinalized(currentProfile, worklogMonth)` is true, renders a prominent lock alert (`🔒 Appraisal for ${worklogMonth} has been finalized by HR. Work logs for this month are locked.`) and disables the submit button and quantity inputs for that month.
3. **Yearly Appraisal Calculator (`computeYearlyAppraisalSummary(u, yearStr)`)**:
   - Generates 12 monthly slots (`${yearStr}-01` through `${yearStr}-12`).
   - Evaluates each month where the employee has assigned KPIs (`k.effectiveMonth === monthStr`) or a month-specific qualitative record (`u.qualitativeByMonth?.[monthStr]`).
   - Computes `avgQuantPoints`, `avgQualPoints`, `avgTotalScore`, `band`, `evaluatedMonthsCount`, and the 12-row `monthsBreakdown` array.
4. **PDF Generators (`downloadYearlyAppraisalPdf` & upgraded `downloadDepartmentRankingPdf`)**:
   - Uses the isolated `html2canvas` `onclone` container pattern to generate crisp A4 PDFs for both the **Individual Yearly Performance Report** and the **Department Yearly Best Employee Ranking Report**.
