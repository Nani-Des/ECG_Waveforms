import { initializeApp, type FirebaseApp } from "firebase/app";
import { getAnalytics, isSupported, type Analytics } from "firebase/analytics";
import { getAuth, type Auth } from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";
import { getStorage, type FirebaseStorage } from "firebase/storage";

const required = (key: keyof ImportMetaEnv) => {
  const v = import.meta.env[key];
  if (!v) throw new Error(`Missing ${key} in .env`);
  return v as string;
};

let app: FirebaseApp | null = null;
let analytics: Analytics | null = null;
let analyticsReady: Promise<Analytics | null> | null = null;

async function ensureAnalytics(a: FirebaseApp): Promise<Analytics | null> {
  if (analytics) return analytics;
  if (!import.meta.env.VITE_FIREBASE_MEASUREMENT_ID) return null;
  if (typeof window === "undefined") return null;
  if (!(await isSupported())) return null;
  analytics = getAnalytics(a);
  return analytics;
}

export function getFirebase(): {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  storage: FirebaseStorage;
  analytics: Analytics | null;
  analyticsReady: Promise<Analytics | null>;
} {
  if (!app) {
    const measurementId = import.meta.env.VITE_FIREBASE_MEASUREMENT_ID;
    app = initializeApp({
      apiKey: required("VITE_FIREBASE_API_KEY"),
      authDomain: required("VITE_FIREBASE_AUTH_DOMAIN"),
      projectId: required("VITE_FIREBASE_PROJECT_ID"),
      storageBucket: required("VITE_FIREBASE_STORAGE_BUCKET"),
      messagingSenderId: required("VITE_FIREBASE_MESSAGING_SENDER_ID"),
      appId: required("VITE_FIREBASE_APP_ID"),
      ...(measurementId ? { measurementId } : {}),
    });
    analyticsReady = ensureAnalytics(app);
  }
  const bucketId = required("VITE_FIREBASE_STORAGE_BUCKET").replace(/^gs:\/\//, "");
  return {
    app,
    auth: getAuth(app),
    db: getFirestore(app),
    storage: getStorage(app, `gs://${bucketId}`),
    analytics,
    analyticsReady: analyticsReady ?? Promise.resolve(null),
  };
}

export function isFirebaseConfigured(): boolean {
  try {
    return Boolean(import.meta.env.VITE_FIREBASE_API_KEY);
  } catch {
    return false;
  }
}

/** Maps Firebase errors to short, actionable text (especially for mobile / LAN testing). */
export function formatFirebaseError(err: unknown): string {
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? String((err as { code?: string }).code)
      : "";
  const fallback = err instanceof Error ? err.message : "Something went wrong";

  if (code === "auth/configuration-not-found") {
    return [
      "Firebase Authentication isn’t set up for this project.",
      "Fix: Firebase Console → Authentication → open “Get started”.",
      "Then Sign-in methods → Anonymous → Enable.",
      "If the phone opens your app via http://YOUR-PC-IP:5173, also add that exact host under Authentication → Settings → Authorized domains.",
    ].join(" ");
  }

  if (code === "auth/unauthorized-domain") {
    return [
      "This web address isn’t allowed for Firebase Auth.",
      "Firebase Console → Authentication → Settings → Authorized domains → add your host (e.g. ecg-waveforms.vercel.app, localhost, or your LAN IP).",
    ].join(" ");
  }

  if (
    code.startsWith("storage/") ||
    /cors|preflight|access-control|blocked by cors/i.test(fallback)
  ) {
    return [
      "Storage upload failed — often the Cloud Storage bucket needs a CORS rule for your dev URL.",
      "Install Google Cloud SDK, then from this project folder run:",
      "gsutil cors set storage-cors.json gs://YOUR_BUCKET",
      "Replace YOUR_BUCKET with Project settings → storageBucket (e.g. gs://ecg-waveforms.firebasestorage.app).",
      "Add http://YOUR-LAN-IP:5173 to storage-cors.json origins if you test from a phone.",
      "Also confirm Firebase Console → Storage is enabled and storage.rules are deployed.",
    ].join(" ");
  }

  return fallback;
}
