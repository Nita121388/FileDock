import { useEffect, useMemo, useRef, useState } from "react";
import { WorkspaceView } from "./components/WorkspaceView";
import {
  DEFAULT_APP_STATE,
  type AppState,
  type TabState,
  newTab,
  removeTab
} from "./model/state";
import { loadState, saveState } from "./model/storage";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from "./model/settings";
import {
  basename,
  loadTransfers,
  saveTransfers,
  uid,
  type Conn,
  type TransferJob,
  type TransferProgress,
  type TransferStatus
} from "./model/transfers";
import {
  apiGetBytes,
  apiGetUint8Array,
  chunksPresence,
  createSnapshot,
  getTree,
  getManifest,
  putChunk,
  putManifest
} from "./api/client";
import { chunkBytes } from "./util/chunking";

export default function App() {
  const [state, setState] = useState<AppState>(() => loadState() ?? DEFAULT_APP_STATE);
  const [settings, setSettings] = useState<Settings>(() => loadSettings() ?? DEFAULT_SETTINGS);
  const [transfers, setTransfers] = useState<TransferJob[]>(() => loadTransfers());
  const abortersRef = useRef<Map<string, AbortController>>(new Map());

  const getRateLimitBytesPerSec = (): number => {
    try {
      const raw = localStorage.getItem("filedock.desktop.queue.v1");
      if (!raw) return 0;
      const parsed = JSON.parse(raw) as any;
      const mbps = Number(parsed?.maxMBps);
      if (!Number.isFinite(mbps) || mbps <= 0) return 0;
      return mbps * 1024 * 1024;
    } catch {
      return 0;
    }
  };

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const makeLimiter = (bytesPerSec: number) => {
    if (!bytesPerSec || bytesPerSec <= 0) return null;
    const start = performance.now();
    return async (doneBytes: number) => {
      const idealMs = (doneBytes / bytesPerSec) * 1000;
      const elapsedMs = performance.now() - start;
      if (idealMs > elapsedMs) await sleep(idealMs - elapsedMs);
    };
  };

  useEffect(() => {
    saveState(state);
  }, [state]);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    saveTransfers(transfers);
  }, [transfers]);

  const activeTab: TabState = useMemo(() => {
    const t = state.tabs.find((x) => x.id === state.activeTabId);
    return t ?? state.tabs[0];
  }, [state]);

  const setActiveTab = (tabId: string) => {
    setState((s) => ({ ...s, activeTabId: tabId }));
  };

  const onNewTab = () => {
    setState((s) => {
      const t = newTab("Workspace");
      return {
        ...s,
        tabs: [...s.tabs, t],
        activeTabId: t.id
      };
    });
  };

  const onCloseTab = (tabId: string) => {
    setState((s) => {
      const next = removeTab(s, tabId);
      return next;
    });
  };

  const enqueueDownload = (snapshotId: string, path: string, conn?: Conn) => {
    const job: TransferJob = {
      id: uid("xfer"),
      kind: "download",
      createdAt: Date.now(),
      status: "queued",
      conn,
      snapshotId,
      path,
      fileName: basename(path)
    };
    setTransfers((xs) => [job, ...xs]);
  };

  const enqueueCopy = (req: {
    src: Conn;
    srcSnapshotId: string;
    srcPath: string;
    dst: Conn;
    dstDeviceName: string;
    dstDeviceId?: string;
    dstPath: string;
    dstBaseSnapshotId?: string;
    conflictPolicy?: "overwrite" | "skip" | "rename";
  }) => {
    const job: TransferJob = {
      id: uid("xfer"),
      kind: "copy_file",
      createdAt: Date.now(),
      status: "queued",
      src: req.src,
      dst: req.dst,
      srcSnapshotId: req.srcSnapshotId,
      srcPath: req.srcPath,
      dstDeviceName: req.dstDeviceName,
      dstDeviceId: req.dstDeviceId,
      dstPath: req.dstPath,
      dstBaseSnapshotId: req.dstBaseSnapshotId,
      conflictPolicy: req.conflictPolicy ?? "overwrite"
    };
    setTransfers((xs) => [job, ...xs]);
  };

  const enqueueCopyFolder = (req: {
    src: Conn;
    srcSnapshotId: string;
    srcDirPath: string;
    dst: Conn;
    dstDeviceName: string;
    dstDeviceId?: string;
    dstDirPath: string;
    dstBaseSnapshotId?: string;
    conflictPolicy?: "overwrite" | "skip" | "rename";
  }) => {
    const job: TransferJob = {
      id: uid("xfer"),
      kind: "copy_folder",
      createdAt: Date.now(),
      status: "queued",
      src: req.src,
      dst: req.dst,
      srcSnapshotId: req.srcSnapshotId,
      srcDirPath: req.srcDirPath,
      dstDeviceName: req.dstDeviceName,
      dstDeviceId: req.dstDeviceId,
      dstDirPath: req.dstDirPath,
      dstBaseSnapshotId: req.dstBaseSnapshotId,
      conflictPolicy: req.conflictPolicy ?? "overwrite",
      nextIndex: 0,
      filePaths: undefined
    } as any;
    setTransfers((xs) => [job, ...xs]);
  };

  const removeTransfer = (id: string) => setTransfers((xs) => xs.filter((x) => x.id !== id));
  const setTransferStatus = (id: string, status: TransferStatus) => {
    setTransfers((xs) => xs.map((x) => (x.id === id ? { ...x, status } : x)));
  };
  const setTransferProgress = (id: string, progress: TransferProgress | undefined) => {
    setTransfers((xs) => xs.map((x) => (x.id === id ? { ...x, progress } : x)));
  };
  const setTransferError = (id: string, error: string | undefined) => {
    setTransfers((xs) => xs.map((x) => (x.id === id ? { ...x, error } : x)));
  };

  const patchTransfer = (id: string, patch: (j: TransferJob) => TransferJob) => {
    setTransfers((xs) => xs.map((x) => (x.id === id ? patch(x) : x)));
  };

  function isAbortError(e: unknown): boolean {
    const any = e as any;
    return any?.name === "AbortError" || String(any?.message ?? "").toLowerCase().includes("aborted");
  }

  const withRetry = async <T,>(fn: () => Promise<T>, tries = 3): Promise<T> => {
    let last: unknown = null;
    for (let attempt = 0; attempt < tries; attempt++) {
      try {
        return await fn();
      } catch (e) {
        // Stop retry loops on user cancel.
        if (isAbortError(e)) throw e;
        last = e;
        const ms = Math.min(3000, 250 * Math.pow(2, attempt)) + Math.floor(Math.random() * 150);
        await new Promise((r) => setTimeout(r, ms));
      }
    }
    throw last;
  };

  const newAborter = (id: string): AbortController => {
    // Replace any previous controller for the same job id.
    const prev = abortersRef.current.get(id);
    if (prev) {
      try {
        prev.abort();
      } catch {
        // ignore
      }
    }
    const ac = new AbortController();
    abortersRef.current.set(id, ac);
    return ac;
  };

  const clearAborter = (id: string) => {
    abortersRef.current.delete(id);
  };

  const cancelTransfer = (id: string) => {
    const ac = abortersRef.current.get(id);
    if (!ac) return;
    try {
      ac.abort();
    } finally {
      // Status update happens in the transfer catch handler.
    }
  };

  const connToSettings = (c: Conn): Settings => ({
    serverBaseUrl: c.serverBaseUrl,
    token: c.token,
    deviceId: c.deviceId,
    deviceToken: c.deviceToken
  });

  const downloadNow = async (id: string) => {
    const job = transfers.find((x) => x.id === id);
    if (!job) return;
    if (job.kind !== "download") return;
    if (job.status === "running" || job.status === "done") return;
    const ac = newAborter(id);
    setTransferStatus(id, "running");
    setTransferError(id, undefined);
    try {
      const eff = job.conn ? connToSettings(job.conn) : settings;
      const limiter = makeLimiter(getRateLimitBytesPerSec());
      setTransferProgress(id, { phase: "downloading", pct: 0 });
      const buf = await withRetry(async () => {
        return await apiGetUint8Array(
          eff,
          `/v1/snapshots/${encodeURIComponent(job.snapshotId)}/file`,
          { path: job.path },
          (done, total) => {
            const pct = total && total > 0 ? Math.floor((done / total) * 100) : undefined;
            setTransferProgress(id, { phase: "downloading", doneBytes: done, totalBytes: total ?? undefined, pct });
          },
          ac.signal,
          limiter ? async (_chunkBytes, doneBytes) => limiter(doneBytes) : undefined
        );
      });
      setTransferProgress(id, { phase: "saving", pct: 100 });
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
      const blob = new Blob([ab]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = job.fileName || "download";
      a.click();
      URL.revokeObjectURL(url);
      setTransfers((xs) =>
        xs.map((x) => (x.id === id ? { ...x, status: "done", error: undefined, progress: undefined } : x))
      );
    } catch (e: any) {
      if (isAbortError(e)) {
        setTransfers((xs) =>
          xs.map((x) => (x.id === id ? { ...x, status: "failed", error: "canceled", progress: undefined } : x))
        );
        return;
      }
      const msg = String(e?.message ?? e);
      setTransfers((xs) =>
        xs.map((x) => (x.id === id ? { ...x, status: "failed", error: msg, progress: undefined } : x))
      );
    } finally {
      clearAborter(id);
    }
  };

  const copyNow = async (id: string) => {
    const job = transfers.find((x) => x.id === id);
    if (!job) return;
    if (job.kind !== "copy_file") return;
    if (job.status === "running" || job.status === "done") return;
    const ac = newAborter(id);
    setTransferStatus(id, "running");
    setTransferError(id, undefined);

    const srcSettings = connToSettings(job.src);
    const dstSettings = connToSettings(job.dst);

    try {
      // Optional: base the destination on an existing snapshot manifest (copy-on-write into a new snapshot).
      const baseFiles: { path: string; size: number; mtime_unix: number; chunks: { hash: string; size: number }[] }[] =
        [];
      if (job.dstBaseSnapshotId) {
        setTransferProgress(id, { phase: "loading destination base", pct: 0 });
        try {
          const base = await getManifest(dstSettings, job.dstBaseSnapshotId, ac.signal);
          for (const f of base.files ?? []) {
            if (!f?.path || !Array.isArray(f.chunks)) continue;
            baseFiles.push({
              path: f.path,
              size: f.size,
              mtime_unix: f.mtime_unix,
              chunks: (f.chunks ?? []).map((c) => ({ hash: c.hash, size: c.size }))
            });
          }
        } catch {
          // ignore
        }
      }

      // 1) Download bytes from source server.
      setTransferProgress(id, { phase: "downloading", pct: 0 });
      const dlLimiter = makeLimiter(getRateLimitBytesPerSec());
      const buf = await withRetry(async () => {
        return await apiGetUint8Array(
          srcSettings,
          `/v1/snapshots/${encodeURIComponent(job.srcSnapshotId)}/file`,
          { path: job.srcPath },
          (done, total) => {
            const pct = total && total > 0 ? Math.floor((done / total) * 100) : undefined;
            setTransferProgress(id, { phase: "downloading", doneBytes: done, totalBytes: total ?? undefined, pct });
          },
          ac.signal,
          dlLimiter ? async (_chunkBytes, doneBytes) => dlLimiter(doneBytes) : undefined
        );
      });

      // 2) Chunk + hash.
      setTransferProgress(id, { phase: "hashing", pct: 0 });
      const refs = chunkBytes(buf);
      const hashes = refs.map((c) => c.hash);
      const manifestChunks = refs.map((c) => ({ hash: c.hash, size: c.size }));

      // 3) Presence (batched) on destination.
      setTransferProgress(id, { phase: "checking", pct: 0 });
      const missing = new Set<string>();
      const batchSize = 1000;
      for (let i = 0; i < hashes.length; i += batchSize) {
        const batch = hashes.slice(i, i + batchSize);
        const resp = await chunksPresence(dstSettings, { hashes: batch }, ac.signal);
        for (const h of resp.missing) missing.add(h);
      }

      // 4) Upload missing chunks.
      setTransferProgress(id, { phase: "uploading", pct: 0 });
      const ulLimiter = makeLimiter(getRateLimitBytesPerSec());
      let offset = 0;
      let uploaded = 0;
      for (const c of refs) {
        const end = offset + c.size;
        if (missing.has(c.hash)) {
          await withRetry(async () => {
            await putChunk(dstSettings, c.hash, buf.subarray(offset, end), ac.signal);
          });
          uploaded++;
        }
        offset = end;
        if (ulLimiter) await ulLimiter(offset);
        const pct = refs.length > 0 ? Math.floor((offset / buf.length) * 100) : 100;
        setTransferProgress(id, { phase: `uploading (${uploaded}/${missing.size} chunks)`, pct });
      }

      // 5) Create snapshot + manifest on destination.
      setTransferProgress(id, { phase: "finalizing", pct: 0 });
      const now = Math.floor(Date.now() / 1000);
      const snap = await createSnapshot(
        dstSettings,
        {
          device_name: job.dstDeviceName,
          device_id: job.dstDeviceId ?? null,
          root_path: job.dstBaseSnapshotId ? `(transfer from ${job.dstBaseSnapshotId})` : "(transfer)"
        },
        ac.signal
      );

      const fileMap = new Map<
        string,
        { path: string; size: number; mtime_unix: number; chunks: { hash: string; size: number }[] }
      >();
      for (const f of baseFiles) fileMap.set(f.path, f);

      const pol = job.conflictPolicy ?? "overwrite";
      const choosePath = (p: string): string | null => {
        if (!fileMap.has(p)) return p;
        if (pol === "skip") return null;
        if (pol === "overwrite") return p;
        // rename
        const dot = p.lastIndexOf(".");
        const base = dot > 0 ? p.slice(0, dot) : p;
        const ext = dot > 0 ? p.slice(dot) : "";
        for (let i = 2; i < 1000; i++) {
          const cand = `${base} (${i})${ext}`;
          if (!fileMap.has(cand)) return cand;
        }
        return p;
      };

      const finalPath = choosePath(job.dstPath);
      if (finalPath !== null) {
        fileMap.set(finalPath, {
          path: finalPath,
          size: buf.length,
          mtime_unix: now,
          chunks: manifestChunks
        });
      }

      const files = Array.from(fileMap.values()).sort((a, b) => a.path.localeCompare(b.path));
      await putManifest(
        dstSettings,
        snap.snapshot_id,
        {
          snapshot_id: snap.snapshot_id,
          created_unix: now,
          files: files.map((f) => ({
            path: f.path,
            size: f.size,
            mtime_unix: f.mtime_unix,
            chunk_hash: null,
            chunks: f.chunks
          }))
        },
        ac.signal
      );

      setTransfers((xs) =>
        xs.map((x) => (x.id === id ? { ...x, status: "done", error: undefined, progress: undefined } : x))
      );
    } catch (e: any) {
      if (isAbortError(e)) {
        setTransfers((xs) =>
          xs.map((x) => (x.id === id ? { ...x, status: "failed", error: "canceled", progress: undefined } : x))
        );
        return;
      }
      const msg = String(e?.message ?? e);
      setTransfers((xs) =>
        xs.map((x) => (x.id === id ? { ...x, status: "failed", error: msg, progress: undefined } : x))
      );
    } finally {
      clearAborter(id);
    }
  };

  const copyFolderNow = async (id: string) => {
    const job = transfers.find((x) => x.id === id);
    if (!job) return;
    if (job.kind !== "copy_folder") return;
    if (job.status === "running" || job.status === "done") return;

    const ac = newAborter(id);
    setTransferStatus(id, "running");
    setTransferError(id, undefined);

    const srcSettings = connToSettings(job.src);
    const dstSettings = connToSettings(job.dst);
    let dstSnapshotId = job.dstSnapshotId;
    let filesList: string[] = (job.filePaths ?? []) as any;
    let nextIndex: number = job.nextIndex ?? 0;
    let manifestFiles: { path: string; size: number; mtime_unix: number; chunks: { hash: string; size: number }[] }[] =
      [];

    try {
      // 1) Ensure destination snapshot exists.
      if (!dstSnapshotId) {
        setTransferProgress(id, { phase: "creating snapshot", pct: 0 });
        const snap = await createSnapshot(
          dstSettings,
          {
            device_name: job.dstDeviceName,
            device_id: job.dstDeviceId ?? null,
            root_path: job.dstBaseSnapshotId ? `(transfer-folder from ${job.dstBaseSnapshotId})` : "(transfer-folder)"
          },
          ac.signal
        );
        patchTransfer(id, (x) => ({ ...(x as any), dstSnapshotId: snap.snapshot_id }));
        dstSnapshotId = snap.snapshot_id;
      }

      // 1.5) Load destination manifest (for resume / skip already-copied files).
      setTransferProgress(id, { phase: "loading destination manifest", pct: 0 });
      try {
        const m = await getManifest(dstSettings, dstSnapshotId!, ac.signal);
        manifestFiles = (m.files ?? [])
          .filter((f) => f && typeof f.path === "string" && Array.isArray(f.chunks))
          .map((f) => ({
            path: f.path,
            size: f.size,
            mtime_unix: f.mtime_unix,
            chunks: (f.chunks ?? []).map((c) => ({ hash: c.hash, size: c.size }))
          }));
      } catch {
        // Manifest may not exist yet; treat as empty.
        manifestFiles = [];
      }

      // If this job is based on another snapshot and the destination snapshot is empty, seed it now.
      if (manifestFiles.length === 0 && job.dstBaseSnapshotId) {
        setTransferProgress(id, { phase: "seeding base manifest", pct: 0 });
        try {
          const base = await getManifest(dstSettings, job.dstBaseSnapshotId, ac.signal);
          manifestFiles = (base.files ?? [])
            .filter((f) => f && typeof f.path === "string" && Array.isArray(f.chunks))
            .map((f) => ({
              path: f.path,
              size: f.size,
              mtime_unix: f.mtime_unix,
              chunks: (f.chunks ?? []).map((c) => ({ hash: c.hash, size: c.size }))
            }));
          await putManifest(
            dstSettings,
            dstSnapshotId!,
            {
              snapshot_id: dstSnapshotId!,
              created_unix: Math.floor(Date.now() / 1000),
              files: manifestFiles.map((f) => ({
                path: f.path,
                size: f.size,
                mtime_unix: f.mtime_unix,
                chunk_hash: null,
                chunks: f.chunks
              }))
            },
            ac.signal
          );
        } catch {
          // ignore
        }
      }

      const doneSet = new Set(manifestFiles.map((f) => f.path));
      const pol = job.conflictPolicy ?? "overwrite";

      const uniquePath = (p: string): string => {
        if (!doneSet.has(p)) return p;
        const dot = p.lastIndexOf(".");
        const base = dot > 0 ? p.slice(0, dot) : p;
        const ext = dot > 0 ? p.slice(dot) : "";
        for (let i = 2; i < 1000; i++) {
          const cand = `${base} (${i})${ext}`;
          if (!doneSet.has(cand)) return cand;
        }
        return p;
      };

      // 2) Enumerate all files under the source directory (once; persist for resume).
      if (!filesList || filesList.length === 0) {
        setTransferProgress(id, { phase: "enumerating files", pct: 0 });
        const files: string[] = [];
        const stack: string[] = [job.srcDirPath || ""];
        while (stack.length > 0) {
          const cur = stack.pop()!;
          const tr = await getTree(srcSettings, job.srcSnapshotId, cur, ac.signal);
          for (const e of tr.entries) {
            const child = cur ? `${cur}/${e.name}` : e.name;
            if (e.kind === "dir") stack.push(child);
            else files.push(child);
          }
          if (stack.length + files.length > 200000) throw new Error("too many files for desktop copy");
        }
        files.sort();
        patchTransfer(id, (x) => ({ ...(x as any), filePaths: files, nextIndex: 0 }));
        filesList = files;
        nextIndex = 0;
      }

      const total = filesList.length;

      const bytesPerSec = getRateLimitBytesPerSec();

      // 3) Copy files sequentially (per-job concurrency can come later; queue concurrency already exists).
      for (let i = nextIndex; i < total; i++) {
        const srcFilePath = filesList[i]!;
        const rel = job.srcDirPath ? srcFilePath.slice(job.srcDirPath.length + 1) : srcFilePath;
        let dstFilePath = job.dstDirPath ? `${job.dstDirPath}/${rel}` : rel;

        if (doneSet.has(dstFilePath)) {
          if (pol === "skip") {
            const pct = total > 0 ? Math.floor(((i + 1) / total) * 100) : 0;
            setTransferProgress(id, { phase: `skipping ${dstFilePath}`, pct });
            patchTransfer(id, (x) => ({ ...(x as any), nextIndex: i + 1 }));
            continue;
          }
          if (pol === "rename") {
            dstFilePath = uniquePath(dstFilePath);
          }
          if (pol === "overwrite") {
            // Remove existing entry before rewriting.
            manifestFiles = manifestFiles.filter((f) => f.path !== dstFilePath);
            doneSet.delete(dstFilePath);
          }
        }

        const dlLimiter = makeLimiter(bytesPerSec);
        const buf = await withRetry(async () => {
          return await apiGetUint8Array(
            srcSettings,
            `/v1/snapshots/${encodeURIComponent(job.srcSnapshotId)}/file`,
            { path: srcFilePath },
            (done, totalBytes) => {
              const frac = totalBytes && totalBytes > 0 ? done / totalBytes : 0;
              const pct = total > 0 ? Math.floor(((i + frac) / total) * 100) : 0;
              setTransferProgress(id, { phase: `downloading ${srcFilePath}`, doneBytes: done, totalBytes: totalBytes ?? undefined, pct });
            },
            ac.signal,
            dlLimiter ? async (_chunk, doneBytes) => dlLimiter(doneBytes) : undefined
          );
        });

        setTransferProgress(id, { phase: `hashing ${srcFilePath}`, pct: total > 0 ? Math.floor(((i + 0.5) / total) * 100) : 0 });
        const refs = chunkBytes(buf);
        const hashes = refs.map((c) => c.hash);
        const manifestChunks = refs.map((c) => ({ hash: c.hash, size: c.size }));

        // Presence on destination.
        const missing = new Set<string>();
        const batchSize = 1000;
        for (let j = 0; j < hashes.length; j += batchSize) {
          const batch = hashes.slice(j, j + batchSize);
          const resp = await chunksPresence(dstSettings, { hashes: batch }, ac.signal);
          for (const h of resp.missing) missing.add(h);
        }

        // Upload missing chunks.
        const ulLimiter = makeLimiter(bytesPerSec);
        let offset = 0;
        let uploaded = 0;
        for (const c of refs) {
          const end = offset + c.size;
          if (missing.has(c.hash)) {
            await withRetry(async () => {
              await putChunk(dstSettings, c.hash, buf.subarray(offset, end), ac.signal);
            });
            uploaded++;
          }
          offset = end;
          if (ulLimiter) await ulLimiter(offset);
          const pct = total > 0 ? Math.floor(((i + (offset / Math.max(1, buf.length))) / total) * 100) : 0;
          setTransferProgress(id, { phase: `uploading ${srcFilePath} (${uploaded}/${missing.size} chunks)`, pct });
        }

        const now = Math.floor(Date.now() / 1000);
        manifestFiles.push({
          path: dstFilePath,
          size: buf.length,
          mtime_unix: now,
          chunks: manifestChunks
        });
        doneSet.add(dstFilePath);

        // Persist resume point after each file and write manifest for crash-resume.
        patchTransfer(id, (x) => ({ ...(x as any), nextIndex: i + 1 }));
        await putManifest(
          dstSettings,
          dstSnapshotId!,
          {
            snapshot_id: dstSnapshotId!,
            created_unix: Math.floor(Date.now() / 1000),
            files: manifestFiles.map((f) => ({
              path: f.path,
              size: f.size,
              mtime_unix: f.mtime_unix,
              chunk_hash: null,
              chunks: f.chunks
            }))
          },
          ac.signal
        );
      }

      setTransferProgress(id, { phase: "writing manifest", pct: 99 });
      await putManifest(
        dstSettings,
        dstSnapshotId!,
        {
          snapshot_id: dstSnapshotId!,
          created_unix: Math.floor(Date.now() / 1000),
          files: manifestFiles.map((e) => ({
            path: e.path,
            size: e.size,
            mtime_unix: e.mtime_unix,
            chunk_hash: null,
            chunks: e.chunks
          }))
        },
        ac.signal
      );

      setTransfers((xs) =>
        xs.map((x) => (x.id === id ? { ...x, status: "done", error: undefined, progress: undefined } : x))
      );
    } catch (e: any) {
      if (isAbortError(e)) {
        setTransfers((xs) =>
          xs.map((x) => (x.id === id ? { ...x, status: "failed", error: "canceled", progress: undefined } : x))
        );
        return;
      }
      const msg = String(e?.message ?? e);
      setTransfers((xs) =>
        xs.map((x) => (x.id === id ? { ...x, status: "failed", error: msg, progress: undefined } : x))
      );
    } finally {
      clearAborter(id);
    }
  };

  const runTransfer = async (id: string) => {
    const job = transfers.find((x) => x.id === id);
    if (!job) return;
    if (job.kind === "download") return downloadNow(id);
    if (job.kind === "copy_file") return copyNow(id);
    if (job.kind === "copy_folder") return copyFolderNow(id);
  };

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <h1>FileDock</h1>
          <div className="meta">desktop UI shell</div>
        </div>

        <div className="conn">
          <input
            className="conn-input"
            value={settings.serverBaseUrl}
            onChange={(e) => setSettings((s) => ({ ...s, serverBaseUrl: e.target.value }))}
            placeholder="http://127.0.0.1:8787"
            title="Server base URL"
          />
          <input
            className="conn-input"
            value={settings.token}
            onChange={(e) => setSettings((s) => ({ ...s, token: e.target.value }))}
            placeholder="token (optional)"
            title="X-FileDock-Token (optional)"
          />
          <input
            className="conn-input"
            value={settings.deviceId}
            onChange={(e) => setSettings((s) => ({ ...s, deviceId: e.target.value }))}
            placeholder="device id (optional)"
            title="X-FileDock-Device-Id (optional)"
          />
          <input
            className="conn-input"
            value={settings.deviceToken}
            onChange={(e) => setSettings((s) => ({ ...s, deviceToken: e.target.value }))}
            placeholder="device token (optional)"
            title="X-FileDock-Device-Token (optional)"
          />
        </div>

        <div className="tabs" role="tablist" aria-label="Workspaces">
          {state.tabs.map((t) => (
            <div
              key={t.id}
              className={t.id === activeTab.id ? "tab active" : "tab"}
              role="tab"
              aria-selected={t.id === activeTab.id}
              tabIndex={0}
              onClick={() => setActiveTab(t.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") setActiveTab(t.id);
              }}
            >
              <span className="dot" />
              <span>{t.name}</span>
              {state.tabs.length > 1 ? (
                <button
                  className="tab-close"
                  title="Close tab"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(t.id);
                  }}
                >
                  x
                </button>
              ) : null}
            </div>
          ))}
        </div>

        <button className="btn primary" onClick={onNewTab} title="New tab">
          + Tab
        </button>
      </div>

      <div className="workspace" role="main">
        <WorkspaceView
          tab={activeTab}
          settings={settings}
          transfers={transfers}
          onEnqueueDownload={enqueueDownload}
          onEnqueueCopy={enqueueCopy}
          onEnqueueCopyFolder={enqueueCopyFolder}
          onRemoveTransfer={removeTransfer}
          onRunTransfer={runTransfer}
          onCancelTransfer={cancelTransfer}
          onSetDeviceAuth={(deviceId, deviceToken) =>
            setSettings((s) => ({ ...s, deviceId, deviceToken }))
          }
          onTabChange={(tab) => {
            setState((s) => ({
              ...s,
              tabs: s.tabs.map((x) => (x.id === tab.id ? tab : x))
            }));
          }}
        />
      </div>

      <div className="statusbar">
        <span className="kbd">Split</span> via pane toolbar
        <span className="kbd">Drag</span> gutters to resize
        <span className="kbd">Persist</span> layouts saved locally per tab
      </div>
    </div>
  );
}
