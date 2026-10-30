import React, { useState, useEffect } from "react";
import { initializeApp, getApps, deleteApp } from "firebase/app";
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  updatePassword,
  EmailAuthProvider,
  reauthenticateWithCredential,
  getAuth,
  User,
} from "firebase/auth";
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  getDocs,
  query,
  where,
} from "firebase/firestore";
import { firebaseConfig, auth, db, FAKE_EMAIL_DOMAIN } from "./firebase";
import {
  UserProfile,
  KpiItem,
  KraItem,
  CompetencyItem,
  QualitativeAssessment,
  WorkLogDoc,
  WorkLogEntry,
  SystemSettings,
  RATING_SCALE,
  toFakeEmail,
  today,
  escapeHtml,
  kpiPercent,
  statusColor,
  statusLabel,
  weightedScore,
  fmtVal,
  getDeadlineStatus,
  getLogDate,
  computeAppraisalBreakdown,
  getPerformanceBand,
  filterKpisByEffectiveMonth,
  AppraisalWorkflowStatus,
  APPRAISAL_WORKFLOW_LABELS,
  APPRAISAL_RECOMMENDATIONS,
  isMonthFinalized,
  isMonthLockedForRole,
  computeYearlyAppraisalSummary,
} from "./utils";

declare global {
  interface Window {
    Chart: any;
    html2pdf: any;
  }
}

const DEFAULT_SETTINGS: SystemSettings = {
  kpiUnits: ["%", "BDT", "hrs", "number", "clients"],
  offices: ["Corporate Office", "Factory 1", "Factory 2"],
  cycles: ["Monthly", "Quarterly", "Half-Yearly", "Yearly"],
  frequencies: ["Daily", "Weekly", "Monthly", "Quarterly", "Yearly"],
  competencies: [
    "Teamwork & Collaboration",
    "Ownership & Accountability",
    "Communication & Clarity",
    "Problem Solving & Initiative",
    "Punctuality & Discipline",
    "Quality & Attention to Detail",
  ],
  defaultQuantWeight: 80,
};

const TABS_BY_ROLE: Record<string, { id: string; label: string }[]> = {
  hr: [
    { id: "dashboard", label: "Dashboard" },
    { id: "hr", label: "All Accounts" },
    { id: "create_account", label: "Create Account" },
    { id: "settings", label: "System Settings" },
  ],
  manager: [
    { id: "dashboard", label: "Dashboard" },
    { id: "team", label: "My Team" },
  ],
  employee: [
    { id: "dashboard", label: "Dashboard" },
    { id: "mykpis", label: "My KPIs & Appraisal" },
    { id: "worklog", label: "Daily Work Report" },
  ],
};

const ROLE_LABELS: Record<string, string> = {
  hr: "HR",
  manager: "Line Manager",
  employee: "Employee",
};

function getAvatarColor(name: string) {
  const colors = ["#0078d4", "#038387", "#5c2d91", "#ca5010", "#107c10", "#a4262c"];
  return colors[(name || "?").charCodeAt(0) % colors.length];
}

function getInitials(name: string) {
  return (name || "?")
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function barColorClass(pct: number) {
  if (pct >= 80) return "bar-green";
  if (pct >= 50) return "bar-orange";
  return "bar-red";
}

function KpiBadge({ pct }: { pct: number }) {
  const rounded = Math.round(pct);
  if (pct >= 80) {
    return <span className="kpi-badge kpi-badge-on-target">{rounded}% · Excellent</span>;
  }
  if (pct >= 50) {
    return <span className="kpi-badge kpi-badge-on-track">{rounded}% · Good</span>;
  }
  return <span className="kpi-badge kpi-badge-at-risk">{rounded}% · Needs Improvement</span>;
}

export default function App() {
  const [authUser, setAuthUser] = useState<User | null>(null);
  const [currentProfile, setCurrentProfile] = useState<UserProfile | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState("");

  // Login / Forgot Password Mode
  const [authView, setAuthView] = useState<"login" | "forgot">("login");
  const [loginUserId, setLoginUserId] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginErr, setLoginErr] = useState("");

  // Forgot Password (Login Screen Self-Reset)
  const [forgotUserId, setForgotUserId] = useState("");
  const [forgotVerify, setForgotVerify] = useState("");
  const [forgotOldPass, setForgotOldPass] = useState("");
  const [forgotNewPass, setForgotNewPass] = useState("");
  const [forgotConfirmPass, setForgotConfirmPass] = useState("");
  const [forgotStatus, setForgotStatus] = useState<{ type: "info" | "success" | "danger"; text: string } | null>(null);

  // Self Change Password Modal (for logged-in users)
  const [showChangePassModal, setShowChangePassModal] = useState(false);
  const [selfOldPass, setSelfOldPass] = useState("");
  const [selfNewPass, setSelfNewPass] = useState("");
  const [selfConfirmPass, setSelfConfirmPass] = useState("");
  const [selfPassMsg, setSelfPassMsg] = useState<{ type: "info" | "success" | "danger"; text: string } | null>(null);

  // HR / Manager Reset Employee Password state
  const [resettingPassUid, setResettingPassUid] = useState<string | null>(null);
  const [hrResetNewPass, setHrResetNewPass] = useState("");
  const [hrResetOldPassHint, setHrResetOldPassHint] = useState("");
  const [hrResetMsg, setHrResetMsg] = useState<{
    uid: string;
    type: "info" | "success" | "danger";
    text: string;
  } | null>(null);

  // Navigation
  const [activeTab, setActiveTab] = useState("dashboard");

  // System Settings
  const [systemSettings, setSystemSettings] = useState<SystemSettings>(DEFAULT_SETTINGS);
  const [newUnitInput, setNewUnitInput] = useState("");
  const [newOfficeInput, setNewOfficeInput] = useState("");
  const [newCycleInput, setNewCycleInput] = useState("");
  const [newFreqInput, setNewFreqInput] = useState("");
  const [newCompInput, setNewCompInput] = useState("");

  // Users / Employees / Team
  const [allUsers, setAllUsers] = useState<UserProfile[]>([]);
  const [teamUsers, setTeamUsers] = useState<UserProfile[]>([]);
  const [expandedEmpUid, setExpandedEmpUid] = useState<string | null>(null);
  const [editingProfileUid, setEditingProfileUid] = useState<string | null>(null);
  const [editProfileDraft, setEditProfileDraft] = useState<Partial<UserProfile>>({});
  const [confirmDeleteUid, setConfirmDeleteUid] = useState<string | null>(null);

  // HR Create New Account Form
  const [newName, setNewName] = useState("");
  const [newUserId, setNewUserId] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<"employee" | "manager" | "hr">("employee");
  const [newDept, setNewDept] = useState("");
  const [newEmpCode, setNewEmpCode] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newFactory, setNewFactory] = useState("Corporate Office");
  const [newManager, setNewManager] = useState("");
  const [newCycle, setNewCycle] = useState("Monthly");
  const [newPurpose, setNewPurpose] = useState("");
  const [createMsg, setCreateMsg] = useState<{ type: "info" | "success" | "danger"; text: string } | null>(null);

  // KRA & Employee KPI inputs per employee card
  const [kraTitleInputs, setKraTitleInputs] = useState<Record<string, string>>({});
  const [kraObjInputs, setKraObjInputs] = useState<Record<string, string>>({});
  const [empKpiInputs, setEmpKpiInputs] = useState<
    Record<
      string,
      {
        title: string;
        target: string;
        unit: string;
        freq: string;
        weight: string;
        deadline: string;
        effectiveMonth: string;
        lowerIsBetter?: boolean;
      }
    >
  >({});
  const [empKpiFilterMonth, setEmpKpiFilterMonth] = useState<Record<string, string>>({});

  // Qualitative Assessment inputs per employee card
  const [empNewCompTitle, setEmpNewCompTitle] = useState<Record<string, string>>({});
  const [empNewCompMonth, setEmpNewCompMonth] = useState<Record<string, string>>({});
  const [qualSaveMsg, setQualSaveMsg] = useState<Record<string, string>>({});
  const [selfAppraisalMsg, setSelfAppraisalMsg] = useState<string>("");

  // HR All Accounts Search & PMS QC Filter state
  const [hrSearchQuery, setHrSearchQuery] = useState<string>("");
  const [hrFilterDept, setHrFilterDept] = useState<string>("ALL");
  const [hrFilterRole, setHrFilterRole] = useState<string>("ALL");
  const [hrFilterPmsAudit, setHrFilterPmsAudit] = useState<string>("ALL");

  // Daily Work Log
  const [worklogDate, setWorklogDate] = useState(today());
  const [worklogQty, setWorklogQty] = useState<Record<string, string>>({});
  const [worklogNotes, setWorklogNotes] = useState<Record<string, string>>({});
  const [worklogMsg, setWorklogMsg] = useState<{ type: "info" | "success" | "danger"; text: string } | null>(null);
  const [historyMonth, setHistoryMonth] = useState(today().slice(0, 7));
  const [monthLogs, setMonthLogs] = useState<WorkLogDoc[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // HR / Line Manager: Employee Performance Details Modal
  const [detailEmpUid, setDetailEmpUid] = useState<string | null>(null);
  const [detailFilterMode, setDetailFilterMode] = useState<"all" | "month">("all");
  const [detailMonth, setDetailMonth] = useState(today().slice(0, 7));
  const [detailAllLogs, setDetailAllLogs] = useState<WorkLogDoc[]>([]);
  const [loadingDetailLogs, setLoadingDetailLogs] = useState(false);
  const [generatingPdfFor, setGeneratingPdfFor] = useState<string | null>(null);
  const [hrReportDept, setHrReportDept] = useState<string>("ALL");
  const [hrReportMonth, setHrReportMonth] = useState<string>(today().slice(0, 7));
  const [hrReportPeriodMode, setHrReportPeriodMode] = useState<"month" | "year">("month");
  const [hrReportYear, setHrReportYear] = useState<string>(today().slice(0, 4));
  const [selectedYearForReport, setSelectedYearForReport] = useState<string>(today().slice(0, 4));
  const [generatingDeptPdf, setGeneratingDeptPdf] = useState<boolean>(false);

  // Auth Listener
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      setAuthLoading(true);
      setAuthError("");
      if (!user) {
        setAuthUser(null);
        setCurrentProfile(null);
        setAuthLoading(false);
        return;
      }
      try {
        const snap = await getDoc(doc(db, "users", user.uid));
        if (!snap.exists()) {
          setAuthError(`Login successful, but no Firestore profile was found at users/${user.uid}.`);
          await signOut(auth);
          setAuthLoading(false);
          return;
        }
        const profileData = { ...(snap.data() as UserProfile), _uid: user.uid };
        setAuthUser(user);
        setCurrentProfile(profileData);
        await fetchSystemSettings(profileData.role);
        setActiveTab("dashboard");
      } catch (err: any) {
        setAuthError(err.message || "Authentication error");
      } finally {
        setAuthLoading(false);
      }
    });
    return () => unsub();
  }, []);

  // Load role data when profile changes
  useEffect(() => {
    if (!currentProfile) return;
    if (currentProfile.role === "hr") {
      fetchAllUsers();
    } else if (currentProfile.role === "manager") {
      fetchTeamUsers(currentProfile.userId);
    } else if (currentProfile.role === "employee" && authUser) {
      fetchWorkLogHistory(authUser.uid, historyMonth);
    }
  }, [currentProfile]);

  useEffect(() => {
    if (currentProfile?.role === "employee" && authUser) {
      fetchWorkLogHistory(authUser.uid, historyMonth);
    }
  }, [historyMonth]);

  // Data Fetchers
  async function fetchSystemSettings(role?: string) {
    try {
      const snap = await getDoc(doc(db, "settings", "global"));
      if (snap.exists()) {
        const data = snap.data();
        const next: SystemSettings = {
          kpiUnits: Array.isArray(data.kpiUnits) && data.kpiUnits.length > 0 ? data.kpiUnits : DEFAULT_SETTINGS.kpiUnits,
          offices: Array.isArray(data.offices) && data.offices.length > 0 ? data.offices : DEFAULT_SETTINGS.offices,
          cycles: Array.isArray(data.cycles) && data.cycles.length > 0 ? data.cycles : DEFAULT_SETTINGS.cycles,
          frequencies:
            Array.isArray(data.frequencies) && data.frequencies.length > 0
              ? data.frequencies
              : DEFAULT_SETTINGS.frequencies,
          competencies:
            Array.isArray(data.competencies) && data.competencies.length > 0
              ? data.competencies
              : DEFAULT_SETTINGS.competencies,
          defaultQuantWeight: 80,
        };
        setSystemSettings(next);
        setNewFactory(next.offices[0] || "Corporate Office");
        setNewCycle(next.cycles[0] || "Monthly");
      } else if (role === "hr") {
        await setDoc(doc(db, "settings", "global"), DEFAULT_SETTINGS);
      }
    } catch (e) {
      console.warn("Settings load warning (using defaults):", e);
    }
  }

  async function fetchAllUsers() {
    try {
      const snap = await getDocs(collection(db, "users"));
      const list: UserProfile[] = [];
      snap.forEach((d) => list.push({ ...(d.data() as UserProfile), _uid: d.id }));
      setAllUsers(list);
    } catch (e) {
      console.error("Failed to fetch users:", e);
    }
  }

  async function fetchTeamUsers(managerUserId: string) {
    try {
      const snap = await getDocs(
        query(collection(db, "users"), where("role", "==", "employee"), where("managerUserId", "==", managerUserId))
      );
      const list: UserProfile[] = [];
      snap.forEach((d) => list.push({ ...(d.data() as UserProfile), _uid: d.id }));
      setTeamUsers(list);
    } catch (e) {
      console.error("Failed to fetch team users:", e);
    }
  }

  async function fetchWorkLogHistory(uid: string, monthPrefix: string) {
    setLoadingHistory(true);
    try {
      const snap = await getDocs(query(collection(db, "worklogs"), where("userUid", "==", uid)));
      const logs: WorkLogDoc[] = [];
      snap.forEach((d) => {
        const data = d.data() as WorkLogDoc;
        if (data.date && data.date.startsWith(monthPrefix)) {
          logs.push(data);
        }
      });
      logs.sort((a, b) => b.date.localeCompare(a.date));
      setMonthLogs(logs);
    } catch (e) {
      console.error("Error loading worklog history:", e);
    } finally {
      setLoadingHistory(false);
    }
  }

  // Handlers: Auth & Setup & Password Reset
  async function handleLogin(e?: React.FormEvent) {
    if (e) e.preventDefault();
    setLoginErr("");
    if (!loginUserId.trim() || !loginPassword) return;
    try {
      const cred = await signInWithEmailAndPassword(auth, toFakeEmail(loginUserId), loginPassword);
      try {
        await updateDoc(doc(db, "users", cred.user.uid), {
          authSecret: loginPassword,
        });
      } catch (_) {
        // Ignore if doc update fails
      }
    } catch (err: any) {
      setLoginErr("Incorrect User ID or password. (" + err.message + ")");
    }
  }

  async function handleSelfChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setSelfPassMsg(null);
    if (!authUser || !authUser.email) return;

    if (!selfOldPass || !selfNewPass) {
      setSelfPassMsg({ type: "danger", text: "Please fill in both Current Password and New Password." });
      return;
    }
    if (selfNewPass.length < 6) {
      setSelfPassMsg({ type: "danger", text: "New Password must be at least 6 characters long." });
      return;
    }
    if (selfNewPass !== selfConfirmPass) {
      setSelfPassMsg({ type: "danger", text: "New Password and Confirm Password do not match." });
      return;
    }

    try {
      setSelfPassMsg({ type: "info", text: "Verifying and updating password…" });
      const credential = EmailAuthProvider.credential(authUser.email, selfOldPass);
      await reauthenticateWithCredential(authUser, credential);
      await updatePassword(authUser, selfNewPass);

      await updateDoc(doc(db, "users", authUser.uid), {
        authSecret: selfNewPass,
        passwordUpdatedAt: today(),
        resetRequestedAt: "",
      });

      if (currentProfile) {
        setCurrentProfile({
          ...currentProfile,
          authSecret: selfNewPass,
          passwordUpdatedAt: today(),
          resetRequestedAt: "",
        });
      }

      setSelfPassMsg({ type: "success", text: "Password changed successfully!" });
      setSelfOldPass("");
      setSelfNewPass("");
      setSelfConfirmPass("");
    } catch (err: any) {
      if (err.code === "auth/wrong-password" || err.code === "auth/invalid-credential") {
        setSelfPassMsg({ type: "danger", text: "Current password is incorrect." });
      } else {
        setSelfPassMsg({ type: "danger", text: "Error: " + err.message });
      }
    }
  }

  async function handleHrResetUserPassword(u: UserProfile) {
    const uid = u._uid;
    if (!uid) return;
    const newPass = hrResetNewPass.trim();
    if (newPass.length < 6) {
      setHrResetMsg({
        uid,
        type: "danger",
        text: "New password must be at least 6 characters.",
      });
      return;
    }

    setHrResetMsg({ uid, type: "info", text: "Resetting password in Firebase Auth…" });

    const existing = getApps().find((a) => a.name === "ResetWorkerApp");
    if (existing) await deleteApp(existing);
    const workerApp = initializeApp(firebaseConfig, "ResetWorkerApp");
    const workerAuth = getAuth(workerApp);

    const candidates = Array.from(
      new Set(
        [
          hrResetOldPassHint.trim(),
          u.authSecret,
          "123456",
          "welcome123",
          "admin123",
          "password",
          u.userId,
        ].filter(Boolean) as string[]
      )
    );

    let updatedInAuth = false;
    let lastError = "";

    for (const candidatePass of candidates) {
      try {
        const cred = await signInWithEmailAndPassword(workerAuth, toFakeEmail(u.userId), candidatePass);
        await updatePassword(cred.user, newPass);
        await signOut(workerAuth);
        updatedInAuth = true;
        break;
      } catch (err: any) {
        lastError = err.message;
      }
    }

    await deleteApp(workerApp);

    if (updatedInAuth) {
      await updateDoc(doc(db, "users", uid), {
        authSecret: newPass,
        passwordUpdatedAt: today(),
        resetRequestedAt: "",
      });
      setHrResetMsg({
        uid,
        type: "success",
        text: `Password reset to "${newPass}" for ${u.name} (${u.userId}).`,
      });
      setHrResetNewPass("");
      setHrResetOldPassHint("");
      if (currentProfile?.role === "hr") await fetchAllUsers();
      if (currentProfile?.role === "manager") await fetchTeamUsers(currentProfile.userId);
    } else {
      setHrResetMsg({
        uid,
        type: "danger",
        text: `This legacy account has no synced password yet. Please enter ${u.name}'s current password once in the "Current Password (if legacy)" box so it can be reset (${lastError}).`,
      });
    }
  }

  async function handleForgotPasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setForgotStatus(null);
    const uId = forgotUserId.trim().toLowerCase();
    const verifyInput = forgotVerify.trim().toLowerCase();
    const newPass = forgotNewPass;

    if (!uId || !newPass) {
      setForgotStatus({ type: "danger", text: "User ID and New Password are required." });
      return;
    }
    if (newPass.length < 6) {
      setForgotStatus({ type: "danger", text: "New Password must be at least 6 characters." });
      return;
    }
    if (newPass !== forgotConfirmPass) {
      setForgotStatus({ type: "danger", text: "New Password and Confirm Password do not match." });
      return;
    }

    setForgotStatus({ type: "info", text: "Verifying account details…" });

    try {
      const qSnap = await getDocs(query(collection(db, "users"), where("userId", "==", uId)));
      let targetDocId = "";
      let targetUser: UserProfile | null = null;

      if (!qSnap.empty) {
        targetDocId = qSnap.docs[0].id;
        targetUser = qSnap.docs[0].data() as UserProfile;
      } else {
        const allSnap = await getDocs(collection(db, "users"));
        allSnap.forEach((d) => {
          const data = d.data() as UserProfile;
          if ((data.userId || "").toLowerCase() === uId) {
            targetDocId = d.id;
            targetUser = data;
          }
        });
      }

      if (!targetUser || !targetDocId) {
        setForgotStatus({ type: "danger", text: `No account found with User ID "${uId}".` });
        return;
      }

      const empCodeMatch = (targetUser.employeeCode || "").toLowerCase() === verifyInput && verifyInput !== "";
      const deptMatch = (targetUser.dept || "").toLowerCase() === verifyInput && verifyInput !== "";
      const nameMatch = (targetUser.name || "").toLowerCase() === verifyInput && verifyInput !== "";

      if (!forgotOldPass.trim() && !empCodeMatch && !deptMatch && !nameMatch) {
        setForgotStatus({
          type: "danger",
          text: "Verification failed. Please enter your exact Department, Employee ID, or Full Name.",
        });
        return;
      }

      const existing = getApps().find((a) => a.name === "ForgotResetApp");
      if (existing) await deleteApp(existing);
      const workerApp = initializeApp(firebaseConfig, "ForgotResetApp");
      const workerAuth = getAuth(workerApp);

      const candidates = Array.from(
        new Set(
          [
            forgotOldPass.trim(),
            targetUser.authSecret,
            "123456",
            "welcome123",
            "admin123",
            "password",
          ].filter(Boolean) as string[]
        )
      );

      let resetDone = false;
      for (const candidate of candidates) {
        try {
          const cred = await signInWithEmailAndPassword(workerAuth, toFakeEmail(targetUser.userId), candidate);
          await updatePassword(cred.user, newPass);
          await signOut(workerAuth);
          resetDone = true;
          break;
        } catch (_) {
          // try next
        }
      }

      await deleteApp(workerApp);

      if (resetDone) {
        await updateDoc(doc(db, "users", targetDocId), {
          authSecret: newPass,
          passwordUpdatedAt: today(),
          resetRequestedAt: "",
        });
        setForgotStatus({
          type: "success",
          text: `Password successfully reset! You can now sign in with User ID "${targetUser.userId}" and your new password.`,
        });
        setLoginUserId(targetUser.userId);
        setLoginPassword(newPass);
        setForgotOldPass("");
        setForgotNewPass("");
        setForgotConfirmPass("");
      } else {
        await updateDoc(doc(db, "users", targetDocId), {
          resetRequestedAt: today(),
        });
        setForgotStatus({
          type: "info",
          text: "A Password Reset Request has been flagged for HR. Please enter your previous password if you remember it, or ask HR to approve your reset.",
        });
      }
    } catch (err: any) {
      setForgotStatus({ type: "danger", text: "Reset error: " + err.message });
    }
  }

  // Handlers: HR Create Employee (Secondary App pattern)
  async function handleCreateEmployee() {
    const name = newName.trim();
    const userId = newUserId.trim();
    const password = newPassword;
    const dept = newDept.trim();
    setCreateMsg(null);

    if (!name || !userId || !password) {
      setCreateMsg({ type: "danger", text: "Full Name, User ID, and Password are required." });
      return;
    }

    const extra: Partial<UserProfile> = {};
    if (newRole === "employee") {
      extra.employeeCode = newEmpCode.trim();
      extra.title = newTitle.trim();
      extra.factory = newFactory;
      extra.managerUserId = newManager;
      extra.appraisalCycle = newCycle;
      extra.purpose = newPurpose.trim();
      extra.kras = [];
      extra.kpis = [];
      extra.qualitative = {
        quantWeight: 80,
        qualWeight: 20,
        mode: "competencies",
        directScorePct: 0,
        competencies: systemSettings.competencies.map((c, idx) => ({
          id: "c" + idx + "_" + Math.random().toString(36).slice(2, 6),
          title: c,
          rating: 3,
          weight: 1,
        })),
      };
      extra.lastUpdate = today();
    }

    const existing = getApps().find((a) => a.name === "Secondary");
    if (existing) await deleteApp(existing);

    const secondaryApp = initializeApp(firebaseConfig, "Secondary");
    const secondaryAuth = getAuth(secondaryApp);

    setCreateMsg({ type: "info", text: "Creating account, please wait…" });

    try {
      const cred = await createUserWithEmailAndPassword(secondaryAuth, toFakeEmail(userId), password);
      await setDoc(doc(db, "users", cred.user.uid), {
        name,
        role: newRole,
        dept,
        userId,
        authSecret: password,
        createdAt: new Date().toISOString(),
        ...extra,
      });
      await signOut(secondaryAuth);
      await deleteApp(secondaryApp);

      setCreateMsg({
        type: "success",
        text: `Account created successfully — User ID: ${userId} | Password: ${password}`,
      });
      setNewName("");
      setNewUserId("");
      setNewPassword("");
      setNewDept("");
      setNewEmpCode("");
      setNewTitle("");
      setNewPurpose("");
      await fetchAllUsers();
    } catch (err: any) {
      setCreateMsg({ type: "danger", text: `Error: ${err.message}` });
      await deleteApp(secondaryApp);
    }
  }

  // Handlers: Profile Edit / Delete / KRAs / Employee KPIs / Qualitative Assessment
  function startEditProfile(u: UserProfile) {
    if (!u._uid) return;
    setEditingProfileUid(u._uid);
    setEditProfileDraft({
      employeeCode: u.employeeCode || "",
      title: u.title || "",
      dept: u.dept || "",
      factory: u.factory || systemSettings.offices[0] || "Corporate Office",
      managerUserId: u.managerUserId || "",
      appraisalCycle: u.appraisalCycle || systemSettings.cycles[0] || "Monthly",
      purpose: u.purpose || "",
    });
  }

  async function saveProfileEdit(uid: string) {
    const updates = {
      employeeCode: (editProfileDraft.employeeCode || "").trim(),
      title: (editProfileDraft.title || "").trim(),
      dept: (editProfileDraft.dept || "").trim(),
      factory: (editProfileDraft.factory || "").trim(),
      managerUserId: editProfileDraft.managerUserId || "",
      appraisalCycle: editProfileDraft.appraisalCycle || "Monthly",
      purpose: (editProfileDraft.purpose || "").trim(),
      lastUpdate: today(),
    };
    await updateDoc(doc(db, "users", uid), updates);
    setEditingProfileUid(null);
    if (currentProfile?.role === "hr") await fetchAllUsers();
    if (currentProfile?.role === "manager") await fetchTeamUsers(currentProfile.userId);
  }

  async function handleDeleteEmployeeAccount(uid: string) {
    await deleteDoc(doc(db, "users", uid));
    setConfirmDeleteUid(null);
    setExpandedEmpUid(null);
    await fetchAllUsers();
  }

  async function updateEmployeeKras(u: UserProfile, nextKras: KraItem[]) {
    if (!u._uid) return;
    await updateDoc(doc(db, "users", u._uid), { kras: nextKras, lastUpdate: today() });
    if (currentProfile?.role === "hr") await fetchAllUsers();
    if (currentProfile?.role === "manager") await fetchTeamUsers(currentProfile.userId);
  }

  async function handleAddKra(u: UserProfile) {
    if (!u._uid) return;
    const title = (kraTitleInputs[u._uid] || "").trim();
    if (!title) return;
    const nextKras: KraItem[] = [
      ...(u.kras || []),
      { id: "kra" + Math.random().toString(36).slice(2, 8), title, objectives: [] },
    ];
    setKraTitleInputs((prev) => ({ ...prev, [u._uid!]: "" }));
    await updateEmployeeKras(u, nextKras);
  }

  async function handleRemoveKra(u: UserProfile, kraId: string) {
    const nextKras = (u.kras || []).filter((k) => k.id !== kraId);
    await updateEmployeeKras(u, nextKras);
  }

  async function handleAddObjective(u: UserProfile, kraId: string) {
    if (!u._uid) return;
    const key = `${u._uid}_${kraId}`;
    const text = (kraObjInputs[key] || "").trim();
    if (!text) return;
    const nextKras = (u.kras || []).map((k) =>
      k.id === kraId
        ? {
            ...k,
            objectives: [...(k.objectives || []), { id: "ob" + Math.random().toString(36).slice(2, 8), text }],
          }
        : k
    );
    setKraObjInputs((prev) => ({ ...prev, [key]: "" }));
    await updateEmployeeKras(u, nextKras);
  }

  async function handleRemoveObjective(u: UserProfile, kraId: string, obId: string) {
    const nextKras = (u.kras || []).map((k) =>
      k.id === kraId ? { ...k, objectives: (k.objectives || []).filter((o) => o.id !== obId) } : k
    );
    await updateEmployeeKras(u, nextKras);
  }

  async function handleAddKpiToEmployee(u: UserProfile) {
    if (!u._uid) return;
    const defaultMonth = today().slice(0, 7);
    const draft = empKpiInputs[u._uid] || {
      title: "",
      target: "",
      unit: systemSettings.kpiUnits[0] || "%",
      freq: systemSettings.frequencies[2] || "Monthly",
      weight: "",
      deadline: "",
      effectiveMonth: defaultMonth,
    };
    const title = draft.title.trim();
    const target = Number(draft.target);
    const weight = Number(draft.weight);
    const deadlineVal = (draft.deadline || "").trim();
    const effectiveMonthVal = (draft.effectiveMonth || defaultMonth).trim();
    if (!title || !target || !weight) return;

    const newKpi: KpiItem = {
      id: "k" + Math.random().toString(36).slice(2, 8),
      title,
      target,
      current: 0,
      unit: draft.unit || "%",
      frequency: draft.freq || "Monthly",
      weight,
      effectiveMonth: effectiveMonthVal,
      lowerIsBetter: Boolean(draft.lowerIsBetter),
      ...(deadlineVal ? { deadline: deadlineVal } : {}),
    };

    const nextKpis: KpiItem[] = [...(u.kpis || []), newKpi];
    await updateDoc(doc(db, "users", u._uid), { kpis: nextKpis });
    setEmpKpiInputs((prev) => ({
      ...prev,
      [u._uid!]: {
        title: "",
        target: "",
        unit: draft.unit,
        freq: draft.freq,
        weight: "",
        deadline: "",
        effectiveMonth: effectiveMonthVal,
        lowerIsBetter: false,
      },
    }));
    if (currentProfile?.role === "hr") await fetchAllUsers();
    if (currentProfile?.role === "manager") await fetchTeamUsers(currentProfile.userId);
  }

  async function handleUpdateEmployeeKpiDeadline(u: UserProfile, kpiId: string, nextDeadline: string) {
    if (!u._uid) return;
    const trimmed = nextDeadline.trim();
    const nextKpis = (u.kpis || []).map((k) => {
      if (k.id !== kpiId) return k;
      const updated = { ...k };
      if (trimmed) {
        updated.deadline = trimmed;
      } else {
        delete updated.deadline;
      }
      return updated;
    });
    await updateDoc(doc(db, "users", u._uid), { kpis: nextKpis });
    if (currentProfile?.role === "hr") await fetchAllUsers();
    if (currentProfile?.role === "manager") await fetchTeamUsers(currentProfile.userId);
  }

  async function handleUpdateEmployeeKpiEffectiveMonth(u: UserProfile, kpiId: string, nextMonth: string) {
    if (!u._uid) return;
    const trimmed = nextMonth.trim();
    const nextKpis = (u.kpis || []).map((k) => {
      if (k.id !== kpiId) return k;
      return { ...k, effectiveMonth: trimmed || today().slice(0, 7) };
    });
    await updateDoc(doc(db, "users", u._uid), { kpis: nextKpis });
    if (currentProfile?.role === "hr") await fetchAllUsers();
    if (currentProfile?.role === "manager") await fetchTeamUsers(currentProfile.userId);
  }

  async function handleUpdateEmployeeKpiFields(u: UserProfile, kpiId: string, patch: Partial<KpiItem>) {
    if (!u._uid) return;
    const nextKpis = (u.kpis || []).map((k) => (k.id === kpiId ? { ...k, ...patch } : k));
    await updateDoc(doc(db, "users", u._uid), { kpis: nextKpis, lastUpdate: today() });
    if (currentProfile?.role === "hr") await fetchAllUsers();
    if (currentProfile?.role === "manager") await fetchTeamUsers(currentProfile.userId);
  }

  async function handleRemoveKpiFromEmployee(u: UserProfile, kpiId: string) {
    if (!u._uid) return;
    const nextKpis = (u.kpis || []).filter((k) => k.id !== kpiId);
    await updateDoc(doc(db, "users", u._uid), { kpis: nextKpis });
    if (currentProfile?.role === "hr") await fetchAllUsers();
    if (currentProfile?.role === "manager") await fetchTeamUsers(currentProfile.userId);
  }

  // Qualitative Assessment Helpers & Handlers
  function getEmployeeQualitative(u: UserProfile, targetMonth?: string): QualitativeAssessment {
    const isSpecificMonth = Boolean(targetMonth && targetMonth !== "ALL" && targetMonth !== "all");
    const existing =
      isSpecificMonth && targetMonth && u.qualitativeByMonth?.[targetMonth]
        ? u.qualitativeByMonth[targetMonth]
        : u.qualitative;
    const defaultMonth =
      (isSpecificMonth ? targetMonth : undefined) ||
      existing?.effectiveMonth ||
      today().slice(0, 7);
    return {
      quantWeight: 80,
      qualWeight: 20,
      mode: existing?.mode || "competencies",
      directScorePct: existing?.directScorePct ?? 0,
      competencies: existing?.competencies || [],
      strengths: existing?.strengths || "",
      improvements: existing?.improvements || "",
      evaluatedBy: existing?.evaluatedBy || "",
      evaluatedAt: existing?.evaluatedAt || "",
      effectiveMonth: defaultMonth,
      workflowStatus: existing?.workflowStatus || "draft",
      recommendation: existing?.recommendation || "Pending Decision",
      selfAppraisalNote: existing?.selfAppraisalNote || "",
      selfSubmittedAt: existing?.selfSubmittedAt || "",
      employeeAcknowledged: Boolean(existing?.employeeAcknowledged),
      acknowledgedAt: existing?.acknowledgedAt || "",
    };
  }

  async function handleEmployeeSaveSelfAppraisal(
    noteText: string,
    acknowledge = false,
    targetMonth?: string
  ) {
    if (!currentProfile || !authUser) return;
    const qual = getEmployeeQualitative(currentProfile, targetMonth);
    const effMonth = (targetMonth && targetMonth !== "ALL" ? targetMonth : qual.effectiveMonth) || today().slice(0, 7);
    const nextStatus: AppraisalWorkflowStatus =
      qual.workflowStatus === "hr_approved" || qual.workflowStatus === "manager_reviewed"
        ? qual.workflowStatus
        : "self_submitted";
    const nextQual: QualitativeAssessment = {
      ...qual,
      effectiveMonth: effMonth,
      selfAppraisalNote: noteText,
      selfSubmittedAt: today(),
      workflowStatus: nextStatus,
      ...(acknowledge
        ? { employeeAcknowledged: true, acknowledgedAt: today() }
        : {}),
    };
    const nextQualByMonth = {
      ...(currentProfile.qualitativeByMonth || {}),
      [effMonth]: nextQual,
    };
    await updateDoc(doc(db, "users", authUser.uid), {
      qualitative: nextQual,
      qualitativeByMonth: nextQualByMonth,
      lastUpdate: today(),
    });
    setCurrentProfile({
      ...currentProfile,
      qualitative: nextQual,
      qualitativeByMonth: nextQualByMonth,
      lastUpdate: today(),
    });
    setSelfAppraisalMsg(
      acknowledge
        ? `Appraisal acknowledged and signed off for ${effMonth} (${today()})!`
        : `Self-appraisal submitted for ${effMonth} (${today()})!`
    );
    setTimeout(() => setSelfAppraisalMsg(""), 3500);
  }

  async function saveEmployeeQualitative(
    u: UserProfile,
    nextQual: QualitativeAssessment,
    showMsg = false
  ) {
    if (!u._uid) return;
    const effMonth = (nextQual.effectiveMonth || today().slice(0, 7)).trim();
    const autoWorkflow: AppraisalWorkflowStatus =
      nextQual.workflowStatus && nextQual.workflowStatus !== "draft"
        ? nextQual.workflowStatus
        : currentProfile?.role === "hr"
        ? "hr_approved"
        : "manager_reviewed";
    const stamped: QualitativeAssessment = {
      ...nextQual,
      effectiveMonth: effMonth,
      workflowStatus: autoWorkflow,
      evaluatedBy: currentProfile
        ? `${currentProfile.name} (${ROLE_LABELS[currentProfile.role] || currentProfile.role})`
        : nextQual.evaluatedBy,
      evaluatedAt: today(),
    };
    const nextQualByMonth = {
      ...(u.qualitativeByMonth || {}),
      [effMonth]: stamped,
    };
    await updateDoc(doc(db, "users", u._uid), {
      qualitative: stamped,
      qualitativeByMonth: nextQualByMonth,
      lastUpdate: today(),
    });
    if (showMsg) {
      setQualSaveMsg((prev) => ({
        ...prev,
        [u._uid!]: `Qualitative evaluation saved for Effective Month ${effMonth} (${today()})`,
      }));
      setTimeout(() => {
        setQualSaveMsg((prev) => ({ ...prev, [u._uid!]: "" }));
      }, 3500);
    }
    if (currentProfile?.role === "hr") await fetchAllUsers();
    if (currentProfile?.role === "manager") await fetchTeamUsers(currentProfile.userId);
  }

  async function handleLoadStandardCompetencies(u: UserProfile) {
    const uid = u._uid || u.userId;
    const qual = getEmployeeQualitative(u);
    const effMonth = (empNewCompMonth[uid] || qual.effectiveMonth || today().slice(0, 7)).trim();
    const existingForMonth = new Set(
      qual.competencies
        .filter((c) => (c.effectiveMonth || qual.effectiveMonth || effMonth) === effMonth)
        .map((c) => c.title.toLowerCase())
    );
    const toAdd: CompetencyItem[] = systemSettings.competencies
      .filter((title) => !existingForMonth.has(title.toLowerCase()))
      .map((title) => ({
        id: "comp_" + Math.random().toString(36).slice(2, 8),
        title,
        rating: 4,
        weight: 1,
        effectiveMonth: effMonth,
      }));
    if (toAdd.length === 0) return;
    await saveEmployeeQualitative(u, {
      ...qual,
      effectiveMonth: effMonth,
      mode: "competencies",
      competencies: [...qual.competencies, ...toAdd],
    });
  }

  async function handleAddCustomCompetency(u: UserProfile) {
    if (!u._uid) return;
    const title = (empNewCompTitle[u._uid] || "").trim();
    if (!title) return;
    const qual = getEmployeeQualitative(u);
    const effMonth = (empNewCompMonth[u._uid] || qual.effectiveMonth || today().slice(0, 7)).trim();
    const nextComps: CompetencyItem[] = [
      ...qual.competencies,
      {
        id: "comp_" + Math.random().toString(36).slice(2, 8),
        title,
        rating: 4,
        weight: 1,
        effectiveMonth: effMonth,
      },
    ];
    setEmpNewCompTitle((prev) => ({ ...prev, [u._uid!]: "" }));
    await saveEmployeeQualitative(u, {
      ...qual,
      effectiveMonth: effMonth,
      mode: "competencies",
      competencies: nextComps,
    });
  }

  async function handleUpdateCompetencyEffectiveMonth(u: UserProfile, compId: string, nextMonth: string) {
    const qual = getEmployeeQualitative(u);
    const trimmed = nextMonth.trim() || today().slice(0, 7);
    const nextComps = qual.competencies.map((c) =>
      c.id === compId ? { ...c, effectiveMonth: trimmed } : c
    );
    await saveEmployeeQualitative(u, {
      ...qual,
      effectiveMonth: trimmed,
      competencies: nextComps,
    });
  }

  async function handleRateCompetency(u: UserProfile, compId: string, rating: number) {
    const qual = getEmployeeQualitative(u);
    const nextComps = qual.competencies.map((c) => (c.id === compId ? { ...c, rating } : c));
    await saveEmployeeQualitative(u, {
      ...qual,
      mode: "competencies",
      competencies: nextComps,
    });
  }

  async function handleRemoveCompetency(u: UserProfile, compId: string) {
    const qual = getEmployeeQualitative(u);
    const nextComps = qual.competencies.filter((c) => c.id !== compId);
    await saveEmployeeQualitative(u, {
      ...qual,
      competencies: nextComps,
    });
  }

  // Handlers: Daily Work Log (with safe same-day entry merge so earlier entries on the same date are preserved)
  async function handleSubmitDailyWorkLog() {
    if (!currentProfile || !authUser) return;
    const date = worklogDate || today();
    const targetMonth = date.slice(0, 7);
    if (isMonthFinalized(currentProfile, targetMonth)) {
      setWorklogMsg({
        type: "danger",
        text: `🔒 Appraisal for ${targetMonth} has been Finalized & Locked by HR. Daily Work Report inputs for ${targetMonth} are closed.`,
      });
      return;
    }
    const kpis = currentProfile.kpis || [];
    const newInputs: WorkLogEntry[] = [];

    kpis.forEach((k) => {
      const qty = Number(worklogQty[k.id]) || 0;
      const notes = (worklogNotes[k.id] || "").trim();
      if (qty > 0 || notes.length > 0) {
        newInputs.push({
          kpiId: k.id,
          kpiTitle: k.title,
          unit: k.unit,
          quantity: qty,
          notes,
        });
      }
    });

    if (newInputs.length === 0) {
      setWorklogMsg({ type: "danger", text: "Please enter at least one quantity or work summary note." });
      return;
    }

    try {
      setWorklogMsg({ type: "info", text: "Saving work log and synchronizing KPI progress…" });
      const systemLogDate = today();
      const logDocId = `${authUser.uid}_${date}`;
      const existingSnap = await getDoc(doc(db, "worklogs", logDocId));
      const existingEntries: WorkLogEntry[] = existingSnap.exists()
        ? (existingSnap.data() as WorkLogDoc).entries || []
        : [];

      // Merge entries by kpiId so logging multiple times on the same date accumulates or updates cleanly
      const mergedMap = new Map<string, WorkLogEntry>();
      existingEntries.forEach((e) => mergedMap.set(e.kpiId, { ...e }));
      newInputs.forEach((inp) => {
        const prev = mergedMap.get(inp.kpiId);
        if (prev) {
          mergedMap.set(inp.kpiId, {
            ...prev,
            quantity: Number(prev.quantity || 0) + Number(inp.quantity || 0),
            notes: prev.notes && inp.notes ? `${prev.notes} | ${inp.notes}` : inp.notes || prev.notes,
          });
        } else {
          mergedMap.set(inp.kpiId, inp);
        }
      });

      const finalEntries = Array.from(mergedMap.values());
      let updatedAnyKpi = false;
      const updatedKpis = kpis.map((k) => {
        const addedQty = Number(worklogQty[k.id]) || 0;
        if (addedQty > 0) {
          updatedAnyKpi = true;
          return {
            ...k,
            current: Number((Number(k.current || 0) + addedQty).toFixed(2)),
          };
        }
        return k;
      });

      await setDoc(doc(db, "worklogs", logDocId), {
        userId: currentProfile.userId,
        userUid: authUser.uid,
        userName: currentProfile.name,
        dept: currentProfile.dept || "",
        date,
        logDate: systemLogDate,
        entries: finalEntries,
        submittedAt: new Date().toISOString(),
      });

      if (updatedAnyKpi) {
        await updateDoc(doc(db, "users", authUser.uid), { kpis: updatedKpis, lastUpdate: today() });
        setCurrentProfile({ ...currentProfile, kpis: updatedKpis });
      }

      setWorklogMsg({
        type: "success",
        text: `Work report for ${date} (logged on ${systemLogDate}) submitted and KPI progress synchronized!`,
      });
      setWorklogQty({});
      setWorklogNotes({});
      await fetchWorkLogHistory(authUser.uid, historyMonth);
    } catch (err: any) {
      setWorklogMsg({ type: "danger", text: `Failed to submit: ${err.message}` });
    }
  }

  // Fetch all worklogs for a given employee (matches both userUid and userId)
  async function fetchAllLogsForEmployee(emp: UserProfile): Promise<WorkLogDoc[]> {
    const map = new Map<string, WorkLogDoc>();
    try {
      if (emp._uid) {
        const snapUid = await getDocs(query(collection(db, "worklogs"), where("userUid", "==", emp._uid)));
        snapUid.forEach((d) => {
          const data = d.data() as WorkLogDoc;
          if (data.date) map.set(`${data.date}_${d.id}`, data);
        });
      }
      if (emp.userId) {
        const snapId = await getDocs(query(collection(db, "worklogs"), where("userId", "==", emp.userId)));
        snapId.forEach((d) => {
          const data = d.data() as WorkLogDoc;
          if (data.date) map.set(`${data.date}_${d.id}`, data);
        });
      }
    } catch (e) {
      console.error("Failed to fetch employee worklogs:", e);
    }
    // Deduplicate by date (keep latest submittedAt if multiple docs for same date)
    const byDate = new Map<string, WorkLogDoc>();
    Array.from(map.values()).forEach((item) => {
      const prev = byDate.get(item.date);
      if (!prev || (item.submittedAt || "") >= (prev.submittedAt || "")) {
        byDate.set(item.date, item);
      }
    });
    return Array.from(byDate.values()).sort((a, b) => b.date.localeCompare(a.date));
  }

  async function openEmployeePerformanceDetails(emp: UserProfile) {
    const uid = emp._uid || emp.userId;
    setDetailEmpUid(uid);
    setDetailFilterMode("all");
    setDetailMonth(today().slice(0, 7));
    setLoadingDetailLogs(true);
    try {
      const logs = await fetchAllLogsForEmployee(emp);
      setDetailAllLogs(logs);
    } finally {
      setLoadingDetailLogs(false);
    }
  }

  // CSV Export for Monthly or Full Work Report (works for Employee, HR, and Line Manager)
  function downloadMonthlyCsvReport(targetUser?: UserProfile, customLogs?: WorkLogDoc[], periodSuffix?: string) {
    const profileToUse = targetUser || currentProfile;
    if (!profileToUse) return;
    const logsToUse = customLogs || monthLogs;
    const suffix = periodSuffix || historyMonth || today().slice(0, 7);

    const rows: string[][] = [
      ["Work Date", "Log Date", "Employee", "User ID", "Department", "KPI Title", "Quantity", "Unit", "Task Summary"],
    ];
    logsToUse.forEach((log) => {
      const logDateStr = getLogDate(log);
      (log.entries || []).forEach((e) => {
        rows.push([
          log.date,
          logDateStr,
          profileToUse.name,
          profileToUse.userId,
          profileToUse.dept || "",
          e.kpiTitle,
          String(e.quantity || 0),
          e.unit || "",
          (e.notes || "").replace(/"/g, '""'),
        ]);
      });
    });

    const csvContent = rows.map((r) => r.map((cell) => `"${cell}"`).join(",")).join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `WorkLog_${profileToUse.userId}_${suffix}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Executive PDF Report Generator (with 80/20 Quantitative + Qualitative Breakdown)
  async function downloadWorkLogPdf(targetUser?: UserProfile, targetMonthStr?: string) {
    const profileToUse = targetUser || currentProfile;
    if (!profileToUse) return;
    const uId = profileToUse.userId;
    const uName = profileToUse.name;
    setGeneratingPdfFor(profileToUse._uid || uId);

    try {
      const allEmpLogs = await fetchAllLogsForEmployee(profileToUse);
      let periodLabel = targetMonthStr || historyMonth || today().slice(0, 7);
      let logs: WorkLogDoc[] = [];

      if (targetMonthStr === "all") {
        logs = [...allEmpLogs];
        periodLabel = "All Recorded Logs";
      } else if (targetMonthStr) {
        logs = allEmpLogs.filter((l) => l.date && l.date.startsWith(targetMonthStr));
      } else {
        const currentMonthPrefix = historyMonth || today().slice(0, 7);
        const currentMonthMatches = allEmpLogs.filter((l) => l.date && l.date.startsWith(currentMonthPrefix));
        if (currentMonthMatches.length > 0 || allEmpLogs.length === 0) {
          logs = currentMonthMatches;
          periodLabel = currentMonthPrefix;
        } else {
          // If current month has 0 logs but previous months have logs, include all logs so PDF is complete
          logs = [...allEmpLogs];
          periodLabel = `All Logs (up to ${ today() })`;
        }
      }
      logs.sort((a, b) => a.date.localeCompare(b.date));

      const effectiveMonthForPdf =
        targetMonthStr && targetMonthStr !== "all" ? targetMonthStr : undefined;
      const kpis = filterKpisByEffectiveMonth(profileToUse.kpis || [], effectiveMonthForPdf);
      const br = computeAppraisalBreakdown(profileToUse, effectiveMonthForPdf);
      const qual = getEmployeeQualitative(profileToUse, effectiveMonthForPdf);
      const pdfCompetencies =
        effectiveMonthForPdf && qual.competencies
          ? qual.competencies.filter((c) => !c.effectiveMonth || c.effectiveMonth === effectiveMonthForPdf)
          : qual.competencies || [];

      // IMPORTANT: Do NOT set position: absolute or left: -9999px on reportContainer!
      // html2pdf clones reportContainer inside .html2pdf__container (overflow: hidden at 0,0),
      // so negative left coordinates push the content off-canvas and cause a blank PDF.
      const reportContainer = document.createElement("div");
      reportContainer.id = "pdf-report-render-target";
      reportContainer.style.width = "700px";
      reportContainer.style.padding = "20px";
      reportContainer.style.margin = "0 auto";
      reportContainer.style.fontFamily = "'Segoe UI', Arial, sans-serif";
      reportContainer.style.color = "#201f1e";
      reportContainer.style.backgroundColor = "#ffffff";
      reportContainer.style.boxSizing = "border-box";

      const qualCompetenciesRowsHtml =
        qual.mode === "competencies" && pdfCompetencies.length > 0
          ? pdfCompetencies
              .map((c) => {
                const rInfo = RATING_SCALE[c.rating] || RATING_SCALE[3];
                return `
                  <tr>
                    <td style="padding: 6px 8px; border: 1px solid #c8c6c4; font-weight: 600; color: #201f1e;">${escapeHtml(c.title)}</td>
                    <td style="padding: 6px 8px; border: 1px solid #c8c6c4; text-align: center; font-family: monospace; font-weight: 700; color: #038387;">${escapeHtml(c.effectiveMonth || qual.effectiveMonth || "All Months")}</td>
                    <td style="padding: 6px 8px; border: 1px solid #c8c6c4; text-align: center; font-family: monospace; font-weight: 700; color: #201f1e;">${c.rating} / 5</td>
                    <td style="padding: 6px 8px; border: 1px solid #c8c6c4; text-align: center; font-family: monospace; color: #201f1e;">${rInfo.pct}%</td>
                    <td style="padding: 6px 8px; border: 1px solid #c8c6c4; text-align: center; font-weight: 700; color: ${rInfo.color};">${escapeHtml(rInfo.shortLabel)}</td>
                  </tr>
                `;
              })
              .join("")
          : `<tr><td colspan="5" style="padding: 8px; border: 1px solid #c8c6c4; text-align: center; color: #605e5c;">${
              qual.mode === "direct"
                ? `Direct Qualitative Score Assigned (${escapeHtml(qual.effectiveMonth || "All Months")}): <strong style="color:#038387;">${br.qualPoints} / ${br.qualWeight} pts (${br.qualRawPct}%)</strong>`
                : "No qualitative competencies evaluated yet."
            }</td></tr>`;

      reportContainer.innerHTML = `
        <table style="width: 100%; border-collapse: collapse; border-bottom: 2px solid #0078d4; margin-bottom: 14px;">
          <tr>
            <td style="padding: 0 0 10px 0; vertical-align: bottom;">
              <div style="color: #0078d4; font-size: 22px; font-weight: 700; line-height: 1.2;">KPI Ledger</div>
              <div style="font-size: 12px; color: #605e5c; margin-top: 2px;">Executive Performance Appraisal &amp; Work Activity Report</div>
            </td>
            <td style="padding: 0 0 10px 0; text-align: right; vertical-align: bottom;">
              <div style="font-size: 12px; font-weight: 700; color: #201f1e;">Period: ${escapeHtml(periodLabel)}</div>
              <div style="font-size: 11px; color: #605e5c; margin-top: 2px;">Generated: ${today()}</div>
            </td>
          </tr>
        </table>

        <table style="width: 100%; border-collapse: collapse; background: #f8f9fa; border: 1px solid #e1dfdd; margin-bottom: 12px; font-size: 11px;">
          <tr>
            <td style="padding: 8px 10px; border-right: 1px solid #e1dfdd; width: 34%;">
              <div style="font-size: 9px; text-transform: uppercase; color: #605e5c;">Employee Name &amp; Title</div>
              <div style="font-weight: 700; color: #201f1e; font-size: 12px; margin-top: 2px;">${escapeHtml(uName)}</div>
              <div style="color: #605e5c; font-size: 10px;">${escapeHtml(profileToUse.title || "Employee")}</div>
            </td>
            <td style="padding: 8px 10px; border-right: 1px solid #e1dfdd; width: 33%;">
              <div style="font-size: 9px; text-transform: uppercase; color: #605e5c;">User ID / Employee Code</div>
              <div style="font-weight: 700; color: #201f1e; font-size: 12px; margin-top: 2px;">${escapeHtml(uId)} (${escapeHtml(profileToUse.employeeCode || "—")})</div>
              <div style="color: #605e5c; font-size: 10px;">Line Manager: ${escapeHtml(profileToUse.managerUserId || "—")}</div>
            </td>
            <td style="padding: 8px 10px; width: 33%;">
              <div style="font-size: 9px; text-transform: uppercase; color: #605e5c;">Department &amp; Cycle</div>
              <div style="font-weight: 700; color: #201f1e; font-size: 12px; margin-top: 2px;">${escapeHtml(profileToUse.dept || "—")}</div>
              <div style="color: #605e5c; font-size: 10px;">${escapeHtml(profileToUse.factory || "Corporate Office")} · ${escapeHtml(profileToUse.appraisalCycle || "Monthly")}</div>
            </td>
          </tr>
        </table>

        <table style="width: 100%; border-collapse: collapse; background: #eff6fc; border: 1px solid #c7e0f4; margin-bottom: 18px; font-size: 11px;">
          <tr>
            <td style="padding: 10px; border-right: 1px solid #c7e0f4; width: 33%;">
              <div style="font-size: 9px; text-transform: uppercase; color: #005a9e; font-weight: 700;">Segment A: Quantitative (${br.quantWeight}%)</div>
              <div style="font-size: 16px; font-family: monospace; font-weight: 700; color: #0078d4; margin-top: 2px;">${br.quantPoints} / ${br.quantWeight} pts</div>
              <div style="font-size: 10px; color: #605e5c;">Raw KPI Achievement: ${br.quantRawPct}%</div>
            </td>
            <td style="padding: 10px; border-right: 1px solid #c7e0f4; width: 33%;">
              <div style="font-size: 9px; text-transform: uppercase; color: #005a9e; font-weight: 700;">Segment B: Qualitative (${br.qualWeight}%)</div>
              <div style="font-size: 16px; font-family: monospace; font-weight: 700; color: #038387; margin-top: 2px;">${br.qualPoints} / ${br.qualWeight} pts</div>
              <div style="font-size: 10px; color: #605e5c;">Behavioral Score: ${br.qualRawPct}%</div>
            </td>
            <td style="padding: 10px; width: 34%;">
              <div style="font-size: 9px; text-transform: uppercase; color: #005a9e; font-weight: 700;">Total Appraisal Score (100%)</div>
              <div style="font-size: 16px; font-family: monospace; font-weight: 700; color: ${br.band.color}; margin-top: 2px;">${br.totalScore}%</div>
              <div style="font-size: 10px; font-weight: 700; color: ${br.band.color};">${escapeHtml(br.band.label)}</div>
            </td>
          </tr>
        </table>

        <div style="color:#201f1e; margin: 0 0 6px; font-size: 13px; font-weight: 700; border-bottom: 1px solid #edebe9; padding-bottom: 4px;">
          1. Segment A — Quantitative KPI Target Achievement (${br.quantWeight}% Weight)
        </div>
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 16px; font-size: 11px;">
          <thead>
            <tr style="background: #edebe9;">
              <th style="padding: 6px; text-align: left; border: 1px solid #c8c6c4; color: #201f1e;">KPI Metric</th>
              <th style="padding: 6px; text-align: center; border: 1px solid #c8c6c4; width: 72px; color: #201f1e;">Eff. Month</th>
              <th style="padding: 6px; text-align: center; border: 1px solid #c8c6c4; width: 64px; color: #201f1e;">Target</th>
              <th style="padding: 6px; text-align: center; border: 1px solid #c8c6c4; width: 64px; color: #201f1e;">Achieved</th>
              <th style="padding: 6px; text-align: center; border: 1px solid #c8c6c4; width: 50px; color: #201f1e;">Weight</th>
              <th style="padding: 6px; text-align: center; border: 1px solid #c8c6c4; width: 92px; color: #201f1e;">Deadline</th>
              <th style="padding: 6px; text-align: center; border: 1px solid #c8c6c4; width: 54px; color: #201f1e;">Progress</th>
              <th style="padding: 6px; text-align: center; border: 1px solid #c8c6c4; width: 72px; color: #201f1e;">Status</th>
            </tr>
          </thead>
          <tbody>
            ${kpis.length === 0 ? '<tr><td colspan="8" style="padding:8px; border: 1px solid #c8c6c4; text-align:center; color:#605e5c;">No Quantitative KPIs assigned.</td></tr>' : ""}
            ${kpis
              .map((k) => {
                const p = Math.round(kpiPercent(k));
                const dl = getDeadlineStatus(k);
                const dlHtml = dl
                  ? `<div style="font-family:monospace; color:#201f1e;">${escapeHtml(dl.date)}</div><div style="font-size:9px;font-weight:700;color:${dl.color};">${escapeHtml(dl.label)}</div>`
                  : "—";
                return `
                <tr>
                  <td style="padding: 6px; border: 1px solid #c8c6c4; font-weight: 600; color: #201f1e;">${escapeHtml(k.title)}</td>
                  <td style="padding: 6px; border: 1px solid #c8c6c4; text-align: center; font-family: monospace; font-weight: 700; color: #005a9e;">${escapeHtml(k.effectiveMonth || "All")}</td>
                  <td style="padding: 6px; border: 1px solid #c8c6c4; text-align: center; color: #201f1e;">${fmtVal(k.target, k.unit)}</td>
                  <td style="padding: 6px; border: 1px solid #c8c6c4; text-align: center; font-weight: 700; color: #201f1e;">${fmtVal(k.current || 0, k.unit)}</td>
                  <td style="padding: 6px; border: 1px solid #c8c6c4; text-align: center; font-family: monospace; color: #201f1e;">${k.weight}%</td>
                  <td style="padding: 6px; border: 1px solid #c8c6c4; text-align: center;">${dlHtml}</td>
                  <td style="padding: 6px; border: 1px solid #c8c6c4; text-align: center; font-family: monospace; font-weight: 700; color: #201f1e;">${p}%</td>
                  <td style="padding: 6px; border: 1px solid #c8c6c4; text-align: center; font-weight: 700; color:${statusColor(p)};">${statusLabel(p)}</td>
                </tr>
              `;
              })
              .join("")}
          </tbody>
        </table>

        <div style="color:#201f1e; margin: 0 0 6px; font-size: 13px; font-weight: 700; border-bottom: 1px solid #edebe9; padding-bottom: 4px;">
          2. Segment B — Qualitative &amp; Behavioral Competency Evaluation (${br.qualWeight}% Weight)
        </div>
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 12px; font-size: 11px;">
          <thead>
            <tr style="background: #edebe9;">
              <th style="padding: 6px; text-align: left; border: 1px solid #c8c6c4; color: #201f1e;">Behavioral Competency</th>
              <th style="padding: 6px; text-align: center; border: 1px solid #c8c6c4; width: 95px; color: #201f1e;">Effective Month</th>
              <th style="padding: 6px; text-align: center; border: 1px solid #c8c6c4; width: 75px; color: #201f1e;">Rating</th>
              <th style="padding: 6px; text-align: center; border: 1px solid #c8c6c4; width: 75px; color: #201f1e;">Score %</th>
              <th style="padding: 6px; text-align: center; border: 1px solid #c8c6c4; width: 120px; color: #201f1e;">Evaluation Level</th>
            </tr>
          </thead>
          <tbody>
            ${qualCompetenciesRowsHtml}
          </tbody>
        </table>

        <table style="width: 100%; border-collapse: collapse; background: #f8f9fa; border: 1px solid #e1dfdd; margin-bottom: 16px; font-size: 11px;">
          <tr>
            <td style="padding: 8px 10px; border-right: 1px solid #e1dfdd; width: 34%; vertical-align: top;">
              <strong style="display:block; color:#005a9e; margin-bottom:2px;">Appraisal Workflow Status:</strong>
              <div style="font-weight:700; color:${(APPRAISAL_WORKFLOW_LABELS[qual.workflowStatus || "draft"] || APPRAISAL_WORKFLOW_LABELS.draft).color};">
                ${escapeHtml((APPRAISAL_WORKFLOW_LABELS[qual.workflowStatus || "draft"] || APPRAISAL_WORKFLOW_LABELS.draft).label)}
              </div>
              ${qual.employeeAcknowledged ? `<div style="font-size:10px; color:#107c10; margin-top:2px;">✓ Employee Signed Off (${escapeHtml(qual.acknowledgedAt || "")})</div>` : ""}
            </td>
            <td style="padding: 8px 10px; border-right: 1px solid #e1dfdd; width: 33%; vertical-align: top;">
              <strong style="display:block; color:#038387; margin-bottom:2px;">Management Recommendation:</strong>
              <div style="font-weight:700; color:#201f1e;">${escapeHtml(qual.recommendation || "Pending Decision")}</div>
            </td>
            <td style="padding: 8px 10px; width: 33%; vertical-align: top;">
              <strong style="display:block; color:#605e5c; margin-bottom:2px;">Employee Self-Appraisal Note:</strong>
              <div style="color:#201f1e;">${escapeHtml(qual.selfAppraisalNote || "—")}</div>
            </td>
          </tr>
          ${
            qual.strengths || qual.improvements
              ? `<tr>
                  <td colspan="2" style="padding: 8px 10px; border-top: 1px solid #e1dfdd; border-right: 1px solid #e1dfdd; vertical-align: top;">
                    <strong style="display:block; color:#107c10; margin-bottom:2px;">Key Strengths:</strong>
                    <div style="color:#201f1e;">${escapeHtml(qual.strengths || "—")}</div>
                  </td>
                  <td style="padding: 8px 10px; border-top: 1px solid #e1dfdd; vertical-align: top;">
                    <strong style="display:block; color:#ca5010; margin-bottom:2px;">Areas for Growth / Coaching:</strong>
                    <div style="color:#201f1e;">${escapeHtml(qual.improvements || "—")}</div>
                  </td>
                </tr>`
              : ""
          }
        </table>

        <div style="color:#201f1e; margin: 0 0 6px; font-size: 13px; font-weight: 700; border-bottom: 1px solid #edebe9; padding-bottom: 4px;">
          3. Daily Work Activity Details (${logs.length} Logged Day${logs.length === 1 ? "" : "s"})
        </div>
        <table style="width: 100%; border-collapse: collapse; font-size: 10px;">
          <thead>
            <tr style="background: #edebe9;">
              <th style="padding: 6px; text-align: left; border: 1px solid #c8c6c4; width: 78px; color: #201f1e;">Work Date</th>
              <th style="padding: 6px; text-align: left; border: 1px solid #c8c6c4; width: 78px; color: #201f1e;">Log Date</th>
              <th style="padding: 6px; text-align: left; border: 1px solid #c8c6c4; width: 140px; color: #201f1e;">KPI</th>
              <th style="padding: 6px; text-align: center; border: 1px solid #c8c6c4; width: 70px; color: #201f1e;">Output</th>
              <th style="padding: 6px; text-align: left; border: 1px solid #c8c6c4; color: #201f1e;">Work Description / Accomplishments</th>
            </tr>
          </thead>
          <tbody>
            ${logs.length === 0 ? '<tr><td colspan="5" style="padding:10px; border: 1px solid #c8c6c4; text-align:center; color:#605e5c;">No work reports logged for this period.</td></tr>' : ""}
            ${logs
              .map((log) => {
                const logDateStr = getLogDate(log);
                return (log.entries || [])
                  .map(
                    (e, idx) => `
                  <tr>
                    ${
                      idx === 0
                        ? `<td rowspan="${log.entries.length}" style="padding: 5px; border: 1px solid #c8c6c4; font-weight: 600; vertical-align: top; background:#fcfcfc; font-family:monospace; color:#201f1e;">${escapeHtml(log.date)}</td>
                           <td rowspan="${log.entries.length}" style="padding: 5px; border: 1px solid #c8c6c4; color: #605e5c; vertical-align: top; background:#fcfcfc; font-family:monospace;">${escapeHtml(logDateStr)}</td>`
                        : ""
                    }
                    <td style="padding: 5px; border: 1px solid #c8c6c4; color: #201f1e;">${escapeHtml(e.kpiTitle)}</td>
                    <td style="padding: 5px; border: 1px solid #c8c6c4; text-align: center; font-weight: 600; color: #201f1e;">${e.quantity > 0 ? `+${e.quantity} ${escapeHtml(e.unit)}` : "—"}</td>
                    <td style="padding: 5px; border: 1px solid #c8c6c4; color: #3b3a39;">${escapeHtml(e.notes) || "—"}</td>
                  </tr>
                `
                  )
                  .join("");
              })
              .join("")}
          </tbody>
        </table>

        <table style="width: 100%; border-collapse: collapse; margin-top: 28px; border-top: 1px dashed #c8c6c4; font-size: 11px; color: #605e5c;">
          <tr>
            <td style="padding-top: 14px; text-align: left;">Employee Signature: _______________________</td>
            <td style="padding-top: 14px; text-align: right;">Supervisor / HR Signature: _______________________</td>
          </tr>
        </table>
      `;

      if (!window.html2pdf) {
        await new Promise<void>((resolve, reject) => {
          const s = document.createElement("script");
          s.src = "https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.9.3/html2pdf.bundle.min.js";
          s.onload = () => resolve();
          s.onerror = () => reject(new Error("Failed to load html2pdf.js"));
          document.head.appendChild(s);
        });
      }

      if (window.html2pdf) {
        const cleanFilePeriod = (targetMonthStr || historyMonth || today().slice(0, 7)).replace(/[^a-zA-Z0-9_-]/g, "_");
        const opt = {
          margin: [8, 8, 8, 8],
          filename: `Performance_Report_${uId}_${cleanFilePeriod}.pdf`,
          image: { type: "jpeg", quality: 0.98 },
          html2canvas: {
            scale: 2,
            useCORS: true,
            logging: false,
            scrollX: 0,
            scrollY: 0,
            backgroundColor: "#ffffff",
            onclone: (clonedDoc: Document) => {
              // Remove #root and external stylesheets so html2canvas only parses reportContainer
              const appRoot = clonedDoc.getElementById("root");
              if (appRoot) appRoot.remove();
              clonedDoc.querySelectorAll('style, link[rel="stylesheet"]').forEach((el) => el.remove());
              const cleanStyle = clonedDoc.createElement("style");
              cleanStyle.textContent = `
                * { box-sizing: border-box; }
                body { margin: 0; padding: 0; background: #ffffff; color: #201f1e; font-family: 'Segoe UI', Arial, sans-serif; }
                .html2pdf__overlay, .html2pdf__container { opacity: 1 !important; visibility: visible !important; }
              `;
              clonedDoc.head.appendChild(cleanStyle);
            },
          },
          jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
        };
        await window.html2pdf().set(opt).from(reportContainer).save();
      }
    } catch (err) {
      console.error("PDF generation failed:", err);
    } finally {
      setGeneratingPdfFor(null);
    }
  }

  // Individual Yearly Average Performance PDF Report Generator (Jan-Dec Breakdown + Evaluated Months Average)
  async function downloadYearlyAppraisalPdf(targetUser?: UserProfile, yearStr?: string) {
    const u = targetUser || currentProfile;
    if (!u) return;
    const uid = u._uid || u.userId;
    const year = (yearStr || selectedYearForReport || today().slice(0, 4)).slice(0, 4);
    setGeneratingPdfFor(`yearly_${uid}`);
    try {
      const yearly = computeYearlyAppraisalSummary(u, year);
      const reportContainer = document.createElement("div");
      reportContainer.id = "pdf-yearly-render-target";
      reportContainer.style.width = "700px";
      reportContainer.style.padding = "20px";
      reportContainer.style.margin = "0 auto";
      reportContainer.style.fontFamily = "'Segoe UI', Arial, sans-serif";
      reportContainer.style.color = "#201f1e";
      reportContainer.style.backgroundColor = "#ffffff";
      reportContainer.style.boxSizing = "border-box";

      const monthRowsHtml = yearly.months
        .map((m, i) => {
          const wfBadge = APPRAISAL_WORKFLOW_LABELS[m.workflowStatus] || APPRAISAL_WORKFLOW_LABELS.draft;
          const rowBg = m.isEvaluated ? (i % 2 === 1 ? "#f8fbff" : "#ffffff") : "#fafafa";
          return `
            <tr style="background: ${rowBg};">
              <td style="padding: 6px 8px; border: 1px solid #c8c6c4; font-family: monospace; font-weight: 700; color: #201f1e;">
                ${escapeHtml(m.monthLabel)}
              </td>
              <td style="padding: 6px 8px; border: 1px solid #c8c6c4; text-align: center; font-family: monospace; color: ${m.isEvaluated ? "#0078d4" : "#a19f9d"}; font-weight: 700;">
                ${m.isEvaluated ? `${m.quantPoints} / 80 (${m.quantRawPct}%)` : "—"}
              </td>
              <td style="padding: 6px 8px; border: 1px solid #c8c6c4; text-align: center; font-family: monospace; color: ${m.isEvaluated ? "#038387" : "#a19f9d"}; font-weight: 700;">
                ${m.isEvaluated ? `${m.qualPoints} / 20 (${m.qualRawPct}%)` : "—"}
              </td>
              <td style="padding: 6px 8px; border: 1px solid #c8c6c4; text-align: center; font-family: monospace; font-weight: 700; color: ${m.isEvaluated ? m.band.color : "#a19f9d"};">
                ${m.isEvaluated ? `${m.totalScore}%` : "Not Evaluated"}
              </td>
              <td style="padding: 6px 8px; border: 1px solid #c8c6c4; text-align: center; font-size: 10px; font-weight: 700; color: ${m.isEvaluated ? m.band.color : "#a19f9d"};">
                ${m.isEvaluated ? escapeHtml(m.band.label) : "—"}
              </td>
              <td style="padding: 6px 8px; border: 1px solid #c8c6c4; text-align: center; font-size: 9px;">
                <span style="display: inline-block; padding: 2px 6px; border-radius: 3px; background: ${wfBadge.bg}; color: ${wfBadge.color}; font-weight: 700;">
                  ${m.isFinalized ? "🔒 Finalized" : escapeHtml(wfBadge.label)}
                </span>
              </td>
              <td style="padding: 6px 8px; border: 1px solid #c8c6c4; font-size: 9px; color: #201f1e;">
                ${m.isEvaluated ? escapeHtml(m.recommendation || "Pending Decision") : "—"}
              </td>
            </tr>
          `;
        })
        .join("");

      reportContainer.innerHTML = `
        <table style="width: 100%; border-collapse: collapse; border-bottom: 2px solid #0078d4; margin-bottom: 14px;">
          <tr>
            <td style="padding: 0 0 10px 0; vertical-align: bottom;">
              <div style="color: #0078d4; font-size: 22px; font-weight: 700; line-height: 1.2;">KPI Ledger</div>
              <div style="font-size: 13px; font-weight: 700; color: #201f1e; margin-top: 2px;">
                Annual Performance Appraisal &amp; Yearly Average Report (${escapeHtml(year)})
              </div>
            </td>
            <td style="padding: 0 0 10px 0; text-align: right; vertical-align: bottom;">
              <div style="font-size: 12px; font-weight: 700; color: #0078d4;">Appraisal Year: ${escapeHtml(year)}</div>
              <div style="font-size: 11px; color: #201f1e; margin-top: 2px;">
                Evaluated Months: <strong>${yearly.evaluatedMonthsCount} / 12</strong> (${yearly.finalizedMonthsCount} Finalized)
              </div>
              <div style="font-size: 10px; color: #605e5c; margin-top: 2px;">Generated: ${today()}</div>
            </td>
          </tr>
        </table>

        <table style="width: 100%; border-collapse: collapse; background: #f8f9fa; border: 1px solid #e1dfdd; margin-bottom: 14px; font-size: 11px;">
          <tr>
            <td style="padding: 6px 10px; width: 50%; border-bottom: 1px solid #edebe9;">
              <strong>Employee Name:</strong> ${escapeHtml(u.name || "")}
            </td>
            <td style="padding: 6px 10px; width: 50%; border-bottom: 1px solid #edebe9;">
              <strong>User ID / Emp Code:</strong> ${escapeHtml(u.userId || "")} (${escapeHtml(u.employeeCode || "—")})
            </td>
          </tr>
          <tr>
            <td style="padding: 6px 10px; border-bottom: 1px solid #edebe9;">
              <strong>Job Title:</strong> ${escapeHtml(u.title || "—")}
            </td>
            <td style="padding: 6px 10px; border-bottom: 1px solid #edebe9;">
              <strong>Department &amp; Office:</strong> ${escapeHtml(u.dept || "—")} (${escapeHtml(u.factory || "Corporate Office")})
            </td>
          </tr>
          <tr>
            <td style="padding: 6px 10px;">
              <strong>Line Manager:</strong> ${escapeHtml(u.managerUserId || "—")}
            </td>
            <td style="padding: 6px 10px;">
              <strong>Latest HR Recommendation:</strong> <span style="color: #107c10; font-weight: 700;">${escapeHtml(yearly.latestRecommendation)}</span>
            </td>
          </tr>
        </table>

        <table style="width: 100%; border-collapse: collapse; margin-bottom: 16px;">
          <tr>
            <td style="width: 33.33%; padding-right: 6px; vertical-align: top;">
              <div style="background: #eff6fc; border: 1px solid #0078d4; border-radius: 4px; padding: 10px;">
                <div style="font-size: 10px; font-weight: 700; text-transform: uppercase; color: #005a9e;">
                  Yearly Avg Quantitative (80%)
                </div>
                <div style="font-size: 18px; font-weight: 700; color: #0078d4; margin-top: 4px; font-family: monospace;">
                  ${yearly.avgQuantPoints} / 80 pts
                </div>
                <div style="font-size: 10px; color: #605e5c; margin-top: 2px;">
                  Avg Achievement: <strong>${yearly.avgQuantRawPct}%</strong>
                </div>
              </div>
            </td>
            <td style="width: 33.33%; padding: 0 3px; vertical-align: top;">
              <div style="background: #e6f4f1; border: 1px solid #038387; border-radius: 4px; padding: 10px;">
                <div style="font-size: 10px; font-weight: 700; text-transform: uppercase; color: #038387;">
                  Yearly Avg Qualitative (20%)
                </div>
                <div style="font-size: 18px; font-weight: 700; color: #038387; margin-top: 4px; font-family: monospace;">
                  ${yearly.avgQualPoints} / 20 pts
                </div>
                <div style="font-size: 10px; color: #605e5c; margin-top: 2px;">
                  Avg Behavioral: <strong>${yearly.avgQualRawPct}%</strong>
                </div>
              </div>
            </td>
            <td style="width: 33.33%; padding-left: 6px; vertical-align: top;">
              <div style="background: ${yearly.band.bg}; border: 2px solid ${yearly.band.color}; border-radius: 4px; padding: 10px;">
                <div style="font-size: 10px; font-weight: 700; text-transform: uppercase; color: ${yearly.band.color};">
                  Yearly Average Score (${yearly.evaluatedMonthsCount} Months)
                </div>
                <div style="font-size: 20px; font-weight: 700; color: ${yearly.band.color}; margin-top: 4px; font-family: monospace;">
                  ${yearly.avgTotalScore}% · ${escapeHtml(yearly.band.label)}
                </div>
                <div style="font-size: 10px; color: #605e5c; margin-top: 2px;">
                  Formula: Average of ${yearly.evaluatedMonthsCount} Evaluated Month(s) in ${escapeHtml(year)}
                </div>
              </div>
            </td>
          </tr>
        </table>

        <div style="color:#201f1e; margin: 0 0 8px; font-size: 13px; font-weight: 700; border-bottom: 1px solid #edebe9; padding-bottom: 4px;">
          12-Month Appraisal Breakdown (${escapeHtml(year)}-01 to ${escapeHtml(year)}-12)
        </div>
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 18px; font-size: 10px;">
          <thead>
            <tr style="background: #edebe9;">
              <th style="padding: 6px 8px; text-align: left; border: 1px solid #c8c6c4; width: 78px;">Month</th>
              <th style="padding: 6px 8px; text-align: center; border: 1px solid #c8c6c4; width: 105px;">Quant (80%)</th>
              <th style="padding: 6px 8px; text-align: center; border: 1px solid #c8c6c4; width: 100px;">Qual (20%)</th>
              <th style="padding: 6px 8px; text-align: center; border: 1px solid #c8c6c4; width: 85px;">Total Score</th>
              <th style="padding: 6px 8px; text-align: center; border: 1px solid #c8c6c4; width: 95px;">Band</th>
              <th style="padding: 6px 8px; text-align: center; border: 1px solid #c8c6c4; width: 95px;">Approval Status</th>
              <th style="padding: 6px 8px; text-align: left; border: 1px solid #c8c6c4;">HR / Manager Decision</th>
            </tr>
          </thead>
          <tbody>
            ${monthRowsHtml}
          </tbody>
          <tfoot>
            <tr style="background: #eff6fc; font-weight: 700;">
              <td style="padding: 7px 8px; border: 1px solid #c8c6c4; color: #005a9e;">YEARLY AVG</td>
              <td style="padding: 7px 8px; border: 1px solid #c8c6c4; text-align: center; font-family: monospace; color: #0078d4;">
                ${yearly.avgQuantPoints} / 80
              </td>
              <td style="padding: 7px 8px; border: 1px solid #c8c6c4; text-align: center; font-family: monospace; color: #038387;">
                ${yearly.avgQualPoints} / 20
              </td>
              <td style="padding: 7px 8px; border: 1px solid #c8c6c4; text-align: center; font-family: monospace; color: ${yearly.band.color}; font-size: 12px;">
                ${yearly.avgTotalScore}%
              </td>
              <td style="padding: 7px 8px; border: 1px solid #c8c6c4; text-align: center; color: ${yearly.band.color};">
                ${escapeHtml(yearly.band.label)}
              </td>
              <td colspan="2" style="padding: 7px 8px; border: 1px solid #c8c6c4; font-size: 9px; color: #605e5c;">
                Averaged across ${yearly.evaluatedMonthsCount} evaluated month(s) (${yearly.finalizedMonthsCount} HR Finalized)
              </td>
            </tr>
          </tfoot>
        </table>

        <table style="width: 100%; border-collapse: collapse; margin-top: 26px; border-top: 1px dashed #c8c6c4; font-size: 11px; color: #605e5c;">
          <tr>
            <td style="padding-top: 14px; text-align: left;">Employee Signature: _______________________</td>
            <td style="padding-top: 14px; text-align: center;">Line Manager: _______________________</td>
            <td style="padding-top: 14px; text-align: right;">HR Approval: _______________________</td>
          </tr>
        </table>
      `;

      if (!window.html2pdf) {
        await new Promise<void>((resolve, reject) => {
          const s = document.createElement("script");
          s.src = "https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.9.3/html2pdf.bundle.min.js";
          s.onload = () => resolve();
          s.onerror = () => reject(new Error("Failed to load html2pdf.js"));
          document.head.appendChild(s);
        });
      }

      if (window.html2pdf) {
        const opt = {
          margin: [8, 8, 8, 8],
          filename: `Yearly_Performance_Report_${u.userId}_${year}.pdf`,
          image: { type: "jpeg", quality: 0.98 },
          html2canvas: {
            scale: 2,
            useCORS: true,
            logging: false,
            scrollX: 0,
            scrollY: 0,
            backgroundColor: "#ffffff",
            onclone: (clonedDoc: Document) => {
              const appRoot = clonedDoc.getElementById("root");
              if (appRoot) appRoot.remove();
              clonedDoc.querySelectorAll('style, link[rel="stylesheet"]').forEach((el) => el.remove());
              const cleanStyle = clonedDoc.createElement("style");
              cleanStyle.textContent = `
                * { box-sizing: border-box; }
                body { margin: 0; padding: 0; background: #ffffff; color: #201f1e; font-family: 'Segoe UI', Arial, sans-serif; }
                .html2pdf__overlay, .html2pdf__container { opacity: 1 !important; visibility: visible !important; }
              `;
              clonedDoc.head.appendChild(cleanStyle);
            },
          },
          jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
        };
        await window.html2pdf().set(opt).from(reportContainer).save();
      }
    } catch (err) {
      console.error("Failed to generate Yearly Appraisal PDF:", err);
    } finally {
      setGeneratingPdfFor(null);
    }
  }

  // HR Department-wise Best Employee & Ranking PDF Report Generator (Supports Both Monthly & Yearly Average Mode)
  async function downloadDepartmentRankingPdf(
    deptFilter: string,
    periodValue: string,
    periodMode: "month" | "year" = hrReportPeriodMode
  ) {
    setGeneratingDeptPdf(true);
    try {
      const isYearly = periodMode === "year";
      const targetYear = isYearly ? (periodValue || today().slice(0, 4)).slice(0, 4) : "";
      const monthFilter = !isYearly ? periodValue || today().slice(0, 7) : "";

      const emps = allUsers.filter((u) => {
        if (u.role !== "employee") return false;
        if (deptFilter === "ALL") return true;
        return (u.dept || "").trim().toLowerCase() === deptFilter.trim().toLowerCase();
      });

      // Fetch worklogs for the selected period (month or year) to show activity count per employee
      let allWorklogs: WorkLogDoc[] = [];
      try {
        const wSnap = await getDocs(collection(db, "worklogs"));
        wSnap.forEach((d) => {
          const data = d.data() as WorkLogDoc;
          const prefix = isYearly ? targetYear : monthFilter;
          if (!prefix || (data.date && data.date.startsWith(prefix))) {
            allWorklogs.push(data);
          }
        });
      } catch (e) {
        console.error("Error loading worklogs for department report:", e);
      }

      const rankedList = emps
        .map((emp) => {
          const empLogs = allWorklogs.filter(
            (l) => (emp._uid && l.userUid === emp._uid) || (emp.userId && l.userId === emp.userId)
          );
          const uniqueDates = new Set(empLogs.map((l) => l.date));
          if (isYearly) {
            const yr = computeYearlyAppraisalSummary(emp, targetYear);
            return {
              ...emp,
              breakdown: {
                quantPoints: yr.avgQuantPoints,
                qualPoints: yr.avgQualPoints,
                totalScore: yr.avgTotalScore,
                band: yr.band,
              },
              evaluatedMonthsCount: yr.evaluatedMonthsCount,
              monthDaysLogged: uniqueDates.size,
            };
          } else {
            const br = computeAppraisalBreakdown(emp, monthFilter || undefined);
            return {
              ...emp,
              breakdown: br,
              evaluatedMonthsCount: 1,
              monthDaysLogged: uniqueDates.size,
            };
          }
        })
        .sort((a, b) => {
          if (b.breakdown.totalScore !== a.breakdown.totalScore) {
            return b.breakdown.totalScore - a.breakdown.totalScore;
          }
          if (b.breakdown.quantPoints !== a.breakdown.quantPoints) {
            return b.breakdown.quantPoints - a.breakdown.quantPoints;
          }
          return b.monthDaysLogged - a.monthDaysLogged;
        });

      const deptLabel = deptFilter === "ALL" ? "All Departments" : deptFilter;
      const periodLabel = isYearly ? `Year ${targetYear} (Yearly Average)` : monthFilter || today().slice(0, 7);
      const bestTitleBadge = isYearly
        ? "★ RANK #1 · BEST EMPLOYEE OF THE YEAR"
        : "★ RANK #1 · BEST EMPLOYEE OF THE MONTH";
      const bestEmp = rankedList.length > 0 ? rankedList[0] : null;
      const avgScore =
        rankedList.length > 0
          ? Math.round(rankedList.reduce((acc, r) => acc + r.breakdown.totalScore, 0) / rankedList.length)
          : 0;
      const onTargetCount = rankedList.filter((r) => r.breakdown.totalScore >= 80).length;

      const reportContainer = document.createElement("div");
      reportContainer.id = "pdf-dept-ranking-render-target";
      reportContainer.style.width = "700px";
      reportContainer.style.padding = "20px";
      reportContainer.style.margin = "0 auto";
      reportContainer.style.fontFamily = "'Segoe UI', Arial, sans-serif";
      reportContainer.style.color = "#201f1e";
      reportContainer.style.backgroundColor = "#ffffff";
      reportContainer.style.boxSizing = "border-box";

      const bestEmployeeHtml = bestEmp
        ? `
          <div style="background: #eff6fc; border: 2px solid #0078d4; border-radius: 6px; padding: 14px 16px; margin-bottom: 18px;">
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="vertical-align: top; width: 68%;">
                  <div style="display: inline-block; background: #0078d4; color: #ffffff; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; padding: 3px 8px; border-radius: 3px; margin-bottom: 6px;">
                    ${bestTitleBadge}
                  </div>
                  <div style="font-size: 18px; font-weight: 700; color: #201f1e; margin-top: 2px;">
                    ${escapeHtml(bestEmp.name)}
                  </div>
                  <div style="font-size: 11px; color: #605e5c; margin-top: 3px;">
                    Designation: <strong style="color: #201f1e;">${escapeHtml(bestEmp.title || "Employee")}</strong>
                    &nbsp;|&nbsp; Department: <strong style="color: #201f1e;">${escapeHtml(bestEmp.dept || "—")}</strong>
                  </div>
                  <div style="font-size: 11px; color: #605e5c; margin-top: 2px;">
                    User ID: <strong style="font-family: monospace; color: #201f1e;">${escapeHtml(bestEmp.userId)}</strong>
                    &nbsp;|&nbsp; Emp ID: <strong style="color: #201f1e;">${escapeHtml(bestEmp.employeeCode || "—")}</strong>
                    &nbsp;|&nbsp; Line Manager: <strong style="color: #201f1e;">${escapeHtml(bestEmp.managerUserId || "—")}</strong>
                  </div>
                </td>
                <td style="vertical-align: top; text-align: right; width: 32%;">
                  <div style="font-size: 10px; text-transform: uppercase; color: #005a9e; font-weight: 700;">
                    ${isYearly ? `Yearly Avg Score (${bestEmp.evaluatedMonthsCount}M)` : "Total Appraisal Score"}
                  </div>
                  <div style="font-size: 28px; font-family: monospace; font-weight: 700; color: ${bestEmp.breakdown.band.color}; line-height: 1.15; margin-top: 2px;">
                    ${bestEmp.breakdown.totalScore}%
                  </div>
                  <div style="font-size: 11px; font-weight: 700; color: ${bestEmp.breakdown.band.color}; margin-top: 2px;">
                    ${escapeHtml(bestEmp.breakdown.band.label)}
                  </div>
                  <div style="font-size: 10px; color: #605e5c; margin-top: 4px; font-family: monospace;">
                    Quant: ${bestEmp.breakdown.quantPoints}/80 · Qual: ${bestEmp.breakdown.qualPoints}/20
                  </div>
                </td>
              </tr>
            </table>
          </div>
        `
        : "";

      const rowsHtml =
        rankedList.length === 0
          ? `<tr><td colspan="9" style="padding: 12px; border: 1px solid #c8c6c4; text-align: center; color: #605e5c;">No employees found for Department "${escapeHtml(deptLabel)}".</td></tr>`
          : rankedList
              .map((emp, idx) => {
                const rankNum = idx + 1;
                const isBest = rankNum === 1;
                const br = emp.breakdown;
                const rowBg = isBest ? "#f0f7ff" : idx % 2 === 1 ? "#fafafa" : "#ffffff";
                const rankBadge = isBest
                  ? `<div style="font-weight: 700; color: #0078d4; font-family: monospace; font-size: 12px;">#1 ★</div><div style="font-size: 8px; font-weight: 700; color: #ffffff; background: #0078d4; padding: 1px 4px; border-radius: 2px; display: inline-block; margin-top: 2px;">BEST</div>`
                  : `<span style="font-weight: 700; color: #3b3a39; font-family: monospace; font-size: 11px;">#${rankNum}</span>`;

                return `
                  <tr style="background: ${rowBg};">
                    <td style="padding: 7px 6px; border: 1px solid #c8c6c4; text-align: center; vertical-align: middle;">
                      ${rankBadge}
                    </td>
                    <td style="padding: 7px 8px; border: 1px solid #c8c6c4; vertical-align: middle;">
                      <div style="font-weight: 700; color: #201f1e; font-size: 11px;">${escapeHtml(emp.name)}</div>
                      <div style="font-size: 9px; color: #605e5c; font-family: monospace;">ID: ${escapeHtml(emp.userId)} ${emp.employeeCode ? `(${escapeHtml(emp.employeeCode)})` : ""}</div>
                    </td>
                    <td style="padding: 7px 8px; border: 1px solid #c8c6c4; vertical-align: middle;">
                      <div style="font-weight: 600; color: #201f1e; font-size: 10px;">${escapeHtml(emp.dept || "—")}</div>
                      <div style="font-size: 9px; color: #605e5c;">${escapeHtml(emp.title || "Employee")}</div>
                    </td>
                    <td style="padding: 7px 6px; border: 1px solid #c8c6c4; text-align: center; vertical-align: middle; font-size: 10px; color: #201f1e;">
                      ${escapeHtml(emp.managerUserId || "—")}
                    </td>
                    <td style="padding: 7px 6px; border: 1px solid #c8c6c4; text-align: center; vertical-align: middle; font-family: monospace; font-size: 10px; color: #201f1e;">
                      ${isYearly ? `${emp.evaluatedMonthsCount}/12 m` : (emp.kpis || []).length}
                    </td>
                    <td style="padding: 7px 6px; border: 1px solid #c8c6c4; text-align: center; vertical-align: middle; font-family: monospace; font-size: 10px; color: #201f1e;">
                      ${emp.monthDaysLogged} d
                    </td>
                    <td style="padding: 7px 6px; border: 1px solid #c8c6c4; text-align: center; vertical-align: middle; font-family: monospace; font-weight: 700; color: #0078d4; font-size: 11px;">
                      ${br.quantPoints} / 80
                    </td>
                    <td style="padding: 7px 6px; border: 1px solid #c8c6c4; text-align: center; vertical-align: middle; font-family: monospace; font-weight: 700; color: #038387; font-size: 11px;">
                      ${br.qualPoints} / 20
                    </td>
                    <td style="padding: 7px 6px; border: 1px solid #c8c6c4; text-align: center; vertical-align: middle;">
                      <div style="font-family: monospace; font-size: 12px; font-weight: 700; color: ${br.band.color};">${br.totalScore}%</div>
                      <div style="font-size: 9px; font-weight: 700; color: ${br.band.color};">${escapeHtml(br.band.label)}</div>
                    </td>
                  </tr>
                `;
              })
              .join("");

      reportContainer.innerHTML = `
        <table style="width: 100%; border-collapse: collapse; border-bottom: 2px solid #0078d4; margin-bottom: 14px;">
          <tr>
            <td style="padding: 0 0 10px 0; vertical-align: bottom;">
              <div style="color: #0078d4; font-size: 22px; font-weight: 700; line-height: 1.2;">KPI Ledger</div>
              <div style="font-size: 13px; font-weight: 600; color: #201f1e; margin-top: 2px;">
                Department-wise ${isYearly ? "Yearly Average" : "Monthly"} Performance &amp; Best Employee Ranking Report
              </div>
            </td>
            <td style="padding: 0 0 10px 0; text-align: right; vertical-align: bottom;">
              <div style="font-size: 12px; font-weight: 700; color: #0078d4;">Department: ${escapeHtml(deptLabel)}</div>
              <div style="font-size: 11px; font-weight: 600; color: #201f1e; margin-top: 2px;">Evaluation Period: ${escapeHtml(periodLabel)}</div>
              <div style="font-size: 10px; color: #605e5c; margin-top: 2px;">Generated: ${today()}</div>
            </td>
          </tr>
        </table>

        <table style="width: 100%; border-collapse: collapse; background: #f8f9fa; border: 1px solid #e1dfdd; margin-bottom: 16px; font-size: 11px;">
          <tr>
            <td style="padding: 8px 10px; border-right: 1px solid #e1dfdd; width: 25%;">
              <div style="font-size: 9px; text-transform: uppercase; color: #605e5c;">Selected Department</div>
              <div style="font-weight: 700; color: #201f1e; font-size: 13px; margin-top: 2px;">${escapeHtml(deptLabel)}</div>
            </td>
            <td style="padding: 8px 10px; border-right: 1px solid #e1dfdd; width: 25%;">
              <div style="font-size: 9px; text-transform: uppercase; color: #605e5c;">Total Employees Ranked</div>
              <div style="font-weight: 700; color: #201f1e; font-size: 13px; font-family: monospace; margin-top: 2px;">${rankedList.length}</div>
            </td>
            <td style="padding: 8px 10px; border-right: 1px solid #e1dfdd; width: 25%;">
              <div style="font-size: 9px; text-transform: uppercase; color: #605e5c;">Department Avg Score</div>
              <div style="font-weight: 700; color: #0078d4; font-size: 13px; font-family: monospace; margin-top: 2px;">${avgScore}%</div>
            </td>
            <td style="padding: 8px 10px; width: 25%;">
              <div style="font-size: 9px; text-transform: uppercase; color: #605e5c;">Excellent (&ge;80%)</div>
              <div style="font-weight: 700; color: #107c10; font-size: 13px; font-family: monospace; margin-top: 2px;">${onTargetCount} / ${rankedList.length}</div>
            </td>
          </tr>
        </table>

        ${bestEmployeeHtml}

        <div style="color:#201f1e; margin: 0 0 8px; font-size: 13px; font-weight: 700; border-bottom: 1px solid #edebe9; padding-bottom: 4px;">
          Employee Performance Ranking Table — Rank #1 (Best Employee) to #${rankedList.length}
        </div>
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 10px;">
          <thead>
            <tr style="background: #edebe9;">
              <th style="padding: 6px; text-align: center; border: 1px solid #c8c6c4; width: 46px; color: #201f1e;">Rank</th>
              <th style="padding: 6px; text-align: left; border: 1px solid #c8c6c4; color: #201f1e;">Employee Name &amp; ID</th>
              <th style="padding: 6px; text-align: left; border: 1px solid #c8c6c4; width: 115px; color: #201f1e;">Department &amp; Role</th>
              <th style="padding: 6px; text-align: center; border: 1px solid #c8c6c4; width: 65px; color: #201f1e;">Manager</th>
              <th style="padding: 6px; text-align: center; border: 1px solid #c8c6c4; width: 48px; color: #201f1e;">${isYearly ? "Months" : "KPIs"}</th>
              <th style="padding: 6px; text-align: center; border: 1px solid #c8c6c4; width: 54px; color: #201f1e;">Logged</th>
              <th style="padding: 6px; text-align: center; border: 1px solid #c8c6c4; width: 68px; color: #201f1e;">Quant (80%)</th>
              <th style="padding: 6px; text-align: center; border: 1px solid #c8c6c4; width: 64px; color: #201f1e;">Qual (20%)</th>
              <th style="padding: 6px; text-align: center; border: 1px solid #c8c6c4; width: 72px; color: #201f1e;">${isYearly ? "Yearly Avg" : "Total Score"}</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>

        <table style="width: 100%; border-collapse: collapse; margin-top: 28px; border-top: 1px dashed #c8c6c4; font-size: 11px; color: #605e5c;">
          <tr>
            <td style="padding-top: 14px; text-align: left;">Prepared by HR: _______________________</td>
            <td style="padding-top: 14px; text-align: right;">Approved by Management: _______________________</td>
          </tr>
        </table>
      `;

      if (!window.html2pdf) {
        await new Promise<void>((resolve, reject) => {
          const s = document.createElement("script");
          s.src = "https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.9.3/html2pdf.bundle.min.js";
          s.onload = () => resolve();
          s.onerror = () => reject(new Error("Failed to load html2pdf.js"));
          document.head.appendChild(s);
        });
      }

      if (window.html2pdf) {
        const cleanDept = deptLabel.replace(/[^a-zA-Z0-9_-]/g, "_");
        const cleanPeriod = (isYearly ? `Year_${targetYear}` : monthFilter || today().slice(0, 7)).replace(
          /[^a-zA-Z0-9_-]/g,
          "_"
        );
        const opt = {
          margin: [8, 8, 8, 8],
          filename: `Best_Employee_Ranking_${cleanDept}_${cleanPeriod}.pdf`,
          image: { type: "jpeg", quality: 0.98 },
          html2canvas: {
            scale: 2,
            useCORS: true,
            logging: false,
            scrollX: 0,
            scrollY: 0,
            backgroundColor: "#ffffff",
            onclone: (clonedDoc: Document) => {
              // Remove #root and external stylesheets so html2canvas only parses reportContainer
              const appRoot = clonedDoc.getElementById("root");
              if (appRoot) appRoot.remove();
              clonedDoc.querySelectorAll('style, link[rel="stylesheet"]').forEach((el) => el.remove());
              const cleanStyle = clonedDoc.createElement("style");
              cleanStyle.textContent = `
                * { box-sizing: border-box; }
                body { margin: 0; padding: 0; background: #ffffff; color: #201f1e; font-family: 'Segoe UI', Arial, sans-serif; }
                .html2pdf__overlay, .html2pdf__container { opacity: 1 !important; visibility: visible !important; }
              `;
              clonedDoc.head.appendChild(cleanStyle);
            },
          },
          jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
        };
        await window.html2pdf().set(opt).from(reportContainer).save();
      }
    } catch (err) {
      console.error("Failed to generate department ranking PDF:", err);
    } finally {
      setGeneratingDeptPdf(false);
    }
  }

  // Handlers: System Settings
  async function handleAddMasterOption(
    type: "kpiUnits" | "offices" | "cycles" | "frequencies" | "competencies",
    val: string,
    clearFn: () => void
  ) {
    const trimmed = val.trim();
    if (!trimmed) return;
    if (!systemSettings[type].includes(trimmed)) {
      const next = { ...systemSettings, [type]: [...systemSettings[type], trimmed] };
      setSystemSettings(next);
      await setDoc(doc(db, "settings", "global"), next);
    }
    clearFn();
  }

  async function handleDeleteMasterOption(
    type: "kpiUnits" | "offices" | "cycles" | "frequencies" | "competencies",
    val: string
  ) {
    if (systemSettings[type].length <= 1) return;
    const next = {
      ...systemSettings,
      [type]: systemSettings[type].filter((item) => item !== val),
    };
    setSystemSettings(next);
    await setDoc(doc(db, "settings", "global"), next);
  }

  // Render Helpers for Profile, KRA, Quantitative KPIs, and Qualitative Competencies
  function renderProfileCard(u: UserProfile) {
    const isHrViewer = currentProfile?.role === "hr";
    if (u.role !== "employee") {
      return (
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              User ID: <strong className="mono">{u.userId}</strong>
              {isHrViewer && (
                <>
                  {" "}· Password:{" "}
                  <strong className="mono" style={{ color: "var(--ms-blue-dark)" }}>
                    {u.authSecret || "Not synced"}
                  </strong>
                </>
              )}
              {" "}· Department: <strong>{u.dept || "—"}</strong>
            </span>
            {u.passwordUpdatedAt && (
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                Password Updated: {u.passwordUpdatedAt}
              </span>
            )}
          </div>
        </div>
      );
    }
    return (
      <div className="card">
        <div className="card-header">
          <div className="card-title">Profile Details</div>
          {u.passwordUpdatedAt && (
            <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
              Password Updated: {u.passwordUpdatedAt}
            </span>
          )}
        </div>
        <div className="profile-grid">
          <div className="profile-field">
            <span>User ID (Username)</span>
            <strong className="mono">{u.userId || "—"}</strong>
          </div>
          {isHrViewer && (
            <div className="profile-field">
              <span>Current Password</span>
              <strong className="mono" style={{ color: "var(--ms-blue-dark)" }}>
                {u.authSecret || "Not synced"}
              </strong>
            </div>
          )}
          <div className="profile-field">
            <span>Employee ID</span>
            <strong>{u.employeeCode || "—"}</strong>
          </div>
          <div className="profile-field">
            <span>Department</span>
            <strong>{u.dept || "—"}</strong>
          </div>
          <div className="profile-field">
            <span>Factory / Office</span>
            <strong>{u.factory || "—"}</strong>
          </div>
          <div className="profile-field">
            <span>Line Manager</span>
            <strong>{u.managerUserId || "—"}</strong>
          </div>
          <div className="profile-field">
            <span>Appraisal Cycle</span>
            <strong>{u.appraisalCycle || "—"}</strong>
          </div>
        </div>
        <span className="section-label" style={{ marginTop: 8 }}>
          Purpose of Role
        </span>
        <div className="purpose-block">
          {u.purpose ? u.purpose : <span style={{ color: "var(--text-disabled)" }}>Not set.</span>}
        </div>
      </div>
    );
  }

  function renderKraSection(u: UserProfile, canEdit: boolean) {
    const kras = u.kras || [];
    const uid = u._uid || "";
    return (
      <div className="card" style={{ marginTop: 12 }}>
        <div className="card-header">
          <div className="card-title">KRA-based Role Description</div>
        </div>
        {kras.length === 0 && (
          <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>No KRAs have been defined yet.</p>
        )}
        {kras.map((k, ki) => {
          const objKey = `${uid}_${k.id}`;
          return (
            <div key={k.id} className="kra-item">
              <div className="kra-title-row">
                <span>
                  {ki + 1}. {k.title}
                </span>
                {canEdit && (
                  <button className="x-btn" onClick={() => handleRemoveKra(u, k.id)}>
                    ✕ Remove
                  </button>
                )}
              </div>
              {(k.objectives || []).map((o, oi) => (
                <div key={o.id} className="kra-obj">
                  <span>
                    {ki + 1}
                    {String.fromCharCode(97 + oi)}. {o.text}
                  </span>
                  {canEdit && (
                    <button className="x-btn" onClick={() => handleRemoveObjective(u, k.id, o.id)}>
                      ✕
                    </button>
                  )}
                </div>
              ))}
              {canEdit && (
                <div className="kra-add-row">
                  <input
                    placeholder="Add objective or activity…"
                    value={kraObjInputs[objKey] || ""}
                    onChange={(e) => setKraObjInputs((prev) => ({ ...prev, [objKey]: e.target.value }))}
                  />
                  <button className="btn-secondary btn-sm" onClick={() => handleAddObjective(u, k.id)}>
                    Add
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {canEdit && (
          <div className="inline-row" style={{ marginTop: 14 }}>
            <input
              placeholder="Enter new KRA title…"
              style={{ flex: 1 }}
              value={kraTitleInputs[uid] || ""}
              onChange={(e) => setKraTitleInputs((prev) => ({ ...prev, [uid]: e.target.value }))}
            />
            <button className="btn-secondary btn-sm" onClick={() => handleAddKra(u)}>
              Add KRA
            </button>
          </div>
        )}
      </div>
    );
  }

  function renderCompositeScoreStrip(u: UserProfile) {
    const uid = u._uid || u.userId;
    const selectedMonth = empKpiFilterMonth[uid] || "ALL";
    const br = computeAppraisalBreakdown(u, selectedMonth);
    const qual = getEmployeeQualitative(u, selectedMonth);
    const wfInfo = APPRAISAL_WORKFLOW_LABELS[qual.workflowStatus || "draft"] || APPRAISAL_WORKFLOW_LABELS.draft;
    const activeLockMonth = selectedMonth === "ALL" ? qual.effectiveMonth || today().slice(0, 7) : selectedMonth;
    const monthLocked = isMonthFinalized(u, activeLockMonth);
    const reportYear = (activeLockMonth || selectedYearForReport || today().slice(0, 4)).slice(0, 4);
    const yearlySummary = computeYearlyAppraisalSummary(u, reportYear);

    return (
      <div
        className="card"
        style={{
          marginTop: 12,
          background: "linear-gradient(135deg, #eff6fc 0%, #ffffff 100%)",
          borderColor: "var(--ms-blue-light)",
        }}
      >
        <div className="card-header" style={{ flexWrap: "wrap", gap: 10, marginBottom: 12 }}>
          <div>
            <div className="card-title" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span>Composite Appraisal Score (80% Quantitative + 20% Qualitative)</span>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  background: "var(--ms-blue)",
                  color: "#ffffff",
                  padding: "2px 8px",
                  borderRadius: 4,
                }}
              >
                Effective Month: {selectedMonth === "ALL" ? "All Months" : selectedMonth}
              </span>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  background: wfInfo.bg,
                  color: wfInfo.color,
                  border: `1px solid ${wfInfo.color}`,
                  padding: "2px 8px",
                  borderRadius: 4,
                }}
              >
                Status: {wfInfo.label}
              </span>
              {monthLocked && (
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    background: "#fde7e9",
                    color: "#a4262c",
                    border: "1px solid #a4262c",
                    padding: "2px 8px",
                    borderRadius: 4,
                  }}
                >
                  🔒 Locked ({activeLockMonth})
                </span>
              )}
              {qual.recommendation && qual.recommendation !== "Pending Decision" && (
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    background: "#dff6dd",
                    color: "#107c10",
                    border: "1px solid #107c10",
                    padding: "2px 8px",
                    borderRadius: 4,
                  }}
                >
                  Action: {qual.recommendation}
                </span>
              )}
              {qual.employeeAcknowledged && (
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    background: "#e6f4f1",
                    color: "#008272",
                    padding: "2px 8px",
                    borderRadius: 4,
                  }}
                >
                  ✓ Signed Off by Employee
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
              Segment A: Quantitative KPIs (80%) + Segment B: Qualitative & Behavioral (20%)
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}>
              Filter Score by Effective Month:
            </span>
            <button
              type="button"
              className={selectedMonth === "ALL" ? "btn-primary btn-sm" : "btn-secondary btn-sm"}
              style={{ width: "auto", marginTop: 0, padding: "4px 10px" }}
              onClick={() => setEmpKpiFilterMonth((prev) => ({ ...prev, [uid]: "ALL" }))}
            >
              All Months
            </button>
            <input
              type="month"
              value={selectedMonth === "ALL" ? today().slice(0, 7) : selectedMonth}
              onChange={(e) =>
                setEmpKpiFilterMonth((prev) => ({
                  ...prev,
                  [uid]: e.target.value || "ALL",
                }))
              }
              style={{ width: "auto", padding: "3px 8px", fontSize: 12 }}
            />
            <button
              type="button"
              className="btn-secondary btn-sm"
              style={{ width: "auto", marginTop: 0, padding: "4px 10px" }}
              disabled={generatingPdfFor === `yearly_${uid}`}
              onClick={() => downloadYearlyAppraisalPdf(u, reportYear)}
            >
              {generatingPdfFor === `yearly_${uid}`
                ? "Generating Yearly PDF…"
                : `⬇ Yearly Avg Report (${reportYear}: ${yearlySummary.avgTotalScore}%)`}
            </button>
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
            gap: 12,
          }}
        >
          {/* Quantitative Segment Box */}
          <div
            style={{
              background: "var(--bg-surface)",
              border: "1px solid var(--border-default)",
              borderRadius: "var(--radius-md)",
              padding: "12px 14px",
            }}
          >
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: "var(--text-secondary)" }}>
              Segment A · Quantitative (80%)
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 4 }}>
              <span className="mono" style={{ fontSize: 22, fontWeight: 700, color: "var(--ms-blue)" }}>
                {br.quantPoints}
              </span>
              <span className="mono" style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                / 80 pts
              </span>
            </div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
              Raw KPI Achievement: <strong className="mono">{br.quantRawPct}%</strong>
            </div>
          </div>

          {/* Qualitative Segment Box */}
          <div
            style={{
              background: "var(--bg-surface)",
              border: "1px solid var(--border-default)",
              borderRadius: "var(--radius-md)",
              padding: "12px 14px",
            }}
          >
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: "var(--text-secondary)" }}>
              Segment B · Qualitative (20%)
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 4 }}>
              <span className="mono" style={{ fontSize: 22, fontWeight: 700, color: "var(--ms-teal)" }}>
                {br.qualPoints}
              </span>
              <span className="mono" style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                / 20 pts
              </span>
            </div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
              {br.isQualEvaluated ? (
                <>
                  Behavioral Score: <strong className="mono">{br.qualRawPct}%</strong> (
                  {br.mode === "competencies" ? "1–5 Rubric" : "Direct Score"})
                </>
              ) : (
                <span style={{ color: "var(--ms-orange)" }}>Pending Supervisor Evaluation</span>
              )}
            </div>
          </div>

          {/* Final Composite Appraisal Box */}
          <div
            style={{
              background: "var(--bg-surface)",
              border: `1px solid ${br.band.color}`,
              borderRadius: "var(--radius-md)",
              padding: "12px 14px",
            }}
          >
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: "var(--text-secondary)" }}>
              Final Appraisal Score (100%)
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 4 }}>
              <span className="mono" style={{ fontSize: 24, fontWeight: 700, color: br.band.color }}>
                {br.totalScore}%
              </span>
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: br.band.color,
                  background: br.band.bg,
                  padding: "2px 8px",
                  borderRadius: 4,
                }}
              >
                {br.band.label}
              </span>
            </div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
              Formula: {br.quantPoints} (Quant) + {br.qualPoints} (Qual)
            </div>
          </div>

          {/* Yearly Average Summary Box */}
          <div
            style={{
              background: "var(--bg-surface)",
              border: `1px solid ${yearlySummary.band.color}`,
              borderRadius: "var(--radius-md)",
              padding: "12px 14px",
            }}
          >
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: "var(--text-secondary)" }}>
              Yearly Average ({reportYear}) · {yearlySummary.evaluatedMonthsCount}/12 M
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 4 }}>
              <span className="mono" style={{ fontSize: 24, fontWeight: 700, color: yearlySummary.band.color }}>
                {yearlySummary.avgTotalScore}%
              </span>
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: yearlySummary.band.color,
                  background: yearlySummary.band.bg,
                  padding: "2px 8px",
                  borderRadius: 4,
                }}
              >
                {yearlySummary.band.label}
              </span>
            </div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
              Avg Quant: <strong className="mono">{yearlySummary.avgQuantPoints}/80</strong> + Avg Qual:{" "}
              <strong className="mono">{yearlySummary.avgQualPoints}/20</strong>
            </div>
          </div>
        </div>
      </div>
    );
  }

  function renderEmployeeKpiSection(u: UserProfile, rawCanManage: boolean) {
    const allKpis = u.kpis || [];
    const uid = u._uid || "";
    const selectedMonth = empKpiFilterMonth[uid] || "ALL";
    const defaultMonth = today().slice(0, 7);
    const activeKpiMonth = selectedMonth === "ALL" ? defaultMonth : selectedMonth;
    const isLockedForManager = isMonthLockedForRole(u, activeKpiMonth, currentProfile?.role);
    const canManage = rawCanManage && !isLockedForManager;
    const kpis =
      selectedMonth === "ALL"
        ? allKpis
        : allKpis.filter((k) => !k.effectiveMonth || k.effectiveMonth === selectedMonth);
    const totalAssignedWeight = kpis.reduce((sum, k) => sum + (Number(k.weight) || 0), 0);
    const isWeightExact100 = totalAssignedWeight === 100;
    const br = computeAppraisalBreakdown(u, selectedMonth);
    const draft = empKpiInputs[uid] || {
      title: "",
      target: "",
      unit: systemSettings.kpiUnits[0] || "%",
      freq: systemSettings.frequencies[2] || "Monthly",
      weight: "",
      deadline: "",
      effectiveMonth: defaultMonth,
      lowerIsBetter: false,
    };

    const updateDraft = (patch: Partial<typeof draft>) => {
      setEmpKpiInputs((prev) => ({
        ...prev,
        [uid]: { ...draft, ...patch },
      }));
    };

    return (
      <div className="card" style={{ marginTop: 12 }}>
        <div className="card-header" style={{ flexWrap: "wrap", gap: 8 }}>
          <div>
            <div className="card-title" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span>Segment A: Quantitative KPIs ({br.quantWeight}% of Total Appraisal)</span>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  background: "var(--ms-blue-faint)",
                  color: "var(--ms-blue)",
                  padding: "2px 8px",
                  borderRadius: 4,
                }}
              >
                Showing: {selectedMonth === "ALL" ? `All Months (${allKpis.length})` : `${selectedMonth} (${kpis.length})`}
              </span>
              {kpis.length > 0 && (
                <span
                  className="mono"
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    background: isWeightExact100 ? "#dff6dd" : "#fff4ce",
                    color: isWeightExact100 ? "#107c10" : "#ca5010",
                    border: `1px solid ${isWeightExact100 ? "#107c10" : "#ca5010"}`,
                    padding: "2px 8px",
                    borderRadius: 4,
                  }}
                >
                  Total KPI Weight: {totalAssignedWeight}% / 100%{" "}
                  {isWeightExact100 ? "✓ Balanced" : "(Recommended: 100%)"}
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
              Weighted KPI Score: <strong className="mono">{br.quantRawPct}%</strong> &nbsp;→&nbsp; Contributes{" "}
              <strong className="mono" style={{ color: "var(--ms-blue)" }}>
                {br.quantPoints} / {br.quantWeight} pts
              </strong>
            </div>
          </div>
        </div>
        {isLockedForManager && rawCanManage && (
          <div className="alert alert-danger" style={{ marginBottom: 12 }}>
            🔒 Effective Month <strong>{activeKpiMonth}</strong> is Finalized &amp; Approved by HR. Quantitative KPI
            editing is locked for Line Managers and Employees. Only HR can reopen a finalized month.
          </div>
        )}
        {kpis.length === 0 && (
          <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>
            {selectedMonth === "ALL"
              ? "No Quantitative KPIs have been assigned yet."
              : `No Quantitative KPIs found for Effective Month ${selectedMonth}.`}
          </p>
        )}
        {kpis.map((k) => {
          const pct = kpiPercent(k);
          const dl = getDeadlineStatus(k);
          return (
            <div key={k.id} className="kpi-card">
              <div className="kpi-header">
                <div>
                  <div className="kpi-title" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <span>{k.title}</span>
                    <span
                      className="mono"
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        background: "#eff6fc",
                        color: "#0078d4",
                        border: "1px solid #c7e0f4",
                        padding: "1px 7px",
                        borderRadius: 4,
                      }}
                    >
                      Effective Month: {k.effectiveMonth || "All / Ongoing"}
                    </span>
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        background: k.lowerIsBetter ? "#fff4ce" : "#f3f2f1",
                        color: k.lowerIsBetter ? "#ca5010" : "#605e5c",
                        padding: "1px 6px",
                        borderRadius: 4,
                      }}
                    >
                      {k.lowerIsBetter ? "↓ Lower is Better" : "↑ Higher is Better"}
                    </span>
                    {k.frequency && (
                      <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>· {k.frequency}</span>
                    )}
                  </div>
                  <div className="kpi-meta" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <span>
                      Achieved: <strong>{fmtVal(k.current, k.unit)}</strong> / Target: {fmtVal(k.target, k.unit)} · Weight: {k.weight}%
                    </span>
                    {dl && (
                      <>
                        <span>·</span>
                        <span>
                          Deadline: <strong>{dl.date}</strong>{" "}
                          <span style={{ color: dl.color, fontWeight: 700 }}>({dl.label})</span>
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <KpiBadge pct={pct} />
                  {canManage && (
                    <button className="x-btn" onClick={() => handleRemoveKpiFromEmployee(u, k.id)}>
                      ✕
                    </button>
                  )}
                </div>
              </div>
              <div className="bar-track">
                <div className={`bar-fill ${barColorClass(pct)}`} style={{ width: `${Math.min(pct, 100)}%` }} />
              </div>
              {canManage && (
                <div
                  style={{
                    marginTop: 8,
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    flexWrap: "wrap",
                    fontSize: 12,
                    color: "var(--text-secondary)",
                    background: "var(--bg-overlay)",
                    padding: "8px 10px",
                    borderRadius: 6,
                    border: "1px solid var(--border-default)",
                  }}
                >
                  <div style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                    <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>Achieved ({k.unit}):</span>
                    <input
                      type="number"
                      step="any"
                      value={k.current ?? 0}
                      onChange={(e) =>
                        handleUpdateEmployeeKpiFields(u, k.id, { current: Number(e.target.value) || 0 })
                      }
                      style={{ width: 78, padding: "3px 6px", fontSize: 12 }}
                    />
                  </div>

                  <div style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                    <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>Target:</span>
                    <input
                      type="number"
                      step="any"
                      value={k.target}
                      onChange={(e) =>
                        handleUpdateEmployeeKpiFields(u, k.id, { target: Math.max(0.01, Number(e.target.value) || 1) })
                      }
                      style={{ width: 78, padding: "3px 6px", fontSize: 12 }}
                    />
                  </div>

                  <div style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                    <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>Weight %:</span>
                    <input
                      type="number"
                      value={k.weight}
                      onChange={(e) =>
                        handleUpdateEmployeeKpiFields(u, k.id, { weight: Math.max(1, Number(e.target.value) || 1) })
                      }
                      style={{ width: 64, padding: "3px 6px", fontSize: 12 }}
                    />
                  </div>

                  <div style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                    <span style={{ fontWeight: 600, color: "var(--ms-blue)" }}>Eff. Month:</span>
                    <input
                      type="month"
                      value={k.effectiveMonth || defaultMonth}
                      onChange={(e) => handleUpdateEmployeeKpiEffectiveMonth(u, k.id, e.target.value)}
                      style={{ width: "auto", padding: "3px 6px", fontSize: 12 }}
                    />
                  </div>

                  <div style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                    <span>Direction:</span>
                    <select
                      value={k.lowerIsBetter ? "lower" : "higher"}
                      onChange={(e) =>
                        handleUpdateEmployeeKpiFields(u, k.id, { lowerIsBetter: e.target.value === "lower" })
                      }
                      style={{ width: "auto", padding: "3px 6px", fontSize: 12 }}
                    >
                      <option value="higher">↑ Higher is Better</option>
                      <option value="lower">↓ Lower is Better (Error/Cost)</option>
                    </select>
                  </div>

                  <div style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                    <span>Deadline:</span>
                    <input
                      type="date"
                      value={k.deadline || ""}
                      onChange={(e) => handleUpdateEmployeeKpiDeadline(u, k.id, e.target.value)}
                      style={{ width: "auto", padding: "3px 6px", fontSize: 12 }}
                    />
                    {k.deadline && (
                      <button
                        type="button"
                        className="btn-link"
                        style={{ fontSize: 11, color: "var(--text-secondary)" }}
                        onClick={() => handleUpdateEmployeeKpiDeadline(u, k.id, "")}
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {canManage && (
          <div className="form-card" style={{ marginTop: 12 }}>
            <div className="card-title" style={{ marginBottom: 12 }}>
              Add Quantitative KPI
            </div>
            <div className="form-row">
              <label>KPI Title</label>
              <input
                placeholder="e.g. Monthly Sales Revenue, Production Output, or Defect Rate < 2%"
                value={draft.title}
                onChange={(e) => updateDraft({ title: e.target.value })}
              />
            </div>
            <div className="form-grid">
              <div className="form-field">
                <label style={{ color: "var(--ms-blue)", fontWeight: 700 }}>Effective Month</label>
                <input
                  type="month"
                  value={draft.effectiveMonth || defaultMonth}
                  onChange={(e) => updateDraft({ effectiveMonth: e.target.value })}
                />
              </div>
              <div className="form-field">
                <label>Target</label>
                <input
                  type="number"
                  value={draft.target}
                  onChange={(e) => updateDraft({ target: e.target.value })}
                />
              </div>
              <div className="form-field">
                <label>Unit</label>
                <select value={draft.unit} onChange={(e) => updateDraft({ unit: e.target.value })}>
                  {systemSettings.kpiUnits.map((unit) => (
                    <option key={unit} value={unit}>
                      {unit}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-field">
                <label>Frequency</label>
                <select value={draft.freq} onChange={(e) => updateDraft({ freq: e.target.value })}>
                  {systemSettings.frequencies.map((freq) => (
                    <option key={freq} value={freq}>
                      {freq}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-field">
                <label>Weight % (Recommended total = 100%)</label>
                <input
                  type="number"
                  placeholder={String(Math.max(0, 100 - totalAssignedWeight) || 25)}
                  value={draft.weight}
                  onChange={(e) => updateDraft({ weight: e.target.value })}
                />
              </div>
              <div className="form-field">
                <label>Scoring Direction</label>
                <select
                  value={draft.lowerIsBetter ? "lower" : "higher"}
                  onChange={(e) => updateDraft({ lowerIsBetter: e.target.value === "lower" })}
                >
                  <option value="higher">↑ Higher is Better (Sales/Output)</option>
                  <option value="lower">↓ Lower is Better (Defect/Cost/Time)</option>
                </select>
              </div>
              <div className="form-field">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <label style={{ marginBottom: 4 }}>Deadline (Optional)</label>
                  {draft.deadline && (
                    <button
                      type="button"
                      className="btn-link"
                      style={{ fontSize: 12 }}
                      onClick={() => updateDraft({ deadline: "" })}
                    >
                      Clear
                    </button>
                  )}
                </div>
                <input
                  type="date"
                  value={draft.deadline || ""}
                  onChange={(e) => updateDraft({ deadline: e.target.value })}
                />
              </div>
            </div>
            <button
              className="btn-primary"
              style={{ width: "auto", marginTop: 10 }}
              onClick={() => handleAddKpiToEmployee(u)}
            >
              Add Quantitative KPI
            </button>
          </div>
        )}
      </div>
    );
  }

  function renderEmployeeQualitativeSection(u: UserProfile, rawCanManage: boolean) {
    const uid = u._uid || u.userId;
    const selectedFilterMonth = empKpiFilterMonth[uid] || "ALL";
    const qual = getEmployeeQualitative(u, selectedFilterMonth);
    const br = computeAppraisalBreakdown(u, selectedFilterMonth);
    const activeEffectiveMonth = empNewCompMonth[uid] || qual.effectiveMonth || today().slice(0, 7);
    const isMonthHrFinalized = isMonthFinalized(u, activeEffectiveMonth);
    const isLockedForManager = isMonthLockedForRole(u, activeEffectiveMonth, currentProfile?.role);
    const canManage = rawCanManage && !isLockedForManager;
    const allComps = qual.competencies || [];
    const comps =
      selectedFilterMonth === "ALL"
        ? allComps
        : allComps.filter((c) => !c.effectiveMonth || c.effectiveMonth === selectedFilterMonth);

    return (
      <div className="card" style={{ marginTop: 12 }}>
        <div className="card-header" style={{ flexWrap: "wrap", gap: 10 }}>
          <div>
            <div className="card-title" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span>Segment B: Qualitative & Behavioral Evaluation ({br.qualWeight}% of Total Appraisal)</span>
              <span
                className="mono"
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  background: "#e6f4f1",
                  color: "#008272",
                  border: "1px solid #b2dfdb",
                  padding: "2px 8px",
                  borderRadius: 4,
                }}
              >
                Effective Month: {qual.effectiveMonth || activeEffectiveMonth}
              </span>
              {isMonthHrFinalized && (
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    background: "#fde7e9",
                    color: "#a4262c",
                    border: "1px solid #a4262c",
                    padding: "2px 8px",
                    borderRadius: 4,
                  }}
                >
                  🔒 HR Finalized & Locked
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
              Qualitative Score: <strong className="mono">{br.qualRawPct}%</strong> &nbsp;→&nbsp; Contributes{" "}
              <strong className="mono" style={{ color: "var(--ms-teal)" }}>
                {br.qualPoints} / {br.qualWeight} pts
              </strong>
              {qual.evaluatedBy && (
                <span>
                  {" "}
                  · Evaluated by <strong>{qual.evaluatedBy}</strong> on {qual.evaluatedAt}
                </span>
              )}
            </div>
          </div>

          {rawCanManage && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <div style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                <strong style={{ color: "var(--ms-teal)" }}>Effective Month:</strong>
                <input
                  type="month"
                  value={activeEffectiveMonth}
                  onChange={(e) => {
                    const nextM = e.target.value || today().slice(0, 7);
                    setEmpNewCompMonth((prev) => ({ ...prev, [uid]: nextM }));
                    saveEmployeeQualitative(u, { ...qual, effectiveMonth: nextM });
                  }}
                  style={{ width: "auto", padding: "3px 8px", fontSize: 12 }}
                />
              </div>

              {canManage && (
                <>
                  <button
                    type="button"
                    className={qual.mode === "competencies" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
                    style={{ width: "auto", marginTop: 0 }}
                    onClick={() =>
                      saveEmployeeQualitative(u, {
                        ...qual,
                        effectiveMonth: activeEffectiveMonth,
                        mode: "competencies",
                      })
                    }
                  >
                    1–5 Competency Rubric
                  </button>
                  <button
                    type="button"
                    className={qual.mode === "direct" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
                    style={{ width: "auto", marginTop: 0 }}
                    onClick={() =>
                      saveEmployeeQualitative(u, {
                        ...qual,
                        effectiveMonth: activeEffectiveMonth,
                        mode: "direct",
                      })
                    }
                  >
                    Direct Score Input
                  </button>
                </>
              )}
              {currentProfile?.role === "hr" && (
                <button
                  type="button"
                  className={isMonthHrFinalized ? "btn-secondary btn-sm" : "btn-danger btn-sm"}
                  style={{ width: "auto", marginTop: 0 }}
                  onClick={() =>
                    saveEmployeeQualitative(
                      u,
                      {
                        ...qual,
                        effectiveMonth: activeEffectiveMonth,
                        workflowStatus: isMonthHrFinalized ? "manager_reviewed" : "hr_approved",
                      },
                      true
                    )
                  }
                >
                  {isMonthHrFinalized
                    ? `🔓 Unlock Month (${activeEffectiveMonth})`
                    : `🔒 Finalize & Lock Month (${activeEffectiveMonth})`}
                </button>
              )}
            </div>
          )}
        </div>

        {isMonthHrFinalized && (
          <div
            className="alert alert-info"
            style={{
              marginBottom: 12,
              background: "#fde7e9",
              borderColor: "#f1707b",
              color: "#a4262c",
              fontWeight: 600,
            }}
          >
            🔒 Appraisal for Effective Month <strong>{activeEffectiveMonth}</strong> has been Finalized &amp; Approved by
            HR. Data inputs (Daily Work Log, Self-Appraisal edits, and Line Manager KPI/Qualitative edits) are locked for
            this month. {currentProfile?.role === "hr" && 'As HR, you can click "Unlock Month" above if adjustments are needed.'}
          </div>
        )}

        {/* MODE 1: BEHAVIORAL COMPETENCIES (1-5 SCALE) */}
        {qual.mode === "competencies" && (
          <div>
            {canManage && (
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 8,
                  marginBottom: 12,
                }}
              >
                <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                  Rate each behavioral competency from <strong>1 (20%)</strong> to <strong>5 (100%)</strong> for Effective Month{" "}
                  <strong className="mono" style={{ color: "var(--ms-teal)" }}>{activeEffectiveMonth}</strong>:
                </span>
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={() => handleLoadStandardCompetencies(u)}
                >
                  + Load Standard Competencies ({activeEffectiveMonth})
                </button>
              </div>
            )}

            {comps.length === 0 ? (
              <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                No behavioral competencies assigned yet.{" "}
                {canManage && 'Click "+ Load Standard Competencies" or add a custom competency below.'}
              </p>
            ) : (
              comps.map((c) => {
                const rInfo = RATING_SCALE[c.rating] || RATING_SCALE[3];
                const compMonth = c.effectiveMonth || qual.effectiveMonth || activeEffectiveMonth;
                return (
                  <div key={c.id} className="kpi-card" style={{ marginTop: 8 }}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        flexWrap: "wrap",
                        gap: 10,
                        marginBottom: 8,
                      }}
                    >
                      <div>
                        <div className="kpi-title" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                          <span>{c.title}</span>
                          <span
                            className="mono"
                            style={{
                              fontSize: 11,
                              fontWeight: 700,
                              background: "#e6f4f1",
                              color: "#008272",
                              border: "1px solid #b2dfdb",
                              padding: "1px 7px",
                              borderRadius: 4,
                            }}
                          >
                            Effective Month: {compMonth}
                          </span>
                        </div>
                        <div className="kpi-meta" style={{ color: rInfo.color, fontWeight: 600 }}>
                          Rating: {c.rating}/5 · {rInfo.shortLabel} ({rInfo.pct}%)
                        </div>
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        {canManage ? (
                          <>
                            <input
                              type="month"
                              title="Change Effective Month for this competency"
                              value={compMonth}
                              onChange={(e) => handleUpdateCompetencyEffectiveMonth(u, c.id, e.target.value)}
                              style={{ width: "auto", padding: "3px 6px", fontSize: 11 }}
                            />
                            {[1, 2, 3, 4, 5].map((star) => {
                              const isSelected = c.rating === star;
                              const sInfo = RATING_SCALE[star];
                              return (
                                <button
                                  key={star}
                                  type="button"
                                  title={sInfo.label}
                                  onClick={() => handleRateCompetency(u, c.id, star)}
                                  style={{
                                    padding: "4px 10px",
                                    fontSize: 12,
                                    fontWeight: 700,
                                    borderRadius: 4,
                                    border: isSelected ? `1px solid ${sInfo.color}` : "1px solid var(--border-default)",
                                    background: isSelected ? sInfo.color : "var(--bg-surface)",
                                    color: isSelected ? "#ffffff" : "var(--text-primary)",
                                  }}
                                >
                                  {star}
                                </button>
                              );
                            })}
                            <button className="x-btn" onClick={() => handleRemoveCompetency(u, c.id)}>
                              ✕
                            </button>
                          </>
                        ) : (
                          <span className="kpi-badge" style={{ background: "var(--neutral-4)", color: rInfo.color }}>
                            {c.rating} / 5 ({rInfo.pct}%)
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="bar-track">
                      <div
                        className={`bar-fill ${barColorClass(rInfo.pct)}`}
                        style={{ width: `${rInfo.pct}%` }}
                      />
                    </div>
                  </div>
                );
              })
            )}

            {canManage && (
              <div className="inline-row" style={{ marginTop: 12, flexWrap: "wrap", gap: 8 }}>
                <input
                  placeholder="Add custom behavioral competency (e.g. Teamwork, Leadership, Client Care)…"
                  style={{ flex: 1, minWidth: 220 }}
                  value={empNewCompTitle[uid] || ""}
                  onChange={(e) => setEmpNewCompTitle((prev) => ({ ...prev, [uid]: e.target.value }))}
                />
                <div style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                  <span style={{ fontWeight: 600, color: "var(--ms-teal)", whiteSpace: "nowrap" }}>
                    Effective Month:
                  </span>
                  <input
                    type="month"
                    value={activeEffectiveMonth}
                    onChange={(e) =>
                      setEmpNewCompMonth((prev) => ({
                        ...prev,
                        [uid]: e.target.value || today().slice(0, 7),
                      }))
                    }
                    style={{ width: "auto", padding: "5px 8px", fontSize: 12 }}
                  />
                </div>
                <button className="btn-secondary btn-sm" onClick={() => handleAddCustomCompetency(u)}>
                  Add Competency
                </button>
              </div>
            )}
          </div>
        )}

        {/* MODE 2: DIRECT QUALITATIVE SCORE INPUT */}
        {qual.mode === "direct" && (
          <div className="form-card" style={{ marginTop: 8 }}>
            <div className="card-title" style={{ marginBottom: 8 }}>
              Direct Qualitative Marks ({br.qualWeight}% Segment · Effective Month: {qual.effectiveMonth || activeEffectiveMonth})
            </div>
            <p style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 12 }}>
              Assign a direct qualitative score out of <strong>{br.qualWeight} points</strong> or as a percentage (
              <strong>0–100%</strong>) for the selected Effective Month.
            </p>
            {canManage ? (
              <div className="form-grid" style={{ maxWidth: 640 }}>
                <div className="form-field">
                  <label style={{ color: "var(--ms-teal)", fontWeight: 700 }}>
                    Effective Month
                  </label>
                  <input
                    type="month"
                    value={qual.effectiveMonth || activeEffectiveMonth}
                    onChange={(e) => {
                      const nextM = e.target.value || today().slice(0, 7);
                      setEmpNewCompMonth((prev) => ({ ...prev, [uid]: nextM }));
                      saveEmployeeQualitative(u, { ...qual, mode: "direct", effectiveMonth: nextM });
                    }}
                  />
                </div>
                <div className="form-field">
                  <label>Points out of {br.qualWeight}</label>
                  <input
                    type="number"
                    step="0.5"
                    min={0}
                    max={br.qualWeight}
                    value={Number(((qual.directScorePct * br.qualWeight) / 100).toFixed(1))}
                    onChange={(e) => {
                      const pts = Math.max(0, Math.min(br.qualWeight, Number(e.target.value) || 0));
                      const pct = br.qualWeight > 0 ? Math.round((pts / br.qualWeight) * 100) : 0;
                      saveEmployeeQualitative(u, {
                        ...qual,
                        mode: "direct",
                        effectiveMonth: qual.effectiveMonth || activeEffectiveMonth,
                        directScorePct: pct,
                      });
                    }}
                  />
                </div>
                <div className="form-field">
                  <label>Qualitative Percentage (0–100%)</label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={qual.directScorePct}
                    onChange={(e) => {
                      const pct = Math.max(0, Math.min(100, Number(e.target.value) || 0));
                      saveEmployeeQualitative(u, {
                        ...qual,
                        mode: "direct",
                        effectiveMonth: qual.effectiveMonth || activeEffectiveMonth,
                        directScorePct: pct,
                      });
                    }}
                  />
                </div>
              </div>
            ) : (
              <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: "var(--ms-teal)" }}>
                Assigned Score ({qual.effectiveMonth || activeEffectiveMonth}): {br.qualPoints} / {br.qualWeight} pts ({br.qualRawPct}%)
              </div>
            )}
          </div>
        )}

        {/* SUPERVISOR COACHING, APPRAISAL WORKFLOW & EMPLOYEE SELF-APPRAISAL */}
        <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--border-default)" }}>
          <div className="card-title" style={{ marginBottom: 10 }}>
            360° Appraisal Governance, Coaching Remarks & Sign-Off
          </div>
          {canManage ? (
            <>
              <div className="form-grid" style={{ marginBottom: 12 }}>
                <div className="form-field">
                  <label style={{ color: "var(--ms-blue-dark)", fontWeight: 700 }}>
                    Appraisal Workflow Stage
                  </label>
                  <select
                    value={qual.workflowStatus || "draft"}
                    onChange={(e) => {
                      const val = e.target.value as AppraisalWorkflowStatus;
                      const patchUser = (list: UserProfile[]) =>
                        list.map((item) =>
                          item._uid === u._uid
                            ? { ...item, qualitative: { ...qual, workflowStatus: val } }
                            : item
                        );
                      setAllUsers(patchUser);
                      setTeamUsers(patchUser);
                    }}
                  >
                    <option value="draft">1. Draft / In Progress</option>
                    <option value="self_submitted">2. Employee Self-Appraisal Submitted</option>
                    <option value="manager_reviewed">3. Line Manager Evaluated</option>
                    {currentProfile?.role === "hr" && (
                      <option value="hr_approved">4. HR Approved & Finalized (Locks Month)</option>
                    )}
                  </select>
                </div>

                <div className="form-field">
                  <label style={{ color: "var(--ms-teal)", fontWeight: 700 }}>
                    Management Appraisal Action / Recommendation
                  </label>
                  <select
                    value={qual.recommendation || "Pending Decision"}
                    onChange={(e) => {
                      const val = e.target.value;
                      const patchUser = (list: UserProfile[]) =>
                        list.map((item) =>
                          item._uid === u._uid
                            ? { ...item, qualitative: { ...qual, recommendation: val } }
                            : item
                        );
                      setAllUsers(patchUser);
                      setTeamUsers(patchUser);
                    }}
                  >
                    {APPRAISAL_RECOMMENDATIONS.map((rec) => (
                      <option key={rec} value={rec}>
                        {rec}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {qual.selfAppraisalNote && (
                <div
                  className="purpose-block"
                  style={{
                    marginBottom: 12,
                    background: "var(--ms-blue-faint)",
                    borderColor: "var(--ms-blue-light)",
                  }}
                >
                  <span className="section-label" style={{ marginBottom: 4, color: "var(--ms-blue-dark)" }}>
                    Employee Self-Appraisal Note {qual.selfSubmittedAt ? `(Submitted ${qual.selfSubmittedAt})` : ""}
                  </span>
                  <div style={{ fontSize: 13 }}>{qual.selfAppraisalNote}</div>
                </div>
              )}

              <div className="form-grid">
                <div className="form-field">
                  <label>Key Strengths & Achievements</label>
                  <textarea
                    rows={2}
                    placeholder="Highlight positive behaviors, teamwork, and strengths…"
                    value={qual.strengths || ""}
                    onChange={(e) => {
                      const val = e.target.value;
                      const patchUser = (list: UserProfile[]) =>
                        list.map((item) =>
                          item._uid === u._uid
                            ? { ...item, qualitative: { ...qual, strengths: val } }
                            : item
                        );
                      setAllUsers(patchUser);
                      setTeamUsers(patchUser);
                    }}
                  />
                </div>
                <div className="form-field">
                  <label>Areas for Growth & Improvement</label>
                  <textarea
                    rows={2}
                    placeholder="Note coaching feedback or development areas…"
                    value={qual.improvements || ""}
                    onChange={(e) => {
                      const val = e.target.value;
                      const patchUser = (list: UserProfile[]) =>
                        list.map((item) =>
                          item._uid === u._uid
                            ? { ...item, qualitative: { ...qual, improvements: val } }
                            : item
                        );
                      setAllUsers(patchUser);
                      setTeamUsers(patchUser);
                    }}
                  />
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 10, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="btn-primary btn-sm"
                  style={{ width: "auto", marginTop: 0, padding: "7px 16px" }}
                  onClick={() =>
                    saveEmployeeQualitative(
                      u,
                      { ...qual, effectiveMonth: activeEffectiveMonth },
                      true
                    )
                  }
                >
                  Save Qualitative Evaluation & Decision ({activeEffectiveMonth})
                </button>
                {qualSaveMsg[uid] && (
                  <span style={{ fontSize: 12, color: "var(--ms-green)", fontWeight: 600 }}>
                    ✓ {qualSaveMsg[uid]}
                  </span>
                )}
              </div>
            </>
          ) : (
            <div>
              <div className="form-grid" style={{ marginBottom: 14 }}>
                <div className="purpose-block">
                  <span className="section-label" style={{ marginBottom: 4 }}>
                    Key Strengths (Manager / HR Feedback)
                  </span>
                  <div>{qual.strengths || "No remarks recorded yet."}</div>
                </div>
                <div className="purpose-block">
                  <span className="section-label" style={{ marginBottom: 4 }}>
                    Areas for Growth & Coaching
                  </span>
                  <div>{qual.improvements || "No remarks recorded yet."}</div>
                </div>
              </div>

              {/* Employee Self-Appraisal & Sign-Off Box */}
              {currentProfile?.role === "employee" && currentProfile._uid === u._uid && (
                <div
                  className="form-card"
                  style={{
                    background: "var(--ms-blue-faint)",
                    borderColor: "var(--ms-blue-light)",
                  }}
                >
                  <div className="card-title" style={{ marginBottom: 6 }}>
                    My Self-Appraisal & Employee Sign-Off ({activeEffectiveMonth})
                  </div>
                  <p style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 10 }}>
                    {isMonthHrFinalized
                      ? `🔒 Appraisal for ${activeEffectiveMonth} has been Finalized by HR. Self-appraisal note editing is locked, but you may still record your final sign-off acknowledgment below.`
                      : "Share your key accomplishments, challenges, or training needs for this period, and acknowledge your appraisal review."}
                  </p>
                  <div className="form-row">
                    <label>My Accomplishments, Challenges & Support Needed</label>
                    <textarea
                      rows={2}
                      disabled={isMonthHrFinalized}
                      placeholder="Write your self-appraisal summary for your Line Manager and HR…"
                      value={qual.selfAppraisalNote || ""}
                      onChange={(e) => {
                        if (isMonthHrFinalized) return;
                        const val = e.target.value;
                        setCurrentProfile((prev) =>
                          prev
                            ? {
                                ...prev,
                                qualitative: { ...qual, selfAppraisalNote: val },
                                qualitativeByMonth: {
                                  ...(prev.qualitativeByMonth || {}),
                                  [activeEffectiveMonth]: { ...qual, selfAppraisalNote: val },
                                },
                              }
                            : prev
                        );
                      }}
                    />
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 8 }}>
                    <button
                      type="button"
                      className="btn-primary btn-sm"
                      style={{ width: "auto", marginTop: 0 }}
                      disabled={isMonthHrFinalized}
                      onClick={() =>
                        handleEmployeeSaveSelfAppraisal(qual.selfAppraisalNote || "", false, activeEffectiveMonth)
                      }
                    >
                      {isMonthHrFinalized ? "🔒 Self-Appraisal Locked" : "Submit Self-Appraisal"}
                    </button>
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      disabled={Boolean(qual.employeeAcknowledged)}
                      onClick={() =>
                        handleEmployeeSaveSelfAppraisal(qual.selfAppraisalNote || "", true, activeEffectiveMonth)
                      }
                    >
                      {qual.employeeAcknowledged
                        ? `✓ Signed Off (${qual.acknowledgedAt || ""})`
                        : "✓ Acknowledge & Sign Off Appraisal"}
                    </button>
                    {selfAppraisalMsg && (
                      <span style={{ fontSize: 12, color: "var(--ms-green)", fontWeight: 600 }}>
                        ✓ {selfAppraisalMsg}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  function renderExpandableEmployeeCard(
    u: UserProfile,
    opts: { canEditProfile: boolean; canDelete: boolean; canManageKpis: boolean }
  ) {
    const uid = u._uid || u.userId;
    const isOpen = expandedEmpUid === uid;
    const isEditing = editingProfileUid === uid;
    const isResettingPass = resettingPassUid === uid;
    const br = computeAppraisalBreakdown(u);
    const managers = allUsers.filter((m) => m.role === "manager");

    return (
      <div key={uid} className="emp-card">
        <div
          className="emp-head"
          onClick={() => {
            setExpandedEmpUid(isOpen ? null : uid);
            setEditingProfileUid(null);
            setConfirmDeleteUid(null);
            setResettingPassUid(null);
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, minWidth: 0 }}>
            <div className="emp-avatar" style={{ background: getAvatarColor(u.name) }}>
              {getInitials(u.name)}
            </div>
            <div className="emp-info">
              <div className="emp-name" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span>{u.name}</span>
                {u.resetRequestedAt && (
                  <span style={{ fontSize: 11, color: "var(--ms-red)", fontWeight: 600 }}>
                    · Password Reset Requested
                  </span>
                )}
              </div>
              <div className="emp-sub" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span>
                  {u.title || ROLE_LABELS[u.role] || u.role} · {u.dept || "—"}
                </span>
                <span>·</span>
                <span>
                  User ID: <strong className="mono" style={{ color: "var(--text-primary)" }}>{u.userId}</strong>
                </span>
                {currentProfile?.role === "hr" && (
                  <>
                    <span>·</span>
                    <span>
                      Password:{" "}
                      <strong
                        className="mono"
                        style={{
                          color: u.authSecret ? "var(--ms-blue-dark)" : "var(--text-secondary)",
                          background: "var(--ms-blue-faint)",
                          padding: "1px 6px",
                          borderRadius: 4,
                        }}
                      >
                        {u.authSecret || "Not synced"}
                      </strong>
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="emp-head-right">
            {currentProfile?.role === "hr" && (
              <button
                type="button"
                className="btn-secondary btn-sm"
                style={{ padding: "4px 10px", fontSize: 11 }}
                onClick={(e) => {
                  e.stopPropagation();
                  setExpandedEmpUid(uid);
                  setResettingPassUid(uid);
                  setHrResetNewPass(u.authSecret || "");
                  setHrResetOldPassHint("");
                  setHrResetMsg(null);
                }}
              >
                Change Password
              </button>
            )}
            {u.role === "employee" && (
              <>
                <div style={{ textAlign: "right", marginRight: 6 }}>
                  <span className="mono" style={{ fontSize: 13, color: br.band.color, fontWeight: 700 }}>
                    {br.totalScore}% · {br.band.label}
                  </span>
                  <div className="mono" style={{ fontSize: 10, color: "var(--text-secondary)" }}>
                    Quant {br.quantPoints}/{br.quantWeight} · Qual {br.qualPoints}/{br.qualWeight}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  style={{ padding: "4px 10px", fontSize: 11 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    openEmployeePerformanceDetails(u);
                  }}
                >
                  View Details
                </button>
              </>
            )}
            <span className={`role-badge role-badge-${u.role}`}>{ROLE_LABELS[u.role] || u.role}</span>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ color: "var(--text-secondary)" }}>
              <path
                d={isOpen ? "M4 10l4-4 4 4" : "M4 6l4 4 4-4"}
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        </div>

        {isOpen && (
          <div className="emp-body">
            {/* HR Credentials Box: Always visible inside expanded card for HR */}
            {currentProfile?.role === "hr" && (
              <div
                className="card"
                style={{
                  marginBottom: 14,
                  background: "var(--ms-blue-faint)",
                  borderColor: "var(--ms-blue-light)",
                  padding: "12px 16px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: 12,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap", fontSize: 13 }}>
                    <div>
                      <span style={{ color: "var(--text-secondary)", fontSize: 11, textTransform: "uppercase", fontWeight: 700 }}>
                        User ID (Username):{" "}
                      </span>
                      <strong className="mono" style={{ fontSize: 14, color: "var(--text-primary)" }}>
                        {u.userId}
                      </strong>
                    </div>
                    <div>
                      <span style={{ color: "var(--text-secondary)", fontSize: 11, textTransform: "uppercase", fontWeight: 700 }}>
                        Current Password:{" "}
                      </span>
                      <strong
                        className="mono"
                        style={{
                          fontSize: 14,
                          color: "var(--ms-blue-dark)",
                          background: "#fff",
                          padding: "2px 8px",
                          borderRadius: 4,
                          border: "1px solid var(--ms-blue-light)",
                        }}
                      >
                        {u.authSecret || "Not synced yet"}
                      </strong>
                    </div>
                    {u.passwordUpdatedAt && (
                      <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                        (Last updated: {u.passwordUpdatedAt})
                      </span>
                    )}
                  </div>

                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    onClick={() => {
                      setResettingPassUid(isResettingPass ? null : uid);
                      setHrResetNewPass("");
                      setHrResetOldPassHint("");
                      setHrResetMsg(null);
                    }}
                  >
                    {isResettingPass ? "Close Password Editor" : "Change Password"}
                  </button>
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 14, alignItems: "center" }}>
              {u.role === "employee" && (
                <button
                  type="button"
                  className="btn-primary btn-sm"
                  style={{ width: "auto", marginTop: 0 }}
                  onClick={() => openEmployeePerformanceDetails(u)}
                >
                  View Full Performance Details & Work Logs
                </button>
              )}
              {opts.canEditProfile && u.role === "employee" && !isEditing && (
                <button className="btn-link" onClick={() => startEditProfile(u)}>
                  Edit Profile
                </button>
              )}
              <button
                className="btn-link"
                onClick={() => {
                  setResettingPassUid(isResettingPass ? null : uid);
                  setHrResetNewPass("");
                  setHrResetOldPassHint("");
                  setHrResetMsg(null);
                }}
              >
                Change / Reset Password
              </button>
              {u.role === "employee" && (
                <>
                  <button
                    className="btn-link"
                    disabled={generatingPdfFor === uid}
                    onClick={() => downloadWorkLogPdf(u)}
                  >
                    {generatingPdfFor === uid ? "Generating PDF…" : "Export Monthly PDF"}
                  </button>
                  <button
                    className="btn-link"
                    disabled={generatingPdfFor === `yearly_${uid}`}
                    onClick={() => downloadYearlyAppraisalPdf(u, selectedYearForReport)}
                  >
                    {generatingPdfFor === `yearly_${uid}`
                      ? "Generating Yearly PDF…"
                      : `Export Yearly Avg PDF (${selectedYearForReport})`}
                  </button>
                </>
              )}
              {opts.canDelete && confirmDeleteUid !== uid && (
                <button className="btn-link-red" onClick={() => setConfirmDeleteUid(uid)}>
                  Delete Account
                </button>
              )}
              {opts.canDelete && confirmDeleteUid === uid && (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 12, color: "var(--ms-red)", fontWeight: 600 }}>
                    Confirm delete Firestore profile for {u.name}?
                  </span>
                  <button className="btn-danger btn-sm" onClick={() => handleDeleteEmployeeAccount(uid)}>
                    Confirm Delete
                  </button>
                  <button className="btn-ghost btn-sm" onClick={() => setConfirmDeleteUid(null)}>
                    Cancel
                  </button>
                </div>
              )}
            </div>

            {isResettingPass && (
              <div className="card" style={{ marginBottom: 14, borderColor: "var(--ms-blue-light)" }}>
                <div className="card-header">
                  <div className="card-title">Change Password for {u.name} (User ID: {u.userId})</div>
                  {u.authSecret && (
                    <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                      Current Password: <strong className="mono">{u.authSecret}</strong>
                    </span>
                  )}
                </div>
                <div className="form-grid">
                  <div className="form-field">
                    <label>New Password (min 6 chars)</label>
                    <input
                      type="text"
                      placeholder="Enter new password (e.g. welcome123)"
                      value={hrResetNewPass}
                      onChange={(e) => setHrResetNewPass(e.target.value)}
                    />
                  </div>
                  {!u.authSecret && (
                    <div className="form-field">
                      <label>Current Password (only if legacy account)</label>
                      <input
                        type="text"
                        placeholder="Optional if default 123456"
                        value={hrResetOldPassHint}
                        onChange={(e) => setHrResetOldPassHint(e.target.value)}
                      />
                    </div>
                  )}
                </div>
                {hrResetMsg && hrResetMsg.uid === uid && (
                  <div className={`alert alert-${hrResetMsg.type}`} style={{ marginTop: 12, marginBottom: 0 }}>
                    {hrResetMsg.text}
                  </div>
                )}
                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <button
                    className="btn-primary"
                    style={{ width: "auto", marginTop: 0 }}
                    onClick={() => handleHrResetUserPassword(u)}
                  >
                    Update Password
                  </button>
                  <button className="btn-ghost" onClick={() => setResettingPassUid(null)}>
                    Close
                  </button>
                </div>
              </div>
            )}

            {!isEditing ? (
              renderProfileCard(u)
            ) : (
              <div className="card">
                <div className="card-header">
                  <div className="card-title">Edit Profile</div>
                </div>
                <div className="form-grid">
                  <div className="form-field">
                    <label>Employee ID</label>
                    <input
                      value={editProfileDraft.employeeCode || ""}
                      onChange={(e) => setEditProfileDraft((p) => ({ ...p, employeeCode: e.target.value }))}
                    />
                  </div>
                  <div className="form-field">
                    <label>Job Title</label>
                    <input
                      value={editProfileDraft.title || ""}
                      onChange={(e) => setEditProfileDraft((p) => ({ ...p, title: e.target.value }))}
                    />
                  </div>
                  <div className="form-field">
                    <label>Department</label>
                    <input
                      value={editProfileDraft.dept || ""}
                      onChange={(e) => setEditProfileDraft((p) => ({ ...p, dept: e.target.value }))}
                    />
                  </div>
                  <div className="form-field">
                    <label>Factory / Office</label>
                    <select
                      value={editProfileDraft.factory || ""}
                      onChange={(e) => setEditProfileDraft((p) => ({ ...p, factory: e.target.value }))}
                    >
                      {systemSettings.offices.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="form-field">
                    <label>Line Manager</label>
                    <select
                      value={editProfileDraft.managerUserId || ""}
                      onChange={(e) => setEditProfileDraft((p) => ({ ...p, managerUserId: e.target.value }))}
                    >
                      <option value="">— Select Line Manager —</option>
                      {managers.map((m) => (
                        <option key={m.userId} value={m.userId}>
                          {m.name} ({m.userId})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="form-field">
                    <label>Appraisal Cycle</label>
                    <select
                      value={editProfileDraft.appraisalCycle || ""}
                      onChange={(e) => setEditProfileDraft((p) => ({ ...p, appraisalCycle: e.target.value }))}
                    >
                      {systemSettings.cycles.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="form-field" style={{ gridColumn: "1 / -1" }}>
                    <label>Purpose of Role</label>
                    <textarea
                      rows={2}
                      value={editProfileDraft.purpose || ""}
                      onChange={(e) => setEditProfileDraft((p) => ({ ...p, purpose: e.target.value }))}
                    />
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <button className="btn-primary" style={{ width: "auto" }} onClick={() => saveProfileEdit(uid)}>
                    Save Changes
                  </button>
                  <button className="btn-ghost" onClick={() => setEditingProfileUid(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {renderKraSection(u, opts.canEditProfile && u.role === "employee")}
            {u.role === "employee" && (
              <>
                {renderCompositeScoreStrip(u)}
                {renderEmployeeKpiSection(u, opts.canManageKpis)}
                {renderEmployeeQualitativeSection(u, opts.canManageKpis)}
              </>
            )}
          </div>
        )}
      </div>
    );
  }

  // Loading state
  if (authLoading) {
    return (
      <div id="login-screen">
        <div className="login-box">
          <div className="login-card" style={{ textAlign: "center" }}>
            <h3>Loading KPI Ledger…</h3>
            <p style={{ margin: 0 }}>Connecting to Firebase Performance Management System</p>
          </div>
        </div>
      </div>
    );
  }

  // Login / Forgot Password / Account Setup Screen
  if (!authUser || !currentProfile) {
    return (
      <div id="login-screen">
        <div className="login-box">
          <div className="login-logo">
            <div className="login-logo-icon">KL</div>
            <div className="login-logo-text">
              <span className="product-name">KPI Ledger</span>
              <span className="product-sub">Performance Management System</span>
            </div>
          </div>

          {authView === "login" && (
            <form className="login-card" onSubmit={handleLogin}>
              <h3>Sign in to your account</h3>
              {authError && <div className="alert alert-danger">{authError}</div>}
              <div className="form-row">
                <label htmlFor="login-userid">User ID</label>
                <input
                  id="login-userid"
                  autoComplete="username"
                  placeholder="e.g. admin"
                  value={loginUserId}
                  onChange={(e) => setLoginUserId(e.target.value)}
                />
              </div>
              <div className="form-row">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <label htmlFor="login-password">Password</label>
                  <button
                    type="button"
                    className="btn-link"
                    style={{ fontSize: 12, marginBottom: 6 }}
                    onClick={() => {
                      setAuthView("forgot");
                      setForgotUserId(loginUserId);
                      setForgotStatus(null);
                    }}
                  >
                    Forgot password?
                  </button>
                </div>
                <input
                  id="login-password"
                  type="password"
                  autoComplete="current-password"
                  placeholder="••••••••"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                />
              </div>
              {loginErr && <div className="error-text">{loginErr}</div>}
              <button type="submit" className="btn-primary">
                Sign In
              </button>
            </form>
          )}

          {authView === "forgot" && (
            <form className="login-card" onSubmit={handleForgotPasswordSubmit}>
              <h3>Reset Your Password</h3>
              <p style={{ fontSize: 13, marginBottom: 16 }}>
                Verify your account with your Department, Employee ID, or Full Name to set a new password.
              </p>
              <div className="form-row">
                <label>User ID</label>
                <input
                  placeholder="e.g. rahim123"
                  value={forgotUserId}
                  onChange={(e) => setForgotUserId(e.target.value)}
                />
              </div>
              <div className="form-row">
                <label>Verification (Department, Employee ID, or Full Name)</label>
                <input
                  placeholder="e.g. Sales or EMP-1001"
                  value={forgotVerify}
                  onChange={(e) => setForgotVerify(e.target.value)}
                />
              </div>
              <div className="form-row">
                <label>Previous Password (optional if already synced)</label>
                <input
                  type="password"
                  placeholder="Leave blank if forgotten"
                  value={forgotOldPass}
                  onChange={(e) => setForgotOldPass(e.target.value)}
                />
              </div>
              <div className="form-row">
                <label>New Password (min 6 characters)</label>
                <input
                  type="password"
                  placeholder="••••••••"
                  value={forgotNewPass}
                  onChange={(e) => setForgotNewPass(e.target.value)}
                />
              </div>
              <div className="form-row">
                <label>Confirm New Password</label>
                <input
                  type="password"
                  placeholder="••••••••"
                  value={forgotConfirmPass}
                  onChange={(e) => setForgotConfirmPass(e.target.value)}
                />
              </div>
              <button type="submit" className="btn-primary">
                Reset Password
              </button>
              {forgotStatus && (
                <div className={`alert alert-${forgotStatus.type}`} style={{ marginTop: 14, marginBottom: 0 }}>
                  {forgotStatus.text}
                </div>
              )}
              <div style={{ marginTop: 16, textAlign: "center" }}>
                <button type="button" className="btn-link" onClick={() => setAuthView("login")}>
                  ← Back to Sign In
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    );
  }

  const tabs = TABS_BY_ROLE[currentProfile.role] || TABS_BY_ROLE.employee;
  const employeesOnly = allUsers.filter((u) => u.role === "employee");
  const managersOnly = allUsers.filter((u) => u.role === "manager");
  const resetRequests = allUsers.filter((u) => Boolean(u.resetRequestedAt));
  const availableDepartments = Array.from(
    new Set(employeesOnly.map((e) => (e.dept || "").trim()).filter(Boolean))
  ).sort();
  const rankedEmployees = employeesOnly
    .filter((emp) =>
      hrReportDept === "ALL"
        ? true
        : (emp.dept || "").trim().toLowerCase() === hrReportDept.trim().toLowerCase()
    )
    .map((emp) => {
      if (hrReportPeriodMode === "year") {
        const yr = computeYearlyAppraisalSummary(emp, hrReportYear);
        const baseBr = computeAppraisalBreakdown(emp);
        const br = {
          ...baseBr,
          quantPoints: yr.avgQuantPoints,
          quantRawPct: yr.avgQuantRawPct,
          qualPoints: yr.avgQualPoints,
          qualRawPct: yr.avgQualRawPct,
          totalScore: yr.avgTotalScore,
          band: yr.band,
        };
        return { ...emp, breakdown: br, performanceScore: yr.avgTotalScore };
      }
      const br = computeAppraisalBreakdown(emp, hrReportMonth || undefined);
      return { ...emp, breakdown: br, performanceScore: br.totalScore };
    })
    .sort((a, b) => b.performanceScore - a.performanceScore || b.breakdown.quantPoints - a.breakdown.quantPoints);

  const rankedTeamEmployees = teamUsers
    .map((emp) => {
      const br = computeAppraisalBreakdown(emp);
      return { ...emp, breakdown: br, performanceScore: br.totalScore };
    })
    .sort((a, b) => b.performanceScore - a.performanceScore);

  const detailEmp: UserProfile | null = detailEmpUid
    ? [...allUsers, ...teamUsers].find((u) => (u._uid || u.userId) === detailEmpUid) || null
    : null;

  const filteredDetailLogs =
    detailFilterMode === "all"
      ? detailAllLogs
      : detailAllLogs.filter((l) => l.date && l.date.startsWith(detailMonth));

  const renderBellCurveAndCharts = (
    empList: Array<UserProfile & { breakdown: ReturnType<typeof computeAppraisalBreakdown>; performanceScore: number }>,
    scopeTitle: string,
    options?: { highlightUser?: UserProfile; isEmployeeSelfView?: boolean; showDeptChart?: boolean }
  ) => {
    const total = empList.length;
    const scores = empList.map((e) => e.performanceScore);
    const meanScore = total > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / total) : 0;
    const maxScore = total > 0 ? Math.max(...scores) : 0;
    const variance =
      total > 0
        ? scores.reduce((acc, s) => acc + Math.pow(s - meanScore, 2), 0) / total
        : 0;
    const stdDev = Math.round(Math.sqrt(variance) * 10) / 10;

    // 5-Bucket HR Performance Bell Curve
    const bellBuckets = [
      {
        id: "b1",
        range: "< 50%",
        label: "Needs Improvement",
        shortLabel: "Needs Imp.",
        idealPct: 10,
        color: "#a4262c",
        bg: "#fde7e9",
        emps: empList.filter((e) => e.performanceScore < 50),
      },
      {
        id: "b2",
        range: "50% – 64%",
        label: "Developing (Good)",
        shortLabel: "Developing",
        idealPct: 20,
        color: "#ca5010",
        bg: "#fff4ce",
        emps: empList.filter((e) => e.performanceScore >= 50 && e.performanceScore < 65),
      },
      {
        id: "b3",
        range: "65% – 79%",
        label: "Core Good Performer",
        shortLabel: "Core Good",
        idealPct: 40,
        color: "#0078d4",
        bg: "#eff6fc",
        emps: empList.filter((e) => e.performanceScore >= 65 && e.performanceScore < 80),
      },
      {
        id: "b4",
        range: "80% – 89%",
        label: "Excellent (High)",
        shortLabel: "Excellent",
        idealPct: 20,
        color: "#008272",
        bg: "#e6f4f1",
        emps: empList.filter((e) => e.performanceScore >= 80 && e.performanceScore < 90),
      },
      {
        id: "b5",
        range: "90% – 100%",
        label: "Role Model (Top)",
        shortLabel: "Top Star",
        idealPct: 10,
        color: "#107c10",
        bg: "#dff6dd",
        emps: empList.filter((e) => e.performanceScore >= 90),
      },
    ].map((b) => ({
      ...b,
      count: b.emps.length,
      actualPct: total > 0 ? Math.round((b.emps.length / total) * 100) : 0,
    }));

    // SVG coordinate geometry for Bell Curve (660 x 230)
    const svgW = 660;
    const svgH = 230;
    const padL = 44;
    const padR = 24;
    const padT = 28;
    const padB = 46;
    const plotW = svgW - padL - padR;
    const plotH = svgH - padT - padB;
    const colW = plotW / 5;

    const bucketCenters = bellBuckets.map((_, idx) => padL + colW * idx + colW / 2);
    const maxScalePct = Math.max(50, ...bellBuckets.map((b) => b.actualPct), 45);
    const yForPct = (pct: number) => padT + plotH - (Math.min(pct, maxScalePct) / maxScalePct) * plotH;

    // Smooth Ideal Gaussian curve across plotW
    const idealPoints: Array<[number, number]> = [];
    const steps = 48;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = padL + t * plotW;
      const z = (t - 0.5) / 0.21;
      const pct = 40 * Math.exp(-0.5 * z * z);
      idealPoints.push([x, yForPct(pct)]);
    }
    const idealCurvePath = idealPoints
      .map((pt, i) => `${i === 0 ? "M" : "L"} ${pt[0].toFixed(1)} ${pt[1].toFixed(1)}`)
      .join(" ");
    const idealAreaPath = `${idealCurvePath} L ${(padL + plotW).toFixed(1)} ${(padT + plotH).toFixed(1)} L ${padL.toFixed(1)} ${(padT + plotH).toFixed(1)} Z`;

    const actualCoords = bellBuckets.map((b, i) => ({
      x: bucketCenters[i],
      y: yForPct(b.actualPct),
      pct: b.actualPct,
      count: b.count,
      color: b.color,
    }));

    let actualSmoothPath = "";
    if (actualCoords.length > 0) {
      actualSmoothPath = `M ${actualCoords[0].x.toFixed(1)} ${actualCoords[0].y.toFixed(1)}`;
      for (let i = 0; i < actualCoords.length - 1; i++) {
        const p0 = actualCoords[i];
        const p1 = actualCoords[i + 1];
        const midX = ((p0.x + p1.x) / 2).toFixed(1);
        actualSmoothPath += ` C ${midX} ${p0.y.toFixed(1)}, ${midX} ${p1.y.toFixed(1)}, ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
      }
    }

    const selfScore = options?.highlightUser
      ? computeAppraisalBreakdown(options.highlightUser).totalScore
      : null;
    const selfBucketIdx =
      selfScore === null
        ? -1
        : selfScore < 50
        ? 0
        : selfScore < 65
        ? 1
        : selfScore < 80
        ? 2
        : selfScore < 90
        ? 3
        : 4;

    const excCount = empList.filter((e) => e.performanceScore >= 80).length;
    const goodCount = empList.filter((e) => e.performanceScore >= 50 && e.performanceScore < 80).length;
    const lowCount = empList.filter((e) => e.performanceScore < 50).length;
    const excPct = total > 0 ? Math.round((excCount / total) * 100) : 0;
    const goodPct = total > 0 ? Math.round((goodCount / total) * 100) : 0;
    const lowPct = total > 0 ? Math.max(0, 100 - excPct - goodPct) : 0;

    const r = 52;
    const circ = 2 * Math.PI * r;
    const excArc = (excPct / 100) * circ;
    const goodArc = (goodPct / 100) * circ;
    const lowArc = (lowPct / 100) * circ;

    const deptStats = Array.from(
      new Set(empList.map((e) => (e.dept || "Unassigned").trim() || "Unassigned"))
    )
      .map((d) => {
        const members = empList.filter(
          (e) => ((e.dept || "Unassigned").trim() || "Unassigned") === d
        );
        const avg =
          members.length > 0
            ? Math.round(members.reduce((s, m) => s + m.performanceScore, 0) / members.length)
            : 0;
        const avgQuant =
          members.length > 0
            ? Math.round(
                (members.reduce((s, m) => s + m.breakdown.quantPoints, 0) / members.length) * 10
              ) / 10
            : 0;
        const avgQual =
          members.length > 0
            ? Math.round(
                (members.reduce((s, m) => s + m.breakdown.qualPoints, 0) / members.length) * 10
              ) / 10
            : 0;
        return { dept: d, count: members.length, avg, avgQuant, avgQual };
      })
      .sort((a, b) => b.avg - a.avg);

    return (
      <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 18 }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
            gap: 16,
          }}
        >
          {/* BELL CURVE CARD */}
          <div className="card" style={{ marginBottom: 0 }}>
            <div className="card-header" style={{ flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
              <div>
                <div className="card-title" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span>Performance Bell Curve (Normal Distribution)</span>
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      padding: "2px 7px",
                      borderRadius: 3,
                      background: "var(--ms-blue-faint)",
                      color: "var(--ms-blue)",
                    }}
                  >
                    {scopeTitle}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>
                  Compares actual employee score distribution against the standard HR Bell Curve (10% · 20% · 40% · 20% · 10%)
                </div>
              </div>

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", fontSize: 11 }}>
                <span
                  style={{
                    background: "var(--bg-overlay)",
                    padding: "3px 8px",
                    borderRadius: 3,
                    border: "1px solid var(--border-default)",
                  }}
                >
                  Mean (μ): <strong className="mono" style={{ color: "var(--ms-blue)" }}>{meanScore}%</strong>
                </span>
                <span
                  style={{
                    background: "var(--bg-overlay)",
                    padding: "3px 8px",
                    borderRadius: 3,
                    border: "1px solid var(--border-default)",
                  }}
                >
                  Top: <strong className="mono" style={{ color: "#107c10" }}>{maxScore}%</strong>
                </span>
                <span
                  style={{
                    background: "var(--bg-overlay)",
                    padding: "3px 8px",
                    borderRadius: 3,
                    border: "1px solid var(--border-default)",
                  }}
                >
                  Std Dev (σ): <strong className="mono">{stdDev}</strong>
                </span>
              </div>
            </div>

            <div
              style={{
                background: "#faf9f8",
                border: "1px solid var(--border-subtle)",
                borderRadius: "var(--radius-md)",
                padding: "10px 8px 6px 8px",
              }}
            >
              <svg
                viewBox={`0 0 ${svgW} ${svgH}`}
                style={{ width: "100%", height: "auto", display: "block", overflow: "visible" }}
              >
                <defs>
                  <linearGradient id="bellIdealGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#0078d4" stopOpacity="0.20" />
                    <stop offset="100%" stopColor="#0078d4" stopOpacity="0.02" />
                  </linearGradient>
                </defs>

                {[0, 20, 40, 60].filter((v) => v <= maxScalePct).map((pctVal) => {
                  const y = yForPct(pctVal);
                  return (
                    <g key={pctVal}>
                      <line
                        x1={padL}
                        y1={y}
                        x2={svgW - padR}
                        y2={y}
                        stroke="#edebe9"
                        strokeWidth="1"
                      />
                      <text
                        x={padL - 6}
                        y={y + 3}
                        textAnchor="end"
                        fontSize="10"
                        fill="#605e5c"
                        fontFamily="IBM Plex Mono, monospace"
                      >
                        {pctVal}%
                      </text>
                    </g>
                  );
                })}

                <path d={idealAreaPath} fill="url(#bellIdealGrad)" />
                <path
                  d={idealCurvePath}
                  fill="none"
                  stroke="#0078d4"
                  strokeWidth="2"
                  strokeDasharray="5 4"
                  opacity="0.75"
                />

                {bellBuckets.map((b, idx) => {
                  const barW = Math.min(54, colW * 0.48);
                  const cx = bucketCenters[idx];
                  const bx = cx - barW / 2;
                  const by = yForPct(b.actualPct);
                  const bh = Math.max(3, padT + plotH - by);
                  const isSelfBucket = idx === selfBucketIdx;

                  return (
                    <g key={b.id}>
                      {isSelfBucket && (
                        <rect
                          x={padL + idx * colW + 4}
                          y={padT - 6}
                          width={colW - 8}
                          height={plotH + 10}
                          rx="5"
                          fill="#0078d4"
                          fillOpacity="0.08"
                          stroke="#0078d4"
                          strokeWidth="1.2"
                          strokeDasharray="3 2"
                        />
                      )}

                      <rect
                        x={bx}
                        y={by}
                        width={barW}
                        height={bh}
                        rx="4"
                        fill={b.color}
                        fillOpacity="0.86"
                      />

                      <text
                        x={cx}
                        y={by - 7}
                        textAnchor="middle"
                        fontSize="10.5"
                        fontWeight="700"
                        fill={b.color}
                        fontFamily="IBM Plex Mono, monospace"
                      >
                        {b.count} ({b.actualPct}%)
                      </text>

                      <text
                        x={cx}
                        y={padT + plotH + 15}
                        textAnchor="middle"
                        fontSize="10.5"
                        fontWeight="700"
                        fill="#201f1e"
                      >
                        {b.range}
                      </text>
                      <text
                        x={cx}
                        y={padT + plotH + 28}
                        textAnchor="middle"
                        fontSize="9.5"
                        fill="#605e5c"
                      >
                        {b.shortLabel} (Ideal {b.idealPct}%)
                      </text>

                      {isSelfBucket && (
                        <text
                          x={cx}
                          y={padT + 10}
                          textAnchor="middle"
                          fontSize="9.5"
                          fontWeight="700"
                          fill="#0078d4"
                        >
                          ★ YOU ({selfScore}%)
                        </text>
                      )}
                    </g>
                  );
                })}

                {actualSmoothPath && (
                  <path
                    d={actualSmoothPath}
                    fill="none"
                    stroke="#201f1e"
                    strokeWidth="2.2"
                  />
                )}
                {actualCoords.map((pt, idx) => (
                  <circle
                    key={idx}
                    cx={pt.x}
                    cy={pt.y}
                    r="4"
                    fill="#ffffff"
                    stroke={pt.color}
                    strokeWidth="2.5"
                  />
                ))}
              </svg>

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 10,
                  marginTop: 6,
                  paddingTop: 6,
                  borderTop: "1px solid var(--border-subtle)",
                  fontSize: 11,
                  color: "var(--text-secondary)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                    <span
                      style={{
                        width: 18,
                        height: 0,
                        borderTop: "2px dashed #0078d4",
                        display: "inline-block",
                      }}
                    />
                    Ideal Normal Curve (10-20-40-20-10%)
                  </span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                    <span
                      style={{
                        width: 18,
                        height: 2,
                        background: "#201f1e",
                        display: "inline-block",
                      }}
                    />
                    Actual Score Curve ({total} Employees)
                  </span>
                </div>
                {!options?.isEmployeeSelfView && (
                  <span>Click any employee below to view full details</span>
                )}
              </div>
            </div>

            {!options?.isEmployeeSelfView && total > 0 && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
                  gap: 6,
                  marginTop: 10,
                }}
              >
                {bellBuckets.map((b) => (
                  <div
                    key={b.id}
                    style={{
                      background: b.bg,
                      border: `1px solid ${b.color}`,
                      borderRadius: 4,
                      padding: "6px 7px",
                      minHeight: 54,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        color: b.color,
                        marginBottom: 4,
                        display: "flex",
                        justifyContent: "space-between",
                      }}
                    >
                      <span>{b.range}</span>
                      <span className="mono">{b.count}</span>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                      {b.emps.length === 0 ? (
                        <span style={{ fontSize: 10, color: "var(--text-muted)" }}>None</span>
                      ) : (
                        b.emps.slice(0, 4).map((e) => (
                          <span
                            key={e._uid || e.userId}
                            onClick={() => openEmployeePerformanceDetails(e)}
                            title={`${e.name} (${e.performanceScore}%)`}
                            style={{
                              fontSize: 10,
                              background: "#fff",
                              color: "var(--text-primary)",
                              padding: "1px 5px",
                              borderRadius: 3,
                              border: "1px solid var(--border-default)",
                              cursor: "pointer",
                              fontWeight: 600,
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              maxWidth: "100%",
                            }}
                          >
                            {e.name.split(" ")[0]} ({e.performanceScore}%)
                          </span>
                        ))
                      )}
                      {b.emps.length > 4 && (
                        <span style={{ fontSize: 9, color: b.color, fontWeight: 700 }}>
                          +{b.emps.length - 4} more
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* RIGHT CARD: PERFORMANCE STATUS DONUT + DEPARTMENT / 80-20 ANALYTICS */}
          <div className="card" style={{ marginBottom: 0, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
            <div>
              <div className="card-header" style={{ marginBottom: 10 }}>
                <div>
                  <div className="card-title">Performance Band & Score Breakdown</div>
                  <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>
                    Distribution across Excellent (80%+), Good (50–79%), and Needs Improvement (&lt;50%)
                  </div>
                </div>
              </div>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 20,
                  flexWrap: "wrap",
                  padding: "10px 12px",
                  background: "#faf9f8",
                  borderRadius: "var(--radius-md)",
                  border: "1px solid var(--border-subtle)",
                }}
              >
                <div style={{ position: "relative", width: 132, height: 132, flexShrink: 0, margin: "0 auto" }}>
                  <svg viewBox="0 0 132 132" style={{ width: 132, height: 132, transform: "rotate(-90deg)" }}>
                    <circle
                      cx="66"
                      cy="66"
                      r={r}
                      fill="none"
                      stroke="#edebe9"
                      strokeWidth="16"
                    />
                    {total > 0 && (
                      <>
                        <circle
                          cx="66"
                          cy="66"
                          r={r}
                          fill="none"
                          stroke="#107c10"
                          strokeWidth="16"
                          strokeDasharray={`${excArc} ${circ}`}
                          strokeDashoffset={0}
                        />
                        <circle
                          cx="66"
                          cy="66"
                          r={r}
                          fill="none"
                          stroke="#0078d4"
                          strokeWidth="16"
                          strokeDasharray={`${goodArc} ${circ}`}
                          strokeDashoffset={-excArc}
                        />
                        <circle
                          cx="66"
                          cy="66"
                          r={r}
                          fill="none"
                          stroke="#a4262c"
                          strokeWidth="16"
                          strokeDasharray={`${lowArc} ${circ}`}
                          strokeDashoffset={-(excArc + goodArc)}
                        />
                      </>
                    )}
                  </svg>
                  <div
                    style={{
                      position: "absolute",
                      top: 0,
                      right: 0,
                      bottom: 0,
                      left: 0,
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "center",
                      textAlign: "center",
                    }}
                  >
                    <div className="mono" style={{ fontSize: 20, fontWeight: 700, color: "var(--text-primary)", lineHeight: 1.1 }}>
                      {meanScore}%
                    </div>
                    <div style={{ fontSize: 10, color: "var(--text-secondary)", fontWeight: 600 }}>
                      AVG SCORE
                    </div>
                  </div>
                </div>

                <div style={{ flex: 1, minWidth: 180, display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12 }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 600, color: "#107c10" }}>
                      <span style={{ width: 10, height: 10, borderRadius: 2, background: "#107c10", display: "inline-block" }} />
                      Excellent (80% – 100%)
                    </span>
                    <strong className="mono">
                      {excCount} ({excPct}%)
                    </strong>
                  </div>
                  <div className="bar-track" style={{ height: 6 }}>
                    <div className="bar-fill" style={{ width: `${excPct}%`, background: "#107c10" }} />
                  </div>

                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12 }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 600, color: "#0078d4" }}>
                      <span style={{ width: 10, height: 10, borderRadius: 2, background: "#0078d4", display: "inline-block" }} />
                      Good (50% – 79%)
                    </span>
                    <strong className="mono">
                      {goodCount} ({goodPct}%)
                    </strong>
                  </div>
                  <div className="bar-track" style={{ height: 6 }}>
                    <div className="bar-fill" style={{ width: `${goodPct}%`, background: "#0078d4" }} />
                  </div>

                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12 }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 600, color: "#a4262c" }}>
                      <span style={{ width: 10, height: 10, borderRadius: 2, background: "#a4262c", display: "inline-block" }} />
                      Needs Improvement (&lt; 50%)
                    </span>
                    <strong className="mono">
                      {lowCount} ({lowPct}%)
                    </strong>
                  </div>
                  <div className="bar-track" style={{ height: 6 }}>
                    <div className="bar-fill" style={{ width: `${lowPct}%`, background: "#a4262c" }} />
                  </div>
                </div>
              </div>

              {options?.showDeptChart && deptStats.length > 0 && (
                <div style={{ marginTop: 14 }}>
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      textTransform: "uppercase",
                      color: "var(--text-secondary)",
                      marginBottom: 8,
                      letterSpacing: "0.04em",
                    }}
                  >
                    Department-wise Average Score Breakdown ({deptStats.length} Depts)
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {deptStats.map((d) => {
                      const band = getPerformanceBand(d.avg);
                      const qWidth = Math.min(80, d.avgQuant);
                      const qlWidth = Math.min(20, d.avgQual);
                      return (
                        <div key={d.dept} style={{ fontSize: 12 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                            <span style={{ fontWeight: 600 }}>
                              {d.dept}{" "}
                              <span style={{ color: "var(--text-secondary)", fontWeight: 400 }}>
                                ({d.count} emp)
                              </span>
                            </span>
                            <span className="mono" style={{ fontWeight: 700, color: band.color }}>
                              {d.avg}% ({d.avgQuant}/80 + {d.avgQual}/20)
                            </span>
                          </div>
                          <div
                            style={{
                              height: 9,
                              background: "#edebe9",
                              borderRadius: 4,
                              overflow: "hidden",
                              display: "flex",
                            }}
                          >
                            <div
                              title={`Avg Quantitative: ${d.avgQuant}/80`}
                              style={{ width: `${qWidth}%`, background: "#0078d4", height: "100%" }}
                            />
                            <div
                              title={`Avg Qualitative: ${d.avgQual}/20`}
                              style={{ width: `${qlWidth}%`, background: "#008272", height: "100%" }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {!options?.isEmployeeSelfView && empList.length > 0 && (
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border-subtle)" }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: 8,
                    flexWrap: "wrap",
                    gap: 6,
                  }}
                >
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      textTransform: "uppercase",
                      color: "var(--text-secondary)",
                      letterSpacing: "0.04em",
                    }}
                  >
                    80/20 Quantitative vs Qualitative Score Graph
                  </span>
                  <div style={{ display: "flex", gap: 10, fontSize: 10 }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      <span style={{ width: 8, height: 8, background: "#0078d4", display: "inline-block", borderRadius: 2 }} />
                      Quantitative (80)
                    </span>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      <span style={{ width: 8, height: 8, background: "#008272", display: "inline-block", borderRadius: 2 }} />
                      Qualitative (20)
                    </span>
                  </div>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 7, maxHeight: 190, overflowY: "auto", paddingRight: 4 }}>
                  {empList.slice(0, 8).map((emp, idx) => {
                    const qPts = emp.breakdown.quantPoints;
                    const qlPts = emp.breakdown.qualPoints;
                    return (
                      <div
                        key={emp._uid || emp.userId}
                        onClick={() => openEmployeePerformanceDetails(emp)}
                        style={{ cursor: "pointer", fontSize: 11 }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                          <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>
                            #{idx + 1} {emp.name}{" "}
                            <span style={{ color: "var(--text-secondary)", fontWeight: 400 }}>
                              ({emp.dept || "—"})
                            </span>
                          </span>
                          <span className="mono" style={{ fontWeight: 700, color: emp.breakdown.band.color }}>
                            {qPts} + {qlPts} = {emp.performanceScore}%
                          </span>
                        </div>
                        <div
                          style={{
                            position: "relative",
                            height: 8,
                            background: "#edebe9",
                            borderRadius: 4,
                            overflow: "hidden",
                            display: "flex",
                          }}
                        >
                          <div style={{ width: `${Math.min(80, qPts)}%`, background: "#0078d4", height: "100%" }} />
                          <div style={{ width: `${Math.min(20, qlPts)}%`, background: "#008272", height: "100%" }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div id="app-shell">
      <header className="app-header">
        <div className="brand">
          <div className="brand-icon">KL</div>
          <span>KPI Ledger</span>
        </div>
        <div className="header-right">
          <div className="who">
            <span className="who-name">{currentProfile.name}</span>
            <span style={{ opacity: 0.6 }}>·</span>
            <span>{ROLE_LABELS[currentProfile.role] || currentProfile.role}</span>
          </div>
          <button
            className="btn-logout"
            onClick={() => {
              setSelfOldPass("");
              setSelfNewPass("");
              setSelfConfirmPass("");
              setSelfPassMsg(null);
              setShowChangePassModal(true);
            }}
          >
            Change Password
          </button>
          <button className="btn-logout" onClick={() => signOut(auth)}>
            Sign Out
          </button>
        </div>
      </header>

      {/* Self Change Password Modal */}
      {showChangePassModal && (
        <div className="modal-backdrop" onClick={() => setShowChangePassModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="card-header" style={{ marginBottom: 12 }}>
              <div className="card-title" style={{ fontSize: 16 }}>
                Change My Password
              </div>
              <button className="x-btn" onClick={() => setShowChangePassModal(false)}>
                ✕
              </button>
            </div>
            <p style={{ fontSize: 13, marginBottom: 16 }}>
              Update the password for account <strong>{currentProfile.userId}</strong>.
            </p>
            <form onSubmit={handleSelfChangePassword}>
              <div className="form-row">
                <label>Current Password</label>
                <input
                  type="password"
                  value={selfOldPass}
                  onChange={(e) => setSelfOldPass(e.target.value)}
                  placeholder="Enter current password"
                />
              </div>
              <div className="form-row">
                <label>New Password (min 6 characters)</label>
                <input
                  type="password"
                  value={selfNewPass}
                  onChange={(e) => setSelfNewPass(e.target.value)}
                  placeholder="Enter new password"
                />
              </div>
              <div className="form-row">
                <label>Confirm New Password</label>
                <input
                  type="password"
                  value={selfConfirmPass}
                  onChange={(e) => setSelfConfirmPass(e.target.value)}
                  placeholder="Re-enter new password"
                />
              </div>
              {selfPassMsg && (
                <div className={`alert alert-${selfPassMsg.type}`} style={{ marginBottom: 12 }}>
                  {selfPassMsg.text}
                </div>
              )}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
                <button type="button" className="btn-ghost" onClick={() => setShowChangePassModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn-primary" style={{ width: "auto", marginTop: 0 }}>
                  Update Password
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* HR / Line Manager: Employee Performance Details & Work Log Inspector Modal */}
      {detailEmp && (() => {
        const activeDetailMonth = detailFilterMode === "month" ? detailMonth : undefined;
        const br = computeAppraisalBreakdown(detailEmp, activeDetailMonth);
        const qual = getEmployeeQualitative(detailEmp, activeDetailMonth);
        const kpis = filterKpisByEffectiveMonth(detailEmp.kpis || [], activeDetailMonth);
        const kras = detailEmp.kras || [];
        const empKey = detailEmp._uid || detailEmp.userId;
        const totalActivityEntries = filteredDetailLogs.reduce(
          (sum, l) => sum + (l.entries ? l.entries.length : 0),
          0
        );

        return (
          <div className="modal-backdrop" onClick={() => setDetailEmpUid(null)}>
            <div className="modal-card-wide" onClick={(e) => e.stopPropagation()}>
              {/* Top Dossier Header */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  flexWrap: "wrap",
                  gap: 12,
                  paddingBottom: 14,
                  borderBottom: "2px solid var(--ms-blue)",
                  marginBottom: 16,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div
                    className="emp-avatar"
                    style={{
                      width: 44,
                      height: 44,
                      fontSize: 16,
                      background: getAvatarColor(detailEmp.name),
                    }}
                  >
                    {getInitials(detailEmp.name)}
                  </div>
                  <div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)" }}>
                      {detailEmp.name}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                      {detailEmp.title || "Employee"} · Dept: <strong>{detailEmp.dept || "—"}</strong> · User ID:{" "}
                      <strong className="mono">{detailEmp.userId}</strong> (Code: {detailEmp.employeeCode || "—"})
                    </div>
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    onClick={() => {
                      setDetailEmpUid(null);
                      setActiveTab(currentProfile.role === "hr" ? "hr" : "team");
                      setExpandedEmpUid(empKey);
                    }}
                  >
                    Edit KPIs & Qualitative Score
                  </button>
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    onClick={() =>
                      downloadMonthlyCsvReport(
                        detailEmp,
                        filteredDetailLogs,
                        detailFilterMode === "all" ? "All" : detailMonth
                      )
                    }
                  >
                    Export Work Log CSV
                  </button>
                  <button
                    type="button"
                    className="btn-primary btn-sm"
                    style={{ width: "auto", marginTop: 0 }}
                    disabled={generatingPdfFor === empKey}
                    onClick={() =>
                      downloadWorkLogPdf(
                        detailEmp,
                        detailFilterMode === "all" ? "all" : detailMonth
                      )
                    }
                  >
                    {generatingPdfFor === empKey ? "Generating PDF…" : "Monthly PDF Report"}
                  </button>
                  <button
                    type="button"
                    className="btn-primary btn-sm"
                    style={{ width: "auto", marginTop: 0, background: "var(--ms-teal)" }}
                    disabled={generatingPdfFor === `yearly_${empKey}`}
                    onClick={() =>
                      downloadYearlyAppraisalPdf(
                        detailEmp,
                        (detailMonth || today().slice(0, 7)).slice(0, 4)
                      )
                    }
                  >
                    {generatingPdfFor === `yearly_${empKey}`
                      ? "Generating Yearly PDF…"
                      : `Yearly Avg PDF (${(detailMonth || today()).slice(0, 4)})`}
                  </button>
                  <button
                    type="button"
                    className="btn-ghost btn-sm"
                    onClick={() => setDetailEmpUid(null)}
                  >
                    ✕ Close
                  </button>
                </div>
              </div>

              {/* Executive 3-Card Appraisal Summary */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                  gap: 12,
                  marginBottom: 16,
                }}
              >
                <div
                  style={{
                    background: "var(--ms-blue-faint)",
                    border: "1px solid var(--ms-blue-light)",
                    borderRadius: "var(--radius-md)",
                    padding: "12px 14px",
                  }}
                >
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--ms-blue-dark)" }}>
                    Segment A · Quantitative ({br.quantWeight}%)
                  </div>
                  <div className="mono" style={{ fontSize: 22, fontWeight: 700, color: "var(--ms-blue)", marginTop: 4 }}>
                    {br.quantPoints} <span style={{ fontSize: 13, fontWeight: 500 }}>/ {br.quantWeight} pts</span>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
                    Raw KPI Achievement: <strong className="mono">{br.quantRawPct}%</strong> ({kpis.length} KPIs)
                  </div>
                </div>

                <div
                  style={{
                    background: "var(--bg-overlay)",
                    border: "1px solid var(--border-default)",
                    borderRadius: "var(--radius-md)",
                    padding: "12px 14px",
                  }}
                >
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--ms-teal)" }}>
                    Segment B · Qualitative ({br.qualWeight}%)
                  </div>
                  <div className="mono" style={{ fontSize: 22, fontWeight: 700, color: "var(--ms-teal)", marginTop: 4 }}>
                    {br.qualPoints} <span style={{ fontSize: 13, fontWeight: 500 }}>/ {br.qualWeight} pts</span>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
                    Behavioral Score: <strong className="mono">{br.qualRawPct}%</strong>{" "}
                    {qual.evaluatedBy ? `· by ${qual.evaluatedBy}` : "· Pending evaluation"}
                  </div>
                </div>

                <div
                  style={{
                    background: br.band.bg,
                    border: `1px solid ${br.band.color}`,
                    borderRadius: "var(--radius-md)",
                    padding: "12px 14px",
                  }}
                >
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: br.band.color }}>
                    Final Appraisal Score (100%)
                  </div>
                  <div className="mono" style={{ fontSize: 24, fontWeight: 700, color: br.band.color, marginTop: 4 }}>
                    {br.totalScore}%
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: br.band.color, marginTop: 2 }}>
                    {br.band.label}
                  </div>
                </div>
              </div>

              {/* Section 1: Quantitative KPIs Table */}
              <div className="card" style={{ marginBottom: 14 }}>
                <div className="card-header">
                  <div className="card-title">
                    1. Segment A — Quantitative KPIs Breakdown ({br.quantWeight}% Weight)
                  </div>
                  <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: "var(--ms-blue)" }}>
                    {br.quantPoints} / {br.quantWeight} pts
                  </span>
                </div>
                {kpis.length === 0 ? (
                  <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0 }}>
                    No Quantitative KPIs assigned to this employee yet.
                  </p>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table>
                      <thead>
                        <tr>
                          <th>KPI Metric</th>
                          <th style={{ width: 110 }}>Effective Month</th>
                          <th style={{ width: 90 }}>Frequency</th>
                          <th style={{ width: 95 }}>Target</th>
                          <th style={{ width: 95 }}>Achieved</th>
                          <th style={{ width: 75 }}>Weight</th>
                          <th style={{ width: 130 }}>Deadline</th>
                          <th style={{ width: 150 }}>Progress</th>
                          <th style={{ width: 120 }}>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {kpis.map((k) => {
                          const pct = Math.round(kpiPercent(k));
                          const dl = getDeadlineStatus(k);
                          return (
                            <tr key={k.id}>
                              <td style={{ fontWeight: 600 }}>{k.title}</td>
                              <td className="mono" style={{ fontWeight: 700, color: "var(--ms-blue-dark)" }}>
                                {k.effectiveMonth || "All Months"}
                              </td>
                              <td>{k.frequency || "Monthly"}</td>
                              <td className="mono">{fmtVal(k.target, k.unit)}</td>
                              <td className="mono" style={{ fontWeight: 700 }}>
                                {fmtVal(k.current || 0, k.unit)}
                              </td>
                              <td className="mono">{k.weight}%</td>
                              <td>
                                {dl ? (
                                  <div>
                                    <div className="mono" style={{ fontSize: 12 }}>
                                      {dl.date}
                                    </div>
                                    <div style={{ fontSize: 10, fontWeight: 700, color: dl.color }}>
                                      {dl.label}
                                    </div>
                                  </div>
                                ) : (
                                  <span style={{ color: "var(--text-disabled)" }}>—</span>
                                )}
                              </td>
                              <td>
                                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                  <div className="bar-track" style={{ flex: 1, margin: 0 }}>
                                    <div
                                      className={`bar-fill ${barColorClass(pct)}`}
                                      style={{ width: `${Math.min(pct, 100)}%` }}
                                    />
                                  </div>
                                  <span className="mono" style={{ fontSize: 12, fontWeight: 700, minWidth: 36 }}>
                                    {pct}%
                                  </span>
                                </div>
                              </td>
                              <td>
                                <KpiBadge pct={pct} />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Section 2: Qualitative & Behavioral Evaluation */}
              <div className="card" style={{ marginBottom: 14 }}>
                <div className="card-header">
                  <div className="card-title">
                    2. Segment B — Qualitative & Behavioral Competency Evaluation ({br.qualWeight}% Weight)
                  </div>
                  <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: "var(--ms-teal)" }}>
                    {br.qualPoints} / {br.qualWeight} pts
                  </span>
                </div>

                {qual.mode === "competencies" ? (
                  qual.competencies.length === 0 ? (
                    <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0 }}>
                      No behavioral competencies rated yet.
                    </p>
                  ) : (
                    <div style={{ overflowX: "auto" }}>
                      <table>
                        <thead>
                          <tr>
                            <th>Behavioral Competency</th>
                            <th style={{ width: 120 }}>Effective Month</th>
                            <th style={{ width: 100 }}>Rating (1–5)</th>
                            <th style={{ width: 100 }}>Score %</th>
                            <th style={{ width: 160 }}>Evaluation Level</th>
                          </tr>
                        </thead>
                        <tbody>
                          {qual.competencies
                            .filter((c) => !activeDetailMonth || !c.effectiveMonth || c.effectiveMonth === activeDetailMonth)
                            .map((c) => {
                              const rInfo = RATING_SCALE[c.rating] || RATING_SCALE[3];
                              return (
                                <tr key={c.id}>
                                  <td style={{ fontWeight: 600 }}>{c.title}</td>
                                  <td className="mono" style={{ fontWeight: 700, color: "var(--ms-teal)" }}>
                                    {c.effectiveMonth || qual.effectiveMonth || "All Months"}
                                  </td>
                                  <td className="mono" style={{ fontWeight: 700 }}>
                                    {c.rating} / 5
                                  </td>
                                  <td className="mono">{rInfo.pct}%</td>
                                  <td style={{ fontWeight: 700, color: rInfo.color }}>{rInfo.shortLabel}</td>
                                </tr>
                              );
                            })}
                        </tbody>
                      </table>
                    </div>
                  )
                ) : (
                  <div className="purpose-block">
                    Direct Qualitative Score Assigned:{" "}
                    <strong className="mono" style={{ color: "var(--ms-teal)" }}>
                      {br.qualPoints} / {br.qualWeight} pts ({br.qualRawPct}%)
                    </strong>
                  </div>
                )}

                {(qual.strengths || qual.improvements) && (
                  <div className="form-grid" style={{ marginTop: 12 }}>
                    <div className="purpose-block">
                      <span className="section-label" style={{ color: "var(--ms-green)", marginBottom: 4 }}>
                        Key Strengths & Achievements
                      </span>
                      <div>{qual.strengths || "—"}</div>
                    </div>
                    <div className="purpose-block">
                      <span className="section-label" style={{ color: "var(--ms-orange)", marginBottom: 4 }}>
                        Areas for Growth & Coaching
                      </span>
                      <div>{qual.improvements || "—"}</div>
                    </div>
                  </div>
                )}
              </div>

              {/* Section 3: Daily Work Report & Activity Log History */}
              <div className="card" style={{ marginBottom: 14 }}>
                <div className="card-header" style={{ flexWrap: "wrap", gap: 10 }}>
                  <div>
                    <div className="card-title">
                      3. Daily Work Activity Reports ({filteredDetailLogs.length} Logged Day
                      {filteredDetailLogs.length === 1 ? "" : "s"} · {totalActivityEntries} KPI Entries)
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
                      Displays both Work Date (Activity Date) and System Log Date (Submission Timestamp)
                    </div>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      className={detailFilterMode === "all" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
                      style={{ width: "auto", marginTop: 0 }}
                      onClick={() => setDetailFilterMode("all")}
                    >
                      All Logs ({detailAllLogs.length})
                    </button>
                    <button
                      type="button"
                      className={detailFilterMode === "month" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
                      style={{ width: "auto", marginTop: 0 }}
                      onClick={() => setDetailFilterMode("month")}
                    >
                      Filter by Month
                    </button>
                    {detailFilterMode === "month" && (
                      <input
                        type="month"
                        style={{ width: "auto", padding: "4px 8px", fontSize: 12 }}
                        value={detailMonth}
                        onChange={(e) => setDetailMonth(e.target.value)}
                      />
                    )}
                  </div>
                </div>

                {loadingDetailLogs ? (
                  <div className="alert alert-info" style={{ marginBottom: 0 }}>
                    Loading employee daily work reports…
                  </div>
                ) : filteredDetailLogs.length === 0 ? (
                  <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0 }}>
                    No daily work reports found for {detailFilterMode === "all" ? "this employee" : detailMonth}.
                  </p>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table>
                      <thead>
                        <tr>
                          <th style={{ width: 110 }}>Work Date</th>
                          <th style={{ width: 110 }}>Log Date</th>
                          <th style={{ width: 190 }}>KPI Metric</th>
                          <th style={{ width: 110 }}>Output</th>
                          <th>Work Summary / Accomplishments</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredDetailLogs.map((log) => {
                          const logDateStr = getLogDate(log);
                          return (log.entries || []).map((e, idx) => (
                            <tr key={`${log.date}_${idx}`}>
                              {idx === 0 && (
                                <>
                                  <td
                                    rowSpan={log.entries.length}
                                    className="mono"
                                    style={{
                                      fontWeight: 700,
                                      verticalAlign: "top",
                                      borderRight: "1px solid var(--border-default)",
                                    }}
                                  >
                                    {log.date}
                                  </td>
                                  <td
                                    rowSpan={log.entries.length}
                                    className="mono"
                                    style={{
                                      color: "var(--text-secondary)",
                                      verticalAlign: "top",
                                      borderRight: "1px solid var(--border-default)",
                                    }}
                                  >
                                    {logDateStr}
                                  </td>
                                </>
                              )}
                              <td style={{ fontWeight: 600 }}>{e.kpiTitle}</td>
                              <td className="mono" style={{ fontWeight: 600, color: "var(--ms-blue)" }}>
                                {e.quantity > 0 ? `+${e.quantity} ${e.unit}` : "—"}
                              </td>
                              <td style={{ color: "var(--text-secondary)", whiteSpace: "pre-wrap" }}>{e.notes || "—"}</td>
                            </tr>
                          ));
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Section 4: Role Profile & KRAs */}
              <div className="card" style={{ marginBottom: 0 }}>
                <div className="card-header">
                  <div className="card-title">4. Role Profile & Key Result Areas (KRAs)</div>
                </div>
                <div className="profile-grid" style={{ marginBottom: 10 }}>
                  <div className="profile-field">
                    <span>Factory / Office</span>
                    <strong>{detailEmp.factory || "—"}</strong>
                  </div>
                  <div className="profile-field">
                    <span>Line Manager</span>
                    <strong>{detailEmp.managerUserId || "—"}</strong>
                  </div>
                  <div className="profile-field">
                    <span>Appraisal Cycle</span>
                    <strong>{detailEmp.appraisalCycle || "—"}</strong>
                  </div>
                </div>
                {detailEmp.purpose && (
                  <div style={{ marginBottom: 10 }}>
                    <span className="section-label">Purpose of Role</span>
                    <div className="purpose-block">{detailEmp.purpose}</div>
                  </div>
                )}
                {kras.length > 0 && (
                  <div>
                    <span className="section-label">Assigned KRAs ({kras.length})</span>
                    {kras.map((k, ki) => (
                      <div key={k.id} className="kra-item">
                        <div className="kra-title-row">
                          <span>
                            {ki + 1}. {k.title}
                          </span>
                        </div>
                        {(k.objectives || []).map((o, oi) => (
                          <div key={o.id} className="kra-obj">
                            <span>
                              {ki + 1}
                              {String.fromCharCode(97 + oi)}. {o.text}
                            </span>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      <div className="subnav-bar" id="tab-nav">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={activeTab === t.id ? "active" : ""}
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <main className="app-main">
        {/* ================= DASHBOARD ================= */}
        {activeTab === "dashboard" && (
          <div className="tab-panel">
            <div className="welcome-strip">
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 12,
                }}
              >
                <div>
                  <h2>Good day, {currentProfile.name.split(" ")[0]}</h2>
                  <p>Welcome to KPI Ledger — Dual-Segment Quantitative & Qualitative Performance Management System.</p>
                </div>
                {currentProfile.role === "employee" && (
                  <div>
                    <button
                      className="btn-secondary btn-sm"
                      disabled={generatingPdfFor === (currentProfile._uid || currentProfile.userId)}
                      onClick={() => downloadWorkLogPdf(currentProfile)}
                    >
                      {generatingPdfFor === (currentProfile._uid || currentProfile.userId)
                        ? "Generating PDF…"
                        : "Download My Performance Report"}
                    </button>
                  </div>
                )}
              </div>
            </div>

            {currentProfile.role === "hr" && resetRequests.length > 0 && (
              <div className="alert alert-warning" style={{ justifyContent: "space-between", alignItems: "center" }}>
                <span>
                  <strong>Password Reset Requests ({resetRequests.length}):</strong>{" "}
                  {resetRequests.map((r) => `${r.name} (${r.userId})`).join(", ")} requested a password reset.
                </span>
                <button className="btn-secondary btn-sm" onClick={() => setActiveTab("hr")}>
                  Open All Accounts →
                </button>
              </div>
            )}

            {/* Employee Dashboard */}
            {currentProfile.role === "employee" && (() => {
              const kpis = currentProfile.kpis || [];
              const kras = currentProfile.kras || [];
              const br = computeAppraisalBreakdown(currentProfile);
              const peerPool =
                employeesOnly.length > 0
                  ? employeesOnly.map((emp) => {
                      const b = computeAppraisalBreakdown(emp);
                      return { ...emp, breakdown: b, performanceScore: b.totalScore };
                    })
                  : [{ ...currentProfile, breakdown: br, performanceScore: br.totalScore }];

              return (
                <>
                  {/* Compact Role Profile Strip at Top of Dashboard */}
                  <div className="card" style={{ marginBottom: 16, padding: "14px 16px" }}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        flexWrap: "wrap",
                        gap: 10,
                        marginBottom: currentProfile.purpose || kras.length > 0 ? 10 : 0,
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                        <div
                          className="emp-avatar"
                          style={{
                            width: 36,
                            height: 36,
                            fontSize: 13,
                            background: getAvatarColor(currentProfile.name),
                          }}
                        >
                          {getInitials(currentProfile.name)}
                        </div>
                        <div>
                          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>
                            {currentProfile.name}{" "}
                            <span style={{ fontWeight: 500, fontSize: 12, color: "var(--text-secondary)" }}>
                              ({currentProfile.title || "Employee"})
                            </span>
                          </div>
                          <div style={{ fontSize: 12, color: "var(--text-secondary)", display: "flex", gap: 10, flexWrap: "wrap", marginTop: 2 }}>
                            <span>User ID: <strong className="mono">{currentProfile.userId}</strong></span>
                            <span>·</span>
                            <span>Emp ID: <strong>{currentProfile.employeeCode || "—"}</strong></span>
                            <span>·</span>
                            <span>Dept: <strong>{currentProfile.dept || "—"}</strong></span>
                            <span>·</span>
                            <span>Office: <strong>{currentProfile.factory || "—"}</strong></span>
                            <span>·</span>
                            <span>Line Manager: <strong>{currentProfile.managerUserId || "—"}</strong></span>
                            <span>·</span>
                            <span>Cycle: <strong>{currentProfile.appraisalCycle || "—"}</strong></span>
                          </div>
                        </div>
                      </div>
                    </div>

                    {(currentProfile.purpose || kras.length > 0) && (
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
                          gap: 10,
                          paddingTop: 10,
                          borderTop: "1px solid var(--border-subtle)",
                          fontSize: 12,
                        }}
                      >
                        <div>
                          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--text-secondary)", marginBottom: 3 }}>
                            Job Purpose
                          </div>
                          <div style={{ color: "var(--text-primary)", lineHeight: 1.45 }}>
                            {currentProfile.purpose || "Not specified."}
                          </div>
                        </div>

                        <div>
                          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--text-secondary)", marginBottom: 3 }}>
                            Key Result Areas (KRAs · {kras.length})
                          </div>
                          {kras.length === 0 ? (
                            <div style={{ color: "var(--text-secondary)" }}>No KRAs assigned yet.</div>
                          ) : (
                            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                              {kras.map((kra, idx) => (
                                <div key={kra.id} style={{ color: "var(--text-primary)" }}>
                                  <strong>{idx + 1}. {kra.title}</strong>
                                  {kra.objectives && kra.objectives.length > 0 && (
                                    <span style={{ color: "var(--text-secondary)" }}>
                                      {" "}— {kra.objectives.map((o) => o.text).join("; ")}
                                    </span>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="stat-grid">
                    <div className="stat-chip">
                      <div className="stat-chip-value" style={{ color: br.band.color }}>
                        {br.totalScore}%
                      </div>
                      <div className="stat-chip-label">
                        Total Score · {br.band.label}
                      </div>
                    </div>
                    <div className="stat-chip">
                      <div className="stat-chip-value" style={{ color: "var(--ms-blue)" }}>
                        {br.quantPoints}/80
                      </div>
                      <div className="stat-chip-label">Quantitative (80%)</div>
                    </div>
                    <div className="stat-chip">
                      <div className="stat-chip-value" style={{ color: "var(--ms-teal)" }}>
                        {br.qualPoints}/20
                      </div>
                      <div className="stat-chip-label">Qualitative (20%)</div>
                    </div>
                    <div className="stat-chip">
                      <div className="stat-chip-value">{kpis.length}</div>
                      <div className="stat-chip-label">Assigned KPIs</div>
                    </div>
                  </div>

                  <div
                    style={{
                      marginTop: 20,
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
                      gap: 16,
                    }}
                  >
                    <div className="card" style={{ marginBottom: 0 }}>
                      <div className="card-header">
                        <div className="card-title">My Performance Summary (80% Quantitative + 20% Qualitative)</div>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                        <div style={{ fontSize: 13 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                            <span>Segment A: Quantitative KPIs (80%)</span>
                            <strong className="mono">
                              {br.quantPoints} / 80 pts ({br.quantRawPct}%)
                            </strong>
                          </div>
                          <div className="bar-track">
                            <div
                              className="bar-fill bar-green"
                              style={{
                                width: `${Math.min(100, br.quantRawPct)}%`,
                                background: "var(--ms-blue)",
                              }}
                            />
                          </div>
                        </div>

                        <div style={{ fontSize: 13 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                            <span>Segment B: Qualitative Competencies (20%)</span>
                            <strong className="mono">
                              {br.qualPoints} / 20 pts ({br.qualRawPct}%)
                            </strong>
                          </div>
                          <div className="bar-track">
                            <div
                              className="bar-fill"
                              style={{
                                width: `${Math.min(100, br.qualRawPct)}%`,
                                background: "var(--ms-teal)",
                              }}
                            />
                          </div>
                        </div>

                        <div style={{ paddingTop: 6, display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <button
                            className="btn-primary"
                            style={{ width: "auto", marginTop: 0 }}
                            onClick={() => setActiveTab("worklog")}
                          >
                            Submit Daily Work Log
                          </button>
                          <button
                            className="btn-secondary"
                            style={{ width: "auto" }}
                            onClick={() => setActiveTab("mykpis")}
                          >
                            View My KPIs & Appraisal
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* KPI-wise Achievement Visual Bar Graph */}
                    <div className="card" style={{ marginBottom: 0 }}>
                      <div className="card-header">
                        <div>
                          <div className="card-title">My KPI Achievement Graph</div>
                          <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>
                            Individual KPI progress against assigned targets
                          </div>
                        </div>
                      </div>
                      {kpis.length === 0 ? (
                        <div style={{ fontSize: 12, color: "var(--text-secondary)", padding: "12px 0" }}>
                          No Quantitative KPIs assigned yet.
                        </div>
                      ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                          {kpis.map((k) => {
                            const pct = Math.round(kpiPercent(k));
                            const band = getPerformanceBand(pct);
                            return (
                              <div key={k.id} style={{ fontSize: 12 }}>
                                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                                  <span style={{ fontWeight: 600 }}>
                                    {k.title}{" "}
                                    <span style={{ color: "var(--text-secondary)", fontWeight: 400 }}>
                                      (Wt: {k.weight || 0}%)
                                    </span>
                                  </span>
                                  <span className="mono" style={{ fontWeight: 700, color: band.color }}>
                                    {k.current}/{k.target} {k.unit} ({pct}%)
                                  </span>
                                </div>
                                <div className="bar-track" style={{ height: 8 }}>
                                  <div
                                    className="bar-fill"
                                    style={{ width: `${Math.min(100, pct)}%`, background: band.color }}
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Employee Bell Curve Position */}
                  {renderBellCurveAndCharts(peerPool, "My Position on Bell Curve", {
                    highlightUser: currentProfile,
                    isEmployeeSelfView: true,
                    showDeptChart: false,
                  })}
                </>
              );
            })()}

            {/* HR Dashboard */}
            {currentProfile.role === "hr" && (
              <>
                <div className="stat-grid">
                  <div className="stat-chip">
                    <div className="stat-chip-value">{employeesOnly.length}</div>
                    <div className="stat-chip-label">Total Employees</div>
                  </div>
                  <div className="stat-chip">
                    <div className="stat-chip-value">{managersOnly.length}</div>
                    <div className="stat-chip-label">Line Managers</div>
                  </div>
                  <div className="stat-chip">
                    <div className="stat-chip-value">
                      {rankedEmployees.length > 0
                        ? Math.round(
                            rankedEmployees.reduce((s, e) => s + e.performanceScore, 0) /
                              rankedEmployees.length
                          )
                        : 0}
                      %
                    </div>
                    <div className="stat-chip-label">
                      Avg Score ({hrReportDept === "ALL" ? "All Depts" : hrReportDept})
                    </div>
                  </div>
                  <div className="stat-chip">
                    <div className="stat-chip-value">80 / 20</div>
                    <div className="stat-chip-label">Quant / Qual Split</div>
                  </div>
                </div>

                {/* Executive Bell Curve + Department & 80/20 Graphs */}
                {renderBellCurveAndCharts(
                  rankedEmployees,
                  hrReportDept === "ALL" ? "All Departments" : hrReportDept,
                  { showDeptChart: true }
                )}

                <div style={{ marginTop: 20 }}>
                  <div className="card">
                    <div className="card-header" style={{ flexWrap: "wrap", gap: 14, alignItems: "flex-end" }}>
                      <div>
                        <div className="card-title">
                          Department-wise Best Employee & Performance Ranking
                        </div>
                        <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
                          Select Department and Month to view the #1 Best Employee, rank-wise leaderboard, and download the official PDF Ranking Report.
                        </div>
                      </div>

                      {/* Department + Period Mode (Monthly / Yearly Avg) + PDF Download Controls */}
                      <div
                        style={{
                          display: "flex",
                          alignItems: "flex-end",
                          gap: 10,
                          flexWrap: "wrap",
                          background: "var(--bg-overlay)",
                          padding: "10px 12px",
                          borderRadius: "var(--radius-md)",
                          border: "1px solid var(--border-default)",
                        }}
                      >
                        <div>
                          <label style={{ fontSize: 11, marginBottom: 3, display: "block" }}>Department</label>
                          <select
                            value={hrReportDept}
                            onChange={(e) => setHrReportDept(e.target.value)}
                            style={{ width: "auto", minWidth: 155, padding: "5px 10px", fontSize: 12 }}
                          >
                            <option value="ALL">All Departments ({employeesOnly.length})</option>
                            {availableDepartments.map((d) => (
                              <option key={d} value={d}>
                                {d}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div>
                          <label style={{ fontSize: 11, marginBottom: 3, display: "block" }}>Ranking Mode</label>
                          <select
                            value={hrReportPeriodMode}
                            onChange={(e) => setHrReportPeriodMode(e.target.value as "month" | "year")}
                            style={{ width: "auto", padding: "5px 10px", fontSize: 12 }}
                          >
                            <option value="month">Monthly Ranking</option>
                            <option value="year">Yearly Average Ranking</option>
                          </select>
                        </div>

                        {hrReportPeriodMode === "month" ? (
                          <div>
                            <label style={{ fontSize: 11, marginBottom: 3, display: "block" }}>Evaluation Month</label>
                            <input
                              type="month"
                              value={hrReportMonth}
                              onChange={(e) => setHrReportMonth(e.target.value)}
                              style={{ width: "auto", padding: "4px 10px", fontSize: 12 }}
                            />
                          </div>
                        ) : (
                          <div>
                            <label style={{ fontSize: 11, marginBottom: 3, display: "block" }}>Appraisal Year</label>
                            <select
                              value={hrReportYear}
                              onChange={(e) => setHrReportYear(e.target.value)}
                              style={{ width: "auto", padding: "5px 10px", fontSize: 12 }}
                            >
                              {[
                                String(Number(today().slice(0, 4)) - 1),
                                today().slice(0, 4),
                                String(Number(today().slice(0, 4)) + 1),
                              ].map((yr) => (
                                <option key={yr} value={yr}>
                                  {yr} (Annual Avg)
                                </option>
                              ))}
                            </select>
                          </div>
                        )}

                        <button
                          type="button"
                          className="btn-primary btn-sm"
                          style={{ width: "auto", marginTop: 0, padding: "7px 14px" }}
                          disabled={generatingDeptPdf}
                          onClick={() =>
                            downloadDepartmentRankingPdf(
                              hrReportDept,
                              hrReportPeriodMode === "year" ? hrReportYear : hrReportMonth,
                              hrReportPeriodMode
                            )
                          }
                        >
                          {generatingDeptPdf
                            ? "Generating Ranking PDF…"
                            : hrReportPeriodMode === "year"
                            ? `Download Yearly Best Employee PDF (${hrReportYear})`
                            : "Download Best Employee & Ranking PDF"}
                        </button>
                      </div>
                    </div>

                    {/* Rank #1 Best Employee Spotlight Banner */}
                    {rankedEmployees.length > 0 && (() => {
                      const best = rankedEmployees[0];
                      return (
                        <div
                          style={{
                            marginTop: 12,
                            marginBottom: 14,
                            padding: "12px 16px",
                            borderRadius: "var(--radius-md)",
                            background: "linear-gradient(135deg, var(--ms-blue-faint) 0%, #ffffff 100%)",
                            border: "1px solid var(--ms-blue)",
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            flexWrap: "wrap",
                            gap: 12,
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                            <div
                              style={{
                                background: "var(--ms-blue)",
                                color: "#fff",
                                fontWeight: 700,
                                fontSize: 12,
                                padding: "6px 10px",
                                borderRadius: "var(--radius-sm)",
                                textAlign: "center",
                                lineHeight: 1.2,
                              }}
                            >
                              <div>RANK #1</div>
                              <div style={{ fontSize: 9, letterSpacing: "0.05em" }}>BEST</div>
                            </div>
                            <div>
                              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>
                                {best.name}{" "}
                                <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-secondary)" }}>
                                  ({best.title || "Employee"} · {best.dept || "—"})
                                </span>
                              </div>
                              <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
                                Best Employee in{" "}
                                <strong>{hrReportDept === "ALL" ? "All Departments" : hrReportDept}</strong> · User ID:{" "}
                                <strong className="mono">{best.userId}</strong> · Quantitative:{" "}
                                <strong className="mono">{best.breakdown.quantPoints}/80</strong> · Qualitative:{" "}
                                <strong className="mono">{best.breakdown.qualPoints}/20</strong>
                              </div>
                            </div>
                          </div>

                          <div style={{ textAlign: "right" }}>
                            <div
                              className="mono"
                              style={{ fontSize: 22, fontWeight: 700, color: best.breakdown.band.color }}
                            >
                              {best.breakdown.totalScore}%
                            </div>
                            <div style={{ fontSize: 11, fontWeight: 700, color: best.breakdown.band.color }}>
                              {best.breakdown.band.label}
                            </div>
                          </div>
                        </div>
                      );
                    })()}

                    <div style={{ overflowX: "auto", marginTop: 10 }}>
                      <table>
                        <thead>
                          <tr>
                            <th style={{ width: 75 }}>Rank</th>
                            <th>Employee</th>
                            <th>Department</th>
                            <th>Quantitative (80%)</th>
                            <th>Qualitative (20%)</th>
                            <th>Total Score</th>
                            <th>Status</th>
                            <th style={{ textAlign: "right" }}>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rankedEmployees.length === 0 ? (
                            <tr>
                              <td colSpan={8} style={{ textAlign: "center", color: "var(--text-secondary)" }}>
                                No employee accounts found for this department.
                              </td>
                            </tr>
                          ) : (
                            rankedEmployees.map((emp, idx) => {
                              const br = emp.breakdown;
                              const empKey = emp._uid || emp.userId;
                              return (
                                <tr
                                  key={empKey}
                                  style={idx === 0 ? { background: "var(--ms-blue-faint)" } : undefined}
                                >
                                  <td className="mono" style={{ fontWeight: 700, color: "var(--ms-blue)" }}>
                                    #{idx + 1}
                                    {idx === 0 && (
                                      <span
                                        style={{
                                          marginLeft: 6,
                                          fontSize: 9,
                                          background: "var(--ms-blue)",
                                          color: "#fff",
                                          padding: "2px 5px",
                                          borderRadius: 3,
                                          verticalAlign: "middle",
                                        }}
                                      >
                                        BEST
                                      </span>
                                    )}
                                  </td>
                                  <td>
                                    <div
                                      style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
                                      onClick={() => openEmployeePerformanceDetails(emp)}
                                      title="Click to view full performance details"
                                    >
                                      <div className="emp-avatar" style={{ background: getAvatarColor(emp.name) }}>
                                        {getInitials(emp.name)}
                                      </div>
                                      <div>
                                        <div style={{ fontWeight: 600, color: "var(--ms-blue)" }}>{emp.name}</div>
                                        <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                                          {emp.userId}
                                        </div>
                                      </div>
                                    </div>
                                  </td>
                                  <td>{emp.dept || "—"}</td>
                                  <td className="mono">
                                    <strong>{br.quantPoints}</strong> / 80
                                  </td>
                                  <td className="mono">
                                    <strong>{br.qualPoints}</strong> / 20
                                  </td>
                                  <td
                                    className="mono"
                                    style={{ fontSize: 14, fontWeight: 700, color: br.band.color }}
                                  >
                                    {br.totalScore}%
                                  </td>
                                  <td>
                                    <KpiBadge pct={br.totalScore} />
                                  </td>
                                  <td style={{ textAlign: "right" }}>
                                    <div style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                                      <button
                                        className="btn-primary btn-sm"
                                        style={{ width: "auto", marginTop: 0 }}
                                        onClick={() => openEmployeePerformanceDetails(emp)}
                                      >
                                        View Details
                                      </button>
                                      <button
                                        className="btn-secondary btn-sm"
                                        onClick={() => {
                                          setActiveTab("hr");
                                          setExpandedEmpUid(empKey);
                                        }}
                                      >
                                        Evaluate
                                      </button>
                                      <button
                                        className="btn-secondary btn-sm"
                                        disabled={generatingPdfFor === empKey}
                                        onClick={() => downloadWorkLogPdf(emp)}
                                      >
                                        {generatingPdfFor === empKey ? "PDF…" : "PDF Report"}
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                              );
                            })
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </>
            )}

            {/* Line Manager Dashboard */}
            {currentProfile.role === "manager" && (
              <>
                <div className="stat-grid">
                  <div className="stat-chip">
                    <div className="stat-chip-value">{teamUsers.length}</div>
                    <div className="stat-chip-label">Direct Reports</div>
                  </div>
                  <div className="stat-chip">
                    <div className="stat-chip-value">
                      {teamUsers.length > 0
                        ? Math.round(
                            teamUsers.reduce(
                              (acc, u) => acc + computeAppraisalBreakdown(u).totalScore,
                              0
                            ) / teamUsers.length
                          )
                        : 0}
                      %
                    </div>
                    <div className="stat-chip-label">Avg Team Score</div>
                  </div>
                </div>

                {/* Line Manager Team Bell Curve & Analytics */}
                {renderBellCurveAndCharts(rankedTeamEmployees, "My Direct Reports", {
                  showDeptChart: true,
                })}

                <div className="card" style={{ marginTop: 20 }}>
                  <div className="card-header" style={{ flexWrap: "wrap", gap: 12 }}>
                    <div>
                      <div className="card-title">My Team Performance & Appraisal Overview</div>
                      <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
                        View detailed KPI progress, daily work activity reports, and evaluate Qualitative competencies
                        for your direct reports.
                      </div>
                    </div>
                    <button className="btn-secondary btn-sm" onClick={() => setActiveTab("team")}>
                      Open My Team Editor →
                    </button>
                  </div>

                  <div style={{ overflowX: "auto", marginTop: 10 }}>
                    <table>
                      <thead>
                        <tr>
                          <th style={{ width: 55 }}>Rank</th>
                          <th>Team Member</th>
                          <th>Department</th>
                          <th>Quantitative (80%)</th>
                          <th>Qualitative (20%)</th>
                          <th>Total Score</th>
                          <th>Status</th>
                          <th style={{ textAlign: "right" }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rankedTeamEmployees.length === 0 ? (
                          <tr>
                            <td colSpan={8} style={{ textAlign: "center", color: "var(--text-secondary)" }}>
                              No direct reports assigned to you yet.
                            </td>
                          </tr>
                        ) : (
                          rankedTeamEmployees.map((emp, idx) => {
                            const br = emp.breakdown;
                            const empKey = emp._uid || emp.userId;
                            return (
                              <tr key={empKey}>
                                <td className="mono" style={{ fontWeight: 700, color: "var(--ms-blue)" }}>
                                  #{idx + 1}
                                </td>
                                <td>
                                  <div
                                    style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
                                    onClick={() => openEmployeePerformanceDetails(emp)}
                                  >
                                    <div className="emp-avatar" style={{ background: getAvatarColor(emp.name) }}>
                                      {getInitials(emp.name)}
                                    </div>
                                    <div>
                                      <div style={{ fontWeight: 600, color: "var(--ms-blue)" }}>{emp.name}</div>
                                      <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>{emp.userId}</div>
                                    </div>
                                  </div>
                                </td>
                                <td>{emp.dept || "—"}</td>
                                <td className="mono">
                                  <strong>{br.quantPoints}</strong> / 80
                                </td>
                                <td className="mono">
                                  <strong>{br.qualPoints}</strong> / 20
                                </td>
                                <td
                                  className="mono"
                                  style={{ fontSize: 14, fontWeight: 700, color: br.band.color }}
                                >
                                  {br.totalScore}%
                                </td>
                                <td>
                                  <KpiBadge pct={br.totalScore} />
                                </td>
                                <td style={{ textAlign: "right" }}>
                                  <div style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                                    <button
                                      className="btn-primary btn-sm"
                                      style={{ width: "auto", marginTop: 0 }}
                                      onClick={() => openEmployeePerformanceDetails(emp)}
                                    >
                                      View Details
                                    </button>
                                    <button
                                      className="btn-secondary btn-sm"
                                      onClick={() => {
                                        setActiveTab("team");
                                        setExpandedEmpUid(empKey);
                                      }}
                                    >
                                      Evaluate
                                    </button>
                                    <button
                                      className="btn-secondary btn-sm"
                                      disabled={generatingPdfFor === empKey}
                                      onClick={() => downloadWorkLogPdf(emp)}
                                    >
                                      {generatingPdfFor === empKey ? "PDF…" : "PDF Report"}
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* ================= HR: ALL ACCOUNTS ================= */}
        {activeTab === "hr" && (
          <div className="tab-panel">
            <div className="page-header">
              <div>
                <div className="page-title">All Accounts & PMS Quality Control ({allUsers.length})</div>
                <div className="page-sub">
                  Search, filter, audit KPI weight compliance, manage Quantitative KPIs (80%), and finalize Qualitative Evaluations (20%)
                </div>
              </div>
              <button
                className="btn-primary btn-sm"
                style={{ width: "auto", marginTop: 0 }}
                onClick={() => setActiveTab("create_account")}
              >
                + Create New Account
              </button>
            </div>

            {/* PMS Governance & Quality Control Audit Strip */}
            {(() => {
              const totalEmps = employeesOnly.length;
              const withKpisCount = employeesOnly.filter((e) => (e.kpis || []).length > 0).length;
              const weight100Count = employeesOnly.filter(
                (e) => (e.kpis || []).reduce((s, k) => s + (Number(k.weight) || 0), 0) === 100
              ).length;
              const qualEvalCount = employeesOnly.filter((e) => computeAppraisalBreakdown(e).isQualEvaluated).length;
              const hrFinalizedCount = employeesOnly.filter(
                (e) => e.qualitative?.workflowStatus === "hr_approved"
              ).length;

              return (
                <div className="stat-grid" style={{ marginBottom: 14 }}>
                  <div className="stat-chip" onClick={() => setHrFilterPmsAudit("MISSING_KPIS")} style={{ cursor: "pointer" }}>
                    <div className="stat-chip-value" style={{ color: withKpisCount === totalEmps ? "#107c10" : "#0078d4" }}>
                      {withKpisCount} / {totalEmps}
                    </div>
                    <div className="stat-chip-label">KPIs Assigned</div>
                  </div>
                  <div className="stat-chip" onClick={() => setHrFilterPmsAudit("WEIGHT_MISMATCH")} style={{ cursor: "pointer" }}>
                    <div className="stat-chip-value" style={{ color: weight100Count === totalEmps ? "#107c10" : "#ca5010" }}>
                      {weight100Count} / {totalEmps}
                    </div>
                    <div className="stat-chip-label">Weight = 100% Balanced</div>
                  </div>
                  <div className="stat-chip" onClick={() => setHrFilterPmsAudit("PENDING_QUAL")} style={{ cursor: "pointer" }}>
                    <div className="stat-chip-value" style={{ color: qualEvalCount === totalEmps ? "#107c10" : "#038387" }}>
                      {qualEvalCount} / {totalEmps}
                    </div>
                    <div className="stat-chip-label">Qualitative Evaluated</div>
                  </div>
                  <div className="stat-chip" onClick={() => setHrFilterPmsAudit("ALL")} style={{ cursor: "pointer" }}>
                    <div className="stat-chip-value" style={{ color: "#107c10" }}>
                      {hrFinalizedCount} / {totalEmps}
                    </div>
                    <div className="stat-chip-label">HR Finalized Appraisals</div>
                  </div>
                </div>
              );
            })()}

            {/* Search & Multi-Filter Bar */}
            <div className="card" style={{ marginBottom: 14, padding: "12px 16px" }}>
              <div className="form-grid" style={{ alignItems: "end" }}>
                <div className="form-field">
                  <label>Search Name / User ID / Emp ID / Role</label>
                  <input
                    placeholder="Type name, userId, or designation…"
                    value={hrSearchQuery}
                    onChange={(e) => setHrSearchQuery(e.target.value)}
                  />
                </div>
                <div className="form-field">
                  <label>Department</label>
                  <select value={hrFilterDept} onChange={(e) => setHrFilterDept(e.target.value)}>
                    <option value="ALL">All Departments</option>
                    {availableDepartments.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-field">
                  <label>Role</label>
                  <select value={hrFilterRole} onChange={(e) => setHrFilterRole(e.target.value)}>
                    <option value="ALL">All Roles</option>
                    <option value="employee">Employees Only</option>
                    <option value="manager">Line Managers Only</option>
                    <option value="hr">HR Only</option>
                  </select>
                </div>
                <div className="form-field">
                  <label>PMS Audit Filter</label>
                  <select value={hrFilterPmsAudit} onChange={(e) => setHrFilterPmsAudit(e.target.value)}>
                    <option value="ALL">All Accounts</option>
                    <option value="MISSING_KPIS">Missing Quantitative KPIs (0 KPIs)</option>
                    <option value="WEIGHT_MISMATCH">KPI Weight ≠ 100%</option>
                    <option value="PENDING_QUAL">Pending Qualitative Evaluation</option>
                    <option value="NEEDS_IMPROVEMENT">Needs Improvement (&lt; 50%)</option>
                  </select>
                </div>
              </div>
            </div>

            {(() => {
              const q = hrSearchQuery.trim().toLowerCase();
              const filteredAccounts = allUsers.filter((u) => {
                if (hrFilterRole !== "ALL" && u.role !== hrFilterRole) return false;
                if (
                  hrFilterDept !== "ALL" &&
                  (u.dept || "").trim().toLowerCase() !== hrFilterDept.trim().toLowerCase()
                ) {
                  return false;
                }
                if (q) {
                  const hay = `${u.name || ""} ${u.userId || ""} ${u.employeeCode || ""} ${u.title || ""} ${u.dept || ""}`.toLowerCase();
                  if (!hay.includes(q)) return false;
                }
                if (hrFilterPmsAudit !== "ALL") {
                  if (u.role !== "employee") return false;
                  const kpis = u.kpis || [];
                  const totalW = kpis.reduce((s, k) => s + (Number(k.weight) || 0), 0);
                  const br = computeAppraisalBreakdown(u);
                  if (hrFilterPmsAudit === "MISSING_KPIS" && kpis.length > 0) return false;
                  if (hrFilterPmsAudit === "WEIGHT_MISMATCH" && totalW === 100) return false;
                  if (hrFilterPmsAudit === "PENDING_QUAL" && br.isQualEvaluated) return false;
                  if (hrFilterPmsAudit === "NEEDS_IMPROVEMENT" && br.totalScore >= 50) return false;
                }
                return true;
              });

              if (filteredAccounts.length === 0) {
                return (
                  <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                    No accounts match the current search/filter criteria.
                  </p>
                );
              }
              return filteredAccounts.map((u) =>
                renderExpandableEmployeeCard(u, {
                  canEditProfile: true,
                  canDelete: true,
                  canManageKpis: u.role === "employee",
                })
              );
            })()}
          </div>
        )}

        {/* ================= HR: CREATE ACCOUNT ================= */}
        {activeTab === "create_account" && (
          <div className="tab-panel">
            <div className="page-header">
              <div>
                <div className="page-title">Create New Account</div>
                <div className="page-sub">
                  Register a new Employee, Line Manager, or HR account in the system
                </div>
              </div>
              <button
                className="btn-secondary btn-sm"
                onClick={() => setActiveTab("hr")}
              >
                View All Accounts ({allUsers.length}) →
              </button>
            </div>

            <div className="card">
              <div className="card-header">
                <div className="card-title">Account Information</div>
              </div>
              <div className="form-grid">
                <div className="form-field">
                  <label>Full Name</label>
                  <input value={newName} onChange={(e) => setNewName(e.target.value)} />
                </div>
                <div className="form-field">
                  <label>User ID</label>
                  <input value={newUserId} onChange={(e) => setNewUserId(e.target.value)} />
                </div>
                <div className="form-field">
                  <label>Temporary Password</label>
                  <input value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
                </div>
                <div className="form-field">
                  <label>Role</label>
                  <select value={newRole} onChange={(e) => setNewRole(e.target.value as any)}>
                    <option value="employee">Employee</option>
                    <option value="manager">Line Manager</option>
                    <option value="hr">HR</option>
                  </select>
                </div>
                <div className="form-field" style={{ gridColumn: "1 / -1" }}>
                  <label>Department</label>
                  <input value={newDept} onChange={(e) => setNewDept(e.target.value)} />
                </div>
              </div>

              {newRole === "employee" && (
                <div>
                  <div className="section-divider" />
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: ".05em",
                      color: "var(--text-secondary)",
                      marginBottom: 12,
                    }}
                  >
                    Employee Details
                  </div>
                  <div className="form-grid">
                    <div className="form-field">
                      <label>Employee ID</label>
                      <input value={newEmpCode} onChange={(e) => setNewEmpCode(e.target.value)} />
                    </div>
                    <div className="form-field">
                      <label>Job Title</label>
                      <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
                    </div>
                    <div className="form-field">
                      <label>Factory / Office</label>
                      <select value={newFactory} onChange={(e) => setNewFactory(e.target.value)}>
                        {systemSettings.offices.map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="form-field">
                      <label>Line Manager</label>
                      <select value={newManager} onChange={(e) => setNewManager(e.target.value)}>
                        <option value="">— Select —</option>
                        {managersOnly.map((m) => (
                          <option key={m.userId} value={m.userId}>
                            {m.name} ({m.userId})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="form-field">
                      <label>Appraisal Cycle</label>
                      <select value={newCycle} onChange={(e) => setNewCycle(e.target.value)}>
                        {systemSettings.cycles.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="form-field" style={{ gridColumn: "1 / -1" }}>
                      <label>Purpose of Role</label>
                      <textarea rows={2} value={newPurpose} onChange={(e) => setNewPurpose(e.target.value)} />
                    </div>
                  </div>
                </div>
              )}

              {createMsg && (
                <div className={`alert alert-${createMsg.type}`} style={{ marginTop: 12 }}>
                  {createMsg.text}
                </div>
              )}

              <button
                className="btn-primary"
                style={{ width: "auto", padding: "10px 24px", marginTop: 12 }}
                onClick={handleCreateEmployee}
              >
                Create Account
              </button>
            </div>
          </div>
        )}

        {/* ================= MANAGER: MY TEAM ================= */}
        {activeTab === "team" && (
          <div className="tab-panel">
            <div className="page-header">
              <div>
                <div className="page-title">My Team</div>
                <div className="page-sub">
                  Direct reports, Quantitative KPIs (80%), Qualitative Behavioral Evaluation (20%), and PDF reports
                </div>
              </div>
            </div>
            {teamUsers.length === 0 ? (
              <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>No team members assigned yet.</p>
            ) : (
              teamUsers.map((u) =>
                renderExpandableEmployeeCard(u, {
                  canEditProfile: true,
                  canDelete: false,
                  canManageKpis: true,
                })
              )
            )}
          </div>
        )}

        {/* ================= EMPLOYEE: MY KPIs & APPRAISAL ================= */}
        {activeTab === "mykpis" && (
          <div className="tab-panel">
            <div className="page-header">
              <div>
                <div className="page-title">My KPIs & Performance Appraisal</div>
                <div className="page-sub">
                  Track your Quantitative KPI targets and review your Qualitative Behavioral evaluation
                </div>
              </div>
              <button
                className="btn-secondary btn-sm"
                onClick={() => downloadWorkLogPdf(currentProfile)}
              >
                Download PDF Appraisal Report
              </button>
            </div>

            {/* Compact Role & KRA Summary at Top of My KPIs */}
            {(currentProfile.purpose || (currentProfile.kras && currentProfile.kras.length > 0)) && (
              <div className="card" style={{ marginBottom: 12, padding: "12px 16px", background: "var(--bg-overlay)" }}>
                <div style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 6 }}>
                  {currentProfile.purpose && (
                    <div>
                      <strong style={{ color: "var(--text-secondary)", textTransform: "uppercase", fontSize: 11 }}>
                        Job Purpose:{" "}
                      </strong>
                      <span>{currentProfile.purpose}</span>
                    </div>
                  )}
                  {currentProfile.kras && currentProfile.kras.length > 0 && (
                    <div>
                      <strong style={{ color: "var(--text-secondary)", textTransform: "uppercase", fontSize: 11 }}>
                        Assigned KRAs:{" "}
                      </strong>
                      <span>
                        {currentProfile.kras.map((k, idx) => `${idx + 1}. ${k.title}`).join(" · ")}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {renderCompositeScoreStrip(currentProfile)}

            <div className="card" style={{ marginTop: 12 }}>
              <div className="card-header">
                <div className="card-title">
                  Segment A: My Quantitative KPIs (80% Weight)
                </div>
              </div>

              {(() => {
                const selfFilterMonth = empKpiFilterMonth[currentProfile._uid || currentProfile.userId] || "ALL";
                const myFilteredKpis = filterKpisByEffectiveMonth(currentProfile.kpis || [], selfFilterMonth);
                if (!currentProfile.kpis || currentProfile.kpis.length === 0) {
                  return (
                    <div className="alert alert-info" style={{ marginBottom: 0 }}>
                      No Quantitative KPIs have been assigned to you yet. Please contact your Line Manager.
                    </div>
                  );
                }
                if (myFilteredKpis.length === 0) {
                  return (
                    <div className="alert alert-info" style={{ marginBottom: 0 }}>
                      No Quantitative KPIs found for Effective Month <strong>{selfFilterMonth}</strong>.
                    </div>
                  );
                }
                return myFilteredKpis.map((k) => {
                  const pct = kpiPercent(k);
                  const dl = getDeadlineStatus(k);
                  return (
                    <div key={k.id} className="kpi-card">
                      <div className="kpi-header">
                        <div>
                          <div className="kpi-title" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                            <span>{k.title}</span>
                            {k.frequency && (
                              <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>· {k.frequency}</span>
                            )}
                            <span
                              className="mono"
                              style={{
                                fontSize: 11,
                                fontWeight: 700,
                                color: "#005a9e",
                                background: "#eff6fc",
                                border: "1px solid #c7e0f4",
                                padding: "1px 7px",
                                borderRadius: 4,
                              }}
                            >
                              Effective Month: {k.effectiveMonth || "All Months"}
                            </span>
                          </div>
                          <div className="kpi-meta" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                            <span>
                              Achieved: <strong>{fmtVal(k.current || 0, k.unit)}</strong> / Target:{" "}
                              {fmtVal(k.target, k.unit)} &nbsp;·&nbsp; Weight: {k.weight}%
                            </span>
                            {dl && (
                              <>
                                <span>·</span>
                                <span>
                                  Deadline: <strong>{dl.date}</strong>{" "}
                                  <span style={{ color: dl.color, fontWeight: 700 }}>({dl.label})</span>
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                        <KpiBadge pct={pct} />
                      </div>
                      <div className="bar-track">
                        <div
                          className={`bar-fill ${barColorClass(pct)}`}
                          style={{ width: `${Math.min(pct, 100)}%` }}
                        />
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: "var(--text-secondary)",
                          marginTop: 8,
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                        }}
                      >
                        <span>Tracking Mode: Automated via Daily Work Log</span>
                        <button className="btn-link" onClick={() => setActiveTab("worklog")}>
                          Log Work →
                        </button>
                      </div>
                    </div>
                  );
                });
              })()}
            </div>

            {renderEmployeeQualitativeSection(currentProfile, false)}
          </div>
        )}

        {/* ================= EMPLOYEE: DAILY WORK LOG ================= */}
        {activeTab === "worklog" && (
          <div className="tab-panel">
            <div className="page-header">
              <div>
                <div className="page-title">Daily Work Report</div>
                <div className="page-sub">
                  Log daily activities, contribute towards Quantitative KPI targets, and export monthly work logs
                </div>
              </div>
            </div>

            <div className="card" style={{ marginBottom: 20 }}>
              <div className="card-header">
                <div className="card-title">Submit Daily Work Report</div>
              </div>
              <div className="form-grid" style={{ maxWidth: 520, marginBottom: 16 }}>
                <div className="form-field">
                  <label>Work Date (Activity Date)</label>
                  <input
                    type="date"
                    value={worklogDate}
                    onChange={(e) => setWorklogDate(e.target.value)}
                  />
                </div>
                <div className="form-field">
                  <label>Log Date (Auto-Recorded Submission Date)</label>
                  <input
                    type="date"
                    value={today()}
                    disabled
                    readOnly
                    style={{ background: "var(--neutral-4)", color: "var(--text-secondary)", cursor: "not-allowed" }}
                  />
                </div>
              </div>

              <div style={{ marginBottom: 16 }}>
                {(!currentProfile.kpis || currentProfile.kpis.length === 0) ? (
                  <div className="alert alert-info">
                    No Quantitative KPIs have been assigned yet. KPIs must be assigned before submitting daily work
                    reports.
                  </div>
                ) : (
                  currentProfile.kpis.map((k) => {
                    const dl = getDeadlineStatus(k);
                    return (
                      <div
                        key={k.id}
                        className="card"
                        style={{ marginBottom: 12, background: "var(--bg-surface)" }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            flexWrap: "wrap",
                            marginBottom: 8,
                            gap: 8,
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                            <strong>{k.title}</strong>
                            <span
                              className="mono"
                              style={{
                                fontSize: 11,
                                fontWeight: 700,
                                color: "#005a9e",
                                background: "#eff6fc",
                                border: "1px solid #c7e0f4",
                                padding: "1px 6px",
                                borderRadius: 4,
                              }}
                            >
                              Effective Month: {k.effectiveMonth || "All Months"}
                            </span>
                            <span
                              className="mono"
                              style={{ fontSize: 12, color: "var(--text-secondary)" }}
                            >
                              Current: {fmtVal(k.current, k.unit)} / Target: {fmtVal(k.target, k.unit)}
                            </span>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-secondary)" }}>
                            <span>{k.frequency || "Monthly"}</span>
                            {dl && (
                              <>
                                <span>·</span>
                                <span className="mono">
                                  Deadline: {dl.date}{" "}
                                  <strong style={{ color: dl.color }}>({dl.label})</strong>
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "minmax(180px, 240px) 1fr",
                            gap: 14,
                            alignItems: "start",
                          }}
                        >
                          <div className="form-field">
                            <label>Today's Quantity / Achievement ({k.unit})</label>
                            <input
                              type="number"
                              step="any"
                              placeholder="0"
                              value={worklogQty[k.id] || ""}
                              onChange={(e) => setWorklogQty((p) => ({ ...p, [k.id]: e.target.value }))}
                            />
                          </div>
                          <div className="form-field">
                            <label>Work Summary / Task Details</label>
                            <textarea
                              rows={3}
                              style={{ minHeight: 68, resize: "vertical", lineHeight: 1.45 }}
                              placeholder="Describe the tasks, deliverables, or activities completed today towards this KPI…"
                              value={worklogNotes[k.id] || ""}
                              onChange={(e) => setWorklogNotes((p) => ({ ...p, [k.id]: e.target.value }))}
                            />
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {(() => {
                const selectedWorklogMonth = (worklogDate || today()).slice(0, 7);
                const isSelectedWorklogLocked = isMonthFinalized(currentProfile, selectedWorklogMonth);
                return (
                  <>
                    {isSelectedWorklogLocked && (
                      <div className="alert alert-danger" style={{ marginBottom: 14 }}>
                        🔒 <strong>Month Locked by HR ({selectedWorklogMonth}):</strong> Appraisal for{" "}
                        <strong>{selectedWorklogMonth}</strong> has been finalized and approved by HR. Daily Work Report
                        submissions for this month are locked.
                      </div>
                    )}
                    {currentProfile.kpis && currentProfile.kpis.length > 0 && (
                      <button
                        className="btn-primary"
                        style={{ width: "auto", padding: "10px 24px" }}
                        disabled={isSelectedWorklogLocked}
                        onClick={handleSubmitDailyWorkLog}
                      >
                        {isSelectedWorklogLocked
                          ? `🔒 Locked by HR (${selectedWorklogMonth})`
                          : "Submit & Sync with KPIs"}
                      </button>
                    )}
                  </>
                );
              })()}

              {worklogMsg && (
                <div className={`alert alert-${worklogMsg.type}`} style={{ marginTop: 12 }}>
                  {worklogMsg.text}
                </div>
              )}
            </div>

            <div className="card">
              <div className="card-header" style={{ flexWrap: "wrap", gap: 12 }}>
                <div className="card-title">Monthly Work Report History</div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input
                    type="month"
                    style={{ width: "auto", margin: 0 }}
                    value={historyMonth}
                    onChange={(e) => setHistoryMonth(e.target.value)}
                  />
                  <button
                    className="btn-secondary btn-sm"
                    onClick={() => downloadMonthlyCsvReport(currentProfile, monthLogs, historyMonth)}
                  >
                    Export CSV
                  </button>
                  <button
                    className="btn-primary btn-sm"
                    style={{ width: "auto", marginTop: 0 }}
                    onClick={() => downloadWorkLogPdf(currentProfile, historyMonth)}
                  >
                    Monthly PDF
                  </button>
                  <button
                    className="btn-secondary btn-sm"
                    style={{ width: "auto", marginTop: 0 }}
                    disabled={generatingPdfFor === `yearly_${currentProfile._uid || currentProfile.userId}`}
                    onClick={() =>
                      downloadYearlyAppraisalPdf(
                        currentProfile,
                        (historyMonth || today().slice(0, 7)).slice(0, 4)
                      )
                    }
                  >
                    Yearly Avg PDF ({(historyMonth || today()).slice(0, 4)})
                  </button>
                </div>
              </div>

              {loadingHistory ? (
                <div className="alert alert-info">Loading records…</div>
              ) : monthLogs.length === 0 ? (
                <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 10 }}>
                  No work reports logged for {historyMonth}.
                </p>
              ) : (
                <div style={{ overflowX: "auto", marginTop: 10 }}>
                  <table>
                    <thead>
                      <tr>
                        <th style={{ width: 110 }}>Work Date</th>
                        <th style={{ width: 110 }}>Log Date</th>
                        <th style={{ width: 180 }}>KPI</th>
                        <th style={{ width: 110 }}>Quantity</th>
                        <th>Task Summary / Activity Log</th>
                      </tr>
                    </thead>
                    <tbody>
                      {monthLogs.map((log) => {
                        const logDateStr = getLogDate(log);
                        return (log.entries || []).map((e, idx) => (
                          <tr key={`${log.date}_${idx}`}>
                            {idx === 0 && (
                              <>
                                <td
                                  rowSpan={log.entries.length}
                                  className="mono"
                                  style={{
                                    fontWeight: 600,
                                    verticalAlign: "top",
                                    borderRight: "1px solid var(--border-default)",
                                  }}
                                >
                                  {log.date}
                                </td>
                                <td
                                  rowSpan={log.entries.length}
                                  className="mono"
                                  style={{
                                    color: "var(--text-secondary)",
                                    verticalAlign: "top",
                                    borderRight: "1px solid var(--border-default)",
                                  }}
                                >
                                  {logDateStr}
                                </td>
                              </>
                            )}
                            <td style={{ fontWeight: 500 }}>{e.kpiTitle}</td>
                            <td className="mono">
                              {e.quantity > 0 ? `+${e.quantity} ${e.unit}` : "—"}
                            </td>
                            <td style={{ color: "var(--text-secondary)", whiteSpace: "pre-wrap" }}>{e.notes || "—"}</td>
                          </tr>
                        ));
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ================= HR: SYSTEM SETTINGS ================= */}
        {activeTab === "settings" && (
          <div className="tab-panel">
            <div className="page-header">
              <div>
                <div className="page-title">System Settings & Customization</div>
                <div className="page-sub">
                  Manage Master Behavioral Competencies, KPI units, offices, cycles, and GitHub deployment export
                </div>
              </div>
            </div>

            {/* GITHUB READY-TO-DEPLOY SINGLE HTML DOWNLOAD */}
            <div
              className="card"
              style={{
                marginBottom: 16,
                background: "var(--ms-blue-faint)",
                borderColor: "var(--ms-blue-light)",
              }}
            >
              <div className="card-header">
                <div className="card-title">GitHub Deployment Export (Ready-to-Upload index.html)</div>
              </div>
              <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 12 }}>
                Download the complete, self-contained <strong>index.html</strong> file below and upload it directly to
                your GitHub repository to host this app on GitHub Pages without needing any build commands:
              </p>
              <button
                type="button"
                className="btn-primary"
                style={{
                  width: "auto",
                  marginTop: 0,
                  padding: "9px 18px",
                }}
                onClick={async () => {
                  try {
                    let htmlContent = "";
                    const res = await fetch("./deploy-bundle.json", { credentials: "include" });
                    if (res.ok) {
                      const data = await res.json();
                      if (data && data.html) {
                        htmlContent = data.html;
                      }
                    }
                    if (!htmlContent) {
                      htmlContent = "<!doctype html>\n" + document.documentElement.outerHTML;
                    }
                    const blob = new Blob([htmlContent], { type: "text/html;charset=utf-8;" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = "index.html";
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                  } catch (e) {
                    console.error("Failed to download index.html:", e);
                  }
                }}
              >
                ⬇ Download Ready-to-Deploy index.html for GitHub
              </button>
            </div>

            {/* MASTER BEHAVIORAL COMPETENCY LIBRARY */}
            <div className="card">
              <div className="card-header">
                <div className="card-title">Master Behavioral Competencies (Qualitative Library)</div>
              </div>
              <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                Define standard behavioral competencies (e.g. Teamwork, Ownership, Communication, Punctuality) that HR
                and Line Managers can assign and rate on a 1–5 scale:
              </p>
              <div className="inline-row" style={{ maxWidth: 460 }}>
                <input
                  placeholder="Type new behavioral competency..."
                  value={newCompInput}
                  onChange={(e) => setNewCompInput(e.target.value)}
                />
                <button
                  className="btn-primary"
                  style={{ width: "auto", marginTop: 0 }}
                  onClick={() => handleAddMasterOption("competencies", newCompInput, () => setNewCompInput(""))}
                >
                  Add Competency
                </button>
              </div>
              <div className="tag-container">
                {systemSettings.competencies.map((c) => (
                  <span key={c} className="tag-item">
                    {c}
                    <span
                      className="tag-del"
                      title="Delete competency"
                      onClick={() => handleDeleteMasterOption("competencies", c)}
                    >
                      &times;
                    </span>
                  </span>
                ))}
              </div>
            </div>

            <div className="card" style={{ marginTop: 16 }}>
              <div className="card-header">
                <div className="card-title">Manage KPI Units</div>
              </div>
              <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                Add or delete available KPI measurement units (e.g. %, BDT, hrs, number, KG, etc.):
              </p>
              <div className="inline-row" style={{ maxWidth: 400 }}>
                <input
                  placeholder="Type new unit name..."
                  value={newUnitInput}
                  onChange={(e) => setNewUnitInput(e.target.value)}
                />
                <button
                  className="btn-primary"
                  style={{ width: "auto", marginTop: 0 }}
                  onClick={() => handleAddMasterOption("kpiUnits", newUnitInput, () => setNewUnitInput(""))}
                >
                  Add Unit
                </button>
              </div>
              <div className="tag-container">
                {systemSettings.kpiUnits.map((u) => (
                  <span key={u} className="tag-item">
                    {u}
                    <span
                      className="tag-del"
                      title="Delete unit"
                      onClick={() => handleDeleteMasterOption("kpiUnits", u)}
                    >
                      &times;
                    </span>
                  </span>
                ))}
              </div>
            </div>

            <div className="card" style={{ marginTop: 16 }}>
              <div className="card-header">
                <div className="card-title">Manage Factories & Offices</div>
              </div>
              <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                Add or remove company locations / branch offices:
              </p>
              <div className="inline-row" style={{ maxWidth: 400 }}>
                <input
                  placeholder="Type new factory/office name..."
                  value={newOfficeInput}
                  onChange={(e) => setNewOfficeInput(e.target.value)}
                />
                <button
                  className="btn-primary"
                  style={{ width: "auto", marginTop: 0 }}
                  onClick={() => handleAddMasterOption("offices", newOfficeInput, () => setNewOfficeInput(""))}
                >
                  Add Office
                </button>
              </div>
              <div className="tag-container">
                {systemSettings.offices.map((o) => (
                  <span key={o} className="tag-item">
                    {o}
                    <span
                      className="tag-del"
                      title="Delete office"
                      onClick={() => handleDeleteMasterOption("offices", o)}
                    >
                      &times;
                    </span>
                  </span>
                ))}
              </div>
            </div>

            <div className="card" style={{ marginTop: 16 }}>
              <div className="card-header">
                <div className="card-title">Manage Appraisal Cycles</div>
              </div>
              <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                Manage cycle intervals used for appraisal periods:
              </p>
              <div className="inline-row" style={{ maxWidth: 400 }}>
                <input
                  placeholder="Type new cycle name..."
                  value={newCycleInput}
                  onChange={(e) => setNewCycleInput(e.target.value)}
                />
                <button
                  className="btn-primary"
                  style={{ width: "auto", marginTop: 0 }}
                  onClick={() => handleAddMasterOption("cycles", newCycleInput, () => setNewCycleInput(""))}
                >
                  Add Cycle
                </button>
              </div>
              <div className="tag-container">
                {systemSettings.cycles.map((c) => (
                  <span key={c} className="tag-item">
                    {c}
                    <span
                      className="tag-del"
                      title="Delete cycle"
                      onClick={() => handleDeleteMasterOption("cycles", c)}
                    >
                      &times;
                    </span>
                  </span>
                ))}
              </div>
            </div>

            <div className="card" style={{ marginTop: 16 }}>
              <div className="card-header">
                <div className="card-title">Manage KPI Tracking Frequencies</div>
              </div>
              <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                Add or remove tracking frequency intervals (e.g. Daily, Weekly, Monthly, Quarterly, Yearly):
              </p>
              <div className="inline-row" style={{ maxWidth: 400 }}>
                <input
                  placeholder="Type new frequency name..."
                  value={newFreqInput}
                  onChange={(e) => setNewFreqInput(e.target.value)}
                />
                <button
                  className="btn-primary"
                  style={{ width: "auto", marginTop: 0 }}
                  onClick={() => handleAddMasterOption("frequencies", newFreqInput, () => setNewFreqInput(""))}
                >
                  Add Frequency
                </button>
              </div>
              <div className="tag-container">
                {systemSettings.frequencies.map((f) => (
                  <span key={f} className="tag-item">
                    {f}
                    <span
                      className="tag-del"
                      title="Delete frequency"
                      onClick={() => handleDeleteMasterOption("frequencies", f)}
                    >
                      &times;
                    </span>
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
