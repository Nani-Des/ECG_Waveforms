import { useCallback, useEffect, useRef, useState } from "react";
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInAnonymously,
  signInWithPopup,
  signOut,
  type User,
} from "firebase/auth";
import {
  collection,
  doc,
  increment,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  where,
  type Timestamp,
} from "firebase/firestore";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";
import { getFirebase, isFirebaseConfigured } from "./firebase";

type UploadKind = "data" | "label";

type EcgRecord = {
  id: string;
  userId: string;
  createdAt: Timestamp | null;
  uploadKind?: UploadKind;
  fileName: string;
  mimeType: string;
  storagePath: string;
  downloadUrl: string;
  /** Text label / notes paired with this row */
  labelText?: string | null;
  /** Optional separate file used as label when uploadKind is data */
  labelFileName?: string | null;
  labelFileStoragePath?: string | null;
  labelFileDownloadUrl?: string | null;
  /** When uploadKind is label — Firestore id of the data row this labels */
  linkedDataRecordId?: string | null;
  /** Legacy fields from older saves */
  labels?: string;
  reportFileName?: string;
  reportStoragePath?: string;
  reportDownloadUrl?: string;
};

const RECORDS = "ecg_records";
const STATS = "app_metadata";
const STATS_DOC = "stats";

export default function App() {
  const [configured] = useState(() => isFirebaseConfigured());
  const [user, setUser] = useState<User | null>(null);
  const [records, setRecords] = useState<EcgRecord[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [labelText, setLabelText] = useState("");
  const [labelAttachment, setLabelAttachment] = useState<File | null>(null);
  const [linkedDataId, setLinkedDataId] = useState("");
  const [cameraKind, setCameraKind] = useState<UploadKind>("data");
  const [fileKind, setFileKind] = useState<UploadKind>("data");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const labelAttachmentRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const dataRecords = records.filter(
    (r) => r.uploadKind === "data" || r.uploadKind == null
  );

  useEffect(() => {
    if (!configured) return;
    const { auth, db } = getFirebase();
    const unsubAuth = onAuthStateChanged(auth, setUser);
    const statsRef = doc(db, STATS, STATS_DOC);
    const unsubStats = onSnapshot(statsRef, (s) => {
      const n = s.data()?.recordCount;
      setTotalCount(typeof n === "number" ? n : 0);
    });
    return () => {
      unsubAuth();
      unsubStats();
    };
  }, [configured]);

  useEffect(() => {
    if (!configured) return;
    const { auth } = getFirebase();
    if (!auth.currentUser) {
      void signInAnonymously(auth).catch(() => {});
    }
  }, [configured, user]);

  useEffect(() => {
    if (!configured || !user) {
      setRecords([]);
      return;
    }
    const { db } = getFirebase();
    const q = query(
      collection(db, RECORDS),
      where("userId", "==", user.uid),
      orderBy("createdAt", "desc")
    );
    return onSnapshot(q, (snap) => {
      setRecords(
        snap.docs.map((d) => {
          const x = d.data() as Omit<EcgRecord, "id">;
          return { id: d.id, ...x };
        })
      );
    });
  }, [configured, user]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const ensureUser = useCallback(async () => {
    const { auth } = getFirebase();
    if (!auth.currentUser) await signInAnonymously(auth);
    return auth.currentUser!;
  }, []);

  const resetExtras = useCallback(() => {
    setLabelText("");
    setLabelAttachment(null);
    setLinkedDataId("");
    if (labelAttachmentRef.current) labelAttachmentRef.current.value = "";
  }, []);

  const uploadFlow = useCallback(
    async (
      primary: File,
      kind: UploadKind,
      extras: { linkedId: string | null }
    ) => {
      if (kind === "label" && !extras.linkedId) {
        setStatus("Choose which data this label belongs to");
        setTimeout(() => setStatus(null), 2800);
        return;
      }

      setStatus(null);
      setBusy(true);
      try {
        const u = await ensureUser();
        const { db, storage } = getFirebase();
        const stamp = Date.now();
        const safe = sanitize(primary.name);

        const primaryFolder =
          kind === "data" ? `ecg_uploads/${u.uid}` : `ecg_label_uploads/${u.uid}`;
        const primaryPath = `${primaryFolder}/${stamp}_${safe}`;
        const mainRef = ref(storage, primaryPath);
        await uploadBytes(mainRef, primary, {
          contentType: primary.type || undefined,
        });
        const downloadUrl = await getDownloadURL(mainRef);

        let labelFileName: string | undefined;
        let labelFileStoragePath: string | undefined;
        let labelFileDownloadUrl: string | undefined;

        if (kind === "data" && labelAttachment) {
          const lp = `ecg_label_attachments/${u.uid}/${stamp}_${sanitize(labelAttachment.name)}`;
          const lr = ref(storage, lp);
          await uploadBytes(lr, labelAttachment, {
            contentType: labelAttachment.type || undefined,
          });
          labelFileDownloadUrl = await getDownloadURL(lr);
          labelFileStoragePath = lp;
          labelFileName = labelAttachment.name;
        }

        const text = labelText.trim();
        const recordRef = doc(collection(db, RECORDS));
        const statsRef = doc(db, STATS, STATS_DOC);

        await runTransaction(db, async (tx) => {
          const payload: Record<string, unknown> = {
            userId: u.uid,
            createdAt: serverTimestamp(),
            uploadKind: kind,
            fileName: primary.name,
            mimeType: primary.type || "application/octet-stream",
            storagePath: primaryPath,
            downloadUrl,
            labelText: text || null,
          };

          if (kind === "data") {
            payload.labelFileName = labelFileName ?? null;
            payload.labelFileStoragePath = labelFileStoragePath ?? null;
            payload.labelFileDownloadUrl = labelFileDownloadUrl ?? null;
            payload.linkedDataRecordId = null;
          } else {
            payload.linkedDataRecordId = extras.linkedId;
            payload.labelFileName = null;
            payload.labelFileStoragePath = null;
            payload.labelFileDownloadUrl = null;
          }

          tx.set(recordRef, payload);
          tx.set(
            statsRef,
            { recordCount: increment(1), updatedAt: serverTimestamp() },
            { merge: true }
          );
        });

        resetExtras();
        setStatus("Saved");
        setTimeout(() => setStatus(null), 2500);
      } catch (e) {
        setStatus(e instanceof Error ? e.message : "Failed");
      } finally {
        setBusy(false);
      }
    },
    [ensureUser, labelAttachment, labelText, resetExtras]
  );

  const startCamera = async () => {
    setStatus(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraOn(true);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Camera unavailable");
    }
  };

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraOn(false);
  };

  const capturePhoto = () => {
    const video = videoRef.current;
    if (!video?.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const file = new File([blob], `photo-${Date.now()}.jpg`, {
          type: "image/jpeg",
        });
        void uploadFlow(file, cameraKind, {
          linkedId: linkedDataId || null,
        });
      },
      "image/jpeg",
      0.9
    );
  };

  const onGoogle = async () => {
    setMenuOpen(false);
    setBusy(true);
    try {
      await signInWithPopup(getFirebase().auth, new GoogleAuthProvider());
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  const onSignOut = async () => {
    setMenuOpen(false);
    setBusy(true);
    try {
      await signOut(getFirebase().auth);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Sign out failed");
    } finally {
      setBusy(false);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) {
      void uploadFlow(file, fileKind, { linkedId: linkedDataId || null });
    }
  };

  const onFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) {
      void uploadFlow(file, fileKind, { linkedId: linkedDataId || null });
    }
  };

  if (!configured) {
    return (
      <div className="shell">
        <p className="bare-msg">Add Firebase keys to .env and restart.</p>
      </div>
    );
  }

  const signedInWithGoogle = Boolean(user && !user.isAnonymous);
  const needsLinkUpload = fileKind === "label" && !linkedDataId;
  const needsLinkCamera = cameraKind === "label" && !linkedDataId;

  return (
    <div className="shell">
      <header className="app-bar">
        <span className="app-title">ECG</span>
        <span className="count-pill" title="Records in database">
          {totalCount}
        </span>
        <div className="app-bar-spacer" />
        <div className="avatar-wrap" ref={menuRef}>
          <button
            type="button"
            className="avatar-btn"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((o) => !o);
            }}
            title={signedInWithGoogle ? "Account" : "Sign in"}
          >
            <Avatar user={user} />
          </button>
          {menuOpen && (
            <div className="avatar-menu" role="menu">
              {!signedInWithGoogle ? (
                <button type="button" role="menuitem" onClick={onGoogle}>
                  Sign in with Google
                </button>
              ) : (
                <button type="button" role="menuitem" onClick={onSignOut}>
                  Sign out
                </button>
              )}
            </div>
          )}
        </div>
      </header>

      <label className="shared-label">
        <span className="field-label">Label text</span>
        <textarea
          className="shared-label-input"
          rows={2}
          placeholder="Optional — applies to camera capture and file upload"
          value={labelText}
          onChange={(e) => setLabelText(e.target.value)}
          disabled={busy}
          autoComplete="off"
        />
      </label>

      <main className="workspace">
        <section className="pane pane-camera">
          <KindToggle
            value={cameraKind}
            onChange={setCameraKind}
            disabled={busy}
            defaultHint="default: data"
          />
          {cameraKind === "label" && (
            <LinkedDataSelect
              value={linkedDataId}
              onChange={setLinkedDataId}
              options={dataRecords}
              disabled={busy}
            />
          )}
          <div className="pane-frame">
            <video
              ref={videoRef}
              className={`camera-video ${cameraOn ? "on" : ""}`}
              playsInline
              muted
            />
            {!cameraOn && (
              <div className="camera-placeholder">Camera off</div>
            )}
          </div>
          <div className="pane-actions">
            {!cameraOn ? (
              <button type="button" onClick={startCamera} disabled={busy}>
                Start camera
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={capturePhoto}
                  disabled={busy || needsLinkCamera}
                >
                  Capture
                </button>
                <button type="button" className="btn-ghost" onClick={stopCamera} disabled={busy}>
                  Stop
                </button>
              </>
            )}
          </div>
        </section>

        <section className="pane pane-upload">
          <KindToggle
            value={fileKind}
            onChange={setFileKind}
            disabled={busy}
            defaultHint="default: data"
          />
          {fileKind === "label" && (
            <LinkedDataSelect
              value={linkedDataId}
              onChange={setLinkedDataId}
              options={dataRecords}
              disabled={busy}
            />
          )}
          <div
            className={`drop-zone ${needsLinkUpload ? "drop-zone-disabled" : ""}`}
            onDragOver={(e) => e.preventDefault()}
            onDrop={needsLinkUpload ? undefined : onDrop}
            onClick={() => {
              if (!needsLinkUpload) fileInputRef.current?.click();
            }}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ")
                if (!needsLinkUpload) fileInputRef.current?.click();
            }}
          >
            <input
              ref={fileInputRef}
              type="file"
              className="sr-only"
              disabled={busy || needsLinkUpload}
              accept="image/*,.dat,.txt,.pdf,.csv,.xml,.hea,.zip,.dcm,application/*,text/*"
              onChange={onFilePick}
            />
            <span className="drop-icon" aria-hidden>
              ↑
            </span>
            <span className="drop-label">
              {needsLinkUpload ? "Choose linked data first" : "Drop or tap to upload"}
            </span>
          </div>
        </section>
      </main>

      {(fileKind === "data" || cameraKind === "data") && (
        <footer className="extras">
          <label className="extras-report">
            <input
              ref={labelAttachmentRef}
              type="file"
              disabled={busy}
              onChange={(e) => setLabelAttachment(e.target.files?.[0] ?? null)}
            />
            <span>{labelAttachment ? labelAttachment.name : "Label file"}</span>
          </label>
        </footer>
      )}

      {status && <div className="toast">{status}</div>}

      {records.length > 0 && (
        <ul className="recent">
          {records.slice(0, 12).map((r) => {
            const kind: UploadKind = r.uploadKind ?? "data";
            const legacyText = r.labelText ?? r.labels ?? "";
            const link =
              kind === "label" && r.linkedDataRecordId
                ? ` → data #${r.linkedDataRecordId.slice(0, 6)}`
                : "";
            return (
              <li key={r.id}>
                <span className={`kind-tag kind-${kind}`}>{kind}</span>
                <a href={r.downloadUrl} target="_blank" rel="noreferrer">
                  {r.fileName}
                </a>
                {legacyText ? ` · ${legacyText}` : ""}
                {link}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function KindToggle({
  value,
  onChange,
  disabled,
  defaultHint,
}: {
  value: UploadKind;
  onChange: (k: UploadKind) => void;
  disabled?: boolean;
  defaultHint?: string;
}) {
  return (
    <div className="kind-toggle" role="group" aria-label="Upload type">
      <button
        type="button"
        className={value === "data" ? "active" : ""}
        disabled={disabled}
        onClick={() => onChange("data")}
      >
        Data
      </button>
      <button
        type="button"
        className={value === "label" ? "active" : ""}
        disabled={disabled}
        onClick={() => onChange("label")}
      >
        Label
      </button>
      {defaultHint && <span className="kind-hint">{defaultHint}</span>}
    </div>
  );
}

function LinkedDataSelect({
  value,
  onChange,
  options,
  disabled,
}: {
  value: string;
  onChange: (id: string) => void;
  options: EcgRecord[];
  disabled?: boolean;
}) {
  return (
    <label className="link-select">
      <span className="sr-only">Link to data record</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        required
      >
        <option value="">Link to data…</option>
        {options.map((r) => (
          <option key={r.id} value={r.id}>
            {r.fileName.slice(0, 48)}
          </option>
        ))}
      </select>
    </label>
  );
}

function Avatar({ user }: { user: User | null }) {
  if (user?.photoURL) {
    return (
      <img className="avatar-img" src={user.photoURL} alt="" referrerPolicy="no-referrer" />
    );
  }
  return (
    <svg className="avatar-svg" viewBox="0 0 48 48" aria-hidden>
      <circle cx="24" cy="24" r="22" fill="currentColor" opacity="0.15" />
      <circle cx="24" cy="18" r="8" fill="currentColor" />
      <ellipse cx="24" cy="36" rx="14" ry="10" fill="currentColor" opacity="0.85" />
    </svg>
  );
}

function sanitize(name: string) {
  return name.replace(/[^\w.\-()+ ]/g, "_").slice(0, 180);
}
