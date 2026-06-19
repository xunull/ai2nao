# 设计：可插拔的「外部 AI 平台用量」同步（MiniMax 为第一个）

> 状态：**设计已锁定，待实现**（office-hours 2026-06-19）。下一步 `/plan-eng-review`。
>
> 做一个**可扩展的 provider 插件**机制:每个 AI 平台（MiniMax、未来其它）= 一个实现
> 统一接口的模块,从它的 API 拉用量,**在管理页可开关**;关掉就不同步、不展示。
> MiniMax 是第一个插件。

---

## 1. 前提更正（office-hours 中纠正，重要）

原始想法是「调 MiniMax API 拿**每天/每月**的 token 数量」。核实后:

> **MiniMax 没有「每天/每月历史」的 API。** 只有 `GET https://www.minimaxi.com/v1/
> token_plan/remains`（`Authorization: Bearer <Key>`），返回**当前快照**:本窗口已用 /
> 剩余 / 重置时间（5 小时滚动 + 周窗口）。社区工具 `minimax-status` 也只显示这个快照。

**决策（已拍）：只存快照,不攒历史。** 显示「MiniMax Token Plan：已用 X / 总 Y · T 重置」,
不画每天曲线（MiniMax 给不了,不自己轮询攒——那是另一个量级的复杂度,放弃）。

## 2. 这是一类新数据，跟现有 token 不混

| | 来源 | 形态 |
|---|---|---|
| Claude / Codex（现有） | 本地 session 文件解析 | 每 session、含 cache/model/cost 明细、按时间分桶 |
| **外部 provider（本功能）** | **平台 API（带 key）** | **当前快照**（已用/剩余/重置），无 session/明细 |

所以**不塞进按 session 的 token-trend**,放一个新区/新页「外部 AI 平台用量」。

## 3. 插件架构

```
ProviderUsageSource 接口（每个平台一个模块,注册进 registry）
  interface ProviderUsageSource {
    id: string;            // "minimax"
    label: string;         // "MiniMax"
    sync(cfg): Promise<ProviderSnapshot>;   // MiniMax: GET /token_plan/remains
  }
  type ProviderSnapshot = {
    used?: number; remaining?: number; total?: number;
    resetAt?: string; window?: string; raw: unknown;   // raw 保留原始响应
  };
   │
   ▼  provider_config 表（provider, enabled, api_key, updated_at）  ← DB 存,管理页可改
   ▼  scheduler 任务 "provider.usage.sync"：遍历【enabled】provider 逐个 sync,错误隔离
   ▼  provider_usage 表（provider, used, remaining, total, reset_at, window,
                        raw_json, synced_at）  ← 每 provider 一行,upsert 最新快照
   │
   ▼  routes：GET 列表（config + 最新快照）/ PATCH 配置（开关、填 key）/ POST 立即同步
   ▼  管理页：列 provider，开关 enabled + 填 key + 同步状态/时间 + 手动同步按钮
   ▼  仪表盘新区「外部 AI 平台用量」：只显示【enabled】provider 的快照；关掉 → 隐藏
```

### 加一个 provider 要改什么（验证可扩展性）

1. 写一个实现 `ProviderUsageSource` 的模块（拉它的用量 API → ProviderSnapshot）。
2. 注册进 registry。
3. 完事——管理页、同步任务、展示区**自动**带上它（开关 + key + 快照）。

## 4. MiniMax 插件（#1）

- `GET https://www.minimaxi.com/v1/token_plan/remains`，header `Authorization: Bearer <key>`。
- 用 `webSearch/brave.ts` 的超时惯例（AbortController + ~8s）。
- 响应字段官方没文档化（社区逆向出「已用额度/剩余次数/重置时间」）→ 实现时**探活真实响应**
  挖字段,容错命名,原始响应进 `raw_json` 兜底。
- 失败 → 该 provider 同步 status=failed,保留上次快照,不影响其它 provider。

## 5. 关键决策（已定）

- **插件抽象从一开始就做**（用户明确要可扩展），MiniMax 是第一个实现。
- **key 存 DB**（`provider_config`，本地 SQLite）——因为要管理页开关 + 填 key。这是 ai2nao
  第一个「带密钥的设置页」。本地优先,key 明文存本地库可接受;实现时注明「仅本地、勿外传」。
- **快照-only**（无历史派生）。
- **一个 scheduler 任务遍历 enabled provider**（不是每 provider 一个任务）——读 provider_config,
  默认禁用,用户在管理页开启。

## 6. 留给 /plan-eng-review 的点

1. **/token_plan/remains 真实响应字段**：实现时拿真 key 探活,字段容错 + raw 兜底。
2. **secret 存储**：DB 明文 vs 加个轻量遮罩;本地优先下明文可接受,但要在管理页标注 + 文件权限。
3. **provider_config 与 scheduler 的关系**：管理页开关写 `provider_config.enabled`;同步任务读它。
   任务本身默认禁用,还是「有任一 provider enabled 就自动跑」?（建议：任务默认禁用,用户开任务 +
   开 provider 两道,或合并成「管理页开 provider 即视为开同步」——eng-review 定。）
4. **管理页落点**：独立新页 `/providers` vs 并进 `/scheduler` 页。
5. **展示区落点**：独立小卡片区 vs 进某个 dashboard。

## 7. 范围边界（明确不做）

- 不攒每天/每月历史（MiniMax 给不了,只存快照）。
- 不抓 pay-as-you-go 余额（只 token_plan 快照;未来可作另一个 snapshot 字段）。
- 不把外部 provider 混进按 session 的 token-trend（数据模型不同）。
- v1 只实现 MiniMax + registry 脚手架;不预先写其它 provider。

## 8. 相关文件（实现时会碰）

- `src/providers/types.ts`（新）— `ProviderUsageSource` / `ProviderSnapshot` 接口
- `src/providers/registry.ts`（新）— provider 注册表
- `src/providers/minimax.ts`（新）— MiniMax 插件
- `src/providers/store.ts`（新）— provider_config / provider_usage 读写
- `src/store/migrations.ts` — 两张表
- `src/scheduler/taskDefinitions.ts` — 注册 `provider.usage.sync`
- `src/serve/` — provider 列表/配置/同步 路由
- `web/src/pages/Providers.tsx`（新）— 管理页 + 展示
- [`docs/token-tracking-ecosystem-comparison.md`](token-tracking-ecosystem-comparison.md) — 多源 token 统计背景
