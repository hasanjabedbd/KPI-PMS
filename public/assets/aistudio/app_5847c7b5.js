import { initializeApp, getApps, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  getAuth
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, getDocs, query, where
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { firebaseConfig, auth, db } from "./firebase-config.js";
import { toFakeEmail, today, escapeHtml, kpiPercent, statusColor, statusLabel, weightedScore, fmtVal } from "./utils.js";

// ---------------------------------------------------------------
// Global state
// ---------------------------------------------------------------
export let currentProfile = null;
let orgKpisCache  = [];
let currentDept   = null;
let deptKpisCache = [];
let deptListCache = [];
let empCache = {};
let empOpts  = {};

export let systemSettings = {
  kpiUnits: ["%", "BDT", "hrs", "number", "clients"],
  offices: ["Corporate Office", "Factory 1", "Factory 2"],
  cycles: ["Monthly", "Quarterly", "Half-Yearly", "Yearly"],
  frequencies: ["Daily", "Weekly", "Monthly", "Quarterly", "Yearly"]
};

// ---------------------------------------------------------------
// ROLE CONFIG
// ---------------------------------------------------------------
const TABS_BY_ROLE = {
  hr: [
    { id: "dashboard", label: "Dashboard" },
    { id: "org",       label: "Organizational KPIs" },
    { id: "dept",      label: "Departmental KPIs" },
    { id: "hr",        label: "Employee Accounts" },
    { id: "settings",  label: "System Settings" },
  ],
  manager: [
    { id: "dashboard", label: "Dashboard" },
    { id: "team",      label: "My Team" },
  ],
  dept_head: [
    { id: "dashboard", label: "Dashboard" },
    { id: "org",       label: "Organizational KPIs" },
    { id: "dept",      label: "Departmental KPIs" },
  ],
  employee: [
    { id: "dashboard", label: "Dashboard" },
    { id: "profile",   label: "My Profile" },
    { id: "mykpis",    label: "My KPIs" },
    { id: "worklog",   label: "Daily Work Report" },
  ],
};

const ROLE_LABELS = {
  hr: "HR",
  manager: "Line Manager",
  dept_head: "Dept. Head",
  employee: "Employee",
};

// ---------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------
function roleBadgeHtml(role) {
  const cls = `role-badge role-badge-${role}`;
  return `<span class="${cls}">${ROLE_LABELS[role] || role}</span>`;
}

function kpiBadgeHtml(pct) {
  let cls = "kpi-badge ";
  let label = "";
  if (pct >= 100) { cls += "kpi-badge-on-target"; label = `${Math.round(pct)}% · On Target`; }
  else if (pct >= 75) { cls += "kpi-badge-on-track"; label = `${Math.round(pct)}% · On Track`; }
  else { cls += "kpi-badge-at-risk"; label = `${Math.round(pct)}% · At Risk`; }
  return `<span class="${cls}">${label}</span>`;
}

function barColor(pct) {
  if (pct >= 100) return "bar-green";
  if (pct >= 75)  return "bar-orange";
  return "bar-red";
}

function avatarHtml(name) {
  const initials = (name || "?").split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
  const colors = ["#0078d4","#038387","#5c2d91","#ca5010","#107c10","#a4262c"];
  const color = colors[name.charCodeAt(0) % colors.length];
  return `<div class="emp-avatar" style="background:${color};">${initials}</div>`;
}

// ---------------------------------------------------------------
// AUTH
// ---------------------------------------------------------------
export async function handleLogin() {
  const userId   = document.getElementById("login-userid").value.trim();
  const password = document.getElementById("login-password").value;
  const errBox   = document.getElementById("login-error");
  errBox.style.display = "none";
  if (!userId || !password) return;
  try {
    const cred = await signInWithEmailAndPassword(auth, toFakeEmail(userId), password);
    console.log("Logged in user:", cred.user.uid);
  } catch (err) {
    console.error("Login failed:", err);
    errBox.textContent = "Incorrect User ID or password. (" + err.message + ")";
    errBox.style.display = "block";
  }
}

export async function handleLogout() {
  await signOut(auth);
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    document.getElementById("login-screen").style.display = "flex";
    document.getElementById("app-shell").style.display = "none";
    currentProfile = null;
    return;
  }
  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    if (!snap.exists()) {
      alert("Login successful but no Firestore profile was found.\nPlease create a document at: users/" + user.uid);
      await signOut(auth);
      return;
    }
    currentProfile = snap.data();
    await loadSystemSettings();
    renderApp();
  } catch (err) {
    console.error("Auth state handling error:", err);
    alert("Authentication error: " + err.message);
  }
});

// ---------------------------------------------------------------
// APP RENDER
// ---------------------------------------------------------------
export function toggleNewEmployeeFields() {
  const role = document.getElementById("new-role").value;
  document.getElementById("new-employee-fields").style.display = role === "employee" ? "block" : "none";
}

export function switchTab(tabId, btnEl) {
  document.querySelectorAll(".tab-panel").forEach(el => el.style.display = "none");
  const panel = document.getElementById("panel-" + tabId);
  if (panel) panel.style.display = "block";
  document.querySelectorAll("#tab-nav button").forEach(b => {
    b.classList.remove("active");
    if (b.getAttribute("data-tab") === tabId) b.classList.add("active");
  });
  if (btnEl) btnEl.classList.add("active");
  if (tabId === "settings") {
    renderSettingsPanel();
  }
  if (tabId === "worklog") {
    renderWorkLogPanel();
  }
  if (tabId === "mykpis") {
    renderMyKpis();
  }
}

function renderApp() {
  document.getElementById("login-screen").style.display = "none";
  document.getElementById("app-shell").style.display = "block";
  document.getElementById("who-name").textContent = currentProfile.name;
  document.getElementById("who-role").innerHTML = roleBadgeHtml(currentProfile.role);
  document.getElementById("welcome-heading").textContent = "Good day, " + currentProfile.name.split(" ")[0] + " 👋";

  // Build nav
  const nav  = document.getElementById("tab-nav");
  nav.innerHTML = "";
  const tabs = TABS_BY_ROLE[currentProfile.role] || TABS_BY_ROLE.employee;
  tabs.forEach((t, i) => {
    const btn = document.createElement("button");
    btn.textContent = t.label;
    btn.setAttribute("data-tab", t.id);
    btn.className = i === 0 ? "active" : "";
    btn.onclick = () => switchTab(t.id, btn);
    nav.appendChild(btn);
  });
  switchTab(tabs[0].id);

  // Dashboard stats
  renderDashboard();

  if (currentProfile.role === "hr" || currentProfile.role === "dept_head") {
    renderOrgPanel();
    renderDeptPanel();
  }
  if (currentProfile.role === "hr")       { loadManagersForSelect(); renderEmployeesList(); renderSettingsPanel(); populateFormSelects(); }
  if (currentProfile.role === "manager")  renderTeamList();
  if (currentProfile.role === "employee") { renderMyProfile(); renderMyKpis(); renderWorkLogPanel(); }
}

let empChartInstance = null;
let hrRankingChartInstance = null;
let hrDeptChartInstance = null;

async function renderDashboard() {
  const grid = document.getElementById("dashboard-stats");
  const content = document.getElementById("dashboard-content");
  const headerActions = document.getElementById("dashboard-header-actions");
  if (!grid || !content) return;

  const role = currentProfile.role;

  // Cleanup old charts if any
  if (empChartInstance) { empChartInstance.destroy(); empChartInstance = null; }
  if (hrRankingChartInstance) { hrRankingChartInstance.destroy(); hrRankingChartInstance = null; }
  if (hrDeptChartInstance) { hrDeptChartInstance.destroy(); hrDeptChartInstance = null; }

  if (role === "employee") {
    const kpis = currentProfile.kpis || [];
    const score = weightedScore(kpis);
    const onTarget = kpis.filter(k => kpiPercent(k) >= 100).length;
    const atRisk = kpis.filter(k => kpiPercent(k) < 75).length;

    if (headerActions) {
      headerActions.innerHTML = `
        <button class="btn-secondary btn-sm" onclick="downloadWorkLogPdf(currentProfile.userId, currentProfile.name)">
          📄 Download My Performance Report
        </button>
      `;
    }

    grid.innerHTML = `
      <div class="stat-chip"><div class="stat-chip-value">${score}%</div><div class="stat-chip-label">Performance Score</div></div>
      <div class="stat-chip"><div class="stat-chip-value">${kpis.length}</div><div class="stat-chip-label">KPIs Assigned</div></div>
      <div class="stat-chip"><div class="stat-chip-value" style="color:var(--ms-green);">${onTarget}</div><div class="stat-chip-label">On Target</div></div>
      <div class="stat-chip"><div class="stat-chip-value" style="color:var(--ms-red);">${atRisk}</div><div class="stat-chip-label">At Risk</div></div>
    `;

    if (kpis.length === 0) {
      content.innerHTML = `
        <div class="card" style="text-align:center; padding:32px;">
          <p style="color:var(--text-secondary); margin:0;">No KPIs assigned yet. Once your manager assigns KPIs, charts and analytics will appear here.</p>
        </div>
      `;
      return;
    }

    content.innerHTML = `
      <div class="form-grid" style="margin-bottom: 20px;">
        <div class="card">
          <div class="card-header">
            <div class="card-title">KPI Achievement Analytics (Current vs Target %)</div>
          </div>
          <div style="height: 280px; position: relative;">
            <canvas id="employeeKpiChart"></canvas>
          </div>
        </div>

        <div class="card">
          <div class="card-header">
            <div class="card-title">Performance Summary</div>
          </div>
          <div style="display:flex; flex-direction:column; gap:12px;">
            <div style="padding:12px; background:var(--neutral-4); border-radius:var(--radius-md);">
              <div style="font-size:12px; text-transform:uppercase; color:var(--text-secondary); font-weight:600;">Overall Achievement Status</div>
              <div style="font-size:18px; font-weight:700; color:${score >= 75 ? 'var(--ms-green)' : 'var(--ms-orange)'}; margin-top:2px;">
                ${score >= 100 ? "Outstanding Performance" : score >= 75 ? "On Track with Expectations" : "Needs Improvement"}
              </div>
            </div>
            <div style="font-size:13px; color:var(--text-secondary); line-height:1.6;">
              Your current weighted KPI performance is calculated across all assigned metrics. Log your daily work reports to consistently increase target progress.
            </div>
            <div style="margin-top:auto; padding-top:10px;">
              <button class="btn-primary" style="width:100%;" onclick="switchTab('worklog', document.querySelectorAll('#tab-nav button')[3])">
                ✍️ Submit Daily Work Log
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    // Render Employee Chart
    setTimeout(() => {
      const ctx = document.getElementById("employeeKpiChart");
      if (!ctx || typeof Chart === "undefined") return;

      const labels = kpis.map(k => k.title.length > 18 ? k.title.slice(0, 16) + "…" : k.title);
      const dataValues = kpis.map(k => Math.round(kpiPercent(k)));
      const bgColors = dataValues.map(v => v >= 100 ? '#107c10' : v >= 75 ? '#ca5010' : '#a4262c');

      empChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: labels,
          datasets: [{
            label: 'Achievement %',
            data: dataValues,
            backgroundColor: bgColors,
            borderRadius: 4
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false }
          },
          scales: {
            y: {
              beginAtZero: true,
              max: 120,
              ticks: { callback: v => v + '%' }
            }
          }
        }
      });
    }, 50);

  } else if (role === "hr") {
    if (headerActions) headerActions.innerHTML = "";
    grid.innerHTML = '<div class="alert alert-info" style="grid-column: 1 / -1;">Loading organization metrics…</div>';
    content.innerHTML = "";

    try {
      const usersSnap = await getDocs(collection(db, "users"));
      const allUsers = [];
      usersSnap.forEach(d => allUsers.push({ ...d.data(), _uid: d.id }));

      const employees = allUsers.filter(u => u.role === "employee");
      const deptSnap = await getDocs(collection(db, "deptKpis"));
      const depts = [];
      deptSnap.forEach(d => depts.push(d.id));

      const orgSnap = await getDoc(doc(db, "orgKpis", "main"));
      const orgKpis = orgSnap.exists() ? orgSnap.data().kpis || [] : [];
      const orgScore = weightedScore(orgKpis);

      grid.innerHTML = `
        <div class="stat-chip"><div class="stat-chip-value">${employees.length}</div><div class="stat-chip-label">Total Employees</div></div>
        <div class="stat-chip"><div class="stat-chip-value">${depts.length}</div><div class="stat-chip-label">Departments</div></div>
        <div class="stat-chip"><div class="stat-chip-value">${orgScore}%</div><div class="stat-chip-label">Org KPI Score</div></div>
        <div class="stat-chip"><div class="stat-chip-value">${allUsers.filter(u => u.role === "manager").length}</div><div class="stat-chip-label">Managers</div></div>
      `;

      // Employee Ranking Calculation
      const rankedEmployees = employees.map(emp => {
        const score = weightedScore(emp.kpis || []);
        return { ...emp, performanceScore: score };
      });
      rankedEmployees.sort((a, b) => b.performanceScore - a.performanceScore);

      content.innerHTML = `
        <div class="form-grid" style="margin-bottom: 24px;">
          <div class="card">
            <div class="card-header">
              <div class="card-title">Top Performers Ranking</div>
            </div>
            <div style="height: 280px; position: relative;">
              <canvas id="hrRankingChart"></canvas>
            </div>
          </div>

          <div class="card">
            <div class="card-header">
              <div class="card-title">Performance Distribution</div>
            </div>
            <div style="height: 280px; position: relative;">
              <canvas id="hrDeptChart"></canvas>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-header" style="flex-wrap:wrap; gap:12px;">
            <div>
              <div class="card-title">Executive Employee Ranking & Report Hub</div>
              <div style="font-size:12px; color:var(--text-secondary); margin-top:2px;">
                Employees ranked by weighted KPI achievement. Download individual monthly performance reports directly.
              </div>
            </div>
          </div>
          <div style="overflow-x:auto; margin-top:10px;">
            <table>
              <thead>
                <tr>
                  <th style="width:60px;">Rank</th>
                  <th>Employee</th>
                  <th>Department</th>
                  <th>Appraisal Cycle</th>
                  <th>Score</th>
                  <th>Status</th>
                  <th style="text-align:right;">Actions</th>
                </tr>
              </thead>
              <tbody>
                ${rankedEmployees.length === 0 ? '<tr><td colspan="7" style="text-align:center; color:var(--text-secondary);">No employee accounts found.</td></tr>' : ''}
                ${rankedEmployees.map((emp, idx) => {
                  const s = emp.performanceScore;
                  const rankBadge = idx === 0 ? '🥇 #1' : idx === 1 ? '🥈 #2' : idx === 2 ? '🥉 #3' : `#${idx + 1}`;
                  return `
                    <tr>
                      <td style="font-weight:700; color:var(--ms-blue);">${rankBadge}</td>
                      <td>
                        <div style="display:flex; align-items:center; gap:8px;">
                          ${avatarHtml(emp.name)}
                          <div>
                            <div style="font-weight:600;">${escapeHtml(emp.name)}</div>
                            <div style="font-size:11px; color:var(--text-secondary);">${escapeHtml(emp.userId)}</div>
                          </div>
                        </div>
                      </td>
                      <td>${escapeHtml(emp.dept || "—")}</td>
                      <td>${escapeHtml(emp.appraisalCycle || "Monthly")}</td>
                      <td class="mono" style="font-size:14px; font-weight:700; color:${statusColor(s)};">${s}%</td>
                      <td>${kpiBadgeHtml(s)}</td>
                      <td style="text-align:right;">
                        <button class="btn-secondary btn-sm" onclick="downloadEmployeeReportPdf('${emp._uid}')">
                          📄 PDF Report
                        </button>
                      </td>
                    </tr>
                  `;
                }).join("")}
              </tbody>
            </table>
          </div>
        </div>
      `;

      // Render HR Charts
      setTimeout(() => {
        if (typeof Chart === "undefined") return;

        // 1. Ranking Chart (Top 7)
        const top7 = rankedEmployees.slice(0, 7);
        const rankCtx = document.getElementById("hrRankingChart");
        if (rankCtx) {
          hrRankingChartInstance = new Chart(rankCtx, {
            type: 'bar',
            data: {
              labels: top7.map(e => e.name.split(" ")[0]),
              datasets: [{
                label: 'Score %',
                data: top7.map(e => e.performanceScore),
                backgroundColor: '#0078d4',
                borderRadius: 4
              }]
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              plugins: { legend: { display: false } },
              scales: { y: { beginAtZero: true, max: 120, ticks: { callback: v => v + '%' } } }
            }
          });
        }

        // 2. Performance Distribution Doughnut
        const distCtx = document.getElementById("hrDeptChart");
        if (distCtx) {
          const high = rankedEmployees.filter(e => e.performanceScore >= 100).length;
          const mid = rankedEmployees.filter(e => e.performanceScore >= 75 && e.performanceScore < 100).length;
          const low = rankedEmployees.filter(e => e.performanceScore < 75).length;

          hrDeptChartInstance = new Chart(distCtx, {
            type: 'doughnut',
            data: {
              labels: ['On Target (≥100%)', 'On Track (75-99%)', 'At Risk (<75%)'],
              datasets: [{
                data: [high, mid, low],
                backgroundColor: ['#107c10', '#ca5010', '#a4262c'],
                borderWidth: 2
              }]
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              plugins: {
                legend: { position: 'bottom' }
              }
            }
          });
        }
      }, 50);

    } catch (e) {
      console.error("Dashboard error: ", e);
      grid.innerHTML = `<div class="alert alert-danger" style="grid-column: 1 / -1;">Failed to load metrics: ${e.message}</div>`;
    }
  }
}

// ---------------------------------------------------------------
// HR: CREATE EMPLOYEE
// ---------------------------------------------------------------
export async function handleCreateEmployee() {
  const name     = document.getElementById("new-name").value.trim();
  const userId   = document.getElementById("new-userid").value.trim();
  const password = document.getElementById("new-password").value;
  const role     = document.getElementById("new-role").value;
  const dept     = document.getElementById("new-dept").value.trim();
  const msgBox   = document.getElementById("create-msg");
  msgBox.innerHTML = "";

  if (!name || !userId || !password) {
    msgBox.innerHTML = '<div class="alert alert-danger">⚠️ Full Name, User ID, and Password are required.</div>';
    return;
  }

  const extra = {};
  if (role === "employee") {
    extra.employeeCode  = document.getElementById("new-empcode").value.trim();
    extra.title         = document.getElementById("new-title").value.trim();
    extra.factory       = document.getElementById("new-factory").value;
    extra.managerUserId = document.getElementById("new-manager").value;
    extra.appraisalCycle = document.getElementById("new-cycle").value;
    extra.purpose       = document.getElementById("new-purpose").value.trim();
    extra.kras = [];
    extra.lastUpdate = today();
  }

  const existing = getApps().find(a => a.name === "Secondary");
  if (existing) await deleteApp(existing);

  const secondaryApp  = initializeApp(firebaseConfig, "Secondary");
  const secondaryAuth = getAuth(secondaryApp);

  msgBox.innerHTML = '<div class="alert alert-info">Creating account, please wait…</div>';

  try {
    const cred = await createUserWithEmailAndPassword(secondaryAuth, toFakeEmail(userId), password);
    await setDoc(doc(db, "users", cred.user.uid), {
      name, role, dept, userId,
      createdAt: new Date().toISOString(),
      ...extra,
    });
    await signOut(secondaryAuth);
    await deleteApp(secondaryApp);

    msgBox.innerHTML = `<div class="alert alert-success">✅ Account created successfully — User ID: <strong>${userId}</strong> &nbsp;|&nbsp; Password: <strong>${password}</strong></div>`;
    ["new-name","new-userid","new-password","new-dept","new-empcode","new-title","new-purpose"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });
    loadManagersForSelect();
    renderEmployeesList();
  } catch (err) {
    msgBox.innerHTML = `<div class="alert alert-danger">Error: ${err.message}</div>`;
    await deleteApp(secondaryApp);
  }
}

// ---------------------------------------------------------------
// KPI ROW (for org / dept panels)
// ---------------------------------------------------------------
function kpiRowHtml(prefix, k, canEdit) {
  const pct = kpiPercent(k);
  const freqBadge = k.frequency ? `<span class="role-badge" style="background:var(--neutral-4);color:var(--text-secondary);border:1px solid var(--border-default);font-size:10px;margin-left:6px;">${escapeHtml(k.frequency)}</span>` : "";
  return `
    <div class="kpi-card">
      <div class="kpi-header">
        <div>
          <div class="kpi-title" style="display:flex;align-items:center;">
            ${escapeHtml(k.title)}
            ${freqBadge}
          </div>
          <div class="kpi-meta">${fmtVal(k.current, k.unit)} / ${fmtVal(k.target, k.unit)} &nbsp;·&nbsp; Weight: ${k.weight}%</div>
        </div>
        ${kpiBadgeHtml(pct)}
      </div>
      <div class="bar-track"><div class="bar-fill ${barColor(pct)}" style="width:${Math.min(pct, 100)}%;"></div></div>
      ${canEdit ? `
        <div class="inline-row">
          <input type="number" id="${prefix}-cur-${k.id}" value="${k.current}" />
          <button class="btn-secondary btn-sm" onclick="${prefix === "org" ? "updateOrgCurrent" : "updateDeptCurrent"}('${k.id}')">Update</button>
        </div>` : ""}
    </div>`;
}

// ---------------------------------------------------------------
// ORGANIZATIONAL KPIs
// ---------------------------------------------------------------
async function renderOrgPanel() {
  const container = document.getElementById("org-list");
  if (!container) return;
  container.innerHTML = '<div class="alert alert-info">Loading data…</div>';
  const snap = await getDoc(doc(db, "orgKpis", "main"));
  orgKpisCache = snap.exists() ? snap.data().kpis || [] : [];
  const score   = weightedScore(orgKpisCache);
  const canEdit = currentProfile.role === "hr";

  let html = `
    <div class="score-section">
      <div class="score-big">${score}%</div>
      <div class="score-text">
        <h4>Overall Organizational Score</h4>
        <p>${orgKpisCache.length} KPI(s) tracked</p>
      </div>
    </div>`;

  orgKpisCache.forEach(k => html += kpiRowHtml("org", k, canEdit));

  if (orgKpisCache.length === 0)
    html += '<p style="color:var(--text-secondary); font-size:13px;">No organizational KPIs have been added yet.</p>';

  if (canEdit) {
    html += `
      <div class="form-card" style="margin-top:16px;">
        <div class="card-title" style="margin-bottom:14px;">Add Organizational KPI</div>
        <div class="form-row"><label>KPI Title</label><input id="org-new-title" /></div>
        <div class="form-grid">
          <div class="form-field"><label>Target</label><input type="number" id="org-new-target" /></div>
          <div class="form-field"><label>Current Value</label><input type="number" id="org-new-current" value="0" /></div>
          <div class="form-field"><label>Unit</label>
            <select id="org-new-unit">${getUnitSelectOptionsHtml("%")}</select>
          </div>
          <div class="form-field"><label>Frequency</label>
            <select id="org-new-freq">${getFrequencySelectOptionsHtml("Monthly")}</select>
          </div>
          <div class="form-field" style="grid-column: 1 / -1;"><label>Weight %</label><input type="number" id="org-new-weight" /></div>
        </div>
        <button class="btn-primary" style="width:auto; margin-top:8px;" onclick="addOrgKpi()">Add KPI</button>
      </div>`;
  }
  container.innerHTML = html;
}

export async function updateOrgCurrent(kpiId) {
  const val = Number(document.getElementById("org-cur-" + kpiId).value);
  orgKpisCache = orgKpisCache.map(k => k.id === kpiId ? { ...k, current: val } : k);
  await setDoc(doc(db, "orgKpis", "main"), { kpis: orgKpisCache });
  renderOrgPanel();
}

export async function addOrgKpi() {
  const title   = document.getElementById("org-new-title").value.trim();
  const target  = Number(document.getElementById("org-new-target").value);
  const current = Number(document.getElementById("org-new-current").value) || 0;
  const unit    = document.getElementById("org-new-unit").value;
  const frequency = document.getElementById("org-new-freq").value;
  const weight  = Number(document.getElementById("org-new-weight").value);
  if (!title || !target || !weight) return;
  orgKpisCache = [...orgKpisCache, { id: "o" + Math.random().toString(36).slice(2, 8), title, target, current, unit, frequency, weight }];
  await setDoc(doc(db, "orgKpis", "main"), { kpis: orgKpisCache });
  renderOrgPanel();
}

// ---------------------------------------------------------------
// DEPARTMENTAL KPIs
// ---------------------------------------------------------------
function newDeptFormHtml() {
  return `
    <div class="form-card" style="margin-top:16px;">
      <div class="card-title" style="margin-bottom:12px;">Create New Department</div>
      <div class="inline-row">
        <input id="new-dept-name" placeholder="e.g. Marketing" style="flex:1;" />
        <button class="btn-secondary btn-sm" onclick="createDepartment()">Create</button>
      </div>
    </div>`;
}

async function renderDeptPanel() {
  const container = document.getElementById("dept-list");
  if (!container) return;
  container.innerHTML = '<div class="alert alert-info">Loading data…</div>';
  const snap = await getDocs(collection(db, "deptKpis"));
  deptListCache = [];
  snap.forEach(d => deptListCache.push(d.id));

  if (currentProfile.role === "hr" || currentProfile.role === "dept_head") {
    if (!currentDept || !deptListCache.includes(currentDept)) {
      currentDept = currentProfile.dept && deptListCache.includes(currentProfile.dept)
        ? currentProfile.dept : deptListCache[0] || null;
    }
  } else {
    currentDept = currentProfile.dept || null;
  }

  // Page header with selector
  let selectorHtml = "";
  if ((currentProfile.role === "hr" || currentProfile.role === "dept_head") && deptListCache.length > 0) {
    selectorHtml = `
      <div class="dept-selector">
        <label>Department:</label>
        <select id="dept-select" onchange="switchDept(this.value)">
          ${deptListCache.map(d => `<option value="${escapeHtml(d)}" ${d === currentDept ? "selected" : ""}>${escapeHtml(d)}</option>`).join("")}
        </select>
      </div>`;
  }

  let html = `
    <div class="page-header">
      <div>
        <div class="page-title">${currentDept ? escapeHtml(currentDept) + " Department" : "Departmental KPIs"}</div>
        <div class="page-sub">Department-level performance indicators</div>
      </div>
    </div>
    ${selectorHtml}`;

  if (!currentDept) {
    html += '<p style="font-size:13px; color:var(--text-secondary);">No departments have been created yet.</p>';
    if (currentProfile.role === "hr") html += newDeptFormHtml();
    container.innerHTML = html;
    return;
  }

  const dsnap = await getDoc(doc(db, "deptKpis", currentDept));
  deptKpisCache = dsnap.exists() ? dsnap.data().kpis || [] : [];
  const score         = weightedScore(deptKpisCache);
  const canEditValues = currentProfile.role === "hr" || (currentProfile.role === "dept_head" && currentProfile.dept === currentDept);
  const canAdd        = currentProfile.role === "hr";

  html += `
    <div class="score-section">
      <div class="score-big">${score}%</div>
      <div class="score-text">
        <h4>${escapeHtml(currentDept)} Department Score</h4>
        <p>${deptKpisCache.length} KPI(s) tracked</p>
      </div>
    </div>`;

  deptKpisCache.forEach(k => html += kpiRowHtml("dept", k, canEditValues));
  if (deptKpisCache.length === 0)
    html += '<p style="font-size:13px; color:var(--text-secondary);">No KPIs have been added for this department yet.</p>';

  if (canAdd) {
    html += `
      <div class="form-card" style="margin-top:16px;">
        <div class="card-title" style="margin-bottom:14px;">Add Department KPI</div>
        <div class="form-row"><label>KPI Title</label><input id="dept-new-title" /></div>
        <div class="form-grid">
          <div class="form-field"><label>Target</label><input type="number" id="dept-new-target" /></div>
          <div class="form-field"><label>Current Value</label><input type="number" id="dept-new-current" value="0" /></div>
          <div class="form-field"><label>Unit</label>
            <select id="dept-new-unit">${getUnitSelectOptionsHtml("%")}</select>
          </div>
          <div class="form-field"><label>Frequency</label>
            <select id="dept-new-freq">${getFrequencySelectOptionsHtml("Monthly")}</select>
          </div>
          <div class="form-field" style="grid-column: 1 / -1;"><label>Weight %</label><input type="number" id="dept-new-weight" /></div>
        </div>
        <button class="btn-primary" style="width:auto; margin-top:8px;" onclick="addDeptKpi()">Add KPI</button>
      </div>
      ${newDeptFormHtml()}`;
  }
  container.innerHTML = html;
}

export function switchDept(name) { currentDept = name; renderDeptPanel(); }

export async function createDepartment() {
  const name = document.getElementById("new-dept-name").value.trim();
  if (!name) return;
  await setDoc(doc(db, "deptKpis", name), { kpis: [] });
  currentDept = name;
  renderDeptPanel();
}

export async function updateDeptCurrent(kpiId) {
  const val = Number(document.getElementById("dept-cur-" + kpiId).value);
  deptKpisCache = deptKpisCache.map(k => k.id === kpiId ? { ...k, current: val } : k);
  await setDoc(doc(db, "deptKpis", currentDept), { kpis: deptKpisCache });
  renderDeptPanel();
}

export async function addDeptKpi() {
  const title   = document.getElementById("dept-new-title").value.trim();
  const target  = Number(document.getElementById("dept-new-target").value);
  const current = Number(document.getElementById("dept-new-current").value) || 0;
  const unit    = document.getElementById("dept-new-unit").value;
  const frequency = document.getElementById("dept-new-freq").value;
  const weight  = Number(document.getElementById("dept-new-weight").value);
  if (!title || !target || !weight) return;
  deptKpisCache = [...deptKpisCache, { id: "d" + Math.random().toString(36).slice(2, 8), title, target, current, unit, frequency, weight }];
  await setDoc(doc(db, "deptKpis", currentDept), { kpis: deptKpisCache });
  renderDeptPanel();
}

// ---------------------------------------------------------------
// MANAGER SELECT
// ---------------------------------------------------------------
async function loadManagersForSelect() {
  const sel = document.getElementById("new-manager");
  if (!sel) return;
  sel.innerHTML = '<option value="">— Select Line Manager —</option>';
  const snap = await getDocs(query(collection(db, "users"), where("role", "==", "manager")));
  snap.forEach(d => {
    const u = d.data();
    const opt = document.createElement("option");
    opt.value = u.userId;
    opt.textContent = u.name + " (" + u.userId + ")";
    sel.appendChild(opt);
  });
}

// ---------------------------------------------------------------
// PROFILE CARD
// ---------------------------------------------------------------
function profileCardHtml(u) {
  if (u.role !== "employee") {
    return '<div class="card"><span style="font-size:12px;color:var(--text-secondary);">Role profile fields are applicable to employee accounts only.</span></div>';
  }
  return `
    <div class="card">
      <div class="card-header"><div class="card-title">Profile Details</div></div>
      <div class="profile-grid">
        <div class="profile-field"><span>Employee ID</span><strong>${escapeHtml(u.employeeCode) || "—"}</strong></div>
        <div class="profile-field"><span>Department</span><strong>${escapeHtml(u.dept) || "—"}</strong></div>
        <div class="profile-field"><span>Factory / Office</span><strong>${escapeHtml(u.factory) || "—"}</strong></div>
        <div class="profile-field"><span>Line Manager</span><strong>${escapeHtml(u.managerUserId) || "—"}</strong></div>
        <div class="profile-field"><span>Appraisal Cycle</span><strong>${escapeHtml(u.appraisalCycle) || "—"}</strong></div>
        <div class="profile-field"><span>Last Updated</span><strong>${escapeHtml(u.lastUpdate) || "—"}</strong></div>
      </div>
      <span class="section-label" style="margin-top:8px;">Purpose of Role</span>
      <div class="purpose-block">${escapeHtml(u.purpose) || "<span style='color:var(--text-disabled)'>Not set.</span>"}</div>
    </div>`;
}

// ---------------------------------------------------------------
// KRA SECTION
// ---------------------------------------------------------------
function kraSectionHtml(u, canEdit) {
  const kras = u.kras || [];
  let html = `
    <div class="card" style="margin-top:12px;">
      <div class="card-header"><div class="card-title">KRA-based Role Description</div></div>`;

  if (kras.length === 0)
    html += '<p style="font-size:13px; color:var(--text-secondary);">No KRAs have been defined yet.</p>';

  kras.forEach((k, ki) => {
    html += `<div class="kra-item">
      <div class="kra-title-row">
        <span>${ki + 1}. ${escapeHtml(k.title)}</span>
        ${canEdit ? `<button class="x-btn" onclick="removeKra('${u._uid}','${k.id}')">✕ Remove</button>` : ""}
      </div>`;
    (k.objectives || []).forEach((o, oi) => {
      html += `<div class="kra-obj">
        <span>${ki + 1}${String.fromCharCode(97 + oi)}. ${escapeHtml(o.text)}</span>
        ${canEdit ? `<button class="x-btn" onclick="removeObjective('${u._uid}','${k.id}','${o.id}')">✕</button>` : ""}
      </div>`;
    });
    if (canEdit) {
      html += `<div class="kra-add-row">
        <input id="obj-input-${u._uid}-${k.id}" placeholder="Add objective or activity…" />
        <button class="btn-secondary btn-sm" onclick="addObjective('${u._uid}','${k.id}')">Add</button>
      </div>`;
    }
    html += `</div>`;
  });

  if (canEdit) {
    html += `<div class="inline-row" style="margin-top:14px;">
      <input id="kra-input-${u._uid}" placeholder="Enter new KRA title…" style="flex:1;" />
      <button class="btn-secondary btn-sm" onclick="addKra('${u._uid}')">Add KRA</button>
    </div>`;
  }

  html += `</div>`;
  return html;
}

// ---------------------------------------------------------------
// KPI SECTION (for employee card inside HR / Manager view)
// ---------------------------------------------------------------
function kpiSectionHtml(u, canManage) {
  const kpis = u.kpis || [];
  let html = `
    <div class="card" style="margin-top:12px;">
      <div class="card-header"><div class="card-title">Individual KPIs</div></div>`;

  if (kpis.length === 0)
    html += '<p style="font-size:13px; color:var(--text-secondary);">No KPIs have been assigned yet.</p>';

  kpis.forEach(k => {
    const pct = kpiPercent(k);
    const freqBadge = k.frequency ? `<span class="role-badge" style="background:var(--neutral-4);color:var(--text-secondary);border:1px solid var(--border-default);font-size:10px;margin-left:6px;">${escapeHtml(k.frequency)}</span>` : "";
    html += `<div class="kpi-card">
      <div class="kpi-header">
        <div>
          <div class="kpi-title" style="display:flex;align-items:center;">
            ${escapeHtml(k.title)}
            ${freqBadge}
          </div>
          <div class="kpi-meta">${fmtVal(k.current, k.unit)} / ${fmtVal(k.target, k.unit)} · Weight: ${k.weight}%</div>
        </div>
        <div style="display:flex; gap:8px; align-items:center;">
          ${kpiBadgeHtml(pct)}
          ${canManage ? `<button class="x-btn" onclick="removeKpi('${u._uid}','${k.id}')">✕</button>` : ""}
        </div>
      </div>
      <div class="bar-track"><div class="bar-fill ${barColor(pct)}" style="width:${Math.min(pct, 100)}%;"></div></div>
    </div>`;
  });

  if (canManage) {
    html += `
      <div class="form-card" style="margin-top:12px;">
        <div class="card-title" style="margin-bottom:12px;">Add KPI</div>
        <div class="form-row"><label>KPI Title</label><input id="kpi-new-title-${u._uid}" /></div>
        <div class="form-grid">
          <div class="form-field"><label>Target</label><input type="number" id="kpi-new-target-${u._uid}" /></div>
          <div class="form-field"><label>Unit</label>
            <select id="kpi-new-unit-${u._uid}">${getUnitSelectOptionsHtml("%")}</select>
          </div>
          <div class="form-field"><label>Frequency</label>
            <select id="kpi-new-freq-${u._uid}">${getFrequencySelectOptionsHtml("Monthly")}</select>
          </div>
          <div class="form-field"><label>Weight %</label><input type="number" id="kpi-new-weight-${u._uid}" /></div>
        </div>
        <button class="btn-primary" style="width:auto; margin-top:8px;" onclick="addKpiToEmployee('${u._uid}')">Add KPI</button>
      </div>`;
  }

  html += `</div>`;
  return html;
}

export async function addKpiToEmployee(uid) {
  const title  = document.getElementById("kpi-new-title-"  + uid).value.trim();
  const target = Number(document.getElementById("kpi-new-target-" + uid).value);
  const unit   = document.getElementById("kpi-new-unit-"   + uid).value;
  const frequency = document.getElementById("kpi-new-freq-" + uid).value;
  const weight = Number(document.getElementById("kpi-new-weight-" + uid).value);
  if (!title || !target || !weight) return;
  const kpis = [...(empCache[uid].kpis || []), { id: "k" + Math.random().toString(36).slice(2, 8), title, target, current: 0, unit, frequency, weight }];
  await updateDoc(doc(db, "users", uid), { kpis });
  empCache[uid].kpis = kpis;
  renderEmpBody(uid);
  document.getElementById("emp-body-" + uid).classList.add("open");
}

export async function removeKpi(uid, kpiId) {
  const kpis = (empCache[uid].kpis || []).filter(k => k.id !== kpiId);
  await updateDoc(doc(db, "users", uid), { kpis });
  empCache[uid].kpis = kpis;
  renderEmpBody(uid);
  document.getElementById("emp-body-" + uid).classList.add("open");
}

// ---------------------------------------------------------------
// EMPLOYEE CARD LIST
// ---------------------------------------------------------------
function empCardHtml(uid, u) {
  const score = weightedScore(u.kpis || []);
  return `
    <div class="emp-card">
      <div class="emp-head" onclick="toggleEmpRow('${uid}')">
        <div style="display:flex; align-items:center; gap:12px; flex:1; min-width:0;">
          ${avatarHtml(u.name)}
          <div class="emp-info">
            <div class="emp-name">${escapeHtml(u.name)}</div>
            <div class="emp-sub">${escapeHtml(u.title || ROLE_LABELS[u.role] || u.role)} · ${escapeHtml(u.dept || "")}</div>
          </div>
        </div>
        <div class="emp-head-right">
          ${u.role === "employee" && u.kpis && u.kpis.length > 0 ? `<span class="mono" style="font-size:12px; color:var(--ms-blue); font-weight:600;">${score}%</span>` : ""}
          ${roleBadgeHtml(u.role)}
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="color:var(--text-secondary)">
            <path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
      </div>
      <div class="emp-body" id="emp-body-${uid}"></div>
    </div>`;
}

async function renderEmployeesList() {
  const container = document.getElementById("employees-list");
  if (!container) return;
  container.innerHTML = '<div class="alert alert-info">Loading accounts…</div>';
  const snap = await getDocs(collection(db, "users"));  let html = "";
  snap.forEach(d => {
    const u = { ...d.data(), _uid: d.id };
    empCache[d.id] = u;
    empOpts[d.id]  = { canEditProfile: true, canDelete: true, canManageKpis: u.role === "employee" };
    html += empCardHtml(d.id, u);
  });
  container.innerHTML = html || '<p style="font-size:13px;color:var(--text-secondary);">No accounts found.</p>';}

async function renderTeamList() {
  const container = document.getElementById("team-list");
  if (!container) return;
  container.innerHTML = '<div class="alert alert-info">Loading team members…</div>';
  const snap = await getDocs(query(collection(db, "users"), where("role", "==", "employee"), where("managerUserId", "==", currentProfile.userId)));  let html = "";
  snap.forEach(d => {
    const u = { ...d.data(), _uid: d.id };
    empCache[d.id] = u;
    empOpts[d.id]  = { canEditProfile: true, canDelete: false, canManageKpis: true };
    html += empCardHtml(d.id, u);
  });
  container.innerHTML = html || '<p style="font-size:13px;color:var(--text-secondary);">No team members assigned yet.</p>';}

export function toggleEmpRow(uid) {
  const body   = document.getElementById("emp-body-" + uid);
  const isOpen = body.classList.contains("open");
  document.querySelectorAll(".emp-body").forEach(b => b.classList.remove("open"));
  if (!isOpen) {
    body.classList.add("open");
    renderEmpBody(uid);
  }
}

function renderEmpBody(uid) {
  const u    = empCache[uid];
  const opts = empOpts[uid] || {};
  const body = document.getElementById("emp-body-" + uid);
  let actions = "";
  if (opts.canEditProfile && u.role === "employee")
    actions += `<button class="btn-link" onclick="startEditProfile('${uid}')">✏️ Edit Profile</button>`;
  if (u.role === "employee")
    actions += `<button class="btn-link" onclick="downloadEmployeeReportPdf('${uid}')">📄 Export Monthly PDF Report</button>`;
  if (opts.canDelete)
    actions += `<button class="btn-link-red" onclick="deleteEmployeeAccount('${uid}')">🗑 Delete Account</button>`;

  body.innerHTML = `
    <div style="display:flex; gap:12px; flex-wrap:wrap; margin-bottom:14px;">${actions}</div>
    <div id="profile-view-${uid}">${profileCardHtml(u)}</div>
    <div id="profile-edit-${uid}"></div>
    ${kraSectionHtml(u, opts.canEditProfile && u.role === "employee")}
    ${u.role === "employee" ? kpiSectionHtml(u, opts.canManageKpis) : ""}
  `;
}

export async function deleteEmployeeAccount(uid) {
  const u  = empCache[uid];
  const ok = confirm(`Delete account for "${u.name}"?\n\nThe Firestore profile will be permanently deleted. The Firebase Authentication credential must be removed separately from the Firebase Console.`);
  if (!ok) return;
  await deleteDoc(doc(db, "users", uid));
  delete empCache[uid];
  renderEmployeesList();
}

export async function startEditProfile(uid) {
  const u = empCache[uid];
  if (u.role !== "employee") return;
  document.getElementById("profile-view-" + uid).style.display = "none";

  const snap = await getDocs(query(collection(db, "users"), where("role", "==", "manager")));
  let managerOptions = '<option value="">— Select Line Manager —</option>';
  snap.forEach(d => {
    const m   = d.data();
    const sel = m.userId === u.managerUserId ? "selected" : "";
    managerOptions += `<option value="${escapeHtml(m.userId)}" ${sel}>${escapeHtml(m.name)} (${escapeHtml(m.userId)})</option>`;
  });

  const cycleOptions = systemSettings.cycles.map(c => `<option value="${escapeHtml(c)}" ${c === u.appraisalCycle ? "selected" : ""}>${escapeHtml(c)}</option>`).join("");
  const officeOptions = systemSettings.offices.map(o => `<option value="${escapeHtml(o)}" ${o === u.factory ? "selected" : ""}>${escapeHtml(o)}</option>`).join("");

  document.getElementById("profile-edit-" + uid).innerHTML = `
    <div class="card">
      <div class="card-header"><div class="card-title">Edit Profile</div></div>
      <div class="form-grid">
        <div class="form-field"><label>Employee ID</label><input id="edit-empcode-${uid}" value="${escapeHtml(u.employeeCode)}" /></div>
        <div class="form-field"><label>Job Title</label><input id="edit-title-${uid}" value="${escapeHtml(u.title)}" /></div>
        <div class="form-field"><label>Department</label><input id="edit-dept-${uid}" value="${escapeHtml(u.dept)}" /></div>
        <div class="form-field"><label>Factory / Office</label><select id="edit-factory-${uid}">${officeOptions}</select></div>
        <div class="form-field"><label>Line Manager</label><select id="edit-manager-${uid}">${managerOptions}</select></div>
        <div class="form-field"><label>Appraisal Cycle</label><select id="edit-cycle-${uid}">${cycleOptions}</select></div>
        <div class="form-field" style="grid-column: 1 / -1;">
          <label>Purpose of Role</label><textarea id="edit-purpose-${uid}" rows="2">${escapeHtml(u.purpose)}</textarea>
        </div>
      </div>
      <div style="display:flex; gap:8px; margin-top:12px;">
        <button class="btn-primary" style="width:auto;" onclick="saveProfileEdit('${uid}')">Save Changes</button>
        <button class="btn-ghost" onclick="cancelEditProfile('${uid}')">Cancel</button>
      </div>
    </div>`;
}

export function cancelEditProfile(uid) {
  document.getElementById("profile-view-" + uid).style.display = "block";
  document.getElementById("profile-edit-" + uid).innerHTML = "";
}

export async function saveProfileEdit(uid) {
  const updates = {
    employeeCode:  document.getElementById("edit-empcode-"  + uid).value.trim(),
    title:         document.getElementById("edit-title-"    + uid).value.trim(),
    dept:          document.getElementById("edit-dept-"     + uid).value.trim(),
    factory:       document.getElementById("edit-factory-"  + uid).value.trim(),
    managerUserId: document.getElementById("edit-manager-"  + uid).value,
    appraisalCycle:document.getElementById("edit-cycle-"    + uid).value,
    purpose:       document.getElementById("edit-purpose-"  + uid).value.trim(),
    lastUpdate: today(),
  };
  await updateDoc(doc(db, "users", uid), updates);
  Object.assign(empCache[uid], updates);
  document.getElementById("profile-view-" + uid).style.display = "block";
  document.getElementById("profile-edit-" + uid).innerHTML = "";
  document.getElementById("profile-view-" + uid).innerHTML = profileCardHtml(empCache[uid]);
}

// ---------------------------------------------------------------
// KRA MUTATIONS
// ---------------------------------------------------------------
async function saveKras(uid, kras) {
  await updateDoc(doc(db, "users", uid), { kras, lastUpdate: today() });
  empCache[uid].kras       = kras;
  empCache[uid].lastUpdate = today();
  renderEmpBody(uid);
  document.getElementById("emp-body-" + uid).classList.add("open");
}

export function addKra(uid) {
  const input = document.getElementById("kra-input-" + uid);
  const title = input.value.trim();
  if (!title) return;
  const kras = [...(empCache[uid].kras || []), { id: "kra" + Math.random().toString(36).slice(2, 8), title, objectives: [] }];
  saveKras(uid, kras);
}

export function removeKra(uid, kraId) {
  const kras = (empCache[uid].kras || []).filter(k => k.id !== kraId);
  saveKras(uid, kras);
}

export function addObjective(uid, kraId) {
  const input = document.getElementById("obj-input-" + uid + "-" + kraId);
  const text  = input.value.trim();
  if (!text) return;
  const kras = (empCache[uid].kras || []).map(k =>
    k.id === kraId
      ? { ...k, objectives: [...(k.objectives || []), { id: "ob" + Math.random().toString(36).slice(2, 8), text }] }
      : k
  );
  saveKras(uid, kras);
}

export function removeObjective(uid, kraId, obId) {
  const kras = (empCache[uid].kras || []).map(k =>
    k.id === kraId ? { ...k, objectives: (k.objectives || []).filter(o => o.id !== obId) } : k
  );
  saveKras(uid, kras);
}

// ---------------------------------------------------------------
// EMPLOYEE: MY PROFILE
// ---------------------------------------------------------------
function renderMyProfile() {
  const u = { ...currentProfile, _uid: auth.currentUser.uid };
  document.getElementById("my-profile-card").innerHTML = profileCardHtml(u) + kraSectionHtml(u, false);
}

// ---------------------------------------------------------------
// EMPLOYEE: MY KPIs
// ---------------------------------------------------------------
function renderMyKpis() {
  const kpis      = currentProfile.kpis || [];
  const container = document.getElementById("my-kpis-list");
  if (!container) return;

  if (kpis.length === 0) {
    container.innerHTML = '<div class="alert alert-info">No KPIs have been assigned to you yet. Please contact your Line Manager.</div>';
    return;
  }

  const score = weightedScore(kpis);
  let html = `
    <div class="score-section">
      <div class="score-big">${score}%</div>
      <div class="score-text">
        <h4>My Overall Performance Score</h4>
        <p>${kpis.filter(k => kpiPercent(k) >= 100).length} of ${kpis.length} KPIs on target</p>
      </div>
    </div>`;

  kpis.forEach(k => {
    const pct = kpiPercent(k);
    const freqBadge = k.frequency ? `<span class="role-badge" style="background:var(--neutral-4);color:var(--text-secondary);border:1px solid var(--border-default);font-size:10px;margin-left:6px;">${escapeHtml(k.frequency)}</span>` : "";
    html += `
      <div class="kpi-card">
        <div class="kpi-header">
          <div>
            <div class="kpi-title" style="display:flex;align-items:center;">
              ${escapeHtml(k.title)}
              ${freqBadge}
            </div>
            <div class="kpi-meta">Achieved: <strong>${fmtVal(k.current || 0, k.unit)}</strong> / Target: ${fmtVal(k.target, k.unit)} &nbsp;·&nbsp; Weight: ${k.weight}%</div>
          </div>
          ${kpiBadgeHtml(pct)}
        </div>
        <div class="bar-track"><div class="bar-fill ${barColor(pct)}" style="width:${Math.min(pct, 100)}%;"></div></div>
        <div style="font-size:12px; color:var(--text-secondary); margin-top:8px; display:flex; justify-content:space-between; align-items:center;">
          <span>Tracking Mode: Automated via Daily Work Log</span>
          <span style="font-weight:600; color:var(--ms-blue); cursor:pointer;" onclick="switchTab('worklog', document.querySelectorAll('#tab-nav button')[3])">Log Work &rarr;</span>
        </div>
      </div>`;
  });

  container.innerHTML = html;
}

export async function updateMyKpi(kpiId) {
  const val  = Number(document.getElementById("my-kpi-cur-" + kpiId).value);
  const kpis = (currentProfile.kpis || []).map(k => k.id === kpiId ? { ...k, current: val } : k);
  await updateDoc(doc(db, "users", auth.currentUser.uid), { kpis });
  currentProfile.kpis = kpis;
  renderMyKpis();
  renderDashboard();
}

// ---------------------------------------------------------------
// EMPLOYEE: DAILY WORK LOG & ACTIVITY REPORTING
// ---------------------------------------------------------------
export async function renderWorkLogPanel() {
  const container = document.getElementById("worklog-container");
  if (!container) return;

  const kpis = currentProfile.kpis || [];
  const selectedDate = document.getElementById("worklog-date")?.value || today();

  let kpiInputsHtml = "";
  if (kpis.length === 0) {
    kpiInputsHtml = '<div class="alert alert-info">No KPIs have been assigned yet. KPIs must be assigned before submitting daily work reports.</div>';
  } else {
    kpiInputsHtml = kpis.map(k => `
      <div class="card" style="margin-bottom: 12px; background: var(--bg-surface);">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; margin-bottom:8px;">
          <div>
            <strong>${escapeHtml(k.title)}</strong>
            <span class="mono" style="font-size:12px; color:var(--text-secondary); margin-left:8px;">
              Current: ${fmtVal(k.current, k.unit)} / Target: ${fmtVal(k.target, k.unit)}
            </span>
          </div>
          <span class="role-badge" style="background:var(--neutral-4); color:var(--text-secondary);">${escapeHtml(k.frequency || "Monthly")}</span>
        </div>
        <div class="form-grid">
          <div class="form-field">
            <label>Today's Quantity / Achievement (${escapeHtml(k.unit)})</label>
            <input type="number" step="any" id="log-qty-${k.id}" placeholder="0" />
          </div>
          <div class="form-field">
            <label>Work Summary / Task Details</label>
            <input type="text" id="log-notes-${k.id}" placeholder="What tasks were completed today towards this KPI..." />
          </div>
        </div>
      </div>
    `).join("");
  }

  container.innerHTML = `
    <div class="card" style="margin-bottom: 20px;">
      <div class="card-header">
        <div class="card-title">Submit Today's Work Report</div>
      </div>
      <div class="form-field" style="max-width: 250px; margin-bottom: 16px;">
        <label>Report Date</label>
        <input type="date" id="worklog-date" value="${selectedDate}" />
      </div>

      <div style="margin-bottom: 16px;">
        ${kpiInputsHtml}
      </div>

      ${kpis.length > 0 ? `
        <button class="btn-primary" style="width:auto; padding:10px 24px;" onclick="submitDailyWorkLog()">
          💾 Submit & Sync with KPIs
        </button>
      ` : ""}
      <div id="worklog-msg" style="margin-top:12px;"></div>
    </div>

    <!-- MONTHLY HISTORY & EXPORT SECTION -->
    <div class="card">
      <div class="card-header" style="flex-wrap: wrap; gap: 12px;">
        <div class="card-title">Monthly Work Report History</div>
        <div style="display:flex; align-items:center; gap:8px;">
          <input type="month" id="history-month" value="${selectedDate.slice(0, 7)}" onchange="loadWorkLogHistory()" style="width:auto; margin:0;" />
          <button class="btn-secondary btn-sm" onclick="downloadMonthlyCsvReport()">📥 Export CSV</button>
          <button class="btn-primary btn-sm" style="width:auto;" onclick="downloadWorkLogPdf(currentProfile.userId, currentProfile.name)">📄 PDF Report</button>
        </div>
      </div>
      <div id="worklog-history-list">Loading history…</div>
    </div>
  `;

  loadWorkLogHistory();
}

export async function submitDailyWorkLog() {
  const date = document.getElementById("worklog-date").value || today();
  const kpis = currentProfile.kpis || [];
  const msgBox = document.getElementById("worklog-msg");
  if (!msgBox) return;

  const entries = [];
  let updatedAnyKpi = false;

  const updatedKpis = kpis.map(k => {
    const qtyInput = document.getElementById(`log-qty-${k.id}`);
    const notesInput = document.getElementById(`log-notes-${k.id}`);
    const qty = Number(qtyInput?.value) || 0;
    const notes = notesInput?.value.trim() || "";

    if (qty > 0 || notes.length > 0) {
      entries.push({
        kpiId: k.id,
        kpiTitle: k.title,
        unit: k.unit,
        quantity: qty,
        notes: notes
      });
    }

    if (qty > 0) {
      updatedAnyKpi = true;
      return {
        ...k,
        current: Number(k.current || 0) + qty
      };
    }
    return k;
  });

  if (entries.length === 0) {
    msgBox.innerHTML = '<div class="alert alert-danger">Please enter at least one quantity or work summary note.</div>';
    return;
  }

  try {
    msgBox.innerHTML = '<div class="alert alert-info">Saving work log and updating KPI progress…</div>';

    // 1. Save daily work log document
    const logDocId = `${auth.currentUser.uid}_${date}`;
    await setDoc(doc(db, "worklogs", logDocId), {
      userId: currentProfile.userId,
      userUid: auth.currentUser.uid,
      userName: currentProfile.name,
      dept: currentProfile.dept || "",
      date: date,
      entries: entries,
      submittedAt: new Date().toISOString()
    });

    // 2. Synchronize new accumulated achievements to user's KPIs
    if (updatedAnyKpi) {
      await updateDoc(doc(db, "users", auth.currentUser.uid), { kpis: updatedKpis });
      currentProfile.kpis = updatedKpis;
    }

    msgBox.innerHTML = '<div class="alert alert-success">✅ Daily work report submitted successfully and KPI progress synchronized!</div>';

    // Clear input fields
    kpis.forEach(k => {
      const q = document.getElementById(`log-qty-${k.id}`);
      const n = document.getElementById(`log-notes-${k.id}`);
      if (q) q.value = "";
      if (n) n.value = "";
    });

    renderMyKpis();
    renderDashboard();
    loadWorkLogHistory();
  } catch (err) {
    console.error("Error submitting work log: ", err);
    msgBox.innerHTML = `<div class="alert alert-danger">Failed to submit: ${err.message}</div>`;
  }
}

let cachedMonthLogs = [];

export async function loadWorkLogHistory() {
  const container = document.getElementById("worklog-history-list");
  if (!container) return;
  const monthInput = document.getElementById("history-month");
  const monthStr = monthInput ? monthInput.value : today().slice(0, 7);

  container.innerHTML = '<div class="alert alert-info">Loading records…</div>';

  try {
    const snap = await getDocs(query(
      collection(db, "worklogs"),
      where("userUid", "==", auth.currentUser.uid)
    ));

    cachedMonthLogs = [];
    snap.forEach(d => {
      const data = d.data();
      if (data.date && data.date.startsWith(monthStr)) {
        cachedMonthLogs.push(data);
      }
    });

    cachedMonthLogs.sort((a, b) => b.date.localeCompare(a.date));

    if (cachedMonthLogs.length === 0) {
      container.innerHTML = `<p style="font-size:13px; color:var(--text-secondary); margin-top:10px;">No work reports logged for ${monthStr}.</p>`;
      return;
    }

    let html = `
      <div style="overflow-x:auto; margin-top:10px;">
        <table>
          <thead>
            <tr>
              <th style="width: 110px;">Date</th>
              <th style="width: 180px;">KPI</th>
              <th style="width: 110px;">Quantity</th>
              <th>Task Summary / Activity Log</th>
            </tr>
          </thead>
          <tbody>
    `;

    cachedMonthLogs.forEach(log => {
      (log.entries || []).forEach((e, idx) => {
        html += `
          <tr>
            ${idx === 0 ? `<td rowspan="${log.entries.length}" style="font-weight:600; vertical-align:top; border-right:1px solid var(--border-default);">${escapeHtml(log.date)}</td>` : ""}
            <td style="font-weight:500;">${escapeHtml(e.kpiTitle)}</td>
            <td class="mono">${e.quantity > 0 ? `+${e.quantity} ${escapeHtml(e.unit)}` : "—"}</td>
            <td style="color:var(--text-secondary);">${escapeHtml(e.notes) || "—"}</td>
          </tr>
        `;
      });
    });

    html += `</tbody></table></div>`;
    container.innerHTML = html;
  } catch (err) {
    console.error("Error loading history: ", err);
    container.innerHTML = `<div class="alert alert-danger">Failed to load history: ${err.message}</div>`;
  }
}

// ---------------------------------------------------------------
// EXECUTIVE PDF REPORT GENERATOR
// ---------------------------------------------------------------
export async function downloadWorkLogPdf(targetUserId, targetUserName, targetMonthStr) {
  try {
    const monthStr = targetMonthStr || document.getElementById("history-month")?.value || today().slice(0, 7);
    const uId = targetUserId || currentProfile.userId;
    const uName = targetUserName || currentProfile.name;

    let logs = [];
    if (targetUserId && targetUserId !== currentProfile.userId) {
      // HR fetching for an employee
      const snap = await getDocs(query(collection(db, "worklogs"), where("userId", "==", targetUserId)));
      snap.forEach(d => {
        const data = d.data();
        if (data.date && data.date.startsWith(monthStr)) logs.push(data);
      });
    } else {
      // Current user's cached logs or direct query
      if (cachedMonthLogs && cachedMonthLogs.length > 0) {
        logs = cachedMonthLogs.filter(l => l.date && l.date.startsWith(monthStr));
      } else {
        const snap = await getDocs(query(collection(db, "worklogs"), where("userUid", "==", auth.currentUser.uid)));
        snap.forEach(d => {
          const data = d.data();
          if (data.date && data.date.startsWith(monthStr)) logs.push(data);
        });
      }
    }
    logs.sort((a, b) => a.date.localeCompare(b.date));

    // Fetch employee profile details for header
    let empProfile = currentProfile;
    if (targetUserId && targetUserId !== currentProfile.userId) {
      const qSnap = await getDocs(query(collection(db, "users"), where("userId", "==", targetUserId)));
      if (!qSnap.empty) empProfile = qSnap.docs[0].data();
    }

    const kpis = empProfile.kpis || [];
    const score = weightedScore(kpis);

    const reportContainer = document.createElement("div");
    reportContainer.id = "pdf-report-render-target";
    reportContainer.style.width = "750px";
    reportContainer.style.padding = "24px";
    reportContainer.style.fontFamily = "'Segoe UI', Arial, sans-serif";
    reportContainer.style.color = "#201f1e";
    reportContainer.style.background = "#ffffff";
    reportContainer.style.position = "absolute";
    reportContainer.style.left = "-9999px";
    reportContainer.style.top = "0";

    reportContainer.innerHTML = `
      <div style="border-bottom: 2px solid #0078d4; padding-bottom: 12px; margin-bottom: 16px; display: flex; justify-content: space-between; align-items: flex-end;">
        <div>
          <h1 style="color: #0078d4; margin: 0 0 2px; font-size: 22px;">KPI Ledger</h1>
          <div style="font-size: 12px; color: #605e5c;">Monthly Performance & Work Activity Report</div>
        </div>
        <div style="text-align: right;">
          <div style="font-size: 13px; font-weight: 700; color: #201f1e;">Period: ${escapeHtml(monthStr)}</div>
          <div style="font-size: 11px; color: #605e5c;">Generated: ${today()}</div>
        </div>
      </div>

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; background: #f8f9fa; border: 1px solid #e1dfdd; border-radius: 4px; padding: 12px; margin-bottom: 20px; font-size: 12px;">
        <div><span style="font-size:10px; text-transform:uppercase; color:#605e5c; display:block;">Employee Name</span><strong>${escapeHtml(uName)}</strong></div>
        <div><span style="font-size:10px; text-transform:uppercase; color:#605e5c; display:block;">User ID / Code</span><strong>${escapeHtml(empProfile.userId)} (${escapeHtml(empProfile.employeeCode || "—")})</strong></div>
        <div><span style="font-size:10px; text-transform:uppercase; color:#605e5c; display:block;">Department</span><strong>${escapeHtml(empProfile.dept || "—")}</strong></div>
        <div><span style="font-size:10px; text-transform:uppercase; color:#605e5c; display:block;">Performance Score</span><strong style="color:${score >= 75 ? '#107c10' : '#ca5010'}; font-size:15px;">${score}%</strong></div>
      </div>

      <h3 style="color:#201f1e; margin: 0 0 8px; font-size: 13px; border-bottom: 1px solid #edebe9; padding-bottom: 4px;">1. KPI Status & Target Achievement Summary</h3>
      <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 11px;">
        <thead>
          <tr style="background: #edebe9;">
            <th style="padding: 6px; text-align: left; border: 1px solid #c8c6c4;">KPI Metric</th>
            <th style="padding: 6px; text-align: center; border: 1px solid #c8c6c4; width: 75px;">Target</th>
            <th style="padding: 6px; text-align: center; border: 1px solid #c8c6c4; width: 75px;">Achieved</th>
            <th style="padding: 6px; text-align: center; border: 1px solid #c8c6c4; width: 65px;">Progress</th>
            <th style="padding: 6px; text-align: center; border: 1px solid #c8c6c4; width: 85px;">Status</th>
          </tr>
        </thead>
        <tbody>
          ${kpis.length === 0 ? '<tr><td colspan="5" style="padding:6px; text-align:center;">No KPIs assigned.</td></tr>' : ''}
          ${kpis.map(k => {
            const p = Math.round(kpiPercent(k));
            return `
              <tr>
                <td style="padding: 6px; border: 1px solid #c8c6c4; font-weight: 600;">${escapeHtml(k.title)}</td>
                <td style="padding: 6px; border: 1px solid #c8c6c4; text-align: center;">${fmtVal(k.target, k.unit)}</td>
                <td style="padding: 6px; border: 1px solid #c8c6c4; text-align: center; font-weight: 700;">${fmtVal(k.current || 0, k.unit)}</td>
                <td style="padding: 6px; border: 1px solid #c8c6c4; text-align: center;">${p}%</td>
                <td style="padding: 6px; border: 1px solid #c8c6c4; text-align: center; font-weight: 600; color:${statusColor(p)};">${statusLabel(p)}</td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>

      <h3 style="color:#201f1e; margin: 0 0 8px; font-size: 13px; border-bottom: 1px solid #edebe9; padding-bottom: 4px;">2. Daily Work Activity Details (${logs.length} Logged Days)</h3>
      <table style="width: 100%; border-collapse: collapse; font-size: 10px;">
        <thead>
          <tr style="background: #edebe9;">
            <th style="padding: 6px; text-align: left; border: 1px solid #c8c6c4; width: 80px;">Date</th>
            <th style="padding: 6px; text-align: left; border: 1px solid #c8c6c4; width: 140px;">KPI</th>
            <th style="padding: 6px; text-align: center; border: 1px solid #c8c6c4; width: 70px;">Output</th>
            <th style="padding: 6px; text-align: left; border: 1px solid #c8c6c4;">Work Description / Accomplishments</th>
          </tr>
        </thead>
        <tbody>
          ${logs.length === 0 ? '<tr><td colspan="4" style="padding:10px; text-align:center; color:#605e5c;">No work reports logged for this period.</td></tr>' : ''}
          ${logs.map(log => {
            return (log.entries || []).map((e, idx) => `
              <tr>
                ${idx === 0 ? `<td rowspan="${log.entries.length}" style="padding: 5px; border: 1px solid #c8c6c4; font-weight: 600; vertical-align: top; background:#fcfcfc;">${escapeHtml(log.date)}</td>` : ""}
                <td style="padding: 5px; border: 1px solid #c8c6c4;">${escapeHtml(e.kpiTitle)}</td>
                <td style="padding: 5px; border: 1px solid #c8c6c4; text-align: center; font-weight: 600;">${e.quantity > 0 ? `+${e.quantity} ${escapeHtml(e.unit)}` : "—"}</td>
                <td style="padding: 5px; border: 1px solid #c8c6c4; color: #3b3a39;">${escapeHtml(e.notes) || "—"}</td>
              </tr>
            `).join("");
          }).join("")}
        </tbody>
      </table>

      <div style="margin-top: 30px; display: flex; justify-content: space-between; font-size: 11px; color: #605e5c; padding-top: 16px; border-top: 1px dashed #c8c6c4;">
        <div>Employee Signature: _______________________</div>
        <div>Supervisor / HR Signature: _______________________</div>
      </div>
    `;

    document.body.appendChild(reportContainer);

    // Check if html2pdf is loaded
    if (window.html2pdf) {
      const opt = {
        margin: [10, 10, 10, 10],
        filename: `Performance_Report_${uId}_${monthStr}.pdf`,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true, logging: false },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
      };

      await window.html2pdf().set(opt).from(reportContainer).save();
    } else {
      // Fallback clean printable window if CDN blocked
      const printWin = window.open('', '_blank');
      printWin.document.write(`<html><head><title>Performance Report</title><style>body{font-family:sans-serif;padding:20px;}</style></head><body>${reportContainer.innerHTML}</body></html>`);
      printWin.document.close();
      printWin.focus();
      printWin.print();
    }

    document.body.removeChild(reportContainer);
  } catch (err) {
    console.error("PDF generation failed: ", err);
    alert("Could not generate PDF: " + err.message);
    const existing = document.getElementById("pdf-report-render-target");
    if (existing) document.body.removeChild(existing);
  }
}

export async function downloadEmployeeReportPdf(uid) {
  const u = empCache[uid];
  if (!u) return;
  const monthStr = today().slice(0, 7);
  await downloadWorkLogPdf(u.userId, u.name, monthStr);
}

// ---------------------------------------------------------------
// SYSTEM SETTINGS & MASTER DROPDOWN OPTIONS
// ---------------------------------------------------------------
async function loadSystemSettings() {
  try {
    const snap = await getDoc(doc(db, "settings", "global"));
    if (snap.exists()) {
      const data = snap.data();
      if (Array.isArray(data.kpiUnits) && data.kpiUnits.length > 0) systemSettings.kpiUnits = data.kpiUnits;
      if (Array.isArray(data.offices) && data.offices.length > 0) systemSettings.offices = data.offices;
      if (Array.isArray(data.cycles) && data.cycles.length > 0) systemSettings.cycles = data.cycles;
      if (Array.isArray(data.frequencies) && data.frequencies.length > 0) systemSettings.frequencies = data.frequencies;
    } else if (currentProfile && currentProfile.role === "hr") {
      await setDoc(doc(db, "settings", "global"), systemSettings);
    }
  } catch (e) {
    console.warn("Settings load warning (using defaults):", e.message);
  }
}

function getUnitSelectOptionsHtml(selectedVal = "") {
  return systemSettings.kpiUnits.map(u => `<option value="${escapeHtml(u)}" ${u === selectedVal ? "selected" : ""}>${escapeHtml(u)}</option>`).join("");
}

function getFrequencySelectOptionsHtml(selectedVal = "Monthly") {
  return systemSettings.frequencies.map(f => `<option value="${escapeHtml(f)}" ${f === selectedVal ? "selected" : ""}>${escapeHtml(f)}</option>`).join("");
}

function populateFormSelects() {
  const factorySelect = document.getElementById("new-factory");
  if (factorySelect) {
    factorySelect.innerHTML = systemSettings.offices.map(o => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join("");
  }
  const cycleSelect = document.getElementById("new-cycle");
  if (cycleSelect) {
    cycleSelect.innerHTML = systemSettings.cycles.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
  }
}

export function renderSettingsPanel() {
  const container = document.getElementById("settings-manager");
  if (!container) return;

  container.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div class="card-title">Manage KPI Units</div>
      </div>
      <p style="font-size:13px; color:var(--text-secondary);">Add or delete available KPI measurement units (e.g. %, BDT, hrs, number, KG, etc.):</p>
      <div class="inline-row" style="max-width: 400px;">
        <input id="new-unit-input" placeholder="Type new unit name..." />
        <button class="btn-primary" style="width:auto;" onclick="addMasterOption('kpiUnits', 'new-unit-input')">Add Unit</button>
      </div>
      <div class="tag-container" id="unit-tags">
        ${systemSettings.kpiUnits.map(u => `
          <span class="tag-item">
            ${escapeHtml(u)}
            <span class="tag-del" title="Delete unit" data-type="kpiUnits" data-val="${escapeHtml(u)}">&times;</span>
          </span>
        `).join("")}
      </div>
    </div>

    <div class="card" style="margin-top: 16px;">
      <div class="card-header">
        <div class="card-title">Manage Factories & Offices</div>
      </div>
      <p style="font-size:13px; color:var(--text-secondary);">Add or remove company locations / branch offices:</p>
      <div class="inline-row" style="max-width: 400px;">
        <input id="new-office-input" placeholder="Type new factory/office name..." />
        <button class="btn-primary" style="width:auto;" onclick="addMasterOption('offices', 'new-office-input')">Add Office</button>
      </div>
      <div class="tag-container" id="office-tags">
        ${systemSettings.offices.map(o => `
          <span class="tag-item">
            ${escapeHtml(o)}
            <span class="tag-del" title="Delete office" data-type="offices" data-val="${escapeHtml(o)}">&times;</span>
          </span>
        `).join("")}
      </div>
    </div>

    <div class="card" style="margin-top: 16px;">
      <div class="card-header">
        <div class="card-title">Manage Appraisal Cycles</div>
      </div>
      <p style="font-size:13px; color:var(--text-secondary);">Manage cycle intervals used for appraisal periods:</p>
      <div class="inline-row" style="max-width: 400px;">
        <input id="new-cycle-input" placeholder="Type new cycle name..." />
        <button class="btn-primary" style="width:auto;" onclick="addMasterOption('cycles', 'new-cycle-input')">Add Cycle</button>
      </div>
      <div class="tag-container" id="cycle-tags">
        ${systemSettings.cycles.map(c => `
          <span class="tag-item">
            ${escapeHtml(c)}
            <span class="tag-del" title="Delete cycle" data-type="cycles" data-val="${escapeHtml(c)}">&times;</span>
          </span>
        `).join("")}
      </div>
    </div>

    <div class="card" style="margin-top: 16px;">
      <div class="card-header">
        <div class="card-title">Manage KPI Tracking Frequencies</div>
      </div>
      <p style="font-size:13px; color:var(--text-secondary);">Add or remove tracking frequency intervals (e.g. Daily, Weekly, Monthly, Quarterly, Yearly):</p>
      <div class="inline-row" style="max-width: 400px;">
        <input id="new-freq-input" placeholder="Type new frequency name..." />
        <button class="btn-primary" style="width:auto;" onclick="addMasterOption('frequencies', 'new-freq-input')">Add Frequency</button>
      </div>
      <div class="tag-container" id="freq-tags">
        ${systemSettings.frequencies.map(f => `
          <span class="tag-item">
            ${escapeHtml(f)}
            <span class="tag-del" title="Delete frequency" data-type="frequencies" data-val="${escapeHtml(f)}">&times;</span>
          </span>
        `).join("")}
      </div>
    </div>
  `;

  // Attach direct event listeners to delete buttons
  container.querySelectorAll(".tag-del").forEach(el => {
    el.addEventListener("click", () => {
      const type = el.getAttribute("data-type");
      const val = el.getAttribute("data-val");
      deleteMasterOption(type, val);
    });
  });
}

export async function addMasterOption(type, inputId) {
  try {
    const input = document.getElementById(inputId);
    if (!input) return;
    const val = input.value.trim();
    if (!val) return;
    if (!systemSettings[type].includes(val)) {
      systemSettings[type].push(val);
      await setDoc(doc(db, "settings", "global"), systemSettings);
    }
    input.value = "";
    renderSettingsPanel();
    populateFormSelects();
    if (currentProfile.role === "hr" || currentProfile.role === "dept_head") {
      renderOrgPanel();
      renderDeptPanel();
    }
  } catch (err) {
    console.error("Error adding option:", err);
    alert("Failed to save: " + err.message);
  }
}

export async function deleteMasterOption(type, val) {
  try {
    if (systemSettings[type].length <= 1) {
      alert("At least one option must remain in the list.");
      return;
    }
    const confirmDelete = confirm(`Are you sure you want to remove "${val}" from the options list?`);
    if (!confirmDelete) return;
    systemSettings[type] = systemSettings[type].filter(item => item !== val);
    await setDoc(doc(db, "settings", "global"), systemSettings);
    renderSettingsPanel();
    populateFormSelects();
    if (currentProfile.role === "hr" || currentProfile.role === "dept_head") {
      renderOrgPanel();
      renderDeptPanel();
    }
  } catch (err) {
    console.error("Error deleting option:", err);
    alert("Failed to delete: " + err.message);
  }
}

// ---------------------------------------------------------------
// BIND GLOBALS (for inline onclick handlers)
// ---------------------------------------------------------------
window.handleLogin           = handleLogin;
window.handleLogout          = handleLogout;
window.toggleNewEmployeeFields = toggleNewEmployeeFields;
window.handleCreateEmployee  = handleCreateEmployee;
window.updateOrgCurrent      = updateOrgCurrent;
window.addOrgKpi             = addOrgKpi;
window.switchDept            = switchDept;
window.createDepartment      = createDepartment;
window.updateDeptCurrent     = updateDeptCurrent;
window.addDeptKpi            = addDeptKpi;
window.addKpiToEmployee      = addKpiToEmployee;
window.removeKpi             = removeKpi;
window.toggleEmpRow          = toggleEmpRow;
window.deleteEmployeeAccount = deleteEmployeeAccount;
window.startEditProfile      = startEditProfile;
window.cancelEditProfile     = cancelEditProfile;
window.saveProfileEdit       = saveProfileEdit;
window.addKra                = addKra;
window.removeKra             = removeKra;
window.addObjective          = addObjective;
window.removeObjective       = removeObjective;
window.updateMyKpi           = updateMyKpi;
window.addMasterOption       = addMasterOption;
window.deleteMasterOption    = deleteMasterOption;
window.submitDailyWorkLog    = submitDailyWorkLog;
window.loadWorkLogHistory    = loadWorkLogHistory;
window.downloadMonthlyCsvReport = downloadMonthlyCsvReport;
window.downloadWorkLogPdf    = downloadWorkLogPdf;
window.downloadEmployeeReportPdf = downloadEmployeeReportPdf;
