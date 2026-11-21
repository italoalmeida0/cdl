import { createSignal, For, onMount, Show } from "solid-js";

import {
  api,
  uploadFileChunked,
  type FileEntryDto,
  type LinkDto,
  type LinkPolicyDefaults,
  type MountStatusDto,
  type UploadDto,
  type UploadProgress,
} from "../api";
import { PageTitle } from "../chrome";
import { LinkComposerModal, type ComposerPrefill } from "../components/LinkComposerModal";
import { LinkShareModal } from "../components/LinkShareModal";
import {
  Alert,
  Badge,
  Btn,
  Card,
  EmptyState,
  Icon,
  IconBtn,
  Icons,
  Progress,
  Segmented,
  SwitchCard,
  fmtBytes,
  fmtDate,
  fmtDuration,
  fmtSpeed,
  toast,
} from "../ui";

interface UploadJob {
  id: string;
  filename: string;
  size: number;
  progress: UploadProgress;
  abort: AbortController;
  error?: string;
}

export default function FilesPage() {
  const [tab, setTab] = createSignal<"mount" | "uploads">("mount");

  // Mounted library state
  const [mountStatus, setMountStatus] = createSignal<MountStatusDto | null>(null);
  const [relPath, setRelPath] = createSignal("");
  const [breadcrumbs, setBreadcrumbs] = createSignal<Array<{ name: string; relPath: string }>>([]);
  const [entries, setEntries] = createSignal<FileEntryDto[]>([]);
  const [search, setSearch] = createSignal("");
  const [recursive, setRecursive] = createSignal(false);
  const [sortBy, setSortBy] = createSignal<"name" | "size" | "mtime">("name");
  const [loadingMount, setLoadingMount] = createSignal(false);
  const [hashingKey, setHashingKey] = createSignal<string | null>(null);

  // Uploads state
  const [uploads, setUploads] = createSignal<UploadDto[]>([]);
  const [jobs, setJobs] = createSignal<UploadJob[]>([]);
  const [dragging, setDragging] = createSignal(false);

  // Composer / share state
  const [defaults, setDefaults] = createSignal<LinkPolicyDefaults | null>(null);
  const [clientIp, setClientIp] = createSignal("");
  const [prefill, setPrefill] = createSignal<ComposerPrefill | null>(null);
  const [composerOpen, setComposerOpen] = createSignal(false);
  const [shareLink, setShareLink] = createSignal<LinkDto | null>(null);

  const loadMount = async (dir = relPath(), q = search(), rec = recursive(), sort = sortBy()) => {
    setLoadingMount(true);
    try {
      const qs = new URLSearchParams({ path: dir, sort });
      if (q.trim()) qs.set("q", q.trim());
      if (rec || q.trim()) qs.set("recursive", "true");
      const res = await api<{
        mount: MountStatusDto;
        relPath: string;
        breadcrumbs: Array<{ name: string; relPath: string }>;
        entries: FileEntryDto[];
      }>("GET", `/api/files?${qs.toString()}`);
      setMountStatus(res.mount);
      setRelPath(res.relPath);
      setBreadcrumbs(res.breadcrumbs);
      setEntries(res.entries);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to list mounted files", "err");
    } finally {
      setLoadingMount(false);
    }
  };

  const loadUploads = async () => {
    try {
      const res = await api<{ uploads: UploadDto[] }>("GET", "/api/uploads");
      setUploads(res.uploads);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to list uploads", "err");
    }
  };

  onMount(async () => {
    void loadMount("");
    void loadUploads();
    try {
      const s = await api<{ clientIp: string; defaultPolicy: LinkPolicyDefaults }>("GET", "/api/settings");
      setClientIp(s.clientIp);
      setDefaults(s.defaultPolicy);
    } catch {}
  });

  const startUploads = async (fileList: FileList | null, shareAfter = false) => {
    if (!fileList || fileList.length === 0) return;
    setTab("uploads");
    for (const file of Array.from(fileList)) {
      const jobId = Math.random().toString(36).slice(2);
      const abort = new AbortController();
      setJobs((prev) => [
        ...prev,
        {
          id: jobId,
          filename: file.name,
          size: file.size,
          abort,
          progress: { loaded: 0, total: file.size, pct: 0, bytesPerSec: 0, etaSec: null },
        },
      ]);

      try {
        const uploaded = await uploadFileChunked(file, {
          signal: abort.signal,
          onProgress: (p) => {
            setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, progress: p } : j)));
          },
        });
        setJobs((prev) => prev.filter((j) => j.id !== jobId));
        toast(`Uploaded ${uploaded.originalName}`);
        await loadUploads();
        if (shareAfter) {
          setPrefill({
            sourceType: "upload",
            uploadId: uploaded.id,
            filename: uploaded.originalName,
            fileSize: uploaded.sizeBytes,
          });
          setComposerOpen(true);
        }
      } catch (e) {
        const msg = abort.signal.aborted ? "Cancelled" : e instanceof Error ? e.message : "Upload failed";
        setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, error: msg } : j)));
      }
    }
  };

  const computeChecksum = async (sourceType: "mount" | "upload", key: string) => {
    setHashingKey(key);
    try {
      await api("POST", "/api/files/checksum", {
        sourceType,
        sourcePath: sourceType === "mount" ? key : undefined,
        uploadId: sourceType === "upload" ? key : undefined,
      });
      toast("SHA-256 computed");
      if (sourceType === "mount") await loadMount();
      else await loadUploads();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to compute SHA-256", "err");
    } finally {
      setHashingKey(null);
    }
  };

  const deleteUpload = async (u: UploadDto) => {
    try {
      await api("DELETE", `/api/uploads/${u.id}`);
      toast(`Deleted ${u.originalName}`);
      await loadUploads();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to delete upload", "err");
    }
  };

  const openShareMount = (entry: FileEntryDto) => {
    setPrefill({
      sourceType: "mount",
      sourcePath: entry.relPath,
      filename: entry.name,
      fileSize: entry.sizeBytes,
    });
    setComposerOpen(true);
  };

  const openShareUpload = (u: UploadDto) => {
    setPrefill({
      sourceType: "upload",
      uploadId: u.id,
      filename: u.originalName,
      fileSize: u.sizeBytes,
    });
    setComposerOpen(true);
  };

  return (
    <div class="space-y-5">
      <PageTitle
        title="Files & Uploads"
        subtitle="Browse your mounted container folder or upload huge files directly from your PC."
        right={
          <Segmented
            value={tab()}
            onChange={setTab}
            options={[
              { value: "mount", label: "Mounted Library" },
              { value: "uploads", label: "PC Uploads", badge: uploads().length || undefined },
            ]}
          />
        }
      />

      <Show when={tab() === "mount"}>
        <Show
          when={mountStatus()?.available}
          fallback={
            <Alert tone="warn" title="Mounted directory unavailable">
              Path <code class="font-mono">{mountStatus()?.path ?? "/files"}</code> is not mounted or readable. Bind your media/files folder with{" "}
              <code class="font-mono">-v /host/path:/files:ro</code> in Docker, or switch to the <strong>PC Uploads</strong> tab.
            </Alert>
          }
        >
          <Card>
            <div class="p-4 border-b border-border flex flex-wrap items-center justify-between gap-3">
              {/* Breadcrumbs */}
              <div class="flex items-center gap-1 flex-wrap text-sm">
                <Icon name={Icons.hardDrive} size={15} class="text-accent mr-1" />
                <For each={breadcrumbs()}>
                  {(crumb, idx) => (
                    <>
                      <Show when={idx() > 0}>
                        <Icon name={Icons.chevronRight} size={14} class="text-fg-muted" />
                      </Show>
                      <button
                        type="button"
                        onClick={() => void loadMount(crumb.relPath)}
                        class="px-2 py-1 rounded-md hover:bg-surface-muted text-fg-secondary hover:text-fg transition-colors cursor-pointer font-medium"
                      >
                        {crumb.name}
                      </button>
                    </>
                  )}
                </For>
              </div>

              <div class="flex flex-col sm:flex-row sm:items-center gap-2 w-full sm:w-auto">
                <input
                  type="search"
                  value={search()}
                  onInput={(e) => {
                    const v = e.currentTarget.value;
                    setSearch(v);
                    void loadMount(relPath(), v, recursive(), sortBy());
                  }}
                  placeholder="Search mounted files…"
                  class="ui-field ui-field-sm w-full sm:w-56"
                />
                <div class="flex items-center justify-between sm:justify-start gap-2">
                  <Btn
                    size="sm"
                    variant={sortBy() === "size" ? "secondary" : "ghost"}
                    onClick={() => {
                      const next = sortBy() === "name" ? "size" : sortBy() === "size" ? "mtime" : "name";
                      setSortBy(next);
                      void loadMount(relPath(), search(), recursive(), next);
                    }}
                  >
                    Sort: {sortBy()}
                  </Btn>
                  <IconBtn icon={Icons.refresh} title="Refresh directory" onClick={() => void loadMount()} />
                </div>
              </div>
            </div>

            <div class="px-4 py-2 border-b border-border-subtle bg-surface-subtle">
              <SwitchCard
                checked={recursive()}
                onChange={(v) => {
                  setRecursive(v);
                  void loadMount(relPath(), search(), v, sortBy());
                }}
                title="Flatten subfolders recursively"
                class="!p-0 !border-0 !bg-transparent"
              />
            </div>

            <Show
              when={!loadingMount() && entries().length > 0}
              fallback={
                <div class="p-8">
                  <EmptyState
                    icon={Icons.folderOpen}
                    title={loadingMount() ? "Scanning mounted folder…" : "This folder is empty"}
                    hint={loadingMount() ? undefined : "Place files in your mounted directory and refresh."}
                  />
                </div>
              }
            >
              <div class="divide-y divide-border-subtle">
                <For each={entries()}>
                  {(entry) => (
                    <div class="px-4 py-3 flex items-center justify-between gap-3 hover:bg-surface-subtle/70 transition-colors">
                      <div
                        class={`flex items-center gap-3 min-w-0 ${entry.isDir ? "cursor-pointer" : ""}`}
                        onClick={() => {
                          if (entry.isDir) {
                            setSearch("");
                            void loadMount(entry.relPath, "", recursive(), sortBy());
                          }
                        }}
                      >
                        <Icon
                          name={entry.isDir ? Icons.folder : Icons.file}
                          size={18}
                          class={entry.isDir ? "text-warning shrink-0" : "text-fg-muted shrink-0"}
                        />
                        <div class="min-w-0">
                          <div class="text-sm font-medium text-fg truncate">
                            {recursive() ? entry.relPath : entry.name}
                          </div>
                          <div class="text-xs text-fg-muted flex flex-wrap items-center gap-x-3 gap-y-1 mt-0.5">
                            <Show when={!entry.isDir}>
                              <span class="tabular-nums">{fmtBytes(entry.sizeBytes)}</span>
                            </Show>
                            <span>{fmtDate(entry.mtimeMs)}</span>
                            <Show when={entry.activeLinksCount > 0}>
                              <Badge tone="accent" size="sm">{entry.activeLinksCount} active link(s)</Badge>
                            </Show>
                            <Show when={entry.sha256}>
                              <code class="font-mono text-2xs text-fg-secondary">sha256:{entry.sha256!.slice(0, 12)}…</code>
                            </Show>
                          </div>
                        </div>
                      </div>

                      <div class="flex items-center gap-1.5 shrink-0">
                        <Show
                          when={!entry.isDir}
                          fallback={
                            <Btn size="xs" variant="ghost" onClick={() => void loadMount(entry.relPath, "", recursive(), sortBy())}>
                              Open
                            </Btn>
                          }
                        >
                          <IconBtn
                            icon={Icons.hash}
                            title="Compute SHA-256"
                            disabled={hashingKey() === entry.relPath}
                            onClick={() => void computeChecksum("mount", entry.relPath)}
                          />
                          <Btn size="xs" onClick={() => openShareMount(entry)}>
                            <Icon name={Icons.share} size={13} />
                            Create Link
                          </Btn>
                        </Show>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Card>
        </Show>
      </Show>

      <Show when={tab() === "uploads"}>
        <div class="space-y-4">
          {/* Drag and Drop Uploader */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              void startUploads(e.dataTransfer?.files ?? null, false);
            }}
            class={`rounded-surface border-2 border-dashed p-6 text-center transition-colors ${
              dragging()
                ? "border-accent bg-accent-subtle"
                : "border-border-strong bg-surface-subtle hover:bg-surface-muted/40"
            }`}
          >
            <div class="flex flex-col items-center gap-2 max-w-md mx-auto">
              <Icon name={Icons.upload} size={28} class="text-accent" />
              <div class="text-sm font-medium text-fg">Drop files here or choose from your computer</div>
              <p class="text-xs text-fg-secondary">
                Files upload in resilient 8 MiB chunks straight to disk — ideal for multi-GB archives, ISOs, or datasets.
              </p>
              <div class="flex flex-wrap items-center justify-center gap-2 pt-2">
                <label class="ui-button ui-button-primary ui-button-sm cursor-pointer">
                  <Icon name={Icons.upload} size={14} />
                  <span>Upload &amp; Create Link</span>
                  <input
                    type="file"
                    class="sr-only"
                    onChange={(e) => void startUploads(e.currentTarget.files, true)}
                  />
                </label>
                <label class="ui-button ui-button-secondary ui-button-sm cursor-pointer">
                  <Icon name={Icons.plus} size={14} />
                  <span>Upload Only</span>
                  <input
                    type="file"
                    multiple
                    class="sr-only"
                    onChange={(e) => void startUploads(e.currentTarget.files, false)}
                  />
                </label>
              </div>
            </div>
          </div>

          {/* Active Upload Jobs */}
          <Show when={jobs().length > 0}>
            <Card class="p-4 space-y-3">
              <div class="text-sm font-medium text-fg">Uploading…</div>
              <For each={jobs()}>
                {(job) => (
                  <div class="rounded-panel border border-border bg-surface-subtle p-3 space-y-2">
                    <div class="flex items-center justify-between gap-2 text-xs">
                      <span class="font-medium text-fg truncate">{job.filename}</span>
                      <div class="flex items-center gap-2 shrink-0">
                        <Show
                          when={!job.error}
                          fallback={<Badge tone="red">{job.error}</Badge>}
                        >
                          <span class="font-mono text-accent tabular-nums">
                            {job.progress.pct}% · {fmtSpeed(job.progress.bytesPerSec)}
                            {job.progress.etaSec ? ` · ETA ${fmtDuration(job.progress.etaSec)}` : ""}
                          </span>
                        </Show>
                        <Btn
                          size="xs"
                          variant="ghost"
                          onClick={() => {
                            job.abort.abort();
                            setJobs((prev) => prev.filter((x) => x.id !== job.id));
                          }}
                        >
                          Cancel
                        </Btn>
                      </div>
                    </div>
                    <Progress value={job.progress.loaded} max={job.size || 1} />
                  </div>
                )}
              </For>
            </Card>
          </Show>

          {/* Uploaded Files List */}
          <Card>
            <Show
              when={uploads().length > 0}
              fallback={
                <div class="p-8">
                  <EmptyState icon={Icons.upload} title="No uploaded files" hint="Uploaded files stay stored in DATA_DIR/uploads until deleted or auto-expired." />
                </div>
              }
            >
              <div class="divide-y divide-border-subtle">
                <For each={uploads()}>
                  {(u) => (
                    <div class="px-4 py-3 flex items-center justify-between gap-3">
                      <div class="flex items-center gap-3 min-w-0">
                        <Icon name={Icons.file} size={18} class="text-fg-muted shrink-0" />
                        <div class="min-w-0">
                          <div class="flex items-center gap-2 flex-wrap">
                            <span class="text-sm font-medium text-fg truncate">{u.originalName}</span>
                            <Show when={u.status !== "ready"}>
                              <Badge tone="amber" size="sm">{u.status}</Badge>
                            </Show>
                            <Show when={u.activeLinksCount > 0}>
                              <Badge tone="accent" size="sm">{u.activeLinksCount} active link(s)</Badge>
                            </Show>
                          </div>
                          <div class="text-xs text-fg-muted flex flex-wrap items-center gap-x-3 gap-y-1 mt-0.5">
                            <span class="tabular-nums">{fmtBytes(u.sizeBytes)}</span>
                            <span>{fmtDate(u.completedAt ?? u.createdAt)}</span>
                            <Show when={u.sha256}>
                              <code class="font-mono text-2xs">sha256:{u.sha256!.slice(0, 12)}…</code>
                            </Show>
                          </div>
                        </div>
                      </div>

                      <div class="flex items-center gap-1.5 shrink-0">
                        <Show when={u.status === "ready"}>
                          <IconBtn
                            icon={Icons.hash}
                            title="Compute SHA-256"
                            disabled={hashingKey() === u.id}
                            onClick={() => void computeChecksum("upload", u.id)}
                          />
                          <Btn size="xs" onClick={() => openShareUpload(u)}>
                            <Icon name={Icons.share} size={13} />
                            Create Link
                          </Btn>
                        </Show>
                        <IconBtn icon={Icons.trash} title="Delete file" danger onClick={() => void deleteUpload(u)} />
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Card>
        </div>
      </Show>

      <LinkComposerModal
        open={composerOpen()}
        onClose={() => setComposerOpen(false)}
        prefill={prefill()}
        clientIp={clientIp()}
        defaults={defaults()}
        onSaved={(link) => {
          void loadMount();
          void loadUploads();
          setShareLink(link);
        }}
      />

      <LinkShareModal link={shareLink()} onClose={() => setShareLink(null)} />
    </div>
  );
}
