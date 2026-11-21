import {
  createEffect,
  createSignal,
  createUniqueId,
  For,
  onCleanup,
  Show,
  type JSX,
} from "solid-js";
import { Portal } from "solid-js/web";
import type { Placement } from "@floating-ui/dom";

import { anchorFloat } from "./floating";
import { usal } from "./motion";
import { Button, type ButtonSize, type ButtonVariant } from "./ds/components/button";
import {
  Alert,
  Badge as DsBadge,
  Checkbox,
  EmptyState as DsEmptyState,
  Kbd,
  Progress,
  Shimmer,
  Skeleton,
  Spinner as DsSpinner,
  Switch,
  type BadgeTone,
  type LegacyTone,
} from "./ds/components/controls";
import { Dialog } from "./ds/components/dialog";
import { DateTimePicker } from "./ds/components/date-picker";
import { Glyph } from "./ds/components/icon";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "./ds/components/menu";
import { Collapse, ConfirmButton, Drawer } from "./ds/components/overlay";
import { RollingNumber } from "./ds/components/rolling-number";
import { SegmentedControl } from "./ds/components/segmented";
import { StepperField, TokenTagField } from "./ds/components/studio-controls";
import { CopyButton, TabPanel, Tabs } from "./ds/components/tabs";
import { pushToast, ToastRegion } from "./ds/components/toast";
import { Tooltip as DsTooltip } from "./ds/components/tooltip";
import { createGlide } from "./ds/motion/glide";
import { createPresence, cssExit } from "./ds/motion/presence";
import { press } from "./ds/motion/press";
import { reducedMotion } from "./ds/motion/reduced";
import { pushLayer } from "./ds/primitives/layers";

export {
  Alert,
  Checkbox,
  Collapse,
  ConfirmButton,
  CopyButton,
  DateTimePicker,
  Drawer,
  Kbd,
  Menu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  Progress,
  RollingNumber,
  Shimmer,
  Skeleton,
  StepperField,
  Switch,
  TabPanel,
  Tabs,
  TokenTagField,
};

import { registry } from "virtual:icons";

export const Icons = {
  home: "lucide:layout-dashboard",
  link: "lucide:link-2",
  download: "lucide:download",
  upload: "lucide:upload-cloud",
  hardDrive: "lucide:hard-drive",
  lock: "lucide:lock",
  unlock: "lucide:unlock",
  shield: "lucide:shield",
  qrCode: "lucide:qr-code",
  activity: "lucide:activity",
  gauge: "lucide:gauge",
  globe: "lucide:globe",
  file: "lucide:file",
  fileText: "lucide:file-text",
  folder: "lucide:folder",
  folderOpen: "lucide:folder-open",
  pause: "lucide:pause",
  play: "lucide:play",
  clock: "lucide:clock",
  hash: "lucide:hash",
  terminal: "lucide:terminal",
  xCircle: "lucide:x-circle",
  cog: "lucide:settings",
  logout: "lucide:log-out",
  plus: "lucide:plus",
  copy: "lucide:copy",
  check: "lucide:check",
  trash: "lucide:trash-2",
  x: "lucide:x",
  refresh: "lucide:refresh-cw",
  eye: "lucide:eye",
  eyeOff: "lucide:eye-off",
  bolt: "lucide:zap",
  ban: "lucide:ban",
  warning: "lucide:alert-triangle",
  search: "lucide:search",
  edit: "lucide:edit-3",
  sun: "lucide:sun",
  moon: "lucide:moon",
  monitor: "lucide:monitor",
  chevronDown: "lucide:chevron-down",
  chevronRight: "lucide:chevron-right",
  arrowUpRight: "lucide:arrow-up-right",
  menu: "lucide:menu",
  alertCircle: "lucide:alert-circle",
  info: "lucide:info",
  key: "lucide:key",
  external: "lucide:external-link",
  share: "lucide:share-2",
  server: "lucide:server",
  timer: "lucide:timer",
  userCheck: "lucide:user-check",
  sparkles: "lucide:sparkles",
} as const;

export function Icon(props: {
  name: string;
  size?: number;
  class?: string;
  strokeWidth?: number;
}) {
  const known = () => registry[props.name] ?? registry[`lucide:${props.name}`];
  return (
    <span class={`inline-flex items-center justify-center shrink-0 ${props.class ?? ""}`}>
      <Show
        when={known()}
        fallback={<svg width={props.size ?? 16} height={props.size ?? 16} aria-hidden="true" />}
      >
        <Glyph
          icon={props.name.includes(":") ? props.name : `lucide:${props.name}`}
          size={props.size ?? 16}
          strokeWidth={props.strokeWidth}
        />
      </Show>
    </span>
  );
}

// ==========================================
// THEME & ACCENT
// ==========================================

export type Theme = "light" | "dark" | "high-contrast";
export type ThemeMode = "light" | "dark" | "high-contrast" | "system";
const THEME_KEY = "cdl-theme";
const ACCENT_KEY = "cdl-accent";

const THEME_COLORS: Record<Theme, string> = {
  light: "#ffffff",
  dark: "#141414",
  "high-contrast": "#000000",
};

export function getThemeMode(): ThemeMode {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(THEME_KEY);
  } catch {}
  return stored === "light" || stored === "dark" || stored === "high-contrast" ? stored : "system";
}

export function getTheme(): Theme {
  if (document.documentElement.dataset.theme === "high-contrast") return "high-contrast";
  if (document.documentElement.dataset.theme === "dark") return "dark";
  if (document.documentElement.dataset.theme === "light") return "light";
  try {
    const s = localStorage.getItem(THEME_KEY);
    if (s === "high-contrast" || s === "dark" || s === "light") return s;
  } catch {}
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

const [theme, setThemeSignal] = createSignal<Theme>(getTheme());
export { theme };
const [themeMode, setThemeModeSignal] = createSignal<ThemeMode>(getThemeMode());
export { themeMode };

function syncMetaThemeColor(): void {
  try {
    const t = getTheme();
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "theme-color");
      document.head.appendChild(meta);
    }
    meta.setAttribute("content", THEME_COLORS[t]);
  } catch {}
}

export interface RevealOrigin {
  x: number;
  y: number;
}

function commitTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  setThemeSignal(t);
  syncMetaThemeColor();
}

function applyTheme(t: Theme, origin?: RevealOrigin): void {
  const html = document.documentElement;
  if (html.dataset.theme === t) {
    setThemeSignal(t);
    return;
  }
  const doc = document as Document & {
    startViewTransition?: (cb: () => void) => { ready: Promise<void> };
  };
  if (origin && doc.startViewTransition && !reducedMotion()) {
    const transition = doc.startViewTransition(() => commitTheme(t));
    const radius = Math.hypot(
      Math.max(origin.x, innerWidth - origin.x),
      Math.max(origin.y, innerHeight - origin.y),
    );
    void transition.ready
      .then(() => {
        html.animate(
          {
            clipPath: [
              `circle(0px at ${origin.x}px ${origin.y}px)`,
              `circle(${radius}px at ${origin.x}px ${origin.y}px)`,
            ],
          },
          {
            duration: 560,
            easing: "cubic-bezier(0.65, 0, 0.35, 1)",
            pseudoElement: "::view-transition-new(root)",
          },
        );
      })
      .catch(() => {});
    return;
  }
  commitTheme(t);
}

export function setThemeMode(m: ThemeMode, origin?: RevealOrigin): void {
  try {
    if (m === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, m);
  } catch {}
  setThemeModeSignal(m);
  if (m === "system") {
    const t: Theme = window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    applyTheme(t, origin);
  } else {
    applyTheme(m, origin);
  }
}

export function toggleTheme(origin?: RevealOrigin): void {
  setThemeMode(getTheme() === "dark" ? "light" : "dark", origin);
}

export type Accent = "teal" | "neutral" | "violet" | "blue" | "green" | "amber" | "orange" | "coral" | "rose";
export const ACCENTS: Array<{ id: Accent; label: string; swatch: string }> = [
  { id: "teal", label: "Teal", swatch: "oklch(0.60 0.125 182)" },
  { id: "neutral", label: "Neutral", swatch: "oklch(0.45 0.008 250)" },
  { id: "violet", label: "Violet", swatch: "oklch(0.58 0.16 285)" },
  { id: "blue", label: "Blue", swatch: "oklch(0.58 0.14 252)" },
  { id: "green", label: "Green", swatch: "oklch(0.60 0.14 152)" },
  { id: "amber", label: "Amber", swatch: "oklch(0.72 0.15 72)" },
  { id: "orange", label: "Orange", swatch: "oklch(0.66 0.16 48)" },
  { id: "coral", label: "Coral", swatch: "oklch(0.64 0.16 28)" },
  { id: "rose", label: "Rose", swatch: "oklch(0.62 0.16 355)" },
];
const ACCENT_IDS = new Set<Accent>(ACCENTS.map((a) => a.id));

export function getAccent(): Accent {
  try {
    const stored = localStorage.getItem(ACCENT_KEY) as Accent | null;
    if (stored && ACCENT_IDS.has(stored)) return stored;
  } catch {}
  return "teal";
}

const [accent, setAccentSignal] = createSignal<Accent>(getAccent());
export { accent };

function applyAccent(a: Accent): void {
  if (a === "teal") delete document.documentElement.dataset.accent;
  else document.documentElement.dataset.accent = a;
  setAccentSignal(a);
}

export function setAccent(a: Accent): void {
  try {
    if (a === "teal") localStorage.removeItem(ACCENT_KEY);
    else localStorage.setItem(ACCENT_KEY, a);
  } catch {}
  applyAccent(a);
}

export function watchSystemTheme(): void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    const mode = getThemeMode();
    setThemeModeSignal(mode);
    if (mode !== "system") {
      if (document.documentElement.dataset.theme !== mode) commitTheme(mode);
      return;
    }
    commitTheme(mq.matches ? "dark" : "light");
  };
  apply();
  window.addEventListener?.("storage", (e) => {
    if (e.key === THEME_KEY) apply();
    if (e.key === ACCENT_KEY) applyAccent(getAccent());
  });
  mq.addEventListener?.("change", apply);
  applyAccent(getAccent());
}

export function ThemeToggle(props: { class?: string; tooltipPlacement?: Placement }) {
  const label = () => (theme() === "dark" ? "Switch to light theme" : "Switch to dark theme");
  return (
    <DsTooltip content={label()} placement={props.tooltipPlacement ?? "bottom"}>
      <button
        type="button"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          toggleTheme({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
        }}
        aria-label="Toggle theme"
        ref={press}
        class={`ui-icon-button ${props.class ?? ""}`}
      >
        <span
          class="flex items-center justify-center transition-transform duration-500 ease-spring"
          style={{ transform: theme() === "dark" ? "rotate(0deg)" : "rotate(180deg)" }}
        >
          <Glyph icon={theme() === "dark" ? Icons.sun : themeMode() === "system" ? Icons.monitor : Icons.moon} size={18} />
        </span>
      </button>
    </DsTooltip>
  );
}

export function AccentPicker() {
  return (
    <div class="flex flex-wrap gap-2">
      <For each={ACCENTS}>
        {(item) => {
          const selected = () => accent() === item.id;
          return (
            <button
              type="button"
              onClick={() => setAccent(item.id)}
              class={`inline-flex items-center gap-2 px-3 py-1.5 rounded-pill border text-xs font-medium cursor-pointer transition-colors ${
                selected()
                  ? "border-fg bg-surface-muted text-fg"
                  : "border-border bg-surface text-fg-secondary hover:border-border-strong"
              }`}
            >
              <span class="w-3 h-3 rounded-full shrink-0" style={{ background: item.swatch }} />
              <span>{item.label}</span>
            </button>
          );
        }}
      </For>
    </div>
  );
}

// ==========================================
// UI COMPONENTS
// ==========================================

const BTN_VARIANT: Record<string, ButtonVariant> = {
  primary: "primary",
  brand: "primary",
  ghost: "ghost",
  danger: "danger",
  "danger-solid": "danger-solid",
  outline: "secondary",
  secondary: "secondary",
  subtle: "secondary",
};

export function Btn(props: {
  variant?: "primary" | "brand" | "ghost" | "danger" | "danger-solid" | "outline" | "secondary" | "subtle";
  size?: "xs" | "sm" | "md" | "lg";
  onClick?: (e: MouseEvent) => void;
  disabled?: boolean;
  loading?: boolean;
  type?: "button" | "submit";
  class?: string;
  title?: string;
  children: JSX.Element;
}) {
  const size = (): ButtonSize =>
    props.size === "sm" || props.size === "xs" ? "xs" : props.size === "lg" ? "md" : "sm";
  const btn = (
    <Button
      variant={BTN_VARIANT[props.variant ?? "primary"]}
      size={size()}
      type={props.type ?? "button"}
      class={props.class}
      onClick={props.onClick}
      disabled={props.disabled}
      loading={props.loading}
    >
      {props.children}
    </Button>
  );
  return (
    <Show when={props.title} fallback={btn}>
      {(title) => <DsTooltip content={title()}>{btn}</DsTooltip>}
    </Show>
  );
}

export function Card(props: {
  class?: string;
  interactive?: boolean;
  motion?: string;
  children: JSX.Element;
}) {
  return (
    <div
      ref={(node) => {
        if (props.motion) usal(props.motion).ref(node);
      }}
      class={`ui-card ${props.interactive ? "ui-card-interactive" : ""} ${props.class ?? ""}`}
    >
      {props.children}
    </div>
  );
}

export function CardHeader(props: { title: string; subtitle?: string; right?: JSX.Element }) {
  return (
    <div class="ui-card-header">
      <div class="min-w-0">
        <h2 class="ui-card-title">{props.title}</h2>
        <Show when={props.subtitle}>
          <p class="ui-card-subtitle">{props.subtitle}</p>
        </Show>
      </div>
      {props.right}
    </div>
  );
}

export function IconBtn(props: {
  icon: string;
  title?: string;
  label?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick?: (e: MouseEvent) => void;
}) {
  const tip = () => props.title ?? props.label ?? "";
  return (
    <DsTooltip content={tip()}>
      <button
        type="button"
        aria-label={tip()}
        disabled={props.disabled}
        onClick={(e) => props.onClick?.(e)}
        ref={press}
        class={`ui-icon-button ${props.danger ? "ui-icon-button-danger" : ""}`}
      >
        <Glyph icon={props.icon} size={16} />
      </button>
    </DsTooltip>
  );
}

export function Segmented<T extends string>(props: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string; badge?: number | string }>;
  class?: string;
  label?: string;
  ariaLabel?: string;
}) {
  return (
    <SegmentedControl
      value={props.value}
      onChange={props.onChange}
      options={props.options}
      class={props.class}
      label={props.label ?? props.ariaLabel}
    />
  );
}

export function Input(props: {
  label?: string;
  type?: string;
  value: string | number;
  onInput: (v: string) => void;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number | string;
  autocomplete?: string;
  required?: boolean;
  hint?: string;
  error?: string;
  disabled?: boolean;
}) {
  const [revealed, setRevealed] = createSignal(false);
  const inputId = createUniqueId();
  const hintId = createUniqueId();
  const describedBy = () => (props.hint || props.error ? hintId : undefined);
  return (
    <div class="block">
      <Show when={props.label}>
        <label for={inputId} class="ui-label">
          {props.label}
        </label>
      </Show>
      <div class={props.type === "password" ? "ui-field-adorned" : undefined}>
        <input
          id={inputId}
          aria-describedby={describedBy()}
          aria-invalid={props.error ? "true" : undefined}
          type={props.type === "password" && revealed() ? "text" : props.type ?? "text"}
          value={props.value}
          onInput={(e) => props.onInput(e.currentTarget.value)}
          placeholder={props.placeholder}
          min={props.min}
          max={props.max}
          step={props.step}
          autocomplete={props.autocomplete}
          required={props.required}
          disabled={props.disabled}
          class="ui-field"
        />
        <Show when={props.type === "password"}>
          <span class="ui-field-adornment">
            <button
              type="button"
              aria-label={revealed() ? "Hide password" : "Show password"}
              data-tip={revealed() ? "Hide password" : "Show password"}
              aria-pressed={revealed()}
              disabled={props.disabled}
              onClick={() => setRevealed(!revealed())}
              class="ui-icon-button"
            >
              <Glyph icon={revealed() ? Icons.eyeOff : Icons.eye} size={16} />
            </button>
          </span>
        </Show>
      </div>
      <Show
        when={props.error}
        fallback={
          <Show when={props.hint}>
            <span id={hintId} class="ui-hint">
              {props.hint}
            </span>
          </Show>
        }
      >
        <span id={hintId} class="ui-error-text">
          {props.error}
        </span>
      </Show>
    </div>
  );
}

export function Textarea(props: {
  label?: string;
  value: string;
  onInput: (v: string) => void;
  placeholder?: string;
  rows?: number;
  hint?: string;
  error?: string;
  disabled?: boolean;
}) {
  const inputId = createUniqueId();
  const hintId = createUniqueId();
  const describedBy = () => (props.hint || props.error ? hintId : undefined);
  return (
    <div class="block">
      <Show when={props.label}>
        <label for={inputId} class="ui-label">
          {props.label}
        </label>
      </Show>
      <textarea
        id={inputId}
        rows={props.rows ?? 3}
        aria-describedby={describedBy()}
        aria-invalid={props.error ? "true" : undefined}
        value={props.value}
        onInput={(e) => props.onInput(e.currentTarget.value)}
        placeholder={props.placeholder}
        disabled={props.disabled}
        class="ui-field py-2 min-h-[4.5rem]"
      />
      <Show
        when={props.error}
        fallback={
          <Show when={props.hint}>
            <span id={hintId} class="ui-hint">
              {props.hint}
            </span>
          </Show>
        }
      >
        <span id={hintId} class="ui-error-text">
          {props.error}
        </span>
      </Show>
    </div>
  );
}

export function Select(props: {
  label?: string;
  ariaLabel?: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string; hint?: string }>;
  hint?: string;
}) {
  const id = createUniqueId();
  const [open, setOpen] = createSignal(false);
  const [highlight, setHighlight] = createSignal(0);
  const [listEl, setListEl] = createSignal<HTMLDivElement>();
  const [indicator, setIndicator] = createSignal<HTMLSpanElement>();
  let root!: HTMLDivElement;
  let button!: HTMLButtonElement;
  const presence = createPresence(open, { exit: (el) => cssExit(el, 130) });
  const current = () =>
    props.options.find((option) => option.value === props.value) ?? {
      value: props.value,
      label: props.value || "Select…",
    };

  createGlide({
    container: listEl,
    indicator,
    target: () => {
      const index = highlight();
      return listEl()?.querySelector<HTMLElement>(`[data-option-index="${index}"]`) ?? null;
    },
  });

  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) button.focus({ preventScroll: true });
  };
  const openMenu = () => {
    setHighlight(Math.max(0, props.options.findIndex((o) => o.value === props.value)));
    setOpen(true);
  };
  const pick = (value: string) => {
    close(true);
    props.onChange(value);
  };

  createEffect(() => {
    if (!open()) return;
    const offLayer = pushLayer({
      kind: "menu",
      contains: (node) => root.contains(node) || !!listEl()?.contains(node),
      onEscape: () => close(true),
      onOutside: () => close(),
    });
    const outside = (event: FocusEvent) => {
      if (event.target instanceof Node && !root.contains(event.target) && !listEl()?.contains(event.target)) close();
    };
    document.addEventListener("focusin", outside);
    onCleanup(() => {
      offLayer();
      document.removeEventListener("focusin", outside);
    });
  });

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && open()) {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      close();
      return;
    }
    if (!open() && ["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      openMenu();
      return;
    }
    if (open() && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const length = props.options.length;
      setHighlight((index) =>
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + length) % Math.max(1, length),
      );
    } else if (open() && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      const option = props.options[highlight()];
      if (option) pick(option.value);
    }
  };

  return (
    <div class="ui-select block">
      <Show when={props.label}>
        <span id={`${id}-label`} class="ui-label">
          {props.label}
        </span>
      </Show>
      <div ref={root} class="relative" onKeyDown={onKeyDown}>
        <button
          ref={button}
          type="button"
          role="combobox"
          aria-label={props.ariaLabel}
          aria-labelledby={!props.ariaLabel && props.label ? `${id}-label` : undefined}
          aria-haspopup="listbox"
          aria-expanded={open()}
          onClick={() => (open() ? close() : openMenu())}
          class="ui-field text-left flex items-center justify-between gap-2 cursor-pointer"
        >
          <span class="min-w-0 truncate">{current().label}</span>
          <Glyph icon={Icons.chevronDown} size={14} class={`ui-select-chevron ${open() ? "is-open" : ""}`} />
        </button>
        <Show when={presence.present()}>
          <Portal>
            <div
              id={`${id}-list`}
              data-glide=""
              ref={(element) => {
                setListEl(element);
                presence.ref(element);
                const anchor = button.getBoundingClientRect();
                const maxHeight = 320;
                const below = document.documentElement.clientHeight - anchor.bottom;
                onCleanup(
                  anchorFloat(button, element, {
                    placement: below >= 220 || below >= anchor.top ? "bottom-start" : "top-start",
                    flip: false,
                    gap: 6,
                    padding: 12,
                    matchWidth: true,
                    maxHeight,
                  }),
                );
                onCleanup(() => setListEl(undefined));
              }}
              role="listbox"
              data-layer-managed=""
              onKeyDown={onKeyDown}
              class="ui-popover ui-menu ui-select-menu"
            >
              <span ref={setIndicator} class="ui-menu-highlight" aria-hidden="true" />
              <For each={props.options}>
                {(option, index) => (
                  <button
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={option.value === props.value}
                    data-option-index={index()}
                    data-hl={index() === highlight() ? "1" : "0"}
                    onClick={() => pick(option.value)}
                    onPointerEnter={() => setHighlight(index())}
                    class={`ui-select-option ${option.value === props.value ? "is-selected" : ""}`}
                  >
                    <span class="min-w-0 truncate">{option.label}</span>
                    <Show when={option.value === props.value}>
                      <Glyph icon={Icons.check} size={14} class="ui-select-check" />
                    </Show>
                  </button>
                )}
              </For>
            </div>
          </Portal>
        </Show>
      </div>
      <Show when={props.hint}>
        <span class="ui-hint">{props.hint}</span>
      </Show>
    </div>
  );
}

export function Tooltip(props: {
  content: JSX.Element;
  placement?: Placement;
  delay?: number;
  disabled?: boolean;
  children: JSX.Element;
}) {
  return (
    <DsTooltip content={props.content} placement={props.placement} delay={props.delay} disabled={props.disabled}>
      {props.children}
    </DsTooltip>
  );
}

export function Badge(props: { tone: BadgeTone | LegacyTone; size?: "sm" | "md"; children: JSX.Element }) {
  return (
    <DsBadge tone={props.tone} size={props.size}>
      {props.children}
    </DsBadge>
  );
}

export function ModalSection(props: {
  title?: string;
  subtitle?: string;
  info?: string;
  badge?: JSX.Element;
  action?: JSX.Element;
  children: JSX.Element;
  class?: string;
}) {
  return (
    <div class={`space-y-3 ${props.class ?? ""}`}>
      <Show when={props.title || props.action}>
        <div class="flex items-start sm:items-center justify-between gap-3 flex-wrap">
          <div class="min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <h4 class="text-sm font-medium text-fg">{props.title}</h4>
              <Show when={props.info}>
                <DsTooltip content={props.info}>
                  <span class="inline-flex text-fg-muted hover:text-fg cursor-help transition-colors">
                    <Glyph icon={Icons.info} size={14} />
                  </span>
                </DsTooltip>
              </Show>
              {props.badge}
            </div>
            <Show when={props.subtitle}>
              <p class="text-xs text-fg-secondary mt-0.5">{props.subtitle}</p>
            </Show>
          </div>
          <Show when={props.action}>
            <div class="shrink-0">{props.action}</div>
          </Show>
        </div>
      </Show>
      {props.children}
    </div>
  );
}

export function ModalField(props: {
  label?: string;
  hint?: string;
  children: JSX.Element;
  class?: string;
}) {
  const fieldId = createUniqueId();
  let root: HTMLDivElement | undefined;
  createEffect(() => {
    if (!props.label || !root) return;
    const control = root.querySelector<HTMLElement>("input, textarea, select");
    if (control && !control.id && !control.getAttribute("aria-label") && !control.getAttribute("aria-labelledby")) {
      control.id = fieldId;
    }
  });
  return (
    <div ref={root} class={props.class ?? ""}>
      <Show when={props.label}>
        <label for={fieldId} class="ui-label">
          {props.label}
        </label>
      </Show>
      {props.children}
      <Show when={props.hint}>
        <p class="ui-hint">{props.hint}</p>
      </Show>
    </div>
  );
}

export function SwitchCard(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  title?: string;
  label?: string;
  description?: string;
  badge?: JSX.Element;
  disabled?: boolean;
  class?: string;
}) {
  const heading = () => props.title ?? props.label ?? "";
  return (
    <label
      class={`ui-switch-card select-none ${props.disabled ? "opacity-50 pointer-events-none" : ""} ${props.class ?? ""}`}
    >
      <span class="relative shrink-0 pt-px">
        <input
          type="checkbox"
          role="switch"
          class="peer sr-only"
          aria-label={heading()}
          checked={props.checked}
          aria-checked={props.checked}
          disabled={props.disabled}
          onChange={(e) => props.onChange(e.currentTarget.checked)}
        />
        <span class="ui-switch-track" aria-hidden="true">
          <span class="ui-switch-thumb" />
        </span>
      </span>
      <span class="min-w-0 flex-1">
        <span class="flex items-center gap-2 flex-wrap">
          <span class="text-sm font-medium text-fg">{heading()}</span>
          {props.badge}
        </span>
        <Show when={props.description}>
          <span class="block text-xs text-fg-secondary mt-0.5">{props.description}</span>
        </Show>
      </span>
    </label>
  );
}

export function Modal(props: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  subtitle?: string;
  badge?: JSX.Element;
  width?: string;
  footer?: JSX.Element;
  children: JSX.Element;
}) {
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={props.title}
      description={props.description}
      subtitle={props.subtitle}
      badge={props.badge}
      width={props.width}
      footer={props.footer}
    >
      {props.children}
    </Dialog>
  );
}

export function ModalNotice(props: {
  tone?: "info" | "warn" | "danger" | "success";
  title?: string;
  children: JSX.Element;
  class?: string;
}) {
  return (
    <Alert tone={props.tone ?? "info"} title={props.title} class={props.class}>
      {props.children}
    </Alert>
  );
}

export function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

function toastFn(text: string, kind: "ok" | "err" = "ok"): void {
  pushToast(capitalize(text), kind);
}
toastFn.success = (text: string) => toastFn(text, "ok");
toastFn.error = (text: string) => toastFn(text, "err");
export const toast = toastFn;

export function Toasts() {
  return <ToastRegion />;
}

export function Spinner(props: { class?: string }) {
  return <DsSpinner class={props.class ?? "w-4 h-4"} />;
}

export function EmptyState(props: { icon: string; title: string; hint?: string; description?: string; action?: JSX.Element }) {
  return (
    <div class="flex flex-col items-center">
      <DsEmptyState icon={props.icon} title={props.title} hint={props.hint ?? props.description} />
      <Show when={props.action}>
        <div class="-mt-4 mb-6">{props.action}</div>
      </Show>
    </div>
  );
}

// ==========================================
// FORMATTING & CLIPBOARD HELPERS
// ==========================================

export function fmtBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const idx = Math.min(units.length - 1, Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024)));
  const scaled = bytes / Math.pow(1024, idx);
  const digits = idx === 0 ? 0 : scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(digits)} ${units[idx]}`;
}

export function fmtSpeed(bytesPerSec: number | null | undefined): string {
  if (!bytesPerSec || !Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return "0 B/s";
  return `${fmtBytes(bytesPerSec)}/s`;
}

export function fmtDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return "—";
  if (sec <= 0) return "0s";
  const s = Math.floor(sec);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  return `${rem}s`;
}

export function fmtDate(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function timeUntil(ts: number | null | undefined, nowMs = Date.now()): string {
  if (!ts) return "Never";
  const deltaSec = Math.floor((ts - nowMs) / 1000);
  if (deltaSec <= 0) return "Expired";
  return fmtDuration(deltaSec);
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export async function copyWithToast(text: string, label = "Copied"): Promise<void> {
  if (await copyToClipboard(text)) toast(label);
  else toast("Could not copy automatically. Select and copy manually.", "err");
}
