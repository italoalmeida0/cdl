import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";

import {
  api,
  type DownloadEventDto,
  type LinkAuthorizedIpDto,
  type LinkDto,
  type LiveTransferDto,
} from "../api";
import {
  Badge,
  Btn,
  Icon,
  Icons,
  Modal,
  ModalSection,
  Progress,
  fmtBytes,
  fmtDate,
  fmtDuration,
  fmtSpeed,
  timeUntil,
  toast,
} from "../ui";

export function LinkDetailModal(props: {
  linkId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [link, setLink] = createSignal<LinkDto | null>(null);
  const [authIps, setAuthIps] = createSignal<LinkAuthorizedIpDto[]>([]);
  const [events, setEvents] = createSignal<DownloadEventDto[]>([]);
  const [transfers, setTransfers] = createSignal<LiveTransferDto[]>([]);
  const [loading, setLoading] = createSignal(false);

  const load = async () => {
    const id = props.linkId;
    if (!id) return;
    setLoading(true);
    try {
      const [detail, live] = await Promise.all([
        api<{ link: LinkDto; authorizedIps: LinkAuthorizedIpDto[]; events: DownloadEventDto[] }>(
          "GET",
          `/api/links/${id}`,
        ),
        api<{ transfers: LiveTransferDto[] }>("GET", `/api/transfers/live?linkId=${id}`),
      ]);
      setLink(detail.link);
      setAuthIps(detail.authorizedIps);
      setEvents(detail.events);
      setTransfers(live.transfers);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to load link details", "err");
    } finally {
      setLoading(false);
    }
  };

  createEffect(() => {
    if (!props.linkId) return;
    void load();
    const timer = setInterval(() => {
      void api<{ transfers: LiveTransferDto[] }>("GET", `/api/transfers/live?linkId=${props.linkId}`)
        .then((r) => setTransfers(r.transfers))
        .catch(() => {});
    }, 2000);
    onCleanup(() => clearInterval(timer));
  });

  const extendBy = async (seconds: number) => {
    const id = props.linkId;
    if (!id) return;
    try {
      await api("POST", `/api/links/${id}/extend`, { seconds });
      toast(`Extended by ${fmtDuration(seconds)}`);
      await load();
      props.onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to extend link", "err");
    }
  };

  const unlockIp = async () => {
    const id = props.linkId;
    if (!id) return;
    try {
      await api("POST", `/api/links/${id}/unlock-ip`, {});
      toast("IP lock cleared");
      await load();
      props.onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to unlock IP", "err");
    }
  };

  const killTransfer = async (transferId: string) => {
    try {
      await api("DELETE", `/api/transfers/${transferId}`);
      toast("Transfer aborted");
      await load();
      props.onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to abort transfer", "err");
    }
  };

  return (
    <Modal
      open={!!props.linkId}
      onClose={props.onClose}
      title={link()?.label || "Link Telemetry & Sessions"}
      description={link() ? `${link()!.downloadFilename} · ${fmtBytes(link()!.fileSize)}` : undefined}
      width="max-w-3xl"
      footer={
        <Btn variant="ghost" onClick={props.onClose}>
          Close
        </Btn>
      }
    >
      <Show
        when={link()}
        fallback={<div class="py-8 text-center text-sm text-fg-muted">{loading() ? "Loading…" : "No details"}</div>}
      >
        {(l) => (
          <div class="space-y-5">
            {/* Quick Extend + Lock Status */}
            <div class="rounded-panel border border-border bg-surface-subtle p-3.5 flex flex-wrap items-center justify-between gap-3">
              <div class="space-y-0.5">
                <div class="text-xs text-fg-muted">Status &amp; expiration</div>
                <div class="flex items-center gap-2 flex-wrap">
                  <Badge
                    tone={
                      l().effectiveStatus === "active"
                        ? "green"
                        : l().effectiveStatus === "resume_only"
                          ? "amber"
                          : l().effectiveStatus === "paused"
                            ? "info"
                            : "red"
                    }
                  >
                    {l().effectiveStatus === "resume_only" ? "Resume Only" : l().effectiveStatus}
                  </Badge>
                  <span class="text-sm font-medium text-fg tabular-nums">
                    {l().expiryMode === "never" ? "Never expires" : `Expires in ${timeUntil(l().expiresAt)} (${fmtDate(l().expiresAt)})`}
                  </span>
                </div>
                <Show when={l().lockedIp}>
                  <div class="text-xs text-fg-secondary pt-1 flex items-center gap-2">
                    <span>
                      Locked to IP <code class="font-mono text-fg">{l().lockedIp}</code>
                    </span>
                    <Btn size="xs" variant="secondary" onClick={() => void unlockIp()}>
                      <Icon name={Icons.unlock} size={12} />
                      Unlock IP
                    </Btn>
                  </div>
                </Show>
              </div>
              <Show when={l().status !== "revoked" && l().expiryMode !== "never"}>
                <div class="flex items-center gap-1.5 flex-wrap">
                  <span class="text-xs text-fg-muted mr-1">Extend:</span>
                  <Btn size="xs" variant="secondary" onClick={() => void extendBy(3600)}>+1h</Btn>
                  <Btn size="xs" variant="secondary" onClick={() => void extendBy(10800)}>+3h</Btn>
                  <Btn size="xs" variant="secondary" onClick={() => void extendBy(86400)}>+24h</Btn>
                  <Btn size="xs" variant="secondary" onClick={() => void extendBy(604800)}>+7d</Btn>
                </div>
              </Show>
            </div>

            {/* Active Live Transfers */}
            <ModalSection title={`Active streams (${transfers().length})`}>
              <Show
                when={transfers().length > 0}
                fallback={<div class="text-xs text-fg-muted py-2">No downloads streaming right now.</div>}
              >
                <div class="space-y-2">
                  <For each={transfers()}>
                    {(t) => (
                      <div class="rounded-panel border border-border bg-surface p-3 space-y-2">
                        <div class="flex items-center justify-between gap-2 text-xs">
                          <div class="flex items-center gap-2 min-w-0">
                            <code class="font-mono text-fg font-medium">{t.ip}</code>
                            <span class="text-fg-muted truncate">{t.userAgent || "Unknown client"}</span>
                          </div>
                          <div class="flex items-center gap-2 shrink-0">
                            <span class="font-mono tabular-nums text-accent font-medium">{fmtSpeed(t.bytesPerSec)}</span>
                            <Btn size="xs" variant="danger" onClick={() => void killTransfer(t.id)}>
                              Kill
                            </Btn>
                          </div>
                        </div>
                        <Progress value={t.bytesSent} max={t.totalRangeBytes || 1} />
                        <div class="flex justify-between text-2xs text-fg-muted tabular-nums">
                          <span>
                            {fmtBytes(t.bytesSent)} / {fmtBytes(t.totalRangeBytes)} ({t.progressPct}%)
                          </span>
                          <span>Offset {fmtBytes(t.rangeStart)}</span>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </ModalSection>

            {/* Authorized Resume IPs */}
            <ModalSection
              title={`Started downloader IPs (${authIps().length})`}
              subtitle={
                l().startedIpCanResume
                  ? `These IPs can resume within ${l().resumeGraceSec === 0 ? "unlimited time" : fmtDuration(l().resumeGraceSec)} after their last activity even if the link expires for others.`
                  : "Started-IP resume grace is disabled on this link."
              }
            >
              <Show
                when={authIps().length > 0}
                fallback={<div class="text-xs text-fg-muted py-2">No IP has started downloading yet.</div>}
              >
                <div class="rounded-panel border border-border overflow-hidden">
                  <table class="w-full text-left text-xs">
                    <thead class="bg-surface-subtle text-fg-muted border-b border-border">
                      <tr>
                        <th class="py-2 px-3 font-medium">IP Address</th>
                        <th class="py-2 px-3 font-medium">Started</th>
                        <th class="py-2 px-3 font-medium">Last Activity</th>
                        <th class="py-2 px-3 font-medium text-right">Requests</th>
                        <th class="py-2 px-3 font-medium text-right">Transferred</th>
                      </tr>
                    </thead>
                    <tbody class="divide-y divide-border-subtle">
                      <For each={authIps()}>
                        {(row) => (
                          <tr>
                            <td class="py-2 px-3 font-mono text-fg">{row.ip}</td>
                            <td class="py-2 px-3 text-fg-secondary">{fmtDate(row.firstStartedAt)}</td>
                            <td class="py-2 px-3 text-fg-secondary">{fmtDate(row.lastActivityAt)}</td>
                            <td class="py-2 px-3 text-right tabular-nums text-fg-secondary">{row.requestsCount}</td>
                            <td class="py-2 px-3 text-right tabular-nums text-fg">{fmtBytes(row.bytesSent)}</td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              </Show>
            </ModalSection>

            {/* Recent Events */}
            <ModalSection title="Recent request log">
              <Show
                when={events().length > 0}
                fallback={<div class="text-xs text-fg-muted py-2">No requests logged yet.</div>}
              >
                <div class="rounded-panel border border-border overflow-x-auto max-h-56 overflow-y-auto">
                  <table class="w-full text-left text-xs">
                    <thead class="bg-surface-subtle text-fg-muted border-b border-border sticky top-0">
                      <tr>
                        <th class="py-2 px-3 font-medium">Time</th>
                        <th class="py-2 px-3 font-medium">IP</th>
                        <th class="py-2 px-3 font-medium">Method</th>
                        <th class="py-2 px-3 font-medium">Outcome</th>
                        <th class="py-2 px-3 font-medium text-right">Bytes</th>
                      </tr>
                    </thead>
                    <tbody class="divide-y divide-border-subtle">
                      <For each={events()}>
                        {(ev) => (
                          <tr>
                            <td class="py-2 px-3 text-fg-secondary whitespace-nowrap">{fmtDate(ev.ts)}</td>
                            <td class="py-2 px-3 font-mono text-fg">{ev.ip}</td>
                            <td class="py-2 px-3 font-mono text-fg-secondary">{ev.method} ({ev.status})</td>
                            <td class="py-2 px-3">
                              <Badge tone={ev.status < 400 ? "green" : ev.status === 401 ? "amber" : "red"}>
                                {ev.outcome}
                              </Badge>
                            </td>
                            <td class="py-2 px-3 text-right tabular-nums text-fg">{fmtBytes(ev.bytesSent)}</td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              </Show>
            </ModalSection>
          </div>
        )}
      </Show>
    </Modal>
  );
}
