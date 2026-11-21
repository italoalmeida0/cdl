import { createEffect, createMemo, createSignal, For, Show } from "solid-js";

import {
  api,
  uploadFileChunked,
  type ExpiryMode,
  type FileEntryDto,
  type LinkDto,
  type LinkPolicyDefaults,
  type MountStatusDto,
  type UploadDto,
} from "../api";
import {
  Badge,
  Btn,
  DateTimePicker,
  Icon,
  Icons,
  Input,
  Modal,
  ModalField,
  ModalNotice,
  ModalSection,
  Progress,
  Segmented,
  Select,
  StepperField,
  SwitchCard,
  Textarea,
  TokenTagField,
  fmtBytes,
  fmtDuration,
  fmtSpeed,
  toast,
} from "../ui";

const SLIDING_PRESETS = [
  { value: "1800", label: "30m" },
  { value: "3600", label: "1h" },
  { value: "10800", label: "3h (Default)" },
  { value: "21600", label: "6h" },
  { value: "43200", label: "12h" },
  { value: "86400", label: "24h" },
];

const FIXED_PRESETS = [
  { value: "3600", label: "1h" },
  { value: "10800", label: "3h" },
  { value: "86400", label: "24h" },
  { value: "172800", label: "48h" },
  { value: "604800", label: "7 days" },
  { value: "2592000", label: "30 days" },
  { value: "custom", label: "Custom date & time…" },
];

const GRACE_PRESETS = [
  { value: "3600", label: "1 hour" },
  { value: "10800", label: "3 hours" },
  { value: "43200", label: "12 hours" },
  { value: "86400", label: "24 hours" },
  { value: "0", label: "Unlimited grace" },
];

export interface ComposerPrefill {
  sourceType: "mount" | "upload";
  sourcePath?: string;
  uploadId?: string;
  filename?: string;
  fileSize?: number;
}

function toDatetimeLocalValue(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function LinkComposerModal(props: {
  open: boolean;
  onClose: () => void;
  editing?: LinkDto | null;
  prefill?: ComposerPrefill | null;
  clientIp?: string;
  defaults?: LinkPolicyDefaults | null;
  onSaved: (link: LinkDto, isNew: boolean) => void;
}) {
  const isEditing = () => !!props.editing;

  // Source selection state
  const [sourceTab, setSourceTab] = createSignal<"mount" | "upload">("mount");
  const [mountRelPath, setMountRelPath] = createSignal("");
  const [mountBreadcrumbs, setMountBreadcrumbs] = createSignal<Array<{ name: string; relPath: string }>>([]);
  const [mountEntries, setMountEntries] = createSignal<FileEntryDto[]>([]);
  const [mountStatus, setMountStatus] = createSignal<MountStatusDto | null>(null);
  const [mountQuery, setMountQuery] = createSignal("");
  const [selectedMountPath, setSelectedMountPath] = createSignal("");
  const [selectedMountSize, setSelectedMountSize] = createSignal<number>(0);

  const [uploads, setUploads] = createSignal<UploadDto[]>([]);
  const [selectedUploadId, setSelectedUploadId] = createSignal("");
  const [uploadingPct, setUploadingPct] = createSignal<number | null>(null);
  const [uploadingSpeed, setUploadingSpeed] = createSignal<number>(0);
  const [loadingFiles, setLoadingFiles] = createSignal(false);

  // Link fields
  const [label, setLabel] = createSignal("");
  const [downloadFilename, setDownloadFilename] = createSignal("");
  const [expiryMode, setExpiryMode] = createSignal<ExpiryMode>("sliding");
  const [idleTtlSec, setIdleTtlSec] = createSignal("10800");
  const [hardCapEnabled, setHardCapEnabled] = createSignal(false);
  const [hardCapDate, setHardCapDate] = createSignal("");
  const [fixedPreset, setFixedPreset] = createSignal("86400");
  const [fixedCustomDate, setFixedCustomDate] = createSignal("");

  const [startedIpCanResume, setStartedIpCanResume] = createSignal(true);
  const [resumeGraceSec, setResumeGraceSec] = createSignal("10800");
  const [lockToFirstIp, setLockToFirstIp] = createSignal(false);
  const [ipWhitelistText, setIpWhitelistText] = createSignal("");
  const [maxDownloads, setMaxDownloads] = createSignal("");
  const [maxSpeedKbps, setMaxSpeedKbps] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [clearPassword, setClearPassword] = createSignal(false);
  const [autoDeleteFile, setAutoDeleteFile] = createSignal(false);
  const [allowInline, setAllowInline] = createSignal(false);
  const [notes, setNotes] = createSignal("");

  const [showAdvanced, setShowAdvanced] = createSignal(false);
  const [saving, setSaving] = createSignal(false);

  const loadMountDir = async (dir: string, q = mountQuery()) => {
    setLoadingFiles(true);
    try {
      const qs = new URLSearchParams({ path: dir });
      if (q.trim()) {
        qs.set("q", q.trim());
        qs.set("recursive", "true");
      }
      const res = await api<{
        mount: MountStatusDto;
        relPath: string;
        breadcrumbs: Array<{ name: string; relPath: string }>;
        entries: FileEntryDto[];
      }>("GET", `/api/files?${qs.toString()}`);
      setMountStatus(res.mount);
      setMountRelPath(res.relPath);
      setMountBreadcrumbs(res.breadcrumbs);
      setMountEntries(res.entries);
    } catch {
      setMountEntries([]);
    } finally {
      setLoadingFiles(false);
    }
  };

  const loadUploads = async () => {
    try {
      const res = await api<{ uploads: UploadDto[] }>("GET", "/api/uploads");
      setUploads(res.uploads.filter((u) => u.status === "ready"));
    } catch {
      setUploads([]);
    }
  };

  // Initialize form whenever modal opens
  createEffect(() => {
    if (!props.open) return;
    const edit = props.editing;
    const pre = props.prefill;
    const defs = props.defaults;

    if (edit) {
      setSourceTab(edit.sourceType);
      setSelectedMountPath(edit.sourceType === "mount" ? edit.sourcePath : "");
      setSelectedUploadId(edit.uploadId ?? "");
      setLabel(edit.label);
      setDownloadFilename(edit.downloadFilename);
      setExpiryMode(edit.expiryMode);
      setIdleTtlSec(String(edit.idleTtlSec ?? 10800));
      setHardCapEnabled(!!edit.hardExpiresAt);
      setHardCapDate(edit.hardExpiresAt ? toDatetimeLocalValue(edit.hardExpiresAt) : "");
      setFixedPreset("custom");
      setFixedCustomDate(edit.expiresAt ? toDatetimeLocalValue(edit.expiresAt) : toDatetimeLocalValue(Date.now() + 86400_000));
      setStartedIpCanResume(edit.startedIpCanResume);
      setResumeGraceSec(String(edit.resumeGraceSec));
      setLockToFirstIp(edit.lockToFirstIp);
      setIpWhitelistText(edit.ipWhitelist.join(", "));
      setMaxDownloads(edit.maxDownloads ? String(edit.maxDownloads) : "");
      setMaxSpeedKbps(edit.maxSpeedKbps ? String(edit.maxSpeedKbps) : "");
      setPassword("");
      setClearPassword(false);
      setAutoDeleteFile(edit.autoDeleteFile);
      setAllowInline(edit.allowInline);
      setNotes(edit.notes);
      setShowAdvanced(
        !!(edit.maxDownloads || edit.maxSpeedKbps || edit.hasPassword || edit.autoDeleteFile || edit.allowInline || edit.notes),
      );
      return;
    }

    // Create mode
    const mode = defs?.expiryMode ?? "sliding";
    setExpiryMode(mode);
    setIdleTtlSec(String(defs?.idleTtlSec ?? 10800));
    setHardCapEnabled(false);
    setHardCapDate(toDatetimeLocalValue(Date.now() + 7 * 86400_000));
    setFixedPreset(String(defs?.fixedTtlSec ?? 86400));
    setFixedCustomDate(toDatetimeLocalValue(Date.now() + 86400_000));
    setStartedIpCanResume(defs?.startedIpCanResume ?? true);
    setResumeGraceSec(String(defs?.resumeGraceSec ?? 10800));
    setLockToFirstIp(defs?.lockToFirstIp ?? false);
    setIpWhitelistText("");
    setMaxDownloads(defs?.maxDownloads ? String(defs.maxDownloads) : "");
    setMaxSpeedKbps("");
    setPassword("");
    setClearPassword(false);
    setAutoDeleteFile(defs?.autoDeleteFile ?? false);
    setAllowInline(defs?.allowInline ?? false);
    setNotes("");
    setShowAdvanced(false);

    if (pre) {
      setSourceTab(pre.sourceType);
      setSelectedMountPath(pre.sourceType === "mount" ? pre.sourcePath ?? "" : "");
      setSelectedMountSize(pre.fileSize ?? 0);
      setSelectedUploadId(pre.sourceType === "upload" ? pre.uploadId ?? "" : "");
      const fname = pre.filename || (pre.sourcePath ? pre.sourcePath.split("/").pop() || "" : "");
      setDownloadFilename(fname);
      setLabel(fname);
    } else {
      setSourceTab("mount");
      setSelectedMountPath("");
      setSelectedMountSize(0);
      setSelectedUploadId("");
      setDownloadFilename("");
      setLabel("");
    }

    void loadMountDir("");
    void loadUploads();
  });

  const handleQuickUpload = async (file: File | undefined) => {
    if (!file) return;
    setUploadingPct(0);
    setUploadingSpeed(0);
    try {
      const uploaded = await uploadFileChunked(file, {
        onProgress: (p) => {
          setUploadingPct(p.pct);
          setUploadingSpeed(p.bytesPerSec);
        },
      });
      toast(`Uploaded ${uploaded.originalName}`);
      await loadUploads();
      setSelectedUploadId(uploaded.id);
      setDownloadFilename(uploaded.originalName);
      if (!label().trim()) setLabel(uploaded.originalName);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Upload failed", "err");
    } finally {
      setUploadingPct(null);
    }
  };

  const selectedFileSummary = createMemo(() => {
    if (props.editing) {
      return {
        name: props.editing.downloadFilename,
        size: props.editing.fileSize,
        source: props.editing.sourceType === "mount" ? `Mounted: ${props.editing.sourcePath}` : "Uploaded file",
      };
    }
    if (sourceTab() === "mount") {
      if (!selectedMountPath()) return null;
      return {
        name: selectedMountPath().split("/").pop() || selectedMountPath(),
        size: selectedMountSize(),
        source: `Mounted: /${selectedMountPath()}`,
      };
    }
    const u = uploads().find((item) => item.id === selectedUploadId());
    if (!u) return null;
    return { name: u.originalName, size: u.sizeBytes, source: "Uploaded from PC" };
  });

  const summaryRules = createMemo(() => {
    const parts: string[] = [];
    if (expiryMode() === "sliding") {
      const sec = Number(idleTtlSec()) || 10800;
      parts.push(`Debounce ${fmtDuration(sec)} idle timeout (resets to 0 on every download/resume; never drops active streams)`);
    } else if (expiryMode() === "fixed") {
      if (fixedPreset() === "custom") {
        parts.push(`Expires at ${fixedCustomDate() || "custom date"}`);
      } else {
        parts.push(`Fixed ${fmtDuration(Number(fixedPreset()) || 86400)} lifetime`);
      }
    } else {
      parts.push("Never expires automatically");
    }

    if (expiryMode() !== "never" && startedIpCanResume()) {
      const grace = Number(resumeGraceSec());
      parts.push(grace === 0 ? "Started IPs can always resume" : `Started IPs keep ${fmtDuration(grace)} resume grace`);
    }
    if (lockToFirstIp()) parts.push("Locks to 1st downloader IP");
    const wl = ipWhitelistText()
      .split(/[\s,;]+/)
      .filter(Boolean);
    if (wl.length > 0) parts.push(`${wl.length} IP whitelist rule${wl.length > 1 ? "s" : ""}`);
    if (maxDownloads().trim()) parts.push(`Max ${maxDownloads()} download(s)`);
    if (password().trim()) parts.push("Password protected");
    return parts;
  });

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!isEditing()) {
      if (sourceTab() === "mount" && !selectedMountPath()) {
        return toast("Select a file from the mounted library", "err");
      }
      if (sourceTab() === "upload" && !selectedUploadId()) {
        return toast("Select or upload a file first", "err");
      }
    }

    let expiresAtPayload: number | null | undefined = undefined;
    let fixedTtlPayload: number | undefined = undefined;
    if (expiryMode() === "fixed") {
      if (fixedPreset() === "custom") {
        const ts = new Date(fixedCustomDate()).getTime();
        if (!Number.isFinite(ts) || ts <= Date.now()) {
          return toast("Pick a future expiration date and time", "err");
        }
        expiresAtPayload = ts;
      } else {
        fixedTtlPayload = Number(fixedPreset()) || 86400;
      }
    }

    let hardExpiresAtPayload: number | null = null;
    if (expiryMode() === "sliding" && hardCapEnabled()) {
      const ts = new Date(hardCapDate()).getTime();
      if (!Number.isFinite(ts) || ts <= Date.now()) {
        return toast("Hard max deadline must be in the future", "err");
      }
      hardExpiresAtPayload = ts;
    }

    const payload: Record<string, unknown> = {
      label: label().trim() || downloadFilename().trim() || undefined,
      downloadFilename: downloadFilename().trim() || undefined,
      expiryMode: expiryMode(),
      idleTtlSec: expiryMode() === "sliding" ? Number(idleTtlSec()) || 10800 : null,
      hardExpiresAt: expiryMode() === "sliding" ? hardExpiresAtPayload : null,
      ...(expiryMode() === "fixed"
        ? expiresAtPayload !== undefined
          ? { expiresAt: expiresAtPayload }
          : isEditing()
            ? { expiresAt: Date.now() + (fixedTtlPayload ?? 86400) * 1000 }
            : { fixedTtlSec: fixedTtlPayload }
        : {}),
      startedIpCanResume: startedIpCanResume(),
      resumeGraceSec: Number(resumeGraceSec()),
      lockToFirstIp: lockToFirstIp(),
      ipWhitelist: ipWhitelistText()
        .split(/[\s,;]+/)
        .map((s) => s.trim())
        .filter(Boolean),
      maxDownloads: maxDownloads().trim() ? Number(maxDownloads()) : null,
      maxSpeedKbps: maxSpeedKbps().trim() ? Number(maxSpeedKbps()) : null,
      allowInline: allowInline(),
      autoDeleteFile: autoDeleteFile(),
      notes: notes().trim(),
    };

    if (password().trim()) {
      payload.password = password();
    } else if (isEditing() && clearPassword()) {
      payload.clearPassword = true;
    }

    setSaving(true);
    try {
      if (isEditing()) {
        const res = await api<{ link: LinkDto }>("PATCH", `/api/links/${props.editing!.id}`, payload);
        toast("Link updated");
        props.onSaved(res.link, false);
      } else {
        const createBody = {
          ...payload,
          sourceType: sourceTab(),
          sourcePath: sourceTab() === "mount" ? selectedMountPath() : undefined,
          uploadId: sourceTab() === "upload" ? selectedUploadId() : undefined,
        };
        const res = await api<{ link: LinkDto }>("POST", "/api/links", createBody);
        toast("Direct download link created");
        props.onSaved(res.link, true);
      }
      props.onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to save link", "err");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title={isEditing() ? "Edit Delivery Link" : "New Content Delivery Link"}
      description={
        isEditing()
          ? "Adjust expiration rules, IP restrictions, or download limits without changing the token."
          : "Pick a mounted or uploaded file and configure temporary direct-download security."
      }
      width="max-w-3xl"
      footer={
        <>
          <Btn variant="ghost" onClick={props.onClose}>
            Cancel
          </Btn>
          <Btn type="submit" loading={saving()} onClick={(e) => void submit(e)}>
            <Icon name={Icons.link} size={15} />
            {isEditing() ? "Save Changes" : "Create Direct Link"}
          </Btn>
        </>
      }
    >
      <form onSubmit={submit} class="space-y-5">
        {/* Step 1: File Picker (only on create) */}
        <Show
          when={!isEditing()}
          fallback={
            <div class="rounded-panel border border-border bg-surface-subtle p-3.5 flex items-center justify-between gap-3">
              <div class="flex items-center gap-3 min-w-0">
                <Icon name={Icons.file} size={20} class="text-accent shrink-0" />
                <div class="min-w-0">
                  <div class="text-sm font-medium text-fg truncate">{selectedFileSummary()?.name}</div>
                  <div class="text-xs text-fg-muted truncate">
                    {selectedFileSummary()?.source} · {fmtBytes(selectedFileSummary()?.size)}
                  </div>
                </div>
              </div>
              <Badge tone="zinc">{props.editing?.sourceType === "mount" ? "Mounted" : "Upload"}</Badge>
            </div>
          }
        >
          <ModalSection
            title="1. Choose file"
            action={
              <Segmented
                value={sourceTab()}
                onChange={(v) => setSourceTab(v)}
                options={[
                  { value: "mount", label: "Mounted folder" },
                  { value: "upload", label: "Uploaded / PC" },
                ]}
              />
            }
          >
            <Show when={sourceTab() === "mount"}>
              <Show
                when={mountStatus()?.available}
                fallback={
                  <ModalNotice tone="warn" title="Mount folder unavailable">
                    Mounted directory <code class="font-mono">{mountStatus()?.path ?? "/files"}</code> was not found or is unreadable. Mount a host folder or switch to the Uploaded / PC tab.
                  </ModalNotice>
                }
              >
                <div class="rounded-panel border border-border bg-surface-subtle overflow-hidden">
                  <div class="p-2.5 border-b border-border flex flex-wrap items-center justify-between gap-2 bg-surface">
                    <div class="flex items-center gap-1 flex-wrap text-xs">
                      <For each={mountBreadcrumbs()}>
                        {(crumb, idx) => (
                          <>
                            <Show when={idx() > 0}>
                              <Icon name={Icons.chevronRight} size={12} class="text-fg-muted" />
                            </Show>
                            <button
                              type="button"
                              onClick={() => void loadMountDir(crumb.relPath)}
                              class="px-2 py-1 rounded-md hover:bg-surface-muted text-fg-secondary hover:text-fg transition-colors cursor-pointer font-medium"
                            >
                              {crumb.name}
                            </button>
                          </>
                        )}
                      </For>
                    </div>
                    <div class="flex items-center gap-1.5 w-full sm:w-56">
                      <input
                        type="search"
                        value={mountQuery()}
                        onInput={(e) => {
                          const v = e.currentTarget.value;
                          setMountQuery(v);
                          void loadMountDir(mountRelPath(), v);
                        }}
                        placeholder="Search mounted files…"
                        class="ui-field ui-field-sm text-xs"
                      />
                    </div>
                  </div>

                  <div class="max-h-52 overflow-y-auto divide-y divide-border-subtle">
                    <Show
                      when={!loadingFiles() && mountEntries().length > 0}
                      fallback={
                        <div class="p-6 text-center text-xs text-fg-muted">
                          {loadingFiles() ? "Loading directory…" : "No files found in this directory"}
                        </div>
                      }
                    >
                      <For each={mountEntries()}>
                        {(entry) => {
                          const selected = () => !entry.isDir && selectedMountPath() === entry.relPath;
                          return (
                            <button
                              type="button"
                              onClick={() => {
                                if (entry.isDir) {
                                  setMountQuery("");
                                  void loadMountDir(entry.relPath, "");
                                } else {
                                  setSelectedMountPath(entry.relPath);
                                  setSelectedMountSize(entry.sizeBytes);
                                  setDownloadFilename(entry.name);
                                  if (!label().trim() || label() === selectedFileSummary()?.name) {
                                    setLabel(entry.name);
                                  }
                                }
                              }}
                              class={`w-full px-3 py-2 flex items-center justify-between gap-3 text-left text-sm transition-colors cursor-pointer ${
                                selected() ? "bg-accent-subtle text-fg" : "hover:bg-surface-muted/70 text-fg"
                              }`}
                            >
                              <div class="flex items-center gap-2.5 min-w-0">
                                <Icon
                                  name={entry.isDir ? Icons.folder : Icons.file}
                                  size={16}
                                  class={entry.isDir ? "text-warning" : selected() ? "text-accent" : "text-fg-muted"}
                                />
                                <span class="truncate font-medium">{entry.name}</span>
                              </div>
                              <div class="flex items-center gap-2 shrink-0 text-xs text-fg-muted tabular-nums">
                                <Show when={!entry.isDir}>
                                  <span>{fmtBytes(entry.sizeBytes)}</span>
                                </Show>
                                <Show when={selected()}>
                                  <Icon name={Icons.check} size={14} class="text-accent" />
                                </Show>
                              </div>
                            </button>
                          );
                        }}
                      </For>
                    </Show>
                  </div>
                </div>
              </Show>
            </Show>

            <Show when={sourceTab() === "upload"}>
              <div class="space-y-3">
                <label class="flex flex-col items-center justify-center gap-1.5 rounded-panel border border-dashed border-border-strong bg-surface-subtle hover:bg-surface-muted/50 px-4 py-4 cursor-pointer transition-colors">
                  <Icon name={Icons.upload} size={20} class="text-accent" />
                  <span class="text-sm font-medium text-fg">Upload a file from your computer</span>
                  <span class="text-xs text-fg-muted">Chunked &amp; resumable — supports huge multi-GB / TB files</span>
                  <input
                    type="file"
                    class="sr-only"
                    onChange={(e) => void handleQuickUpload(e.currentTarget.files?.[0])}
                  />
                </label>

                <Show when={uploadingPct() !== null}>
                  <div class="rounded-panel border border-border p-3 bg-surface space-y-1.5">
                    <div class="flex justify-between text-xs">
                      <span class="text-fg font-medium">Uploading chunked stream…</span>
                      <span class="text-fg-secondary tabular-nums">
                        {uploadingPct()}% · {fmtSpeed(uploadingSpeed())}
                      </span>
                    </div>
                    <Progress value={uploadingPct() ?? 0} max={100} />
                  </div>
                </Show>

                <div class="rounded-panel border border-border bg-surface-subtle max-h-44 overflow-y-auto divide-y divide-border-subtle">
                  <Show
                    when={uploads().length > 0}
                    fallback={<div class="p-4 text-center text-xs text-fg-muted">No uploaded files yet</div>}
                  >
                    <For each={uploads()}>
                      {(u) => {
                        const selected = () => selectedUploadId() === u.id;
                        return (
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedUploadId(u.id);
                              setDownloadFilename(u.originalName);
                              if (!label().trim()) setLabel(u.originalName);
                            }}
                            class={`w-full px-3 py-2 flex items-center justify-between gap-3 text-left text-sm cursor-pointer transition-colors ${
                              selected() ? "bg-accent-subtle text-fg" : "hover:bg-surface-muted/70 text-fg"
                            }`}
                          >
                            <div class="flex items-center gap-2.5 min-w-0">
                              <Icon name={Icons.file} size={15} class={selected() ? "text-accent" : "text-fg-muted"} />
                              <span class="truncate font-medium">{u.originalName}</span>
                            </div>
                            <span class="text-xs text-fg-muted tabular-nums shrink-0">{fmtBytes(u.sizeBytes)}</span>
                          </button>
                        );
                      }}
                    </For>
                  </Show>
                </div>
              </div>
            </Show>
          </ModalSection>
        </Show>

        {/* Step 2: Naming */}
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input
            label="Link label"
            value={label()}
            onInput={setLabel}
            placeholder="e.g. Game Build for Lucas"
          />
          <Input
            label="Download filename"
            value={downloadFilename()}
            onInput={setDownloadFilename}
            placeholder="archive.zip"
          />
        </div>

        {/* Step 3: Expiration Logic */}
        <ModalSection
          title="2. Expiration mode"
          subtitle="Active transfers are never cut off mid-download."
          action={
            <Segmented
              value={expiryMode()}
              onChange={(m) => setExpiryMode(m)}
              options={[
                { value: "sliding", label: "Auto-expire (Debounce)" },
                { value: "fixed", label: "Fixed timer" },
                { value: "never", label: "Never" },
              ]}
            />
          }
        >
          <Show when={expiryMode() === "sliding"}>
            <div class="rounded-panel border border-border bg-surface-subtle p-3.5 space-y-3">
              <div class="flex items-start justify-between gap-3 flex-wrap">
                <div class="min-w-0 flex-1">
                  <Select
                    label="Idle timeout before link expires"
                    value={idleTtlSec()}
                    onChange={setIdleTtlSec}
                    options={SLIDING_PRESETS}
                    hint="Countdown resets to 0 whenever someone starts or resumes a download, and stays paused while bytes are flowing."
                  />
                </div>
              </div>
              <SwitchCard
                checked={hardCapEnabled()}
                onChange={setHardCapEnabled}
                title="Enforce hard absolute deadline"
                description="Stop renewing the sliding debounce after a fixed date even if downloads continue."
              />
              <Show when={hardCapEnabled()}>
                <ModalField label="Hard deadline">
                  <DateTimePicker value={hardCapDate()} onChange={setHardCapDate} />
                </ModalField>
              </Show>
            </div>
          </Show>

          <Show when={expiryMode() === "fixed"}>
            <div class="rounded-panel border border-border bg-surface-subtle p-3.5 space-y-3">
              <Select
                label="Expires after"
                value={fixedPreset()}
                onChange={setFixedPreset}
                options={FIXED_PRESETS}
              />
              <Show when={fixedPreset() === "custom"}>
                <ModalField label="Exact expiration date & time">
                  <DateTimePicker value={fixedCustomDate()} onChange={setFixedCustomDate} />
                </ModalField>
              </Show>
            </div>
          </Show>

          <Show when={expiryMode() === "never"}>
            <ModalNotice tone="info">
              This link remains active until you manually pause, revoke, or hit a download limit.
            </ModalNotice>
          </Show>
        </ModalSection>

        {/* Step 4: IP & Resume Security */}
        <ModalSection
          title="3. Access & resume protection"
          subtitle="Combine IP whitelisting, first-IP lock, and started-IP resume windows."
        >
          <div class="space-y-3">
            <Show when={expiryMode() !== "never"}>
              <div class="rounded-panel border border-border bg-surface-subtle p-3.5 space-y-3">
                <SwitchCard
                  checked={startedIpCanResume()}
                  onChange={setStartedIpCanResume}
                  title="Allow started IP to resume after expiration"
                  description="If the link expires while a friend is downloading (or their connection dropped), their IP can still reconnect with Range requests while new IPs get 410 Gone."
                />
                <Show when={startedIpCanResume()}>
                  <Select
                    label="Resume grace window after last byte"
                    value={resumeGraceSec()}
                    onChange={setResumeGraceSec}
                    options={GRACE_PRESETS}
                    hint="Default 3h lets a client recover from network drops long after the public link expired."
                  />
                </Show>
              </div>
            </Show>

            <SwitchCard
              checked={lockToFirstIp()}
              onChange={setLockToFirstIp}
              title="Lock link to first downloader IP"
              description="Once the first client starts downloading, all other IP addresses are blocked until you unlock it."
            />

            <div class="space-y-1.5">
              <TokenTagField
                label="IP / CIDR Whitelist (optional)"
                value={ipWhitelistText()}
                onInput={setIpWhitelistText}
                placeholder="e.g. 203.0.113.10, 192.168.1.0/24"
                suggestions={props.clientIp ? [{ value: props.clientIp, label: `My IP (${props.clientIp})` }] : ["127.0.0.1", "192.168.0.0/16"]}
                hint="Leave empty to allow any IP. Supports IPv4, IPv6, and CIDR ranges."
              />
            </div>
          </div>
        </ModalSection>

        {/* Step 5: Optional Advanced Limits */}
        <div>
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced())}
            class="inline-flex items-center gap-1.5 text-xs font-medium text-fg-secondary hover:text-fg cursor-pointer"
          >
            <Icon name={showAdvanced() ? Icons.chevronDown : Icons.chevronRight} size={14} />
            Advanced options (download cap, speed limit, password, auto-delete)
          </button>

          <Show when={showAdvanced()}>
            <div class="mt-3 rounded-panel border border-border bg-surface-subtle p-3.5 space-y-3">
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <StepperField
                  label="Max downloads"
                  value={maxDownloads()}
                  onInput={setMaxDownloads}
                  min={1}
                  placeholder="Unlimited"
                  presets={[
                    { value: "", label: "Unlimited" },
                    { value: "1", label: "1" },
                    { value: "3", label: "3" },
                    { value: "10", label: "10" },
                  ]}
                  hint="Range resumes from the same downloader do not double-count."
                />
                <StepperField
                  label="Max speed limit"
                  value={maxSpeedKbps()}
                  onInput={setMaxSpeedKbps}
                  min={64}
                  step={512}
                  unit="KB/s"
                  placeholder="Unlimited"
                  presets={[
                    { value: "", label: "Max" },
                    { value: "1024", label: "1 MB/s" },
                    { value: "5120", label: "5 MB/s" },
                    { value: "25600", label: "25 MB/s" },
                  ]}
                />
              </div>

              <Input
                label={isEditing() && props.editing?.hasPassword ? "Replace download password" : "Download password (optional)"}
                type="password"
                value={password()}
                onInput={setPassword}
                placeholder={isEditing() && props.editing?.hasPassword ? "Leave blank to keep existing password" : "Optional password"}
                hint="Prompts browsers with a minimal unlock page and accepts Basic Auth or X-CDL-Password for CLI tools."
              />

              <Show when={isEditing() && props.editing?.hasPassword}>
                <SwitchCard
                  checked={clearPassword()}
                  onChange={setClearPassword}
                  title="Remove existing password"
                />
              </Show>

              <SwitchCard
                checked={allowInline()}
                onChange={setAllowInline}
                title="Allow browser inline preview (?inline=1)"
                description="By default links force Content-Disposition: attachment. Enable to allow ?inline=1 previews for media/PDFs."
              />

              <Show when={sourceTab() === "upload" || props.editing?.sourceType === "upload"}>
                <SwitchCard
                  checked={autoDeleteFile()}
                  onChange={setAutoDeleteFile}
                  title="Auto-delete uploaded file after link expires"
                  description="Frees disk space automatically once this link and any sibling links expire."
                />
              </Show>

              <Textarea
                label="Private admin notes"
                value={notes()}
                onInput={setNotes}
                placeholder="Shared with Lucas for LAN party…"
                rows={2}
              />
            </div>
          </Show>
        </div>

        {/* Live Policy Summary */}
        <div class="rounded-panel border border-border bg-surface p-3 space-y-1.5">
          <div class="text-xs font-medium text-fg flex items-center gap-1.5">
            <Icon name={Icons.shield} size={13} class="text-accent" />
            Effective delivery policy
          </div>
          <ul class="text-xs text-fg-secondary space-y-0.5 list-disc pl-4">
            <For each={summaryRules()}>{(rule) => <li>{rule}</li>}</For>
          </ul>
        </div>
      </form>
    </Modal>
  );
}
