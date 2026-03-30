import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const execFileAsync = promisify(execFile);

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
  voice: {
    enabled: true,
    assistantVoiceOnly: true,
    prefix: "【Web】",
    tempDir: join(tmpdir(), "web-telegram-mirror-voice"),
    voice: "zh-CN-XiaoxiaoNeural",
    rate: "+8%",
    pitch: "+12Hz",
    scriptPath: "/home/yusu/.openclaw/workspace/skills/telegram-voice-tts/scripts/telegram_voice.py",
    retainMs: 3600000,
    webLink: {
      enabled: true,
      label: "🔊 苏雨语音",
      host: "0.0.0.0",
      port: 17864,
      routePrefix: "/voice",
      publicBaseUrl: "",
      includeInMessage: true,
      linkTemplate: "[{label}]({url})",
    },
  },
};

const recentSourceBySession = new Map();
const dedupeCache = new Map();
const voiceAssetBySession = new Map();
let voiceHttpServerStarted = false;

function parseConfig(raw) {
  const cfg = raw && typeof raw === "object" ? raw : {};
  const filters = cfg.filters && typeof cfg.filters === "object" ? cfg.filters : {};
  const senderIds = Array.isArray(cfg.senderIds)
    ? cfg.senderIds.filter((v) => typeof v === "string")
    : DEFAULT_CONFIG.senderIds;
  const voice = cfg.voice && typeof cfg.voice === "object" ? cfg.voice : {};
  const webLink = voice.webLink && typeof voice.webLink === "object" ? voice.webLink : {};

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
    voice: {
      enabled: voice.enabled ?? DEFAULT_CONFIG.voice.enabled,
      assistantVoiceOnly: voice.assistantVoiceOnly ?? DEFAULT_CONFIG.voice.assistantVoiceOnly,
      prefix: typeof voice.prefix === "string" ? voice.prefix : DEFAULT_CONFIG.voice.prefix,
      tempDir: typeof voice.tempDir === "string" ? voice.tempDir : DEFAULT_CONFIG.voice.tempDir,
      voice: typeof voice.voice === "string" ? voice.voice : DEFAULT_CONFIG.voice.voice,
      rate: typeof voice.rate === "string" ? voice.rate : DEFAULT_CONFIG.voice.rate,
      pitch: typeof voice.pitch === "string" ? voice.pitch : DEFAULT_CONFIG.voice.pitch,
      scriptPath: typeof voice.scriptPath === "string" ? voice.scriptPath : DEFAULT_CONFIG.voice.scriptPath,
      retainMs: Number(voice.retainMs ?? DEFAULT_CONFIG.voice.retainMs),
      webLink: {
        enabled: webLink.enabled ?? DEFAULT_CONFIG.voice.webLink.enabled,
        label: typeof webLink.label === "string" ? webLink.label : DEFAULT_CONFIG.voice.webLink.label,
        host: typeof webLink.host === "string" ? webLink.host : DEFAULT_CONFIG.voice.webLink.host,
        port: Number(webLink.port ?? DEFAULT_CONFIG.voice.webLink.port),
        routePrefix:
          typeof webLink.routePrefix === "string"
            ? webLink.routePrefix
            : DEFAULT_CONFIG.voice.webLink.routePrefix,
        publicBaseUrl:
          typeof webLink.publicBaseUrl === "string"
            ? webLink.publicBaseUrl
            : DEFAULT_CONFIG.voice.webLink.publicBaseUrl,
        includeInMessage:
          webLink.includeInMessage ?? DEFAULT_CONFIG.voice.webLink.includeInMessage,
        linkTemplate:
          typeof webLink.linkTemplate === "string"
            ? webLink.linkTemplate
            : DEFAULT_CONFIG.voice.webLink.linkTemplate,
      },
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

function stripLeadingTimestamp(text) {
  return text.replace(/^\[[^\]]+\]\s*/m, "");
}

function normalizeMirrorText(text) {
  return stripLeadingTimestamp(stripMarkdownArtifacts(stripReplyTag(text))).replace(/\n{3,}/g, "\n\n").trim();
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

function cleanupFile(filePath) {
  try {
    unlinkSync(filePath);
  } catch {
    // ignore cleanup failures
  }
}

function buildVoiceHash(text) {
  return createHash("sha1").update(text, "utf8").digest("hex");
}

function buildWebLinkBase(cfg) {
  const routePrefix = cfg.voice.webLink.routePrefix || "/voice";
  const normalizedPrefix = routePrefix.startsWith("/") ? routePrefix : `/${routePrefix}`;
  const explicitBase = (cfg.voice.webLink.publicBaseUrl || "").trim();
  if (explicitBase) {
    return `${explicitBase.replace(/\/+$/, "")}${normalizedPrefix}`;
  }
  return `http://127.0.0.1:${cfg.voice.webLink.port}${normalizedPrefix}`;
}

function pruneVoiceFiles(tempDir, retainMs) {
  const now = nowMs();
  let files;
  try {
    files = readdirSync(tempDir);
  } catch {
    return;
  }
  for (const name of files) {
    if (!name.endsWith(".ogg")) continue;
    const fullPath = join(tempDir, name);
    try {
      const st = statSync(fullPath);
      if (!st.isFile()) continue;
      if (now - st.mtimeMs > retainMs) {
        unlinkSync(fullPath);
      }
    } catch {
      // ignore cleanup failures
    }
  }
}

function ensureWebVoiceServer(api, cfg) {
  if (voiceHttpServerStarted) return;
  const routePrefix = (cfg.voice.webLink.routePrefix || "/voice").replace(/\/+$/, "");
  const prefix = routePrefix.startsWith("/") ? routePrefix : `/${routePrefix}`;
  const host = cfg.voice.webLink.host || "0.0.0.0";
  const port = Number(cfg.voice.webLink.port) || 17864;
  mkdirSync(cfg.voice.tempDir, { recursive: true });
  const server = createServer((req, res) => {
    try {
      const rawPath = (req.url || "").split("?", 1)[0] || "/";
      if (!rawPath.startsWith(`${prefix}/`)) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const name = basename(rawPath.slice(prefix.length + 1));
      if (!name || !name.endsWith(".ogg")) {
        res.statusCode = 400;
        res.end("bad request");
        return;
      }
      const filePath = join(cfg.voice.tempDir, name);
      const st = statSync(filePath);
      if (!st.isFile()) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      res.setHeader("Content-Type", "audio/ogg");
      res.setHeader("Cache-Control", "public, max-age=300");
      res.setHeader("Content-Length", String(st.size));
      createReadStream(filePath).pipe(res);
    } catch {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  server.listen(port, host, () => {
    api.logger.info(
      `[web-telegram-mirror] voice-web-server listening host=${host} port=${port} prefix=${prefix}`,
    );
  });
  voiceHttpServerStarted = true;
}

function appendVoiceLinkToMessage(message, linkLine) {
  if (!message || typeof message !== "object" || !linkLine) return message;
  const next = { ...message };
  if (typeof next.content === "string") {
    next.content = `${next.content}\n\n${linkLine}`.trim();
    return next;
  }
  if (Array.isArray(next.content)) {
    const blocks = [...next.content];
    const last = blocks[blocks.length - 1];
    if (last && typeof last === "object" && last.type === "text" && typeof last.text === "string") {
      blocks[blocks.length - 1] = { ...last, text: `${last.text}\n\n${linkLine}`.trim() };
      next.content = blocks;
      return next;
    }
    blocks.push({ type: "text", text: linkLine });
    next.content = blocks;
    return next;
  }
  if (typeof next.text === "string") {
    next.text = `${next.text}\n\n${linkLine}`.trim();
    return next;
  }
  return message;
}

function stripVoiceLinkSuffix(text, cfg) {
  const label = (cfg.voice.webLink.label || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!label) return text;
  const pattern = new RegExp(`\\n?\\s*\\[${label}\\]\\([^\\)]+\\)\\s*$`, "i");
  return text.replace(pattern, "").trim();
}

async function generateVoiceOgg(text, cfg) {
  mkdirSync(cfg.voice.tempDir, { recursive: true });
  pruneVoiceFiles(cfg.voice.tempDir, cfg.voice.retainMs);
  const voiceHash = buildVoiceHash(text);
  const filePath = join(cfg.voice.tempDir, `voice-${voiceHash}.ogg`);
  const env = {
    ...process.env,
    EDGE_TTS_VOICE: cfg.voice.voice,
    EDGE_TTS_RATE: cfg.voice.rate,
    EDGE_TTS_PITCH: cfg.voice.pitch,
  };
  await execFileAsync("python3", [cfg.voice.scriptPath, text, filePath], { env });
  const linkBase = buildWebLinkBase(cfg);
  const mediaUrl = `${linkBase}/${basename(filePath)}`;
  return {
    hash: voiceHash,
    filePath,
    mediaUrl,
    createdAt: nowMs(),
  };
}

async function sendTextMirror(api, target, text, logPrefix, logContext = "") {
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

async function sendVoiceMirror(api, target, mediaPath, cfg, logContext = "") {
  const sendMessageTelegram = getTelegramSender(api);
  if (typeof sendMessageTelegram !== "function") {
    api.logger.warn(`[web-telegram-mirror] skip-voice: telegram-runtime-unavailable ${logContext}`.trim());
    return false;
  }

  try {
    const sendResult = await sendMessageTelegram(target.to, "[[audio_as_voice]]", {
      accountId: target.accountId,
      messageThreadId: target.threadId,
      mediaUrl: mediaPath,
      mediaLocalRoots: [cfg.voice.tempDir, tmpdir(), "/tmp", "/home/yusu/.openclaw/workspace/skills/telegram-voice-tts/scripts"],
      asVoice: true,
      plainText: "",
    });
    api.logger.info(
      `[web-telegram-mirror] voice-sent: to=${target.to} messageId=${sendResult?.messageId || ""} ${logContext}`.trim(),
    );
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    api.logger.error(
      `[web-telegram-mirror] voice-failed: to=${target.to} error=${JSON.stringify(message)} ${logContext}`.trim(),
    );
    return false;
  }
}

export default definePluginEntry({
  id: "web-telegram-mirror",
  name: "Web Telegram Mirror",
  description: "Web -> Telegram mirror with live send support",
  register(api) {
    const cfg = parseConfig(api.pluginConfig);
    if (cfg.voice.enabled && cfg.voice.webLink.enabled) {
      ensureWebVoiceServer(api, cfg);
    }

    api.on("llm_output", async (event, ctx) => {
      if (!cfg.enabled) return;
      if (!cfg.voice.enabled || !cfg.voice.webLink.enabled || !cfg.voice.webLink.includeInMessage) return;
      if (ctx?.sessionKey !== cfg.mainSessionKey) return;
      if (!hasRecentWebSource(ctx.sessionKey)) return;
      const assistantText = normalizeMirrorText(safeText(Array.isArray(event?.assistantTexts) ? event.assistantTexts[event.assistantTexts.length - 1] : ""));
      if (!assistantText) return;
      const voiceHash = buildVoiceHash(assistantText);
      const preparedFromCache = voiceAssetBySession.get(ctx.sessionKey);
      if (preparedFromCache && preparedFromCache.hash === voiceHash) return;
      const prepared = await generateVoiceOgg(assistantText, cfg);
      voiceAssetBySession.set(ctx.sessionKey, prepared);
    });

    api.on("before_message_write", (event, ctx) => {
      if (!cfg.enabled) return;
      if (!cfg.voice.enabled || !cfg.voice.webLink.enabled || !cfg.voice.webLink.includeInMessage) return;
      if (ctx?.sessionKey !== cfg.mainSessionKey) return;
      if (!hasRecentWebSource(ctx.sessionKey)) return;
      const msg = event?.message;
      if (!msg || msg.role !== "assistant") return;
      const assistantText = normalizeMirrorText(safeText(extractTextFromContent(msg.content)));
      if (!assistantText) return;
      const expectedHash = buildVoiceHash(assistantText);
      const prepared = voiceAssetBySession.get(ctx.sessionKey);
      if (!prepared || prepared.hash !== expectedHash) {
        return;
      }
      const linkLine = cfg.voice.webLink.linkTemplate
        .replace("{label}", cfg.voice.webLink.label)
        .replace("{url}", prepared.mediaUrl);
      const patchedMessage = appendVoiceLinkToMessage(msg, linkLine);
      if (patchedMessage === msg) return;
      return { message: patchedMessage };
    });

    api.on("before_dispatch", async (event) => {
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
        api.logger.info(`[web-telegram-mirror] skip-user: reason=${skipReason} session=${sessionKey}`);
        return;
      }

      const entry = loadSessionStoreEntry(api, sessionKey, undefined);
      const target = resolveTelegramTarget(entry);
      if (!target) {
        api.logger.warn(`[web-telegram-mirror] skip-user: no-telegram-target session=${sessionKey}`);
        return;
      }

      const mirroredUserText = `${cfg.voice.prefix}${userText}`;
      const dedupeKey = makeDedupeKey(["user", sessionKey, senderId, target.to, mirroredUserText]);
      if (seenDedupe(dedupeKey, cfg.dedupeTtlMs, cfg.dedupeMaxEntries)) {
        api.logger.info(`[web-telegram-mirror] skip-user: dedupe-hit session=${sessionKey} to=${target.to}`);
        return;
      }

      api.logger.info(
        `[web-telegram-mirror] decision=user-mirror observeOnly=${String(cfg.observeOnly)} session=${sessionKey} to=${target.to} preview=${JSON.stringify(mirroredUserText.slice(0, 120))}`,
      );

      if (cfg.observeOnly) return;
      await sendTextMirror(api, target, mirroredUserText, "user-sent", `session=${sessionKey}`);
    });

    api.on("agent_end", async (event, ctx) => {
      if (!cfg.enabled) return;
      if (ctx?.sessionKey !== cfg.mainSessionKey) return;
      if (ctx?.trigger && ctx.trigger !== "user") return;

      const sourceFromCache = hasRecentWebSource(ctx.sessionKey);
      const sourceFromCtx = ctx?.channelId === "webchat" || ctx?.messageProvider === "webchat";
      if (!sourceFromCache && !sourceFromCtx) return;

      const rawAssistantText = extractLastAssistantText(event?.messages);
      const assistantText = stripVoiceLinkSuffix(normalizeMirrorText(rawAssistantText), cfg);
      const skipReason = shouldSkipText(assistantText, cfg.filters);
      if (skipReason) {
        api.logger.info(`[web-telegram-mirror] skip: reason=${skipReason} session=${ctx.sessionKey || ""}`);
        return;
      }

      const entry = loadSessionStoreEntry(api, ctx?.sessionKey, ctx?.agentId);
      const target = resolveTelegramTarget(entry);
      if (!target) {
        api.logger.warn(`[web-telegram-mirror] skip: no-telegram-target session=${ctx?.sessionKey || ""}`);
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
        api.logger.info(`[web-telegram-mirror] skip: dedupe-hit session=${ctx?.sessionKey || ""} to=${target.to}`);
        return;
      }

      const preview = assistantText.length > 120 ? `${assistantText.slice(0, 120)}...` : assistantText;
      api.logger.info(
        `[web-telegram-mirror] decision=mirror observeOnly=${String(cfg.observeOnly)} session=${ctx?.sessionKey || ""} to=${target.to} accountId=${target.accountId || ""} threadId=${target.threadId ?? ""} targetSource=${target.source} preview=${JSON.stringify(preview)}`,
      );

      if (cfg.observeOnly) return;

      let voiceOk = false;
      if (cfg.voice.enabled && cfg.voice.assistantVoiceOnly) {
        let preparedVoice = voiceAssetBySession.get(ctx.sessionKey);
        if (!preparedVoice || preparedVoice.hash !== buildVoiceHash(assistantText)) {
          preparedVoice = await generateVoiceOgg(assistantText, cfg);
          voiceAssetBySession.set(ctx.sessionKey, preparedVoice);
        }
        voiceOk = await sendVoiceMirror(
          api,
          target,
          preparedVoice.filePath,
          cfg,
          `session=${ctx?.sessionKey || ""}`,
        );
      }

      await sendTextMirror(api, target, assistantText, voiceOk ? "sent-text-after-voice" : "sent", `session=${ctx?.sessionKey || ""}`);
    });
  },
});
