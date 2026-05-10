import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  query,
  runTransaction,
  serverTimestamp,
  where,
  type Timestamp,
} from "firebase/firestore";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";
import { formatFirebaseError, getFirebase, isFirebaseConfigured } from "./firebase";

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
  labelText?: string | null;
  labelFileName?: string | null;
  labelFileStoragePath?: string | null;
  labelFileDownloadUrl?: string | null;
  linkedDataRecordId?: string | null;
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
  const [draftCameraFile, setDraftCameraFile] = useState<File | null>(null);
  const [draftDiskFile, setDraftDiskFile] = useState<File | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const labelAttachmentRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const cameraPreviewUrl = useMemo(() => {
    if (!draftCameraFile?.type.startsWith("image/")) return null;
    return URL.createObjectURL(draftCameraFile);
  }, [draftCameraFile]);

  const diskPreviewUrl = useMemo(() => {
    if (!draftDiskFile?.type.startsWith("image/")) return null;
    return URL.createObjectURL(draftDiskFile);
  }, [draftDiskFile]);

  useEffect(() => {
    return () => {
      if (cameraPreviewUrl) URL.revokeObjectURL(cameraPreviewUrl);
    };
  }, [cameraPreviewUrl]);

  useEffect(() => {
    return () => {
      if (diskPreviewUrl) URL.revokeObjectURL(diskPreviewUrl);
    };
  }, [diskPreviewUrl]);

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
    const q = query(collection(db, RECORDS), where("userId", "==", user.uid));
    return onSnapshot(q, (snap) => {
      const rows = snap.docs.map((d) => {
        const x = d.data() as Omit<EcgRecord, "id">;
        return { id: d.id, ...x };
      });
      rows.sort((a, b) => {
        const ta = a.createdAt?.toMillis?.() ?? 0;
        const tb = b.createdAt?.toMillis?.() ?? 0;
        return tb - ta;
      });
      setRecords(rows);
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

  /** Upload one asset to Storage + Firestore (used only after explicit Submit). */
  const persistUpload = useCallback(
    async (
      primary: File,
      kind: UploadKind,
      extras: { linkedId: string | null },
      includeLabelAttachment: boolean
    ) => {
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

      if (kind === "data" && includeLabelAttachment && labelAttachment) {
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
    },
    [ensureUser, labelAttachment, labelText]
  );

  const submitAll = useCallback(async () => {
    type Task = { file: File; kind: UploadKind };
    const tasks: Task[] = [];
    if (draftCameraFile) tasks.push({ file: draftCameraFile, kind: cameraKind });
    if (draftDiskFile) tasks.push({ file: draftDiskFile, kind: fileKind });

    if (tasks.length === 0) {
      setStatus("Capture or choose a file first");
      setTimeout(() => setStatus(null), 2800);
      return;
    }

    for (const t of tasks) {
      if (t.kind === "label" && !linkedDataId) {
        setStatus("Choose which data a label upload belongs to");
        setTimeout(() => setStatus(null), 3200);
        return;
      }
    }

    setStatus(null);
    setBusy(true);
    let attachmentConsumed = false;
    try {
      for (const t of tasks) {
        const includeAttach =
          t.kind === "data" && !!labelAttachment && !attachmentConsumed;
        if (includeAttach) attachmentConsumed = true;
        await persistUpload(t.file, t.kind, { linkedId: linkedDataId || null }, includeAttach);
      }
      setDraftCameraFile(null);
      setDraftDiskFile(null);
      resetExtras();
      setStatus("Saved");
      setTimeout(() => setStatus(null), 2500);
    } catch (e) {
      setStatus(formatFirebaseError(e));
    } finally {
      setBusy(false);
    }
  }, [
    draftCameraFile,
    draftDiskFile,
    cameraKind,
    fileKind,
    linkedDataId,
    labelAttachment,
    persistUpload,
    resetExtras,
  ]);

  const startCamera = async () => {
    setStatus(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
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

  /** Saves scan locally only — Firebase runs on Submit. */
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
        setDraftCameraFile(file);
        setStatus("Scan saved — review and tap Submit");
        setTimeout(() => setStatus(null), 2200);
      },
      "image/jpeg",
      0.92
    );
  };

  const onGoogle = async () => {
    setMenuOpen(false);
    setBusy(true);
    try {
      await signInWithPopup(getFirebase().auth, new GoogleAuthProvider());
    } catch (e) {
      setStatus(formatFirebaseError(e));
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
      setStatus(formatFirebaseError(e));
    } finally {
      setBusy(false);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) {
      setDraftDiskFile(file);
      setStatus("File ready — tap Submit to upload");
      setTimeout(() => setStatus(null), 2200);
    }
  };

  const onFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) {
      setDraftDiskFile(file);
      setStatus("File ready — tap Submit to upload");
      setTimeout(() => setStatus(null), 2200);
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
  const hasDraft = Boolean(draftCameraFile || draftDiskFile);
  const canSubmit =
    hasDraft &&
    !(cameraKind === "label" && draftCameraFile && !linkedDataId) &&
    !(fileKind === "label" && draftDiskFile && !linkedDataId);

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
          placeholder="Optional — applied when you submit"
          value={labelText}
          onChange={(e) => setLabelText(e.target.value)}
          disabled={busy}
          autoComplete="off"
        />
      </label>

      <main className="workspace">
        <section className="pane pane-camera">
          <div className="pane-camera-heading">
            <span className="pane-camera-title">Scanner</span>
            <span className="pane-camera-sub">Capture ECG strip or document</span>
          </div>
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
          <div className="pane-frame scanner-pane">
            <video
              ref={videoRef}
              className={`camera-video ${cameraOn ? "on" : ""}`}
              playsInline
              muted
            />
            {!cameraOn && (
              <div className="camera-placeholder">Camera off</div>
            )}
            {cameraOn && (
              <div className="scanner-ui" aria-hidden>
                <div className="scanner-vignette" />
                <div className="scanner-target">
                  <span className="scanner-corner scanner-corner-tl" />
                  <span className="scanner-corner scanner-corner-tr" />
                  <span className="scanner-corner scanner-corner-bl" />
                  <span className="scanner-corner scanner-corner-br" />
                  <div className="scanner-scanline" />
                </div>
                <div className="scanner-hud">
                  <span className="scanner-hud-badge">Live</span>
                  <p className="scanner-hud-text">
                    Fit the waveform or paper inside the corners — hold steady, then capture
                  </p>
                </div>
              </div>
            )}
          </div>
          {draftCameraFile && cameraPreviewUrl && (
            <div className="draft-preview">
              <img src={cameraPreviewUrl} alt="Scan preview" />
              <button
                type="button"
                className="btn-clear-draft"
                onClick={() => setDraftCameraFile(null)}
                disabled={busy}
              >
                Clear scan
              </button>
            </div>
          )}
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
                  Capture scan
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
              {needsLinkUpload
                ? "Choose linked data first"
                : draftDiskFile
                  ? draftDiskFile.name
                  : "Tap to choose file (saved locally until Submit)"}
            </span>
          </div>
          {draftDiskFile && diskPreviewUrl && (
            <div className="draft-preview draft-preview-compact">
              <img src={diskPreviewUrl} alt="" />
              <button
                type="button"
                className="btn-clear-draft"
                onClick={() => setDraftDiskFile(null)}
                disabled={busy}
              >
                Clear file
              </button>
            </div>
          )}
        </section>
      </main>

      <div className="submit-bar">
        <button
          type="button"
          className="submit-primary"
          onClick={() => void submitAll()}
          disabled={busy || !canSubmit}
        >
          Submit to cloud
        </button>
        <p className="submit-note">Nothing uploads until you tap Submit.</p>
      </div>

      {(fileKind === "data" || cameraKind === "data") && (
        <footer className="extras">
          <label className="extras-report">
            <input
              ref={labelAttachmentRef}
              type="file"
              disabled={busy}
              onChange={(e) => setLabelAttachment(e.target.files?.[0] ?? null)}
            />
            <span>{labelAttachment ? labelAttachment.name : "Extra label file"}</span>
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
