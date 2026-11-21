import { createSignal, For, onMount, Show } from "solid-js";

import { api, type DownloadEventDto } from "../api";
import { PageTitle } from "../chrome";
import { Badge, Btn, Card, EmptyState, Icon, Icons, Segmented, fmtBytes, fmtDate, fmtDuration, toast } from "../ui";

interface AuditEntry {
  id: number;
  ts: number;
  action: string;
  target: string | null;
  meta: unknown;
  ip: string | null;
}

export default function ActivityPage() {
  const [kind, setKind] = createSignal<"downloads" | "audit">("downloads");
  const [events, setEvents] = createSignal<DownloadEventDto[]>([]);
  const [auditRows, setAuditRows] = createSignal<AuditEntry[]>([]);
  const [loading, setLoading] = createSignal(true);

  const load = async (targetKind = kind()) => {
    setLoading(true);
    try {
      if (targetKind === "downloads") {
        const res = await api<{ events: DownloadEventDto[] }>("GET", "/api/activity?kind=downloads&limit=200");
        setEvents(res.events);
      } else {
        const res = await api<{ audit: AuditEntry[] }>("GET", "/api/activity?kind=audit&limit=200");
        setAuditRows(res.audit);
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to load activity", "err");
    } finally {
      setLoading(false);
    }
  };

  onMount(() => {
    void load("downloads");
  });

  return (
    <div class="space-y-5">
      <PageTitle
        title="Activity Log"
        subtitle="Audit every download request, range resume, IP rejection, and admin change."
        right={
          <div class="flex items-center gap-2">
            <Segmented
              value={kind()}
              onChange={(k) => {
                setKind(k);
                void load(k);
              }}
              options={[
                { value: "downloads", label: "Download Events" },
                { value: "audit", label: "Admin Audit" },
              ]}
            />
            <Btn variant="secondary" onClick={() => void load()}>
              <Icon name={Icons.refresh} size={14} />
              Refresh
            </Btn>
          </div>
        }
      />

      <Show when={(kind() === "downloads" && events().length > 0) || (kind() === "audit" && auditRows().length > 0)}>
        <div class="md:hidden text-2xs text-fg-muted px-1">
          Swipe horizontally to view all table columns.
        </div>
      </Show>

      <Card>
        <Show when={kind() === "downloads"}>
          <Show
            when={!loading() && events().length > 0}
            fallback={
              <div class="p-8">
                <EmptyState
                  icon={Icons.activity}
                  title={loading() ? "Loading download events…" : "No download events yet"}
                  hint="Requests to /d/:token appear here."
                />
              </div>
            }
          >
            <div class="overflow-x-auto">
              <table class="w-full text-left text-xs">
                <thead class="bg-surface-subtle text-fg-muted border-b border-border">
                  <tr>
                    <th class="py-2.5 px-4 font-medium">Time</th>
                    <th class="py-2.5 px-4 font-medium">File / Link</th>
                    <th class="py-2.5 px-4 font-medium">Client IP</th>
                    <th class="py-2.5 px-4 font-medium">Method / Status</th>
                    <th class="py-2.5 px-4 font-medium">Outcome</th>
                    <th class="py-2.5 px-4 font-medium text-right">Bytes</th>
                    <th class="py-2.5 px-4 font-medium text-right">Duration</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-border-subtle">
                  <For each={events()}>
                    {(ev) => (
                      <tr class="hover:bg-surface-subtle/50">
                        <td class="py-2.5 px-4 text-fg-secondary whitespace-nowrap">{fmtDate(ev.ts)}</td>
                        <td class="py-2.5 px-4">
                          <div class="font-medium text-fg truncate max-w-[220px]">{ev.filename || ev.label}</div>
                          <div class="text-2xs text-fg-muted truncate max-w-[220px]">{ev.userAgent || "—"}</div>
                        </td>
                        <td class="py-2.5 px-4 font-mono text-fg">{ev.ip}</td>
                        <td class="py-2.5 px-4 font-mono text-fg-secondary">
                          {ev.method} · {ev.status}
                          <Show when={ev.rangeStart !== null && ev.rangeStart > 0}>
                            <span class="text-fg-muted"> (@{fmtBytes(ev.rangeStart)})</span>
                          </Show>
                        </td>
                        <td class="py-2.5 px-4">
                          <Badge tone={ev.status < 400 ? "green" : ev.status === 401 ? "amber" : "red"} size="sm">
                            {ev.outcome}
                          </Badge>
                        </td>
                        <td class="py-2.5 px-4 text-right tabular-nums text-fg">{fmtBytes(ev.bytesSent)}</td>
                        <td class="py-2.5 px-4 text-right tabular-nums text-fg-secondary">
                          {fmtDuration(Math.round(ev.durationMs / 1000))}
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </Show>

        <Show when={kind() === "audit"}>
          <Show
            when={!loading() && auditRows().length > 0}
            fallback={
              <div class="p-8">
                <EmptyState icon={Icons.shield} title={loading() ? "Loading audit trail…" : "No audit events"} />
              </div>
            }
          >
            <div class="overflow-x-auto">
              <table class="w-full text-left text-xs">
                <thead class="bg-surface-subtle text-fg-muted border-b border-border">
                  <tr>
                    <th class="py-2.5 px-4 font-medium">Time</th>
                    <th class="py-2.5 px-4 font-medium">Action</th>
                    <th class="py-2.5 px-4 font-medium">Target</th>
                    <th class="py-2.5 px-4 font-medium">IP</th>
                    <th class="py-2.5 px-4 font-medium">Metadata</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-border-subtle">
                  <For each={auditRows()}>
                    {(row) => (
                      <tr class="hover:bg-surface-subtle/50">
                        <td class="py-2.5 px-4 text-fg-secondary whitespace-nowrap">{fmtDate(row.ts)}</td>
                        <td class="py-2.5 px-4 font-mono text-fg font-medium">{row.action}</td>
                        <td class="py-2.5 px-4 font-mono text-fg-secondary">{row.target ?? "—"}</td>
                        <td class="py-2.5 px-4 font-mono text-fg-secondary">{row.ip ?? "—"}</td>
                        <td class="py-2.5 px-4 font-mono text-2xs text-fg-muted max-w-md truncate">
                          {row.meta ? JSON.stringify(row.meta) : "—"}
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </Show>
      </Card>
    </div>
  );
}
