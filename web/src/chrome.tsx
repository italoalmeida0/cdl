import { Show, type JSX } from "solid-js";

import { withBase } from "./api";
import { usal } from "./motion";

export function navigate(to: string): void {
  location.hash = to;
}

export function LogoMark(props: { class?: string }) {
  return (
    <img
      src={withBase("/cdl-icon.svg")}
      alt="CDL"
      class={`object-contain shrink-0 rounded-lg ${props.class ?? "w-8 h-8"}`}
    />
  );
}

export function PageTitle(props: {
  title: string;
  subtitle?: string;
  right?: JSX.Element;
}) {
  return (
    <div
      class="relative flex flex-wrap items-end justify-between gap-3 mb-5"
      {...usal("fade-u duration-300")}
    >
      <div>
        <h1 class="text-2xl leading-tight font-medium tracking-tight text-fg">
          {props.title}
        </h1>
        <Show when={props.subtitle}>
          <p class="text-xs leading-relaxed text-fg-secondary mt-1.5">{props.subtitle}</p>
        </Show>
      </div>
      {props.right}
    </div>
  );
}
