export interface ActiveTransfer {
  id: string;
  linkId: string;
  token: string;
  filename: string;
  ip: string;
  userAgent: string;
  startedAt: number;
  lastProgressAt: number;
  rangeStart: number;
  rangeEnd: number;
  totalRangeBytes: number;
  fileSize: number;
  bytesSent: number;
  bytesPerSec: number;
  abortController: AbortController;
  _windowStartAt: number;
  _windowBytes: number;
}

const activeById = new Map<string, ActiveTransfer>();
const byLinkId = new Map<string, Set<string>>();

export function registerTransfer(input: {
  id: string;
  linkId: string;
  token: string;
  filename: string;
  ip: string;
  userAgent: string;
  rangeStart: number;
  rangeEnd: number;
  totalRangeBytes: number;
  fileSize: number;
  abortController: AbortController;
}): ActiveTransfer {
  const now = Date.now();
  const transfer: ActiveTransfer = {
    ...input,
    startedAt: now,
    lastProgressAt: now,
    bytesSent: 0,
    bytesPerSec: 0,
    _windowStartAt: now,
    _windowBytes: 0,
  };
  activeById.set(transfer.id, transfer);
  let set = byLinkId.get(transfer.linkId);
  if (!set) {
    set = new Set();
    byLinkId.set(transfer.linkId, set);
  }
  set.add(transfer.id);
  return transfer;
}

export function updateTransferProgress(id: string, deltaBytes: number): void {
  const t = activeById.get(id);
  if (!t) return;
  const now = Date.now();
  t.bytesSent += deltaBytes;
  t._windowBytes += deltaBytes;
  t.lastProgressAt = now;
  const elapsedMs = now - t._windowStartAt;
  if (elapsedMs >= 1000) {
    t.bytesPerSec = Math.round((t._windowBytes * 1000) / elapsedMs);
    t._windowStartAt = now;
    t._windowBytes = 0;
  } else if (t.bytesPerSec === 0 && now - t.startedAt > 100) {
    t.bytesPerSec = Math.round((t.bytesSent * 1000) / Math.max(1, now - t.startedAt));
  }
}

export function finishTransfer(id: string): ActiveTransfer | undefined {
  const t = activeById.get(id);
  if (!t) return undefined;
  activeById.delete(id);
  const set = byLinkId.get(t.linkId);
  if (set) {
    set.delete(id);
    if (set.size === 0) byLinkId.delete(t.linkId);
  }
  return t;
}

export function abortTransfer(id: string): boolean {
  const t = activeById.get(id);
  if (!t) return false;
  try {
    t.abortController.abort(new Error("aborted_by_admin"));
  } catch {}
  return true;
}

export function abortLinkTransfers(linkId: string): number {
  const set = byLinkId.get(linkId);
  if (!set) return 0;
  let count = 0;
  for (const id of [...set]) {
    if (abortTransfer(id)) count++;
  }
  return count;
}

export function activeCountForLink(linkId: string): number {
  return byLinkId.get(linkId)?.size ?? 0;
}

export function activeCountForLinkAndIp(linkId: string, ip: string): number {
  const set = byLinkId.get(linkId);
  if (!set) return 0;
  let n = 0;
  for (const id of set) {
    const t = activeById.get(id);
    if (t && t.ip === ip) n++;
  }
  return n;
}

export function activeBytesPerSecForLink(linkId: string): number {
  const set = byLinkId.get(linkId);
  if (!set) return 0;
  let total = 0;
  for (const id of set) {
    const t = activeById.get(id);
    if (t) total += t.bytesPerSec;
  }
  return total;
}

export interface LiveTransferDto {
  id: string;
  linkId: string;
  token: string;
  filename: string;
  ip: string;
  userAgent: string;
  startedAt: number;
  lastProgressAt: number;
  rangeStart: number;
  rangeEnd: number;
  totalRangeBytes: number;
  fileSize: number;
  bytesSent: number;
  bytesPerSec: number;
  progressPct: number;
}

export function liveSnapshot(linkId?: string): LiveTransferDto[] {
  const now = Date.now();
  const list: LiveTransferDto[] = [];
  const sourceIds = linkId ? [...(byLinkId.get(linkId) ?? [])] : [...activeById.keys()];
  for (const id of sourceIds) {
    const t = activeById.get(id);
    if (!t) continue;
    const stale = now - t.lastProgressAt > 3000;
    const bps = stale ? 0 : t.bytesPerSec;
    const pct =
      t.totalRangeBytes > 0 ? Math.min(100, Math.round((t.bytesSent / t.totalRangeBytes) * 1000) / 10) : 100;
    list.push({
      id: t.id,
      linkId: t.linkId,
      token: t.token,
      filename: t.filename,
      ip: t.ip,
      userAgent: t.userAgent,
      startedAt: t.startedAt,
      lastProgressAt: t.lastProgressAt,
      rangeStart: t.rangeStart,
      rangeEnd: t.rangeEnd,
      totalRangeBytes: t.totalRangeBytes,
      fileSize: t.fileSize,
      bytesSent: t.bytesSent,
      bytesPerSec: bps,
      progressPct: pct,
    });
  }
  list.sort((a, b) => b.startedAt - a.startedAt);
  return list;
}

export function liveStatsSummary(): { activeCount: number; totalBytesPerSec: number } {
  let totalBytesPerSec = 0;
  const now = Date.now();
  for (const t of activeById.values()) {
    if (now - t.lastProgressAt <= 3000) totalBytesPerSec += t.bytesPerSec;
  }
  return { activeCount: activeById.size, totalBytesPerSec };
}
