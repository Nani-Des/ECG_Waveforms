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
  return {
    app,
    auth: getAuth(app),
    db: getFirestore(app),
    storage: getStorage(app),
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
