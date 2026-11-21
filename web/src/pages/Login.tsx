import { createSignal, onMount, Show } from "solid-js";

import { publicApi, setSession, withBase } from "../api";
import { usal } from "../motion";
import { Alert, Btn, Card, Icon, Icons, Input, ThemeToggle, capitalize } from "../ui";

function enterApp(res: { accessToken: string; refreshToken: string; admin: any }) {
  setSession({
    accessToken: res.accessToken,
    refreshToken: res.refreshToken,
    admin: res.admin,
  });
  location.hash = "#/";
}

export default function LoginPage() {
  const [mode, setMode] = createSignal<"loading" | "setup" | "login" | "2fa">("loading");
  const [username, setUsername] = createSignal("admin");
  const [password, setPassword] = createSignal("");
  const [confirmPassword, setConfirmPassword] = createSignal("");
  const [code, setCode] = createSignal("");
  const [tempToken, setTempToken] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");

  onMount(async () => {
    try {
      const status = await publicApi<{ needsSetup: boolean; username: string | null }>(
        "GET",
        "/api/auth/status",
      );
      if (status.username) setUsername(status.username);
      setMode(status.needsSetup ? "setup" : "login");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to connect to server");
      setMode("login");
    }
  });

  const submitSetup = async (e: Event) => {
    e.preventDefault();
    setError("");
    if (password().length < 8) {
      return setError("Password must be at least 8 characters long.");
    }
    if (password() !== confirmPassword()) {
      return setError("Passwords do not match.");
    }
    setBusy(true);
    try {
      const res = await publicApi<any>("POST", "/api/auth/setup", {
        username: username().trim(),
        password: password(),
      });
      enterApp(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed");
    } finally {
      setBusy(false);
    }
  };

  const submitLogin = async (e: Event) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await publicApi<any>("POST", "/api/auth/login", {
        username: username().trim(),
        password: password(),
      });
      if (res.needs2FA) {
        setTempToken(res.tempToken);
        setMode("2fa");
        return;
      }
      enterApp(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  const submit2fa = async (e: Event) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await publicApi<any>("POST", "/api/auth/2fa", {
        tempToken: tempToken(),
        code: code().replace(/\s+/g, ""),
      });
      enterApp(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid authenticator code");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="relative min-h-screen flex items-center justify-center px-4 py-10 overflow-hidden">
      <div class="absolute top-4 right-4 z-10">
        <ThemeToggle class="rounded-full bg-surface border border-border shadow-xs" />
      </div>

      <div class="relative w-full max-w-sm">
        <div class="flex flex-col items-center mb-6" {...usal("fade-d duration-500")}>
          <img
            src={withBase("/cdl-icon.svg")}
            alt="CDL"
            class="object-contain w-11 h-11 rounded-xl mb-3"
          />
          <h1 class="brand-wordmark text-2xl tracking-tight text-fg">CDL</h1>
          <p class="text-xs text-fg-secondary mt-1">
            {mode() === "setup"
              ? "Content Delivery Link · Initial Admin Setup"
              : mode() === "2fa"
                ? "Two-factor verification"
                : "Content Delivery Link · Admin Sign In"}
          </p>
        </div>

        <Card class="p-5 sm:p-6">
          <Show when={error()}>
            <Alert tone="danger" class="mb-4" icon={<Icon name={Icons.warning} size={16} />}>
              {capitalize(error())}
            </Alert>
          </Show>

          <Show when={mode() === "loading"}>
            <div class="py-8 text-center text-sm text-fg-muted">Connecting…</div>
          </Show>

          <Show when={mode() === "setup"}>
            <form onSubmit={submitSetup} class="space-y-4">
              <Alert tone="info" icon={<Icon name={Icons.shield} size={16} />}>
                Create your single administrator account. Once configured, registration closes permanently.
              </Alert>
              <Input
                label="Admin username"
                value={username()}
                onInput={setUsername}
                autocomplete="username"
                required
              />
              <Input
                label="Password"
                type="password"
                value={password()}
                onInput={setPassword}
                autocomplete="new-password"
                hint="Minimum 8 characters"
                required
              />
              <Input
                label="Confirm password"
                type="password"
                value={confirmPassword()}
                onInput={setConfirmPassword}
                autocomplete="new-password"
                required
              />
              <Btn type="submit" size="lg" class="w-full" loading={busy()}>
                Create Admin Account
              </Btn>
            </form>
          </Show>

          <Show when={mode() === "login"}>
            <form onSubmit={submitLogin} class="space-y-4">
              <Input
                label="Username"
                value={username()}
                onInput={setUsername}
                autocomplete="username"
                required
              />
              <Input
                label="Password"
                type="password"
                value={password()}
                onInput={setPassword}
                autocomplete="current-password"
                required
              />
              <Btn type="submit" size="lg" class="w-full" loading={busy()}>
                Sign In
              </Btn>
            </form>
          </Show>

          <Show when={mode() === "2fa"}>
            <form onSubmit={submit2fa} class="space-y-4">
              <div class="flex items-center gap-2 text-sm text-fg-secondary">
                <Icon name={Icons.shield} size={16} class="text-accent" />
                Enter your 6-digit authenticator code
              </div>
              <Input
                label="Authenticator code"
                value={code()}
                onInput={setCode}
                placeholder="123456"
                autocomplete="one-time-code"
                required
              />
              <Btn type="submit" size="lg" class="w-full" loading={busy()}>
                Verify &amp; Enter
              </Btn>
              <button
                type="button"
                onClick={() => {
                  setMode("login");
                  setCode("");
                  setError("");
                }}
                class="w-full text-center text-xs text-fg-secondary hover:text-fg py-1 cursor-pointer"
              >
                Back to sign in
              </button>
            </form>
          </Show>
        </Card>
      </div>
    </div>
  );
}
