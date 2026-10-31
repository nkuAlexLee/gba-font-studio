// Server-side asset inlining for the HTML file preview.
//
// Why not just point a <base> at a raw-asset API? Because the preview iframe is
// sandboxed without allow-same-origin: its document gets an opaque origin, so
// every relative subresource request is a cross-origin no-cors request and
// Chromium's Opaque Response Blocking (ORB) rejects the response
// (net::ERR_BLOCKED_BY_ORB) — the stylesheet is fetched but never applied.
// Granting CORS on the files API would fix the symptom and open a worse hole
// (any web page could read local files while the app runs).
//
// So the preview document is assembled server-side instead: local stylesheets
// and scripts are inlined as <style>/<script>, other local assets (images,
// fonts, media) become data: URIs. The resulting srcdoc makes no subresource
// requests at all, which also works in browsers without ORB.
//
// Everything is best-effort: a reference that is remote, out of the allowed
// roots, too large, or unreadable is left untouched (the page degrades exactly
// as it did before, it never breaks harder).

import fs from "fs";
import path from "path";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";
import {
  getAudioMime,
  getDocumentMime,
  getFileExt,
  getImageMime,
  getVideoMime,
} from "@/lib/file-types";

/** Single inlined asset cap (a huge asset is left as a plain remote-ish ref). */
const MAX_ASSET_BYTES = 6 * 1024 * 1024;
/** Total inlined budget per preview document. */
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
/** Cap for the previewed HTML source itself. */
export const MAX_HTML_PREVIEW_BYTES = 4 * 1024 * 1024;

/** Fonts need an exact MIME in a data: URI or the browser silently ignores them. */
const FONT_EXT_TO_MIME: Record<string, string> = {
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
};

function assetMime(filePath: string): string {
  return (
    getImageMime(filePath)
    || getAudioMime(filePath)
    || getVideoMime(filePath)
    || getDocumentMime(filePath)
    || FONT_EXT_TO_MIME[getFileExt(filePath)]
    || "application/octet-stream"
  );
}

/** Remote schemes, protocol-relative URLs and in-page anchors are never rewritten. */
const NON_LOCAL_REF = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

/** Attribute reader that requires a real attribute boundary (so `data-src` ≠ `src`). */
function getAttr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`(?:^|[\\s])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? "";
}

/** Property-based attribute writer, same boundary rule as getAttr. */
function setAttr(tag: string, name: string, value: string): string {
  const re = new RegExp(`(^|[\\s])(${name}\\s*=\\s*)(?:"[^"]*"|'[^']*'|[^\\s>]+)`, "i");
  if (!re.test(tag)) return tag;
  return tag.replace(re, (_m, lead: string, prefix: string) => `${lead}${prefix}"${escapeAttr(value)}"`);
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function toDataUri(data: Buffer, mime: string): string {
  return `data:${mime};base64,${data.toString("base64")}`;
}

/**
 * Rewrites a previewed HTML document so that its local relative references no
 * longer need any network request from the sandboxed iframe.
 */
export async function renderHtmlPreview(filePath: string, html: string): Promise<string> {
  const roots = await getAllowedFileRoots();
  const baseDir = path.dirname(filePath);
  let budget = MAX_TOTAL_BYTES;

  const readAsset = (ref: string, fromDir: string): { file: string; data: Buffer } | null => {
    const raw = ref.trim();
    if (!raw || NON_LOCAL_REF.test(raw)) return null;
    // Root-relative refs cannot be resolved against a known document root, skip.
    if (raw.startsWith("/") || raw.startsWith("\\")) return null;
    let clean = raw.split(/[?#]/, 1)[0];
    try {
      clean = decodeURIComponent(clean);
    } catch {
      // keep the raw form; a malformed escape simply fails the lookup below
    }
    if (!clean) return null;
    const resolved = path.resolve(fromDir, clean);
    if (!isFilePathAllowed(resolved, roots)) return null;
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile() || stat.size > MAX_ASSET_BYTES || stat.size > budget) return null;
      const data = fs.readFileSync(resolved);
      budget -= data.length;
      return { file: resolved, data };
    } catch {
      return null;
    }
  };

  const readTextAsset = (ref: string, fromDir: string): { file: string; text: string } | null => {
    const asset = readAsset(ref, fromDir);
    if (!asset) return null;
    return { file: asset.file, text: asset.data.toString("utf8") };
  };

  const inlineCssUrls = (css: string, fromDir: string): string => {
    // @import of a local sheet would otherwise stay a network request.
    const imported = css.replace(
      /@import\s+(?:url\(\s*)?(["'])([^"']+)\1\s*\)?\s*([^;]*);/gi,
      (match, _q: string, ref: string, rest: string) => {
        const asset = readTextAsset(ref, fromDir);
        if (!asset) return match;
        return `${inlineCssUrls(asset.text, path.dirname(asset.file))}${rest.trim() === "" ? "" : ` ${rest.trim()}`}`;
      },
    );
    return imported.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (match, _q: string, ref: string) => {
      const asset = readAsset(ref, fromDir);
      if (!asset) return match;
      return `url("${toDataUri(asset.data, assetMime(asset.file))}")`;
    });
  };

  // Tag rewriting must never look inside <script>/<style> bodies or comments:
  // JS that builds markup ("<img src=…>") would otherwise have its source
  // rewritten. Blocks are split out first; only the rest is rewritten. An
  // unclosed raw-text element also stops the scan (the tail stays verbatim).
  const rewriteTags = (segment: string): string => {
    const cut = segment.search(/<script\b|<style\b|<!--/i);
    const head = cut === -1 ? segment : segment.slice(0, cut);
    const tail = cut === -1 ? "" : segment.slice(cut);

    // 1) <link rel="stylesheet" href="…"> → <style>
    let s = head.replace(/<link\b[^>]*>/gi, (tag) => {
      const rel = getAttr(tag, "rel");
      if (!rel || !/\bstylesheet\b/i.test(rel)) return tag;
      const href = getAttr(tag, "href");
      if (!href) return tag;
      const asset = readTextAsset(href, baseDir);
      if (!asset) return tag;
      const media = getAttr(tag, "media");
      const css = inlineCssUrls(asset.text, path.dirname(asset.file));
      return `<style data-preview-inlined="${escapeAttr(href)}"${media ? ` media="${escapeAttr(media)}"` : ""}>${css}</style>`;
    });

    // 3) 图片/媒体引用 → data: URI（src / poster）
    s = s.replace(/<(img|source|video|audio|input)\b[^>]*>/gi, (tag) => {
      let result = tag;
      for (const name of ["src", "poster"]) {
        const value = getAttr(tag, name);
        if (!value) continue;
        const asset = readAsset(value, baseDir);
        if (!asset) continue;
        result = setAttr(result, name, toDataUri(asset.data, assetMime(asset.file)));
      }
      return result;
    });

    return s + tail;
  };

  let out = "";
  let cursor = 0;
  const blockRe = /<!--[\s\S]*?-->|<(script|style)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
  for (let m; (m = blockRe.exec(html)) !== null; ) {
    out += rewriteTags(html.slice(cursor, m.index));
    cursor = m.index + m[0].length;
    const [, tagName, attrs, body] = m;

    if (tagName?.toLowerCase() === "script" && body.trim() === "") {
      // 2) <script src="…"></script> → 内联脚本
      const open = `<script${attrs}>`;
      const src = getAttr(open, "src");
      const asset = src ? readTextAsset(src, baseDir) : null;
      if (asset) {
        const type = getAttr(open, "type");
        // A literal "</script" inside the payload would close the tag early;
        // escaping it is transparent inside strings/comments.
        const js = asset.text.replace(/<\/script/gi, "<\\/script");
        out += `<script${type ? ` type="${escapeAttr(type)}"` : ""}>${js}</script>`;
        continue;
      }
    }

    // 注释、<style> 块与未能内联的 <script> 原样保留
    out += m[0];
  }
  out += rewriteTags(html.slice(cursor));

  return out;
}
