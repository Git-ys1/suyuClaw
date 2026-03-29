import { createHash } from "node:crypto";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const DEFAULT_CONFIG = {
  enabled: true,
  mainSessionKey: "agent:main:main",
  observeOnly: false,
  sourceTtlMs: 120000,
  dedupeTtlMs: 600000,
  dedupeMaxEntries: 1024,
  senderIds: ["openclaw-control-ui", "webchat-ui", "webchat"],
  filters: {
    skipEmpty: true,
    skipHeartbeatAck: true,
    skipSystemLike: true,
  },
};

const recentSourceBySession = new Map();
const dedupeCache = new Map();

function parseConfig(raw) {
  const cfg = raw && typeof raw === "object" ? raw : {};
  const filters = cfg.filters && typeof cfg.filters === "object" ? cfg.filters : {};
  const senderIds = Array.isArray(cfg.senderIds)
    ? cfg.senderIds.filter((v) => typeof v === "string")
    : DEFAULT_CONFIG.senderIds;

  return {
    enabled: cfg.enabled ?? DEFAULT_CONFIG.enabled,
    mainSessionKey: cfg.mainSessionKey ?? DEFAULT_CONFIG.mainSessionKey,
    observeOnly: cfg.observeOnly ?? DEFAULT_CONFIG.observeOnly,
    sourceTtlMs: Number(cfg.sourceTtlMs ?? DEFAULT_CONFIG.sourceTtlMs),
    dedupeTtlMs: Number(cfg.dedupeTtlMs ?? DEFAULT_CONFIG.dedupeTtlMs),
    dedupeMaxEntries: Number(cfg.dedupeMaxEntries ?? DEFAULT_CONFIG.dedupeMaxEntries),
    senderIds,
    filters: {
      skipEmpty: filters.skipEmpty ?? DEFAULT_CONFIG.filters.skipEmpty,
      skipHeartbeatAck: filters.skipHeartbeatAck ?? DEFAULT_CONFIG.filters.skipHeartbeatAck,
      skipSystemLike: filters.skipSystemLike ?? DEFAULT_CONFIG.filters.skipSystemLike,
    },
  };
}

function getTelegramSender(api) {
  return api?.runtime?.channel?.telegram?.sendMessageTelegram;
}

function nowMs() {
  return Date.now();
}

function pruneExpired(map) {
  const now = nowMs();
  for (const [key, expiresAt] of map.entries()) {
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      map.delete(key);
    }
  }
}

function setRecentWebSource(sessionKey, ttlMs) {
  if (!sessionKey) return;
  recentSourceBySession.set(sessionKey, nowMs() + ttlMs);
}

function hasRecentWebSource(sessionKey) {
  if (!sessionKey) return false;
  const expiresAt = recentSourceBySession.get(sessionKey);
  if (!Number.isFinite(expiresAt)) return false;
  if (expiresAt <= nowMs()) {
    recentSourceBySession.delete(sessionKey);
    return false;
  }
  return true;
}

function makeDedupeKey(parts) {
  return createHash("sha1").update(parts.join("|"), "utf8").digest("hex");
}

function seenDedupe(key, ttlMs, maxEntries) {
  pruneExpired(dedupeCache);
  if (dedupeCache.has(key)) {
    return true;
  }
  if (dedupeCache.size >= maxEntries) {
    const firstKey = dedupeCache.keys().next().value;
    if (firstKey) dedupeCache.delete(firstKey);
  }
  dedupeCache.set(key, nowMs() + ttlMs);
  return false;
}

function safeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function extractTextFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const textParts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    }
  }
  return textParts.join("\n");
}

function extractLastAssistantText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;
    if (msg.role !== "assistant") continue;
    const text = safeText(extractTextFromContent(msg.content));
    if (text) return text;
  }
  return "";
}

function stripReplyTag(text) {
  return text.replace(/^\s*\[\[\s*reply_to(?:\s*:\s*[^\]]+|_current)\s*\]\]\s*/i, "");
}

function stripMarkdownArtifacts(text) {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|[^*])\*([^*\n]+)\*(?=[^*]|$)/g, "$1$2")
    .replace(/(^|[^_])_([^_\n]+)_(?=[^_]|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^>\s?/gm, "")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1: $2");
}

function normalizeMirrorText(text) {
  return stripMarkdownArtifacts(stripReplyTag(text)).replace(/\n{3,}/g, "\n\n").trim();
}

function shouldSkipText(text, filters) {
  if (filters.skipEmpty && !text) return "skip-empty";
  if (filters.skipHeartbeatAck && text === "HEARTBEAT_OK") return "skip-heartbeat-ack";
  if (filters.skipSystemLike) {
    const normalized = text.toLowerCase();
    if (normalized.startsWith("[system") || normalized.includes("gateway status")) {
      return "skip-system-like";
    }
  }
  return "";
}

function normalizeThreadId(value) {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function resolveTelegramTarget(entry) {
  if (!entry || typeof entry !== "object") return null;

  const dc = entry.deliveryContext;
  if (dc && typeof dc === "object" && dc.channel === "telegram" && typeof dc.to === "string" && dc.to) {
    return {
      to: dc.to,
      accountId: typeof dc.accountId === "string" ? dc.accountId : undefined,
      threadId: normalizeThreadId(dc.threadId),
      source: "deliveryContext",
    };
  }

  if (entry.lastChannel === "telegram" && typeof entry.lastTo === "string" && entry.lastTo) {
    return {
      to: entry.lastTo,
      accountId: typeof entry.lastAccountId === "string" ? entry.lastAccountId : undefined,
      threadId: normalizeThreadId(entry.lastThreadId),
      source: "lastRoute",
    };
  }

  return null;
}

function loadSessionStoreEntry(api, sessionKey, agentId) {
  try {
    const storePath = api.runtime.agent.session.resolveStorePath(undefined, {
      agentId,
    });
    const store = api.runtime.agent.session.loadSessionStore(storePath);
    return sessionKey ? store[sessionKey] : undefined;
  } catch {
    return undefined;
  }
}

async function sendMirror(api, target, text, logPrefix, logContext = "") {
  const sendMessageTelegram = getTelegramSender(api);
  if (typeof sendMessageTelegram !== "function") {
    api.logger.warn(`[web-telegram-mirror] skip: telegram-runtime-unavailable ${logContext}`.trim());
    return;
  }

  try {
    const sendResult = await sendMessageTelegram(target.to, text, {
      accountId: target.accountId,
      messageThreadId: target.threadId,
      plainText: text,
    });
    api.logger.info(
      `[web-telegram-mirror] ${logPrefix}: to=${target.to} messageId=${sendResult?.messageId || ""} ${logContext}`.trim(),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    api.logger.error(
      `[web-telegram-mirror] ${logPrefix}-failed: to=${target.to} error=${JSON.stringify(message)} ${logContext}`.trim(),
    );
  }
}

export default definePluginEntry({
  id: "web-telegram-mirror",
  name: "Web Telegram Mirror",
  description: "Web -> Telegram mirror with live send support",
  register(api) {
    const cfg = parseConfig(api.pluginConfig);

    api.on("before_dispatch", async (event, ctx) => {
      if (!cfg.enabled) return;
      if (event?.channel !== "webchat") return;

      const senderId = typeof event?.senderId === "string" ? event.senderId : "";
      if (!cfg.senderIds.includes(senderId)) return;

      const sessionKey = typeof event?.sessionKey === "string" ? event.sessionKey : "";
      if (!sessionKey) return;

      setRecentWebSource(sessionKey, cfg.sourceTtlMs);
      api.logger.info(
        `[web-telegram-mirror] source marked: session=${sessionKey} channel=webchat senderId=${senderId}`,
      );

      if (sessionKey !== cfg.mainSessionKey) return;

      const rawUserText = safeText(event?.body) || safeText(event?.content);
      const userText = normalizeMirrorText(rawUserText);
      const skipReason = shouldSkipText(userText, cfg.filters);
      if (skipReason) {
        api.logger.info(
          `[web-telegram-mirror] skip-user: reason=${skipReason} session=${sessionKey}`,
        );
        return;
      }

      const entry = loadSessionStoreEntry(api, sessionKey, undefined);
      const target = resolveTelegramTarget(entry);
      if (!target) {
        api.logger.warn(`[web-telegram-mirror] skip-user: no-telegram-target session=${sessionKey}`);
        return;
      }

      const mirroredUserText = `【Web】${userText}`;
      const dedupeKey = makeDedupeKey(["user", sessionKey, senderId, target.to, mirroredUserText]);
      if (seenDedupe(dedupeKey, cfg.dedupeTtlMs, cfg.dedupeMaxEntries)) {
        api.logger.info(
          `[web-telegram-mirror] skip-user: dedupe-hit session=${sessionKey} to=${target.to}`,
        );
        return;
      }

      api.logger.info(
        `[web-telegram-mirror] decision=user-mirror observeOnly=${String(cfg.observeOnly)} session=${sessionKey} to=${target.to} preview=${JSON.stringify(mirroredUserText.slice(0, 120))}`,
      );

      if (cfg.observeOnly) return;
      await sendMirror(api, target, mirroredUserText, "user-sent", `session=${sessionKey}`);
    });

    api.on("agent_end", async (event, ctx) => {
      if (!cfg.enabled) return;
      if (ctx?.sessionKey !== cfg.mainSessionKey) return;
      if (ctx?.trigger && ctx.trigger !== "user") return;

      const sourceFromCache = hasRecentWebSource(ctx.sessionKey);
      const sourceFromCtx = ctx?.channelId === "webchat" || ctx?.messageProvider === "webchat";
      if (!sourceFromCache && !sourceFromCtx) return;

      const rawAssistantText = extractLastAssistantText(event?.messages);
      const assistantText = normalizeMirrorText(rawAssistantText);
      const skipReason = shouldSkipText(assistantText, cfg.filters);
      if (skipReason) {
        api.logger.info(
          `[web-telegram-mirror] skip: reason=${skipReason} session=${ctx.sessionKey || ""}`,
        );
        return;
      }

      const entry = loadSessionStoreEntry(api, ctx?.sessionKey, ctx?.agentId);
      const target = resolveTelegramTarget(entry);
      if (!target) {
        api.logger.warn(
          `[web-telegram-mirror] skip: no-telegram-target session=${ctx?.sessionKey || ""}`,
        );
        return;
      }

      const dedupeKey = makeDedupeKey([
        "assistant",
        ctx?.sessionKey || "",
        ctx?.sessionId || "",
        target.to,
        assistantText,
      ]);

      if (seenDedupe(dedupeKey, cfg.dedupeTtlMs, cfg.dedupeMaxEntries)) {
        api.logger.info(
          `[web-telegram-mirror] skip: dedupe-hit session=${ctx?.sessionKey || ""} to=${target.to}`,
        );
        return;
      }

      const preview = assistantText.length > 120 ? `${assistantText.slice(0, 120)}...` : assistantText;
      api.logger.info(
        `[web-telegram-mirror] decision=mirror observeOnly=${String(cfg.observeOnly)} session=${ctx?.sessionKey || ""} to=${target.to} accountId=${target.accountId || ""} threadId=${target.threadId ?? ""} targetSource=${target.source} preview=${JSON.stringify(preview)}`,
      );

      if (cfg.observeOnly) return;
      await sendMirror(api, target, assistantText, "sent", `session=${ctx?.sessionKey || ""}`);
    });
  },
});
