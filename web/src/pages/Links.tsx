import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";

import { api, type LinkDto, type LinkPolicyDefaults } from "../api";
import { PageTitle } from "../chrome";
import { LinkComposerModal } from "../components/LinkComposerModal";
import { LinkDetailModal } from "../components/LinkDetailModal";
import { LinkShareModal } from "../components/LinkShareModal";
import {
  Badge,
  Btn,
  Card,
  EmptyState,
  Icon,
  IconBtn,
  Icons,
  Modal,
  Segmented,
  copyWithToast,
  fmtBytes,
  fmtDate,
  fmtDuration,
  fmtSpeed,
  timeUntil,
  toast,
} from "../ui";

const STATUS_BADGE: Record<string, { tone: "green" | "amber" | "info" | "red" | "zinc"; label: string }> = {
  active: { tone: "green", label: "Active" },
  resume_only: { tone: "amber", label: "Resume Only" },
  paused: { tone: "info", label: "Paused" },
  expired: { tone: "zinc", label: "Expired" },
  revoked: { tone: "red", label: "Revoked" },
};

export default function LinksPage() {
  const [links, setLinks] = createSignal<LinkDto[]>([]);
  const [defaults, setDefaults] = createSignal<LinkPolicyDefaults | null>(null);
  const [clientIp, setClientIp] = createSignal("");
  const [loading, setLoading] = createSignal(true);
  const [search, setSearch] = createSignal("");
  const [statusFilter, setStatusFilter] = createSignal("all");
  const [nowMs, setNowMs] = createSignal(Date.now());

  const [composerOpen, setComposerOpen] = createSignal(false);
  const [editing, setEditing] = createSignal<LinkDto | null>(null);
  const [shareLink, setShareLink] = createSignal<LinkDto | null>(null);
  const [detailLinkId, setDetailLinkId] = createSignal<string | null>(null);
  const [confirmDelete, setConfirmDelete] = createSignal<LinkDto | null>(null);

  const load = async () => {
    try {
      const [res, settings] = await Promise.all([
        api<{ links: LinkDto[] }>("GET", "/api/links"),
        api<{ clientIp: string; defaultPolicy: LinkPolicyDefaults }>("GET", "/api/settings"),
      ]);
      setLinks(res.links);
      setClientIp(settings.clientIp);
      setDefaults(settings.defaultPolicy);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to load links", "err");
    } finally {
      setLoading(false);
    }
  };

  onMount(() => {
    void load();
    const poll = setInterval(() => {
      void api<{ links: LinkDto[] }>("GET", "/api/links")
        .then((r) => setLinks(r.links))
        .catch(() => {});
    }, 5000);
    const tick = setInterval(() => setNowMs(Date.now()), 1000);
    onCleanup(() => {
      clearInterval(poll);
      clearInterval(tick);
    });
  });

  const filtered = createMemo(() => {
    const q = search().trim().toLowerCase();
    const st = statusFilter();
    return links().filter((l) => {
      if (st !== "all" && l.effectiveStatus !== st) return false;
      if (q) {
        const hay = `${l.label} ${l.downloadFilename} ${l.sourcePath} ${l.token}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  });

  const togglePause = async (l: LinkDto) => {
    const next = l.status === "paused" ? "active" : "paused";
    try {
      await api("PATCH", `/api/links/${l.id}`, { status: next });
      toast(next === "paused" ? "Link paused" : "Link resumed");
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to update link", "err");
    }
  };

  const extend3h = async (l: LinkDto) => {
    try {
      await api("POST", `/api/links/${l.id}/extend`, { seconds: 10800 });
      toast("Extended by 3 hours");
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to extend link", "err");
    }
  };

  const revoke = async (l: LinkDto) => {
    try {
      await api("POST", `/api/links/${l.id}/revoke`, {});
      toast("Link revoked");
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to revoke link", "err");
    }
  };

  const remove = async (l: LinkDto) => {
    try {
      await api("DELETE", `/api/links/${l.id}`);
      toast("Link deleted");
      setConfirmDelete(null);
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to delete link", "err");
    }
  };

  return (
    <div class="space-y-5">
      <PageTitle
        title="Delivery Links"
        subtitle="Create, monitor, pause, extend, or revoke direct download links."
        right={
          <Btn
            onClick={() => {
              setEditing(null);
              setComposerOpen(true);
            }}
          >
            <Icon name={Icons.plus} size={15} />
            New Link
          </Btn>
        }
      />

      {/* Filter Toolbar */}
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="relative w-full sm:w-72">
          <input
            type="search"
            value={search()}
            onInput={(e) => setSearch(e.currentTarget.value)}
            placeholder="Filter by label, filename, or token…"
            class="ui-field ui-field-sm"
          />
        </div>
        <Segmented
          value={statusFilter()}
          onChange={setStatusFilter}
          options={[
            { value: "all", label: "All", badge: links().length },
            { value: "active", label: "Active" },
            { value: "resume_only", label: "Resume Only" },
            { value: "paused", label: "Paused" },
            { value: "expired", label: "Expired" },
          ]}
        />
      </div>

      {/* Links List */}
      <Show
        when={!loading() && filtered().length > 0}
        fallback={
          <Card class="p-8">
            <EmptyState
              icon={Icons.link}
              title={loading() ? "Loading links…" : "No matching links"}
              hint={loading() ? undefined : "Create a direct link from mounted storage or an uploaded file."}
              action={
                !loading() ? (
                  <Btn
                    onClick={() => {
                      setEditing(null);
                      setComposerOpen(true);
                    }}
                  >
                    <Icon name={Icons.plus} size={15} />
                    Create Direct Link
                  </Btn>
                ) : undefined
              }
            />
          </Card>
        }
      >
        <div class="space-y-3">
          <For each={filtered()}>
            {(l) => {
              const badge = () => STATUS_BADGE[l.effectiveStatus] ?? { tone: "zinc" as const, label: l.effectiveStatus };
              const countdown = () => {
                if (l.effectiveStatus === "resume_only") {
                  return l.resumeUntil ? `Resume grace: ${timeUntil(l.resumeUntil, nowMs())}` : "Unlimited resume grace";
                }
                if (l.expiryMode === "never") return "Never expires";
                if (l.expiryMode === "sliding") {
                  return l.activeTransfersCount > 0
                    ? `Streaming (${fmtDuration(l.idleTtlSec)} debounce)`
                    : `Idle left: ${timeUntil(l.expiresAt, nowMs())}`;
                }
                return `Expires in ${timeUntil(l.expiresAt, nowMs())}`;
              };

              return (
                <Card class="p-4" interactive>
                  <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                    <div class="min-w-0 space-y-1.5">
                      <div class="flex items-center gap-2 flex-wrap">
                        <span class="text-sm font-medium text-fg truncate">{l.label}</span>
                        <Badge tone={badge().tone} size="sm">{badge().label}</Badge>
                        <Show when={l.expiryMode === "sliding"}>
                          <Badge tone="accent" size="sm">Debounce {fmtDuration(l.idleTtlSec)}</Badge>
                        </Show>
                        <Show when={l.lockToFirstIp}>
                          <Badge tone="info" size="sm">
                            {l.lockedIp ? `Locked: ${l.lockedIp}` : "1-IP Lock"}
                          </Badge>
                        </Show>
                        <Show when={l.ipWhitelist.length > 0}>
                          <Badge tone="violet" size="sm">Whitelist ({l.ipWhitelist.length})</Badge>
                        </Show>
                        <Show when={l.hasPassword}>
                          <Badge tone="amber" size="sm">Password</Badge>
                        </Show>
                        <Show when={l.activeTransfersCount > 0}>
                          <Badge tone="green" size="sm">
                            {l.activeTransfersCount} active · {fmtSpeed(l.activeBytesPerSec)}
                          </Badge>
                        </Show>
                        <Show when={!l.fileExists}>
                          <Badge tone="red" size="sm">File missing</Badge>
                        </Show>
                      </div>

                      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-secondary">
                        <span class="font-mono text-fg">{l.downloadFilename}</span>
                        <span>·</span>
                        <span class="tabular-nums">{fmtBytes(l.fileSize)}</span>
                        <span>·</span>
                        <span class="tabular-nums font-medium text-fg">{countdown()}</span>
                        <span>·</span>
                        <span class="tabular-nums">
                          {l.downloadCount}
                          {l.maxDownloads ? `/${l.maxDownloads}` : ""} dl ({fmtBytes(l.totalBytesServed)} served)
                        </span>
                        <Show when={l.lastActivityAt}>
                          <span>· Last activity {fmtDate(l.lastActivityAt)}</span>
                        </Show>
                      </div>
                    </div>

                    <div class="flex items-center gap-1.5 flex-wrap shrink-0">
                      <Btn size="xs" variant="secondary" onClick={() => void copyWithToast(l.publicUrl, "Direct link copied")}>
                        <Icon name={Icons.copy} size={13} />
                        Copy URL
                      </Btn>
                      <IconBtn icon={Icons.qrCode} title="QR Code & CLI commands" onClick={() => setShareLink(l)} />
                      <IconBtn icon={Icons.activity} title="Telemetry & authorized IPs" onClick={() => setDetailLinkId(l.id)} />
                      <Show when={l.status !== "revoked"}>
                        <Show when={l.expiryMode !== "never"}>
                          <IconBtn icon={Icons.timer} title="Extend +3 hours" onClick={() => void extend3h(l)} />
                        </Show>
                        <IconBtn
                          icon={l.status === "paused" ? Icons.play : Icons.pause}
                          title={l.status === "paused" ? "Resume link" : "Pause link"}
                          onClick={() => void togglePause(l)}
                        />
                        <IconBtn
                          icon={Icons.edit}
                          title="Edit link"
                          onClick={() => {
                            setEditing(l);
                            setComposerOpen(true);
                          }}
                        />
                        <IconBtn icon={Icons.ban} title="Revoke & kill active transfers" danger onClick={() => void revoke(l)} />
                      </Show>
                      <IconBtn icon={Icons.trash} title="Delete record" danger onClick={() => setConfirmDelete(l)} />
                    </div>
                  </div>
                </Card>
              );
            }}
          </For>
        </div>
      </Show>

      <LinkComposerModal
        open={composerOpen()}
        onClose={() => {
          setComposerOpen(false);
          setEditing(null);
        }}
        editing={editing()}
        clientIp={clientIp()}
        defaults={defaults()}
        onSaved={(link, isNew) => {
          void load();
          if (isNew) setShareLink(link);
        }}
      />

      <LinkShareModal
        link={shareLink()}
        onClose={() => setShareLink(null)}
        onChecksumComputed={() => void load()}
      />

      <LinkDetailModal
        linkId={detailLinkId()}
        onClose={() => setDetailLinkId(null)}
        onChanged={() => void load()}
      />

      <Modal
        open={!!confirmDelete()}
        onClose={() => setConfirmDelete(null)}
        title="Delete link record?"
        description="This permanently removes the link and its event history from CDL."
        width="max-w-md"
        footer={
          <>
            <Btn variant="ghost" onClick={() => setConfirmDelete(null)}>Cancel</Btn>
            <Btn variant="danger-solid" onClick={() => confirmDelete() && void remove(confirmDelete()!)}>
              Delete Permanently
            </Btn>
          </>
        }
      >
        <p class="text-sm text-fg-secondary">
          Link <strong class="text-fg">{confirmDelete()?.label}</strong> will stop working immediately. Source files inside your mounted folder are never modified.
        </p>
      </Modal>
    </div>
  );
}
