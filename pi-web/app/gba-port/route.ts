import { NextResponse } from "next/server";

// romctl serve 端口发现：工作台页面未带 ?api= 时由此取端口构造绝对 API/WS 基址
export async function GET() {
  return NextResponse.json({ port: process.env.GBA_SERVE_PORT || "8645" });
}
