import { createSignal, For, onCleanup, onMount, Show } from "solid-js";

import {
  api,
  type DownloadEventDto,
  type LinkDto,
  type LinkPolicyDefaults,
  type LiveTransferDto,
  type MountStatusDto,
} from "../api";
import { navigate, PageTitle } from "../chrome";
import { LinkComposerModal } from "../components/LinkComposerModal";
import { LinkDetailModal } from "../components/LinkDetailModal";
import { LinkShareModal } from "../components/LinkShareModal";
import {
  Badge,
  Btn,
  Card,
  CardHeader,
  EmptyState,
  Icon,
  IconBtn,
  Icons,
  Progress,
  copyWithToast,
  fmtBytes,
  fmtDate,
  fmtSpeed,
  timeUntil,
  toast,
} from "../ui";

interface OverviewData {
  stats: {
    totalLinks: number;
    activeLinks: number;
    activeTransfers: number;
    currentBytesPerSec: number;
    totalDownloads: number;
    totalBytesServed: number;
  };
  mount: MountStatusDto;
  publicBaseUrl: string;
  recentLinks: LinkDto[];
  liveTransfers: LiveTransferDto[];
  recentEvents: DownloadEventDto[];
}

export default function OverviewPage() {
  const [data, setData] = createSignal<OverviewData | null>(null);
  const [defaults, setDefaults] = createSignal<LinkPolicyDefaults | null>(null);
  const [clientIp, setClientIp] = createSignal("");
  const [nowMs, setNowMs] = createSignal(Date.now());
  const [composerOpen, setComposerOpen] = createSignal(false);
  const [shareLink, setShareLink] = createSignal<LinkDto | null>(null);
  const [detailLinkId, setDetailLinkId] = createSignal<string | null>(null);

  const load = async () => {
    try {
      const [ov, settings] = await Promise.all([
        api<OverviewData>("GET", "/api/overview"),
        api<{ clientIp: string; defaultPolicy: LinkPolicyDefaults }>("GET", "/api/settings"),
      ]);
      setData(ov);
      setClientIp(settings.clientIp);
      setDefaults(settings.defaultPolicy);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to load overview", "err");
    }
  };

  onMount(() => {
    void load();
    const poll = setInterval(() => {
      void api<OverviewData>("GET", "/api/overview").then(setData).catch(() => {});
    }, 3000);
    const tick = setInterval(() => setNowMs(Date.now()), 1000);
    onCleanup(() => {
      clearInterval(poll);
      clearInterval(tick);
    });
  });

  const killTransfer = async (id: string) => {
    try {
      await api("DELETE", `/api/transfers/${id}`);
      toast("Transfer aborted");
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to abort transfer", "err");
    }
  };

  return (
    <div class="space-y-6">
      <PageTitle
        title="Overview"
        subtitle="Manage temporary direct download links, active streams, and mounted storage."
        right={
          <div class="flex items-center gap-2">
            <Btn variant="secondary" onClick={() => navigate("/files")}>
              <Icon name={Icons.upload} size={15} />
              Files &amp; Upload
            </Btn>
            <Btn onClick={() => setComposerOpen(true)}>
              <Icon name={Icons.plus} size={15} />
              New Link
            </Btn>
          </div>
        }
      />

      {/* KPI Row */}
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card class="p-4">
          <div class="flex items-center justify-between text-xs text-fg-muted">
            <span>Active links</span>
            <Icon name={Icons.link} size={16} />
          </div>
          <div class="text-2xl font-medium text-fg mt-2 tabular-nums">
            {data()?.stats.activeLinks ?? "—"}
          </div>
          <div class="text-xs text-fg-secondary mt-1">
            {data()?.stats.totalLinks ?? 0} total created
          </div>
        </Card>

        <Card class="p-4">
          <div class="flex items-center justify-between text-xs text-fg-muted">
            <span>Live streams</span>
            <Icon name={Icons.activity} size={16} class={data()?.stats.activeTransfers ? "text-accent" : ""} />
          </div>
          <div class="text-2xl font-medium text-fg mt-2 tabular-nums">
            {data()?.stats.activeTransfers ?? 0}
          </div>
          <div class="text-xs text-accent mt-1 tabular-nums">
            {fmtSpeed(data()?.stats.currentBytesPerSec ?? 0)}
          </div>
        </Card>

        <Card class="p-4">
          <div class="flex items-center justify-between text-xs text-fg-muted">
            <span>Total served</span>
            <Icon name={Icons.download} size={16} />
          </div>
          <div class="text-2xl font-medium text-fg mt-2 tabular-nums">
            {fmtBytes(data()?.stats.totalBytesServed ?? 0)}
          </div>
          <div class="text-xs text-fg-secondary mt-1 tabular-nums">
            {data()?.stats.totalDownloads ?? 0} downloads started
          </div>
        </Card>

        <Card class="p-4">
          <div class="flex items-center justify-between text-xs text-fg-muted">
            <span>Mounted library</span>
            <Icon name={Icons.hardDrive} size={16} />
          </div>
          <div class="mt-2 flex items-center gap-2">
            <Badge tone={data()?.mount.readable ? "green" : "amber"}>
              {data()?.mount.readable ? "Connected" : "Unavailable"}
            </Badge>
          </div>
          <div class="text-xs text-fg-muted font-mono truncate mt-1.5">
            {data()?.mount.path ?? "/files"}
          </div>
        </Card>
      </div>

      {/* Live Transfers Monitor */}
      <Card>
        <CardHeader
          title="Live download streams"
          subtitle="Active multi-hour downloads never expire mid-connection and refresh sliding timers automatically."
          right={
            <Show when={(data()?.liveTransfers.length ?? 0) > 0}>
              <Badge tone="green">{data()!.liveTransfers.length} streaming</Badge>
            </Show>
          }
        />
        <div class="px-6 pb-5">
          <Show
            when={(data()?.liveTransfers.length ?? 0) > 0}
            fallback={
              <div class="rounded-panel border border-border-subtle bg-surface-subtle p-5 text-center text-xs text-fg-muted">
                No active transfers right now. Active downloads appear here with live throughput and a kill switch.
              </div>
            }
          >
            <div class="space-y-2.5">
              <For each={data()?.liveTransfers ?? []}>
                {(t) => (
                  <div class="rounded-panel border border-border bg-surface-subtle p-3.5 space-y-2">
                    <div class="flex flex-wrap items-center justify-between gap-2">
                      <div class="min-w-0">
                        <div class="text-sm font-medium text-fg truncate">{t.filename}</div>
                        <div class="text-xs text-fg-muted font-mono">
                          {t.ip} · Offset {fmtBytes(t.rangeStart)}
                        </div>
                      </div>
                      <div class="flex items-center gap-2">
                        <span class="text-xs font-mono font-medium text-accent tabular-nums">
                          {fmtSpeed(t.bytesPerSec)}
                        </span>
                        <Btn size="xs" variant="danger" onClick={() => void killTransfer(t.id)}>
                          Kill
                        </Btn>
                      </div>
                    </div>
                    <Progress value={t.bytesSent} max={t.totalRangeBytes || 1} />
                    <div class="flex justify-between text-2xs text-fg-muted tabular-nums">
                      <span>{fmtBytes(t.bytesSent)} / {fmtBytes(t.totalRangeBytes)}</span>
                      <span>{t.progressPct}%</span>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Card>

      {/* Recent Links & Recent Activity */}
      <div class="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <Card>
          <CardHeader
            title="Recent links"
            right={
              <Btn size="xs" variant="ghost" onClick={() => navigate("/links")}>
                View all
              </Btn>
            }
          />
          <div class="px-6 pb-5">
            <Show
              when={(data()?.recentLinks.length ?? 0) > 0}
              fallback={<EmptyState icon={Icons.link} title="No links yet" hint="Create your first direct download link." />}
            >
              <div class="divide-y divide-border-subtle">
                <For each={data()?.recentLinks ?? []}>
                  {(l) => (
                    <div class="py-3 flex items-center justify-between gap-3">
                      <div class="min-w-0">
                        <div class="flex items-center gap-2">
                          <span class="text-sm font-medium text-fg truncate">{l.label}</span>
                          <Badge
                            tone={
                              l.effectiveStatus === "active"
                                ? "green"
                                : l.effectiveStatus === "resume_only"
                                  ? "amber"
                                  : l.effectiveStatus === "paused"
                                    ? "info"
                                    : "red"
                            }
                            size="sm"
                          >
                            {l.effectiveStatus === "resume_only" ? "Resume Only" : l.effectiveStatus}
                          </Badge>
                        </div>
                        <div class="text-xs text-fg-muted mt-0.5 tabular-nums truncate">
                          {fmtBytes(l.fileSize)} · {l.expiryMode === "never" ? "Never expires" : `Left: ${timeUntil(l.expiresAt, nowMs())}`}
                        </div>
                      </div>
                      <div class="flex items-center gap-1 shrink-0">
                        <IconBtn icon={Icons.copy} title="Copy direct URL" onClick={() => void copyWithToast(l.publicUrl, "Direct link copied")} />
                        <IconBtn icon={Icons.qrCode} title="QR & CLI" onClick={() => setShareLink(l)} />
                        <IconBtn icon={Icons.activity} title="Details" onClick={() => setDetailLinkId(l.id)} />
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Recent download activity"
            right={
              <Btn size="xs" variant="ghost" onClick={() => navigate("/activity")}>
                Full log
              </Btn>
            }
          />
          <div class="px-6 pb-5">
            <Show
              when={(data()?.recentEvents.length ?? 0) > 0}
              fallback={<EmptyState icon={Icons.activity} title="No downloads yet" hint="Shared link access events appear here." />}
            >
              <div class="divide-y divide-border-subtle">
                <For each={data()?.recentEvents ?? []}>
                  {(ev) => (
                    <div class="py-2.5 flex items-center justify-between gap-3 text-xs">
                      <div class="min-w-0">
                        <div class="font-medium text-fg truncate">{ev.filename || ev.label}</div>
                        <div class="text-fg-muted font-mono truncate">
                          {ev.ip} · {fmtDate(ev.ts)}
                        </div>
                      </div>
                      <div class="flex items-center gap-2 shrink-0">
                        <span class="text-fg-secondary tabular-nums">{fmtBytes(ev.bytesSent)}</span>
                        <Badge tone={ev.status < 400 ? "green" : ev.status === 401 ? "amber" : "red"} size="sm">
                          {ev.outcome}
                        </Badge>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Card>
      </div>

      <LinkComposerModal
        open={composerOpen()}
        onClose={() => setComposerOpen(false)}
        clientIp={clientIp()}
        defaults={defaults()}
        onSaved={(link) => {
          void load();
          setShareLink(link);
        }}
      />

      <LinkShareModal link={shareLink()} onClose={() => setShareLink(null)} />
      <LinkDetailModal linkId={detailLinkId()} onClose={() => setDetailLinkId(null)} onChanged={() => void load()} />
    </div>
  );
}
