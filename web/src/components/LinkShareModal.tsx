import QRCode from "qrcode";
import { createEffect, createSignal, Show } from "solid-js";

import { api, type LinkDto } from "../api";
import { Badge, Btn, CopyButton, Icon, Icons, Modal, Segmented, copyWithToast, fmtBytes, fmtDuration, toast } from "../ui";

export function LinkShareModal(props: {
  link: LinkDto | null;
  onClose: () => void;
  onChecksumComputed?: (sha256: string) => void;
}) {
  const [qrSvg, setQrSvg] = createSignal("");
  const [cliTab, setCliTab] = createSignal<"curl" | "wget" | "aria2c">("curl");
  const [sha256, setSha256] = createSignal<string | null>(null);
  const [hashing, setHashing] = createSignal(false);

  createEffect(() => {
    const l = props.link;
    if (!l) {
      setQrSvg("");
      setSha256(null);
      return;
    }
    setSha256(l.sha256);
    void QRCode.toString(l.publicUrl, { type: "svg", margin: 1, width: 176 })
      .then((svg) => setQrSvg(svg))
      .catch(() => setQrSvg(""));
  });

  const cliCommand = () => {
    const l = props.link;
    if (!l) return "";
    const url = l.publicUrl;
    const fname = l.downloadFilename;
    const pwFlag = l.hasPassword ? ` -H "X-CDL-Password: <password>"` : "";
    if (cliTab() === "wget") {
      return l.hasPassword
        ? `wget -c --header="X-CDL-Password: <password>" -O "${fname}" "${url}"`
        : `wget -c -O "${fname}" "${url}"`;
    }
    if (cliTab() === "aria2c") {
      return l.hasPassword
        ? `aria2c -c -x4 -s4 --header="X-CDL-Password: <password>" -o "${fname}" "${url}"`
        : `aria2c -c -x4 -s4 -o "${fname}" "${url}"`;
    }
    return `curl -fL -C -${pwFlag} -o "${fname}" "${url}"`;
  };

  const computeChecksum = async () => {
    const l = props.link;
    if (!l) return;
    setHashing(true);
    try {
      const res = await api<{ sha256: string }>("POST", "/api/files/checksum", {
        sourceType: l.sourceType,
        sourcePath: l.sourceType === "mount" ? l.sourcePath : undefined,
        uploadId: l.sourceType === "upload" ? l.uploadId : undefined,
      });
      setSha256(res.sha256);
      props.onChecksumComputed?.(res.sha256);
      toast("SHA-256 checksum ready");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to compute SHA-256", "err");
    } finally {
      setHashing(false);
    }
  };

  return (
    <Modal
      open={!!props.link}
      onClose={props.onClose}
      title={props.link?.label || "Direct Download Link"}
      description={props.link ? `${props.link.downloadFilename} · ${fmtBytes(props.link.fileSize)}` : undefined}
      width="max-w-xl"
      footer={
        <>
          <Btn variant="ghost" onClick={props.onClose}>
            Close
          </Btn>
          <Show when={props.link}>
            {(l) => (
              <Btn onClick={() => void copyWithToast(l().publicUrl, "Direct link copied")}>
                <Icon name={Icons.copy} size={15} />
                Copy Direct URL
              </Btn>
            )}
          </Show>
        </>
      }
    >
      <Show when={props.link}>
        {(l) => (
          <div class="space-y-4">
            {/* Direct URL copy box */}
            <div class="rounded-panel border border-border bg-surface-subtle p-3 space-y-2">
              <div class="flex items-center justify-between gap-2">
                <span class="text-xs font-medium text-fg-secondary">Direct download URL</span>
                <div class="flex items-center gap-1.5">
                  <Show when={l().expiryMode === "sliding"}>
                    <Badge tone="accent">Debounce {fmtDuration(l().idleTtlSec)}</Badge>
                  </Show>
                  <Show when={l().hasPassword}>
                    <Badge tone="amber">Password</Badge>
                  </Show>
                  <Show when={l().lockToFirstIp}>
                    <Badge tone="info">1-IP Lock</Badge>
                  </Show>
                </div>
              </div>
              <div class="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={l().publicUrl}
                  onClick={(e) => e.currentTarget.select()}
                  class="ui-field ui-field-sm font-mono text-xs flex-1"
                />
                <CopyButton text={l().publicUrl} label="Copy" />
              </div>
            </div>

            {/* QR Code + Summary */}
            <div class="grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-4 items-center rounded-panel border border-border p-3.5 bg-surface">
              <Show when={qrSvg()}>
                <div
                  class="bg-white p-2 rounded-xl border border-border-subtle mx-auto sm:mx-0 w-[160px] h-[160px] flex items-center justify-center [&>svg]:w-full [&>svg]:h-full"
                  /* eslint-disable-next-line solid/no-innerhtml */
                  innerHTML={qrSvg()}
                />
              </Show>
              <div class="space-y-2 text-xs text-fg-secondary">
                <div class="text-sm font-medium text-fg">Scan on phone or share directly</div>
                <p>
                  This endpoint serves <code class="font-mono text-fg">Content-Disposition: attachment</code> with full HTTP{" "}
                  <code class="font-mono text-fg">Range</code> resume support.
                </p>
                <div class="flex flex-wrap gap-2 pt-1">
                  <a
                    href={l().publicUrl}
                    target="_blank"
                    rel="noreferrer"
                    class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-control border border-border bg-surface-subtle hover:bg-surface-muted text-fg text-xs font-medium transition-colors"
                  >
                    <Icon name={Icons.download} size={13} />
                    Test Download
                  </a>
                  <Btn size="xs" variant="secondary" loading={hashing()} onClick={() => void computeChecksum()}>
                    <Icon name={Icons.hash} size={13} />
                    {sha256() ? "Re-verify SHA-256" : "Compute SHA-256"}
                  </Btn>
                </div>
              </div>
            </div>

            {/* SHA-256 Display */}
            <Show when={sha256()}>
              {(digest) => (
                <div class="rounded-panel border border-border bg-surface-subtle p-3 space-y-1.5">
                  <div class="text-xs font-medium text-fg-secondary">SHA-256 Checksum (also sent as X-Checksum-SHA256)</div>
                  <div class="flex items-center gap-2">
                    <code class="font-mono text-xs text-fg break-all flex-1">{digest()}</code>
                    <CopyButton text={digest()} />
                  </div>
                </div>
              )}
            </Show>

            {/* CLI Resume Commands */}
            <div class="space-y-2">
              <div class="flex items-center justify-between gap-2">
                <span class="text-xs font-medium text-fg-secondary">Resumable CLI commands</span>
                <Segmented
                  value={cliTab()}
                  onChange={setCliTab}
                  options={[
                    { value: "curl", label: "curl" },
                    { value: "wget", label: "wget" },
                    { value: "aria2c", label: "aria2c" },
                  ]}
                />
              </div>
              <div class="rounded-panel border border-border bg-surface-subtle p-2.5 flex items-center gap-2">
                <code class="font-mono text-xs text-fg break-all flex-1">{cliCommand()}</code>
                <CopyButton text={cliCommand()} />
              </div>
            </div>
          </div>
        )}
      </Show>
    </Modal>
  );
}
