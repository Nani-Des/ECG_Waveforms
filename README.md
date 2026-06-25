# ECG Waveforms

Web app to capture, upload, label, and browse ECG scans and related files; stores files in Firebase Storage and metadata in Firestore.

Overview
- Single-page TypeScript + React app (Vite) that supports camera capture, drag/drop file upload, and linking label files to data records.
- Auth: anonymous sign-in by default with optional Google sign-in; uploads are saved to Firebase Storage and a Firestore collection `ecg_records`.
- Uploads run inside Firestore transactions that also increment a stats document (`app_metadata/stats.recordCount`) so the UI shows a live total.
- Remote/runtime configuration via environment variables and (optionally) Firebase Remote Config; CORS and auth domains must be configured for device/LAN testing.

Tech stack
- TypeScript, React, Vite
- Firebase: Auth, Firestore, Storage, (optional) Analytics
- Storage: Cloud Storage (CORS-aware uploads)
- Browser APIs: getUserMedia, MediaStream, canvas toBlob
- Dev tooling: npm, gsutil (for CORS)

Prerequisites
- Node.js and npm
- Modern browser for camera APIs (Chrome recommended)
- Firebase project with a Storage bucket and Firestore enabled
- (Optional) Google Cloud SDK (gsutil) to set storage CORS when testing from a phone

Setup — local dev
1. Clone and install
```
git clone https://github.com/Nani-Des/ECG_Waveforms.git
cd ECG_Waveforms
npm install
```
2. Create environment file
- Copy the provided example:
```
cp .env.example .env
```
- Fill required values (see Environment variables below).
3. Start dev server
```
npm run dev
```
The app will be served by Vite (default port 5173).

Environment variables
The app reads Firebase keys from Vite env vars. Populate these in `.env` (or your host):
- VITE_FIREBASE_API_KEY
- VITE_FIREBASE_AUTH_DOMAIN
- VITE_FIREBASE_PROJECT_ID
- VITE_FIREBASE_STORAGE_BUCKET
- VITE_FIREBASE_MESSAGING_SENDER_ID
- VITE_FIREBASE_APP_ID
- VITE_FIREBASE_MEASUREMENT_ID (optional; for Analytics)

Files referencing these are in `src/firebase.ts`. The app will throw a clear error when a required var is missing.

Firebase setup & deployment
- To deploy Firestore rules and storage rules the project includes:
```
npm run firebase:deploy:rules
npm run firebase:deploy:indexes
```
- For local integration testing you can run Firebase emulators (recommended before touching production data):
```
firebase emulators:start --only firestore,auth,storage
```

Storage CORS (important for uploads from mobile/devices)
If you get CORS errors when uploading from a phone or a LAN-hosted dev server, set bucket CORS with gsutil:
1. Edit `storage-cors.json` origins to include your host (e.g., `http://localhost:5173` or `http://192.168.0.10:5173`).
2. Run:
```
gsutil cors set storage-cors.json gs://YOUR_BUCKET_NAME
```
Replace `YOUR_BUCKET_NAME` with the value from `VITE_FIREBASE_STORAGE_BUCKET` (strip `gs://`).

How the upload flow works (technical)
- User capture / pick: camera capture uses `navigator.mediaDevices.getUserMedia` and `capturePhoto()` draws current frame to canvas then creates a `File` blob.
- Local staging: captures and chosen files are kept client-side until the user taps "Submit to cloud".
- Persist: `persistUpload()` does:
  - Upload primary file to Storage at `ecg_uploads/{uid}/<timestamp>_name` (or `ecg_label_uploads` for label uploads).
  - Optionally upload a label attachment (`ecg_label_attachments/{uid}/...`).
  - Create a Firestore document in collection `ecg_records` with fields: userId, createdAt=serverTimestamp(), uploadKind, fileName, mimeType, storagePath, downloadUrl, labelText, labelFile* fields, linkedDataRecordId.
  - Increment `app_metadata/stats.recordCount` in the same transaction.
- Auth: anonymous sign-in is used automatically; Google sign-in is supported via popup. See `src/App.tsx` for exact auth flows (calls to `signInAnonymously`, `signInWithPopup`).

Important code locations
- Entrypoint: `src/main.tsx`
- App UI + upload logic: `src/App.tsx`
- Firebase initialization and error helpers: `src/firebase.ts` (includes helpful error messages for auth/storage issues)
- Styles: `src/index.css`
- Vite config: `vite.config.ts`
- Firebase rules / indexes: `firestore.rules`, `firestore.indexes.json`

Run and test notes
- If the UI shows "Add Firebase keys to .env and restart." you need to populate `.env` or set host env vars.
- For auth on devices, add your dev host (e.g., `http://192.168.0.XX:5173`) to Firebase Console → Authentication → Authorized domains.
- If Storage uploads fail with CORS errors, follow the Storage CORS steps above.
- The repository contains helpful error messages in `src/firebase.ts` under `formatFirebaseError()` — they explain fixes for common Firebase setup problems.

Build & deploy
- Build:
```
npm run build
```
- Preview build:
```
npm run preview
```
- Deploy Firestore rules/indexes via the package scripts (see above).

Project layout (most relevant)
```
package.json
vite.config.ts
index.html
.env.example
storage-cors.json
firestore.rules
firestore.indexes.json
src/
  main.tsx
  App.tsx
  firebase.ts
  index.css
```

Troubleshooting (quick)
- "Missing .env" → copy `.env.example` and fill values.
- "auth/unauthorized-domain" → add your host to Firebase Authentication Authorized domains.
- "Storage upload failed / CORS" → run `gsutil cors set storage-cors.json gs://YOUR_BUCKET`.
- Camera unavailable → test on HTTPS or localhost, verify browser permissions and that `getUserMedia` is supported.

Status
working

Author
- Nani-Des — https://github.com/Nani-Des

If you want, I can produce a `.env.example` review that lists sample values, or a short script to set the common gsutil CORS command for local test hosts.
