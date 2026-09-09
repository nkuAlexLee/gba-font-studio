# work/ — 流水线运行产物目录

| 文件 | 写入者 | 消费者 |
|------|--------|--------|
| `pipeline.json` | pi 扩展 `pipeline_stage` 工具 | Studio 流水线看板（`/pipeline`）、`pipeline_status` |
| `report-*.md` | pi 扩展 `pipeline_report` 工具 | 人工查阅 |
| `insert-latest.log` | serve `/insert`（后台回填任务） | Studio 审校面板 |

## pipeline.json schema

```jsonc
{
  "rom": "D:/.../roms/xxx.gba",   // 当前工程 ROM
  "base": "dualbyte-esc",          // 基座类型（dualbyte | esc | slot）
  "updated": "ISO 时间",
  "stages": [{
    "id": "engine",                // engine|font|charmap|export|translate|layout|insert|verify
    "name": "定位渲染引擎",
    "status": "done",              // pending|running|done|blocked
    "progress": 1.0,               // 0-1（可选）
    "evidence": ["tmp/xxx.png"],   // 证据（截图/日志/探针输出路径）
    "notes": "…",
    "updated": "ISO 时间"
  }]
}
```

不要手工编辑（除初始化）；由 agent 通过 `pipeline_stage` 工具维护。
