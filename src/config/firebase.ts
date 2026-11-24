// MOBIUS Firebase config.
//
// !!! MANUAL SETUP REQUIRED — paste your own Firebase project keys here.
// Create a free Firebase project (Spark plan, $0) at https://console.firebase.google.com
//   1. Project settings -> "Your apps" -> Web app -> copy the firebaseConfig values.
//   2. Build -> AI Logic -> enable Gemini API (Vertex AI or Gemini Developer API backend).
//   3. Build -> App Check -> register this web app, enable the debug provider for
//      hackathon judging (see docs/PERMISSIONS.md), and paste the debug token below
//      OR set it in the browser console: self.FIREBASE_APPCHECK_DEBUG_TOKEN = '<token>'.
//   4. (Optional) ReCaptcha Enterprise site key for production App Check.
//
// DO NOT commit real keys to a public repo. For the hackathon submission the
// placeholders below keep the extension compiling and running in local-only
// mode (on-device extractive fallback + graceful degradation); Firebase AI
// calls throw a clear "not configured" error until real keys are pasted.
import { initializeApp, type FirebaseApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';

// NOTE: the config is parsed from JSON at runtime (not a plain const literal)
// so the bundler cannot constant-fold the placeholder comparisons away.
// The App Check / debug-token paths must stay in the shipped bundle; they
// are evaluated at runtime instead, which is the correct behaviour either way.
export const FIREBASE_CONFIG = JSON.parse(
  '{"apiKey":"AIzaSyCe3pFg0ZaEfneTYw3ZwqNzNutDqmkzqhY","authDomain":"gen-lang-client-0936734513.firebaseapp.com","projectId":"gen-lang-client-0936734513","storageBucket":"gen-lang-client-0936734513.firebasestorage.app","messagingSenderId":"1035973413407","appId":"1:1035973413407:web:ddc7621b4170a69977e32a"}',
) as {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
};

const SECRETS = JSON.parse(
  '{"appCheckDebugToken":"PASTE_YOUR_APP_CHECK_DEBUG_TOKEN_HERE","recaptchaEnterpriseSiteKey":"PASTE_YOUR_RECAPTCHA_ENTERPRISE_SITE_KEY_HERE"}',
) as { appCheckDebugToken: string; recaptchaEnterpriseSiteKey: string };

/** App Check debug token (hackathon judging). Paste the token from Firebase console, or leave placeholder to disable. */
export const APP_CHECK_DEBUG_TOKEN = SECRETS.appCheckDebugToken;

/** ReCaptcha Enterprise site key for production App Check (optional for the demo). */
export const RECAPTCHA_ENTERPRISE_SITE_KEY = SECRETS.recaptchaEnterpriseSiteKey;

export function isFirebaseConfigured(): boolean {
  return (
    FIREBASE_CONFIG.apiKey !== 'PASTE_YOUR_API_KEY_HERE' &&
    FIREBASE_CONFIG.projectId !== 'PASTE_YOUR_PROJECT_ID' &&
    FIREBASE_CONFIG.appId !== 'PASTE_YOUR_APP_ID'
  );
}

let app: FirebaseApp | null = null;
let appCheckReady = false;

/** Lazily initialize Firebase + App Check. Throws a clear error if keys are still placeholders. */
export function getFirebaseApp(): FirebaseApp {
  if (app) return app;
  if (!isFirebaseConfigured()) {
    throw new Error(
      'Firebase is not configured: paste your project keys into src/config/firebase.ts (see README.md "Firebase setup").',
    );
  }
  app = initializeApp({ ...FIREBASE_CONFIG });
  initAppCheck(app);
  return app;
}

function initAppCheck(firebaseApp: FirebaseApp): void {
  if (appCheckReady) return;
  try {
    // Debug-token support (required path for hackathon judging):
    // a debug token lets App Check pass without a real reCAPTCHA challenge.
    const g = globalThis as unknown as Record<string, unknown>;
    if (APP_CHECK_DEBUG_TOKEN !== 'PASTE_YOUR_APP_CHECK_DEBUG_TOKEN_HERE') {
      g.FIREBASE_APPCHECK_DEBUG_TOKEN = APP_CHECK_DEBUG_TOKEN;
    }
    if (RECAPTCHA_ENTERPRISE_SITE_KEY !== 'PASTE_YOUR_RECAPTCHA_ENTERPRISE_SITE_KEY_HERE') {
      initializeAppCheck(firebaseApp, {
        provider: new ReCaptchaEnterpriseProvider(RECAPTCHA_ENTERPRISE_SITE_KEY),
        isTokenAutoRefreshEnabled: true,
      });
      appCheckReady = true;
    }
  } catch (err) {
    // App Check must never crash the core: AI Logic calls will surface the failure.
    console.warn('[MOBIUS] App Check init failed (continuing without it):', err);
  }
}
