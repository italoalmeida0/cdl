import QRCode from "qrcode";
import { createSignal, For, onMount, Show } from "solid-js";

import { api, type LinkPolicyDefaults, type SettingsDto } from "../api";
import { PageTitle } from "../chrome";
import {
  AccentPicker,
  Alert,
  Badge,
  Btn,
  Card,
  CardHeader,
  CopyButton,
  Icon,
  Icons,
  Input,
  Segmented,
  Select,
  SwitchCard,
  fmtDate,
  setThemeMode,
  themeMode,
  toast,
} from "../ui";

interface SessionDto {
  jti: string;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
  ip: string | null;
  ua: string | null;
  current: boolean;
}

export default function SettingsPage() {
  const [settings, setSettings] = createSignal<SettingsDto | null>(null);
  const [baseUrlInput, setBaseUrlInput] = createSignal("");
  const [policy, setPolicy] = createSignal<LinkPolicyDefaults>({
    expiryMode: "sliding",
    idleTtlSec: 10800,
    fixedTtlSec: 86400,
    startedIpCanResume: true,
    resumeGraceSec: 10800,
    lockToFirstIp: false,
    maxDownloads: null,
    autoDeleteFile: false,
    allowInline: false,
  });
  const [savingSettings, setSavingSettings] = createSignal(false);

  // Account security
  const [totpEnabled, setTotpEnabled] = createSignal(false);
  const [totpSetup, setTotpSetup] = createSignal<{ secret: string; uri: string; qrSvg: string } | null>(null);
  const [totpCode, setTotpCode] = createSignal("");
  const [disablePw, setDisablePw] = createSignal("");
  const [sessions, setSessions] = createSignal<SessionDto[]>([]);

  const [curPw, setCurPw] = createSignal("");
  const [newPw, setNewPw] = createSignal("");
  const [confPw, setConfPw] = createSignal("");
  const [savingPw, setSavingPw] = createSignal(false);

  const load = async () => {
    try {
      const [s, acc, sess] = await Promise.all([
        api<SettingsDto>("GET", "/api/settings"),
        api<{ admin: { totpEnabled: boolean } }>("GET", "/api/account"),
        api<{ sessions: SessionDto[] }>("GET", "/api/account/sessions"),
      ]);
      setSettings(s);
      setBaseUrlInput(s.baseUrlOverride);
      setPolicy(s.defaultPolicy);
      setTotpEnabled(acc.admin.totpEnabled);
      setSessions(sess.sessions);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to load settings", "err");
    }
  };

  onMount(() => {
    void load();
  });

  const saveSettings = async () => {
    setSavingSettings(true);
    try {
      await api("PATCH", "/api/settings", {
        ...(settings()?.envBaseUrlLocked ? {} : { baseUrlOverride: baseUrlInput().trim() }),
        defaultPolicy: policy(),
      });
      toast("Settings saved");
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to save settings", "err");
    } finally {
      setSavingSettings(false);
    }
  };

  const changePassword = async (e: Event) => {
    e.preventDefault();
    if (newPw().length < 8) return toast("New password must be at least 8 characters", "err");
    if (newPw() !== confPw()) return toast("Passwords do not match", "err");
    setSavingPw(true);
    try {
      await api("POST", "/api/account/password", { currentPassword: curPw(), newPassword: newPw() });
      setCurPw("");
      setNewPw("");
      setConfPw("");
      toast("Admin password updated (other sessions revoked)");
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to update password", "err");
    } finally {
      setSavingPw(false);
    }
  };

  const startTotp = async () => {
    try {
      const res = await api<{ secret: string; uri: string }>("POST", "/api/account/totp/setup", {});
      const qrSvg = await QRCode.toString(res.uri, { type: "svg", margin: 1, width: 160 });
      setTotpSetup({ ...res, qrSvg });
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to start 2FA setup", "err");
    }
  };

  const confirmTotp = async (e: Event) => {
    e.preventDefault();
    try {
      await api("POST", "/api/account/totp/confirm", { code: totpCode().trim() });
      setTotpSetup(null);
      setTotpCode("");
      setTotpEnabled(true);
      toast("Two-factor authentication enabled");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Invalid code", "err");
    }
  };

  const disable2fa = async () => {
    if (!disablePw()) return toast("Enter your admin password to disable 2FA", "err");
    try {
      await api("DELETE", "/api/account/totp", { password: disablePw() });
      setDisablePw("");
      setTotpEnabled(false);
      toast("Two-factor authentication disabled");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to disable 2FA", "err");
    }
  };

  const revokeSess = async (jti: string) => {
    try {
      await api("DELETE", `/api/account/sessions/${jti}`);
      toast("Session revoked");
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to revoke session", "err");
    }
  };

  const nginxSnippet = () => {
    const bp = settings()?.effectiveBasePath || "/cdl";
    return `location ${bp}/ {\n    proxy_pass http://127.0.0.1:3000;\n    proxy_http_version 1.1;\n    proxy_set_header Host $host;\n    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n    proxy_set_header X-Forwarded-Proto $scheme;\n    proxy_buffering off;\n    proxy_request_buffering off;\n    client_max_body_size 0;\n}`;
  };

  return (
    <div class="space-y-6 max-w-5xl mx-auto">
      <PageTitle
        title="Settings"
        subtitle="Configure Base URL / subpath behavior, default link policies, appearance, and admin security."
      />

      {/* Base URL & Container Runtime */}
      <Card>
        <CardHeader
          title="Base URL & Subpath Configuration"
          subtitle="CDL strips or keeps your subpath automatically so both reverse proxies and Docker healthchecks work seamlessly."
        />
        <div class="px-6 pb-6 space-y-4">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div class="rounded-panel border border-border bg-surface-subtle p-3">
              <div class="text-fg-muted">Effective Public Base URL</div>
              <div class="font-mono text-fg mt-1 break-all">{settings()?.effectiveBaseUrl || "—"}</div>
            </div>
            <div class="rounded-panel border border-border bg-surface-subtle p-3">
              <div class="text-fg-muted">Detected Client IP (TRUST_PROXY={settings()?.trustProxy ? "true" : "false"})</div>
              <div class="font-mono text-fg mt-1">{settings()?.clientIp || "—"}</div>
            </div>
          </div>

          <Show
            when={!settings()?.envBaseUrlLocked}
            fallback={
              <Alert tone="info" icon={<Icon name={Icons.globe} size={16} />}>
                <code class="font-mono">BASE_URL</code> is managed via container environment (<code class="font-mono">{settings()?.envBaseUrl}</code>). Update the container env var to change it.
              </Alert>
            }
          >
            <Input
              label="Base URL override (when BASE_URL env is unset)"
              value={baseUrlInput()}
              onInput={setBaseUrlInput}
              placeholder="https://example.com/lalala/"
              hint="Leave empty to auto-detect from incoming request Host/Proto."
            />
          </Show>

          <div class="space-y-1.5">
            <div class="flex items-center justify-between">
              <span class="text-xs font-medium text-fg-secondary">Nginx reverse proxy snippet (large streaming + subpath)</span>
              <CopyButton text={nginxSnippet()} label="Copy snippet" />
            </div>
            <pre class="rounded-panel border border-border bg-surface-subtle p-3 text-xs font-mono text-fg overflow-x-auto">
              {nginxSnippet()}
            </pre>
          </div>
        </div>
      </Card>

      {/* Default Link Policy */}
      <Card>
        <CardHeader
          title="Default Link Policy"
          subtitle="Pre-filled defaults when creating new delivery links."
        />
        <div class="px-6 pb-6 space-y-4">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Select
              label="Default expiration mode"
              value={policy().expiryMode}
              onChange={(v) => setPolicy({ ...policy(), expiryMode: v as LinkPolicyDefaults["expiryMode"] })}
              options={[
                { value: "sliding", label: "Auto-expire (Sliding debounce)" },
                { value: "fixed", label: "Fixed timer" },
                { value: "never", label: "Never expires" },
              ]}
            />
            <Select
              label="Default sliding idle timeout"
              value={String(policy().idleTtlSec)}
              onChange={(v) => setPolicy({ ...policy(), idleTtlSec: Number(v) })}
              options={[
                { value: "1800", label: "30 minutes" },
                { value: "3600", label: "1 hour" },
                { value: "10800", label: "3 hours" },
                { value: "21600", label: "6 hours" },
                { value: "86400", label: "24 hours" },
              ]}
            />
          </div>

          <SwitchCard
            checked={policy().startedIpCanResume}
            onChange={(v) => setPolicy({ ...policy(), startedIpCanResume: v })}
            title="Allow started IPs to resume after expiration by default"
          />
          <SwitchCard
            checked={policy().lockToFirstIp}
            onChange={(v) => setPolicy({ ...policy(), lockToFirstIp: v })}
            title="Lock links to first downloader IP by default"
          />
          <SwitchCard
            checked={policy().autoDeleteFile}
            onChange={(v) => setPolicy({ ...policy(), autoDeleteFile: v })}
            title="Auto-delete uploaded files after expiry by default"
          />

          <div class="flex justify-end">
            <Btn loading={savingSettings()} onClick={() => void saveSettings()}>
              Save Defaults
            </Btn>
          </div>
        </div>
      </Card>

      {/* Appearance */}
      <Card>
        <CardHeader title="Appearance" subtitle="Theme and accent color apply immediately across the dashboard." />
        <div class="px-6 pb-6 space-y-4">
          <div class="space-y-1.5">
            <div class="text-xs font-medium text-fg-secondary">Theme</div>
            <div class="max-w-full min-w-0">
              <Segmented
                value={themeMode()}
                onChange={(m) => setThemeMode(m)}
                options={[
                  { value: "system", label: "System" },
                  { value: "light", label: "Light" },
                  { value: "dark", label: "Dark" },
                  { value: "high-contrast", label: "Contrast" },
                ]}
              />
            </div>
          </div>
          <div class="space-y-1.5">
            <div class="text-xs font-medium text-fg-secondary">Accent</div>
            <AccentPicker />
          </div>
        </div>
      </Card>

      {/* Account Security */}
      <Card>
        <CardHeader title="Single Admin Security" subtitle="Change your admin password, manage 2FA, and review active sessions." />
        <div class="px-6 pb-6 space-y-6">
          <form onSubmit={changePassword} class="space-y-3 max-w-md">
            <div class="text-sm font-medium text-fg">Change Password</div>
            <Input label="Current password" type="password" value={curPw()} onInput={setCurPw} required />
            <Input label="New password" type="password" value={newPw()} onInput={setNewPw} required />
            <Input label="Confirm new password" type="password" value={confPw()} onInput={setConfPw} required />
            <Btn type="submit" loading={savingPw()}>Update Password</Btn>
          </form>

          <div class="border-t border-border pt-5 space-y-3">
            <div class="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <div class="text-sm font-medium text-fg">Two-Factor Authentication (TOTP)</div>
                <div class="text-xs text-fg-secondary">Optional authenticator app protection for the admin login.</div>
              </div>
              <Badge tone={totpEnabled() ? "green" : "zinc"}>{totpEnabled() ? "Enabled" : "Disabled"}</Badge>
            </div>

            <Show when={!totpEnabled() && !totpSetup()}>
              <Btn variant="secondary" onClick={() => void startTotp()}>
                <Icon name={Icons.shield} size={14} />
                Enable 2FA
              </Btn>
            </Show>

            <Show when={totpSetup()}>
              {(setup) => (
                <form onSubmit={confirmTotp} class="rounded-panel border border-border bg-surface-subtle p-4 space-y-3 max-w-md">
                  <div
                    class="bg-white p-2 rounded-xl w-[160px] h-[160px] border border-border-subtle"
                    /* eslint-disable-next-line solid/no-innerhtml */
                    innerHTML={setup().qrSvg}
                  />
                  <div class="text-xs text-fg-secondary">
                    Scan with your authenticator app or enter secret: <code class="font-mono text-fg">{setup().secret}</code>
                  </div>
                  <Input label="6-digit verification code" value={totpCode()} onInput={setTotpCode} placeholder="123456" required />
                  <div class="flex gap-2">
                    <Btn type="submit">Verify &amp; Activate</Btn>
                    <Btn variant="ghost" onClick={() => setTotpSetup(null)}>Cancel</Btn>
                  </div>
                </form>
              )}
            </Show>

            <Show when={totpEnabled()}>
              <div class="flex items-end gap-2 max-w-md">
                <div class="flex-1">
                  <Input label="Confirm password to disable 2FA" type="password" value={disablePw()} onInput={setDisablePw} />
                </div>
                <Btn variant="danger" onClick={() => void disable2fa()}>Disable 2FA</Btn>
              </div>
            </Show>
          </div>

          <div class="border-t border-border pt-5 space-y-2.5">
            <div class="text-sm font-medium text-fg">Active Admin Sessions ({sessions().length})</div>
            <div class="divide-y divide-border-subtle rounded-panel border border-border overflow-hidden">
              <For each={sessions()}>
                {(s) => (
                  <div class="px-3.5 py-2.5 flex items-center justify-between gap-3 text-xs bg-surface">
                    <div class="min-w-0">
                      <div class="flex items-center gap-2">
                        <span class="font-mono text-fg">{s.ip ?? "unknown"}</span>
                        <Show when={s.current}><Badge tone="accent" size="sm">Current</Badge></Show>
                      </div>
                      <div class="text-fg-muted truncate">
                        Last active {fmtDate(s.lastUsedAt)} · {s.ua || "Browser session"}
                      </div>
                    </div>
                    <Show when={!s.current}>
                      <Btn size="xs" variant="danger" onClick={() => void revokeSess(s.jti)}>Revoke</Btn>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
