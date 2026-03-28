# Web ↔ Telegram 主线镜像：阶段 A 技术探针报告

负责人：苏雨  
执行工程师：砚秋（Codex）  
日期：2026-03-28

## 0. 探针范围与边界

- 本报告只覆盖阶段 A：技术探针 + 插件骨架设计。
- 不进入完整功能实现。
- 不改 OpenClaw core，不改身份/记忆文件，不做大范围配置改动。

---

## 1. 关键事实（基于本机 OpenClaw 2026.3.24 实际接口）

1. 插件 SDK 存在并可用：`definePluginEntry`、`api.on(...)`、`api.runtime.*`。  
   参考：
   - `/usr/lib/node_modules/openclaw/docs/plugins/sdk-entrypoints.md`
   - `/usr/lib/node_modules/openclaw/docs/plugins/sdk-overview.md`

2. `message_sending` / `message_sent` hook 存在，但其插件上下文不含 `sessionKey`，仅有 `channelId/accountId/conversationId`。  
   参考：
   - `/usr/lib/node_modules/openclaw/dist/plugin-sdk/src/plugins/types.d.ts`（`PluginHookMessageContext`）
   - `/usr/lib/node_modules/openclaw/dist/pi-embedded-BaSvmUpW.js`（`applyMessageSendingHook`）

3. Web 入站（含 Control UI）走 `webchat` 内部通道，且会在入站上下文放入 `SenderId`（客户端 id）。  
   已确认客户端 id 族包含：`webchat-ui`、`openclaw-control-ui`。  
   参考：
   - `/usr/lib/node_modules/openclaw/dist/gateway-cli-SPSnwPDk.js`（`chat.send` 构建 `ctx` 时写入 `SenderId`）
   - `/usr/lib/node_modules/openclaw/dist/plugin-sdk/src/gateway/protocol/client-info.d.ts`

4. session store 持久化了 `deliveryContext` / `lastChannel` / `lastTo` / `lastAccountId`，可用于提取 Telegram 回投目标。  
   参考：
   - `/usr/lib/node_modules/openclaw/dist/plugin-sdk/src/config/sessions/types.d.ts`
   - `/usr/lib/node_modules/openclaw/dist/plugin-sdk/src/utils/delivery-context.d.ts`

5. 插件运行时可直接调用 Telegram 发送能力：`api.runtime.channel.telegram.sendMessageTelegram(...)`。  
   参考：
   - `/usr/lib/node_modules/openclaw/dist/plugin-sdk/src/plugins/runtime/types-channel.d.ts`
   - `/usr/lib/node_modules/openclaw/dist/plugin-sdk/extensions/telegram/src/send.d.ts`

---

## 2. 最合适的 OpenClaw hook 点

## 2.1 主 hook：`agent_end`

建议使用 `api.on("agent_end", ...)` 作为镜像触发点。

理由：
- 能拿到本轮最终 assistant 输出（`event.messages`）。
- `ctx` 含 `sessionKey/sessionId/trigger/channelId/messageProvider`，可精准过滤主会话与触发来源。
- 不依赖 `message_sending`（后者只在“已经发生外发”时触发；而当前问题正是 Web 回合未外发到 Telegram）。

## 2.2 辅助 hook：`before_dispatch`

建议同时挂 `api.on("before_dispatch", ...)`，只做来源标记，不做发送。

用途：
- 读取 `event.channel` + `event.senderId` + `event.sessionKey`，将“本轮是 Web / Control UI 发起”的事实写入短 TTL 缓存。
- 供 `agent_end` 判定是否需要执行镜像。

为什么要双 hook：
- `agent_end` 的 `ctx.channelId/messageProvider` 可判 `webchat`，但不能稳定区分 Control UI 与其他内部入口；
- `before_dispatch` 拿得到 `senderId`（如 `openclaw-control-ui`），能补足来源判定信号。

---

## 3. 如何稳定识别 Web / Control UI 来源

采用“三段式判定”，按优先级从高到低：

1. `before_dispatch` 事件中：
   - `event.channel === "webchat"`
   - `event.senderId in {"openclaw-control-ui", "webchat-ui", "webchat"}`（允许配置扩展）
   满足则记为 `source=web`，并缓存到 `recentSourceBySession[sessionKey]`（TTL 60~120s）。

2. `agent_end` 兜底：
   - `ctx.channelId === "webchat" || ctx.messageProvider === "webchat"`

3. 触发类型过滤：
   - `ctx.trigger === "user"` 才可镜像；
   - `heartbeat/cron/memory` 一律跳过。

结论：
- “Web 来源判定”不是单字段判断，必须组合 `before_dispatch + agent_end + trigger` 才稳定。

---

## 4. 如何提取 Telegram 目标 delivery context

来源优先级（只取第一命中）：

1. `sessionEntry.deliveryContext`（推荐主来源）
2. 回退到 `lastChannel + lastTo + lastAccountId + lastThreadId`

实现步骤：

1. 在 `agent_end` 用 `api.runtime.agent.session.loadSessionStore(api.config)` 读 session store。
2. 取 `ctx.sessionKey` 对应 entry。
3. 解析出 delivery context，要求：
   - `channel === "telegram"`
   - `to` 非空
4. thread/topic：若有 `threadId`，传给 `sendMessageTelegram(..., { messageThreadId })`。

判定失败处理：
- 若未提取到 telegram 目标，则跳过本轮（只记录 debug 日志，不报错中断）。

---

## 5. 如何避免镜像回声 / 重复发送

采用 4 层防护：

1. **来源防护**：仅 `source=web` 且 `trigger=user` 时触发。Telegram 入站回合不会触发。
2. **会话防护**：仅 `ctx.sessionKey === "agent:main:main"`（或配置化等价主会话键）触发。
3. **内容防护**：
   - 跳过空文本。
   - 跳过纯系统噪声（可先做最小规则：`HEARTBEAT_OK`、`/status` 结果模板等）。
4. **幂等防护**：
   - 对 `sessionKey + sessionId + assistantText` 计算 hash。
   - 维护 `dedupeLru`（内存 LRU + TTL，建议 TTL=10min）。命中则不再发。

补充：
- 发送调用统一走 `api.runtime.channel.telegram.sendMessageTelegram(...)`，并在 metadata 里附本插件标记（仅本地日志用）。
- 不在 `message_sent` 钩子里做二次转发，从流程上断开“发送触发发送”的链路。

---

## 6. 插件目录骨架建议

建议以 workspace 插件形式落地：

```text
/home/yusu/.openclaw/workspace/.openclaw/extensions/web-telegram-mirror/
  openclaw.plugin.json
  index.ts
  setup-entry.ts
  README.md
  src/
    config.ts
    hooks.ts
    source-detector.ts
    delivery-target.ts
    mirror-sender.ts
    dedupe.ts
    filters.ts
    logger.ts
```

最小文件职责：
- `index.ts`：`definePluginEntry` + register hooks
- `hooks.ts`：`before_dispatch` / `agent_end` 编排
- `source-detector.ts`：Web/Control UI 判定 + TTL 缓存
- `delivery-target.ts`：从 session store 抽取 telegram target
- `mirror-sender.ts`：调用 `sendMessageTelegram`
- `dedupe.ts`：hash + LRU TTL
- `filters.ts`：噪声过滤

---

## 7. 配置项设计建议

建议把配置放在：`plugins.entries.web-telegram-mirror.config`

```json5
{
  "enabled": true,
  "mainSessionKey": "agent:main:main",
  "mirrorDirection": "web_to_telegram",
  "sources": {
    "allowWebchat": true,
    "allowControlUi": true,
    "senderIds": ["openclaw-control-ui", "webchat-ui", "webchat"]
  },
  "target": {
    "channel": "telegram",
    "preferSessionDeliveryContext": true,
    "fallbackToLastRoute": true
  },
  "dedupe": {
    "enabled": true,
    "ttlMs": 600000,
    "maxEntries": 1024
  },
  "filters": {
    "skipHeartbeatAck": true,
    "skipEmpty": true,
    "skipSystemLike": true
  },
  "observeOnly": true,
  "logLevel": "info"
}
```

说明：
- `observeOnly` 是阶段 B 首发的安全阀：先只打日志不发送，验证判定准确后再切 `false`。
- `mainSessionKey` 显式化，避免后续 mainKey 变化导致误判。

---

## 8. 风险清单

1. **Telegram 网络不可达风险（现网已发生过）**  
   影响：镜像发送失败；不会影响主回复本身。  
   缓解：发送异常吞吐 + 限频日志 + 失败计数。

2. **来源识别误判**（把非 Web 回合当 Web）  
   缓解：`before_dispatch + agent_end + trigger` 联合判定；首发 `observeOnly`。

3. **目标路由漂移**（主会话 recent route 被其它通道覆盖）  
   缓解：仅当 `deliveryContext.channel===telegram` 且 `to` 存在时发送；否则跳过。

4. **重复发送**（重试/并发/重复 hook）  
   缓解：`sessionId + text` 幂等键 + LRU TTL。

5. **文本分段差异**（Telegram 长文本分段，与 Web 显示不一致）  
   缓解：一期接受差异；后续可引入 chunk 策略对齐。

6. **主题线程丢失**（Telegram topic 未带 `messageThreadId`）  
   缓解：从 `deliveryContext.threadId` 透传。

---

## 9. 下一步最小实现方案（阶段 B 最小闭环）

1. 建插件骨架与 manifest（不动 core）。
2. 实现 `before_dispatch`：仅记录 `sessionKey -> source`（TTL）。
3. 实现 `agent_end`：
   - 过滤：主会话 + `trigger=user` + source=web
   - 取最后 assistant 文本
   - 从 session store 提取 telegram delivery context
   - `observeOnly=true` 时只日志；`false` 时调用 `sendMessageTelegram`
4. 加幂等（LRU+TTL）。
5. 本地验证场景：
   - Web 发消息 -> 记录“会发送”日志
   - Telegram 发消息 -> 不记录镜像动作
   - heartbeat/status -> 不触发
6. 负责人审阅通过后，再把 `observeOnly` 置 `false` 做真实发送验证。

---

## 10. 阶段 A 结论

- 技术上可行，且无需改 core。  
- 推荐路径：`before_dispatch`（来源判定） + `agent_end`（镜像触发） + `runtime.channel.telegram.sendMessageTelegram`（发送执行）。  
- 该路径能覆盖计划书要求：主会话限定、Web 来源识别、Telegram 目标提取、回声/重复控制、可配置启停。
