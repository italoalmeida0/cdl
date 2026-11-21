import "./fonts.css";

import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  untrack,
  type JSX,
} from "solid-js";
import { render } from "solid-js/web";

import { api, currentSession, setSession } from "./api";
import { LogoMark, navigate } from "./chrome";
import { Drawer } from "./ds/components/overlay";
import { createGlide } from "./ds/motion/glide";
import LoginPage from "./pages/Login";
import { Icon, Icons, ThemeToggle, Toasts, watchSystemTheme } from "./ui";

function RouteLoading(): JSX.Element {
  return (
    <div class="route-loading" role="status" aria-live="polite" aria-busy="true">
      <span class="route-loading-dot" />
      <span class="route-loading-dot" />
      <span class="route-loading-dot" />
      <span class="sr-only">Loading</span>
    </div>
  );
}

function lazyRoute<T extends (props: any) => JSX.Element>(loader: () => Promise<{ default: T }>): T {
  let cached: T | undefined;
  let pending: Promise<{ default: T }> | undefined;
  return ((props: any) => {
    const [comp, setComp] = createSignal<T | undefined>(cached);
    if (!cached) {
      (pending ??= loader()).then((mod) => {
        cached = mod.default;
        setComp(() => cached);
      });
    }
    return createMemo(() => {
      const C = comp();
      return C ? untrack(() => C(props)) : <RouteLoading />;
    }) as unknown as JSX.Element;
  }) as unknown as T;
}

const OverviewPage = lazyRoute(() => import("./pages/Overview"));
const LinksPage = lazyRoute(() => import("./pages/Links"));
const FilesPage = lazyRoute(() => import("./pages/Files"));
const ActivityPage = lazyRoute(() => import("./pages/Activity"));
const SettingsPage = lazyRoute(() => import("./pages/Settings"));

function parseHash(): { path: string; query: URLSearchParams } {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [path, qs] = raw.split("?");
  return { path: path || "/", query: new URLSearchParams(qs ?? "") };
}

const [route, setRoute] = createSignal(parseHash());
window.addEventListener("hashchange", () => setRoute(parseHash()));

interface NavItem {
  path: string;
  label: string;
  icon: string;
}

const NAV_ITEMS: NavItem[] = [
  { path: "/", label: "Overview", icon: Icons.home },
  { path: "/links", label: "Delivery Links", icon: Icons.link },
  { path: "/files", label: "Files & Uploads", icon: Icons.hardDrive },
  { path: "/activity", label: "Activity Log", icon: Icons.activity },
  { path: "/settings", label: "Settings", icon: Icons.cog },
];

function isActive(item: NavItem, current: string): boolean {
  return item.path === "/" ? current === "/" : current.startsWith(item.path);
}

function RailItem(props: { item: NavItem; current: string }) {
  const active = () => isActive(props.item, props.current);
  return (
    <a
      href={`#${props.item.path}`}
      class="gateway-nav relative z-[1] flex h-9 w-9 lg:w-full items-center justify-center lg:justify-start lg:px-2.5 gap-2.5"
      aria-current={active() ? "page" : undefined}
    >
      <span class="gateway-nav-icon inline-flex">
        <Icon name={props.item.icon} size={17} />
      </span>
      <span class="sr-only lg:not-sr-only lg:block text-sm truncate">{props.item.label}</span>
    </a>
  );
}

function AppShell(props: { children: JSX.Element }) {
  const admin = () => currentSession()!.admin;
  const [mobileNav, setMobileNav] = createSignal(false);
  const [nav, setNav] = createSignal<HTMLElement>();
  const [navIndicator, setNavIndicator] = createSignal<HTMLSpanElement>();

  createGlide({
    container: nav,
    indicator: navIndicator,
    target: () => nav()?.querySelector<HTMLElement>('a[aria-current="page"]') ?? null,
  });

  const signOut = async () => {
    try {
      await api("POST", "/api/auth/logout", {});
    } catch {}
    setSession(null);
    location.hash = "#/login";
  };

  const currentPage = () => NAV_ITEMS.find((n) => isActive(n, route().path)) ?? NAV_ITEMS[0]!;

  return (
    <div class="gw-shell min-h-screen overflow-x-clip bg-background text-fg flex flex-col md:flex-row">
      {/* Desktop / Tablet Sidebar */}
      <aside class="gateway-rail hidden md:flex md:w-16 lg:w-64 shrink-0 flex-col border-r border-border py-3 px-0 lg:p-4 sticky top-0 h-screen">
        <a
          href="#/"
          class="gw-rail-brand flex items-center justify-center lg:justify-start gap-2.5 px-1 py-1.5 mb-4"
        >
          <LogoMark class="w-8 h-8" />
          <div class="hidden lg:block min-w-0">
            <div class="brand-wordmark text-base tracking-tight text-fg leading-none">CDL</div>
            <div class="text-2xs text-fg-muted mt-0.5 truncate">Content Delivery Link</div>
          </div>
        </a>

        <nav ref={setNav} class="gw-nav relative flex-1 flex flex-col items-center lg:items-stretch space-y-1">
          <span ref={setNavIndicator} class="gateway-nav-indicator" aria-hidden="true" />
          <For each={NAV_ITEMS}>{(item) => <RailItem item={item} current={route().path} />}</For>
        </nav>

        <div class="pt-3 border-t border-border-subtle flex flex-col lg:flex-row items-center justify-between gap-2">
          <div class="hidden lg:flex items-center gap-2 min-w-0">
            <div class="w-7 h-7 rounded-full bg-accent-subtle text-accent-strong flex items-center justify-center text-xs font-medium uppercase shrink-0">
              {admin().username.slice(0, 1)}
            </div>
            <div class="min-w-0">
              <div class="text-xs font-medium text-fg truncate">{admin().username}</div>
              <div class="text-2xs text-fg-muted">Administrator</div>
            </div>
          </div>
          <div class="flex flex-col lg:flex-row items-center gap-1.5 lg:gap-1">
            <ThemeToggle tooltipPlacement="right" />
            <button
              type="button"
              onClick={() => void signOut()}
              aria-label="Sign out"
              data-tip="Sign out"
              class="ui-icon-button ui-icon-button-danger"
            >
              <Icon name={Icons.logout} size={17} />
            </button>
          </div>
        </div>
      </aside>

      {/* Mobile Header */}
      <header class="gw-mobile-header md:hidden sticky top-0 z-30 flex items-center justify-between px-4 h-14 border-b border-border bg-surface/90 backdrop-blur">
        <div class="flex items-center gap-2.5 min-w-0">
          <button
            type="button"
            aria-label="Open navigation"
            onClick={() => setMobileNav(true)}
            class="ui-icon-button"
          >
            <Icon name={Icons.menu} size={20} />
          </button>
          <LogoMark class="w-7 h-7" />
          <span class="text-sm font-medium text-fg truncate">{currentPage().label}</span>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <ThemeToggle />
          <button
            type="button"
            onClick={() => void signOut()}
            aria-label="Sign out"
            class="ui-icon-button ui-icon-button-danger"
          >
            <Icon name={Icons.logout} size={17} />
          </button>
        </div>
      </header>

      <Drawer open={mobileNav()} onClose={() => setMobileNav(false)} label="CDL Navigation">
        <div class="flex flex-col h-full">
          <div class="h-14 px-4 border-b border-border flex items-center justify-between shrink-0">
            <div class="flex items-center gap-2.5 min-w-0">
              <LogoMark class="w-7 h-7" />
              <div class="min-w-0">
                <div class="brand-wordmark text-sm tracking-tight text-fg leading-none">CDL</div>
                <div class="text-2xs text-fg-muted mt-0.5 truncate">Content Delivery Link</div>
              </div>
            </div>
            <button
              type="button"
              aria-label="Close navigation"
              onClick={() => setMobileNav(false)}
              class="ui-icon-button"
            >
              <Icon name={Icons.x} size={17} />
            </button>
          </div>

          <nav class="flex-1 overflow-y-auto p-3 space-y-1">
            <For each={NAV_ITEMS}>
              {(item) => (
                <a
                  href={`#${item.path}`}
                  onClick={() => setMobileNav(false)}
                  class={`flex items-center gap-3 px-3 py-2.5 rounded-control text-sm font-medium transition-colors ${
                    isActive(item, route().path)
                      ? "bg-surface-muted text-fg"
                      : "text-fg-secondary hover:bg-surface-subtle hover:text-fg"
                  }`}
                >
                  <Icon name={item.icon} size={17} />
                  <span>{item.label}</span>
                </a>
              )}
            </For>
          </nav>

          <div class="p-3 border-t border-border-subtle flex items-center justify-between gap-2 shrink-0">
            <div class="flex items-center gap-2.5 min-w-0">
              <div class="w-8 h-8 rounded-full bg-accent-subtle text-accent-strong flex items-center justify-center text-xs font-medium uppercase shrink-0">
                {admin().username.slice(0, 1)}
              </div>
              <div class="min-w-0">
                <div class="text-xs font-medium text-fg truncate">{admin().username}</div>
                <div class="text-2xs text-fg-muted">Administrator</div>
              </div>
            </div>
            <div class="flex items-center gap-1 shrink-0">
              <ThemeToggle />
              <button
                type="button"
                onClick={() => {
                  setMobileNav(false);
                  void signOut();
                }}
                aria-label="Sign out"
                class="ui-icon-button ui-icon-button-danger"
              >
                <Icon name={Icons.logout} size={17} />
              </button>
            </div>
          </div>
        </div>
      </Drawer>

      {/* Main Content */}
      <main class="flex-1 min-w-0 px-4 sm:px-6 lg:px-8 py-6 max-w-7xl w-full mx-auto">
        {props.children}
      </main>
    </div>
  );
}

function App() {
  onMount(() => {
    watchSystemTheme();
  });

  createEffect(() => {
    const s = currentSession();
    const path = route().path;
    if (!s && path !== "/login") {
      navigate("/login");
    } else if (s && path === "/login") {
      navigate("/");
    }
  });

  return (
    <>
      <Toasts />
      <Show when={currentSession() && route().path !== "/login"} fallback={<LoginPage />}>
        <AppShell>
          {(() => {
            const path = route().path;
            if (path.startsWith("/links")) return <LinksPage />;
            if (path.startsWith("/files")) return <FilesPage />;
            if (path.startsWith("/activity")) return <ActivityPage />;
            if (path.startsWith("/settings")) return <SettingsPage />;
            return <OverviewPage />;
          })()}
        </AppShell>
      </Show>
    </>
  );
}

const root = document.getElementById("app");
if (root) {
  render(() => <App />, root);
}
