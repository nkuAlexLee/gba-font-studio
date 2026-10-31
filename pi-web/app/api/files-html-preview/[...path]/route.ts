// Preview-ready HTML for FileViewer: the file's own markup with local relative
// assets inlined (see lib/html-preview.ts for why this cannot be done with a
// <base> + raw-asset endpoint inside a sandboxed iframe).
//
// Served as text/html; the viewer puts it into <iframe sandbox="allow-scripts"
// srcDoc>, so this response is never a top-level navigation target.

import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";
import { MAX_HTML_PREVIEW_BYTES, renderHtmlPreview } from "@/lib/html-preview";
import { filePathFromApiSegments } from "@/lib/paths";

export async function GET(
  _request: NextRequest,
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
    if (stat.size > MAX_HTML_PREVIEW_BYTES) {
      return NextResponse.json({ error: "HTML too large for preview (>4MB)" }, { status: 413 });
    }

    const html = fs.readFileSync(filePath, "utf8");
    const preview = await renderHtmlPreview(filePath, html);

    return new NextResponse(preview, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
