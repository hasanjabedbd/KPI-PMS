import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export const firebaseConfig = {
  apiKey: "AIzaSyDo4bjrqSDqbCCAaukusL92IAmMpd2KtY0",
  authDomain: "pms-kpi.firebaseapp.com",
  projectId: "pms-kpi",
  storageBucket: "pms-kpi.firebasestorage.app",
  messagingSenderId: "673875710142",
  appId: "1:673875710142:web:89a482dc6b27c0b7e4ceef",
  measurementId: "G-JXPJ0YNDHJ",
};

export const FAKE_EMAIL_DOMAIN = "yourteam.local";

export const primaryApp = initializeApp(firebaseConfig);
export const auth = getAuth(primaryApp);
export const db = getFirestore(primaryApp);
