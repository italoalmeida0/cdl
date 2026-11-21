process.env.NODE_ENV = "production";

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import path from "path";
import { fileURLToPath } from "url";

import iconifyPlugin from "./plugins/iconify-solid-plugin";
import solidPlugin from "./plugins/solid-plugin";
import tailwindPlugin from "./plugins/tailwind-plugin";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(ROOT, "dist");

/** Static import closure of the entry chunk so the browser preloads first-paint JS. */
function entryStaticChunks(dir: string, entry: string): string[] {
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    let source: string;
    try {
      source = readFileSync(path.join(dir, file), "utf8");
    } catch {
      return;
    }
    for (const match of source.matchAll(/(?:(?:^|[;}\s])import\s*["']|from\s*["'])\.\/([^"']+\.js)["']/g)) {
      walk(match[1]!);
    }
  };
  walk(entry);
  return [...seen];
}

async function build() {
  if (existsSync(distDir)) rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });

  console.log("[build] Bundling CDL dashboard SPA...");
  const result = await Bun.build({
    entrypoints: [path.join(ROOT, "web", "src", "boot.tsx")],
    outdir: path.join(distDir, "assets"),
    target: "browser",
    minify: true,
    splitting: true,
    naming: { entry: "[name]-[hash].[ext]", chunk: "chunk-[hash].[ext]", asset: "[name]-[hash].[ext]" },
    sourcemap: "none",
    plugins: [iconifyPlugin, tailwindPlugin, solidPlugin],
  });

  if (!result.success) {
    console.error("[build] failed:");
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }

  const assetPath = (file: string) => `{{BASE}}/assets/${path.basename(file)}`;
  const emittedEntry = result.outputs.find((output) => output.kind === "entry-point");
  const emittedStyle =
    result.outputs.find(
      (output) => output.kind === "asset" && /^boot-[^/\\]+\.css$/.test(path.basename(output.path)),
    ) ?? result.outputs.find((output) => output.kind === "asset" && output.path.endsWith(".css"));

  if (!emittedEntry || !emittedStyle) {
    console.error("[build] missing entry JS or CSS output");
    process.exit(1);
  }

  const entryFile = path.basename(emittedEntry.path);
  const styleFile = path.basename(emittedStyle.path);
  const preload = entryStaticChunks(path.join(distDir, "assets"), entryFile).map(assetPath);

  const sourceHtml = readFileSync(path.join(ROOT, "web", "index.html"), "utf8");
  const withoutAssets = sourceHtml
    .replace(/\s*<link rel="stylesheet" href="\.\/style\.tailwindcss\.css" \/>/, "")
    .replace(/\s*<script type="module" src="\.\/src\/index\.tsx"><\/script>/, "");
  if (withoutAssets === sourceHtml) {
    console.error("[build] index.html does not match expected dev asset tags");
    process.exit(1);
  }

  const head = [
    `<link rel="stylesheet" crossorigin href="${assetPath(styleFile)}" />`,
    ...preload.map((href) => `<link rel="modulepreload" crossorigin href="${href}" />`),
    `<script type="module" crossorigin src="${assetPath(entryFile)}"></script>`,
  ].join("\n    ");
  const document = withoutAssets.replace("</head>", `    ${head}\n  </head>`);
  writeFileSync(path.join(distDir, "index.html"), document);

  if (existsSync(path.join(ROOT, "web", "public"))) {
    cpSync(path.join(ROOT, "web", "public"), distDir, { recursive: true });
  }

  console.log(`[build] OK -> dist/ (${result.outputs.length} outputs)`);
  process.exit(0);
}

build();
