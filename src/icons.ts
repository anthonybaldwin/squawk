/**
 * Favicon discovery for monitor embeds. Icons are fetched once at startup (and
 * again when a monitor is added at runtime) and cached in memory.
 */

import type { MonitorConfig } from "./config";

export const monitorIcons = new Map<string, string>();

/**
 * Scan HTML for <link rel="icon"> / <link rel="shortcut icon"> / <link rel="apple-touch-icon">
 * tags and return the best candidate URL, resolved against the base URL.
 * Prefers non-SVG icons (neither Discord embeds nor Slack Block Kit images
 * render SVG) and the largest available size.
 */
export function extractIconFromHtml(html: string, baseUrl: string): string | undefined {
  type Candidate = { href: string; size: number; isSvg: boolean };
  const candidates: Candidate[] = [];

  // Match any <link ...> tag; attribute order is arbitrary in HTML.
  const linkRegex = /<link\b[^>]*>/gi;
  for (const linkMatch of html.matchAll(linkRegex)) {
    const tag = linkMatch[0];
    const rel = tag.match(/\brel\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    if (!rel || !/\bicon\b/.test(rel)) continue;
    const rawHref = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!rawHref) continue;
    // Decode minimal HTML entities we commonly see in Next.js-style proxy URLs.
    const href = rawHref
      .replace(/&amp;/g, "&")
      .replace(/&#38;/g, "&")
      .replace(/&quot;/g, '"');

    // Extract the largest dimension from sizes="WxH" (or "any").
    let size = 0;
    const sizesAttr = tag.match(/\bsizes\s*=\s*["']([^"']+)["']/i)?.[1];
    if (sizesAttr) {
      for (const token of sizesAttr.trim().split(/\s+/)) {
        if (token.toLowerCase() === "any") {
          size = Math.max(size, 512); // "any" (SVG) — score as large.
          continue;
        }
        const dims = token.split(/[xX]/).map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n));
        if (dims.length > 0) size = Math.max(size, ...dims);
      }
    }

    const typeAttr = tag.match(/\btype\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    const isSvg =
      rel.includes("mask-icon") ||
      typeAttr === "image/svg+xml" ||
      /\.svg(\?|$)/i.test(href);

    candidates.push({ href, size, isSvg });
  }

  if (candidates.length === 0) return undefined;

  // Prefer non-SVG (chat clients don't render SVG author icons), then largest size.
  candidates.sort((a, b) => {
    if (a.isSvg !== b.isSvg) return a.isSvg ? 1 : -1;
    return b.size - a.size;
  });

  const best = candidates[0];
  try {
    return new URL(best.href, baseUrl).toString();
  } catch {
    if (best.href.startsWith("//")) return `https:${best.href}`;
    return best.href;
  }
}

export async function fetchMonitorIcon(monitor: MonitorConfig): Promise<string | undefined> {
  // Manual override takes priority — skip fetching entirely. This is the
  // escape hatch for pages whose icons are injected by JS, hosted on CDNs
  // that reject hotlinking, or otherwise unreachable for the chat client's
  // image fetcher.
  if (monitor.iconUrl) return monitor.iconUrl;
  try {
    const response = await fetch(monitor.baseUrl);
    if (!response.ok) return undefined;
    const html = await response.text();
    return extractIconFromHtml(html, monitor.baseUrl);
  } catch {
    // Silently fall back to no icon.
  }
  return undefined;
}

export async function cacheMonitorIcons(monitors: MonitorConfig[]) {
  await Promise.all(
    monitors.map(async (monitor) => {
      const icon = await fetchMonitorIcon(monitor);
      if (icon) {
        monitorIcons.set(monitor.id, icon);
        console.log(`Cached icon for "${monitor.id}": ${icon}`);
      }
    }),
  );
}
