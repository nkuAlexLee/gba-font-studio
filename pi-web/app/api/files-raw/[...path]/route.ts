// Raw asset serving for sandboxed HTML file preview.
//
// The file viewer previews HTML in a sandboxed srcdoc iframe (opaque origin,
// allow-scripts). Such a document has no resource base: the page's relative
// css/js/img references would resolve against the app origin and 404. The
// viewer injects a <base> pointing into this route so relative assets load.
//
// Security mirrors app/api/files/[...path]/route.ts GET "read": allowed-roots
// check only (no session-reference fallback — previewed pages reference their
// own directory tree), extension-derived MIME, nosniff, size cap.

import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";
import {
  IMAGE_PREVIEW_MAX_BYTES,
  getAudioMime,
  getDocumentMime,
  getFileExt,
  getImageMime,
  getVideoMime,
} from "@/lib/file-types";
import { filePathFromApiSegments } from "@/lib/paths";
import { streamFile } from "@/lib/stream-file";

// Static assets a previewed HTML page typically references. Images/audio/video/
// documents reuse the existing MIME maps; everything unknown is opaque bytes.
const RAW_EXT_TO_MIME: Record<string, string> = {
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  json: "application/json",
  map: "application/json",
  txt: "text/plain",
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  xml: "application/xml",
  vtt: "text/vtt",
  wasm: "application/wasm",
};

function getRawMime(filePath: string): string {
  return (
    RAW_EXT_TO_MIME[getFileExt(filePath)]
    || getImageMime(filePath)
    || getAudioMime(filePath)
    || getVideoMime(filePath)
    || getDocumentMime(filePath)
    || "application/octet-stream"
  );
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  try {
    const { path: segments } = await params;
    const filePath = filePathFromApiSegments(segments);

    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(filePath, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (!stat.isFile()) {
      return NextResponse.json({ error: "Not a file" }, { status: 400 });
    }
    // Same cap as image preview: preview assets are not a general download API.
    if (stat.size > IMAGE_PREVIEW_MAX_BYTES) {
      return NextResponse.json({ error: "Asset too large (>10MB)" }, { status: 413 });
    }

    return streamFile(filePath, stat, getRawMime(filePath), request.headers.get("range"));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
