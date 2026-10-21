/**
 * Qoder 直连客户端（无 SDK、无 CLI、无代理进程）
 *
 *   messages ──> baseprompt 骨架 ──> qoder_encode ──> COSY 头 ──> SSE
 *
 * 骨架来自官方 baseprompt.json；签名/编码见 qoder-sign.mjs。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CosySession, qoderEncode } from './qoder-sign.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = JSON.parse(fs.readFileSync(path.join(__dirname, 'baseprompt.json'), 'utf8'));

/**
 * 双区端点。
 *
 * CN   ：推理 gateway.qoder.com.cn，账号 openapi.qoder.com.cn，PAT → jobToken
 * INTL ：推理 api1.qoder.sh（api2/api3 是候选，实测 api2 常连不上），
 *        账号 openapi.qoder.sh，**OAuth dt- 直接用**，不需要换 jobToken
 */
const REALMS = {
  cn: { gateway: 'gateway.qoder.com.cn', openapi: 'openapi.qoder.com.cn', ua: 'QoderWork/1.1.64' },
  intl: { gateway: 'api1.qoder.sh', openapi: 'openapi.qoder.sh', ua: 'Qoder/1.1.64' },
};

export function realmConfig(realm) {
  return REALMS[realm] ?? REALMS.cn;
}

const PATH_SSE = '/algo/api/v2/service/pro/sse/agent_chat_generation';
const QUERY = '?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1';

/** jobToken 24 小时有效；提前 5 分钟刷新。 */
const TOKEN_TTL_MS = 23.9 * 3600 * 1000;
/** credential → identity 缓存。多账号时按凭证分开存，互不覆盖。 */
const identityCache = new Map();

/**
 * 把账号凭证解析成 COSY 需要的身份。
 *
 * - `pt-…`（PAT）：换 jobToken，再拉 userinfo
 * - `dt-…`（OAuth）：直接就是 access token，跳过交换（国际版走这条路）
 *
 * COSY identity 必须带 refresh_token：漏了会得到
 * 403 {"code":"105","message":"Login expired"}，和真的过期长得一模一样。
 */
export async function ensureIdentity(credential, { force = false, realm, refreshToken, uid, nickname } = {}) {
  const cacheKey = `${realm ?? 'cn'}::${credential}`;
  const cached = identityCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.at < TOKEN_TTL_MS) return cached;

  const cfg = realmConfig(realm);
  const isOauth = String(credential).startsWith('dt-');

  if (isOauth) {
    // OAuth：access token 已经是最终凭证，只需补齐身份信息
    let info = {};
    if (!uid) {
      try {
        const r = await fetch(`https://${cfg.openapi}/api/v1/userinfo`, {
          headers: { accept: 'application/json', 'user-agent': cfg.ua, authorization: `Bearer ${credential}` },
        });
        if (r.ok) info = await r.json();
      } catch {
        /* 身份拿不到就用缓存/空值，COSY 仍可签名 */
      }
    }
    const entry = {
      token: credential,
      refreshToken: refreshToken ?? cached?.refreshToken ?? '',
      uid: uid ?? info.id ?? cached?.uid ?? '',
      nickname: nickname ?? info.name ?? cached?.nickname ?? '',
      userType: info.user_type || cached?.userType || 'personal_professional_trial',
      orgId: info.organization_id ?? '',
      orgName: info.organization_name ?? '',
      at: Date.now(),
    };
    identityCache.set(cacheKey, entry);
    return entry;
  }

  const ex = await fetch(`https://${cfg.openapi}/api/v1/jobToken/exchange`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': cfg.ua,
    },
    body: JSON.stringify({ personal_token: credential }),
  });
  if (!ex.ok) throw new Error(`jobToken exchange ${ex.status}: ${(await ex.text()).slice(0, 200)}`);
  const exJson = await ex.json();
  if (!exJson.token) throw new Error('jobToken exchange returned no token');

  let info = {};
  try {
    const r = await fetch(`https://${cfg.openapi}/api/v1/userinfo`, {
      headers: { accept: 'application/json', 'user-agent': cfg.ua, authorization: `Bearer ${exJson.token}` },
    });
    if (r.ok) info = await r.json();
  } catch {
    /* 身份信息可用上一次缓存兜底 */
  }

  const entry = {
    token: exJson.token,
    refreshToken: exJson.refresh_token ?? '',
    uid: info.id ?? cached?.uid ?? '',
    nickname: info.name ?? cached?.nickname ?? '',
    userType: info.user_type || 'personal_professional_trial',
    orgId: info.organization_id ?? '',
    orgName: info.organization_name ?? '',
    at: Date.now(),
  };
  identityCache.set(cacheKey, entry);
  return entry;
}

/** 上游拒绝（Token 失效）时清该账号的缓存，下次请求重新交换。 */
export function invalidateIdentity(credential, realm) {
  if (credential === undefined) {
    identityCache.clear();
    accountCache.clear();
  } else identityCache.delete(`${realm ?? 'cn'}::${credential}`);
}

/**
 * OAuth access token 刷新：`drt-` → 新的 `dt-`。
 *
 * 端点：`POST {openapi}/api/v1/deviceToken/refresh`，body `{ refresh_token }`。
 * **响应字段是 `device_token`，不是 `token`** —— 按 token 取会永远拿到 undefined，
 * 表现为「刷新永远失败但现有 token 还能用」。
 *
 * 每次刷新都会**换发新的 refresh_token**，旧的随即作废，调用方必须回写账号池，
 * 否则进程重启后直接登录过期。
 */
export async function refreshDeviceToken(refreshToken, realm) {
  if (!refreshToken) return null;
  const cfg = realmConfig(realm);
  try {
    const res = await fetch(`https://${cfg.openapi}/api/v1/deviceToken/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': cfg.ua },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const token = j?.device_token ?? j?.token ?? j?.access_token;
    if (!token) return null;
    return {
      credential: token,
      refreshToken: j.refresh_token ?? refreshToken,
      expiresAt: j.expires_at ?? j.expiresAt ?? null,
    };
  } catch {
    return null;
  }
}

/** 按账号 id 缓存已解析的身份（凭证会轮换，不能拿凭证当 key）。 */
const accountCache = new Map();
/** 提前多久刷新：5 分钟。 */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

function expiresAtMs(account, fallbackMs) {
  const t = account.expiresAt ? Date.parse(account.expiresAt) : NaN;
  return Number.isFinite(t) ? t : Date.now() + fallbackMs;
}

/**
 * 解析一个账号的身份，需要时自动刷新。
 *
 * 优先级：
 *   1. 缓存还有效 → 直接用
 *   2. OAuth（dt- 且带 drt-）→ 换新 access token 并回写池
 *   3. PAT（pt-）→ 换 jobToken（24h）
 *   4. 兜底 → 用现有凭证直接签
 */
export async function resolveAccount(account, { force = false, updateCredential } = {}) {
  const cached = accountCache.get(account.id);
  // 缓存必须绑定到「当前这份凭证」：账号池里的 credential 会被刷新轮换，
  // 只按 account.id 复用缓存会拿旧 token 去签名，上游回 403 Login expired。
  if (
    !force &&
    cached &&
    cached.sourceCredential === account.credential &&
    cached.expiresAtMs - Date.now() > REFRESH_MARGIN_MS
  ) {
    return cached;
  }

  const isOauth = String(account.credential).startsWith('dt-');
  const isPat = String(account.credential).startsWith('pt-');

  // OAuth：有 refresh token 就续期
  if (isOauth && account.refreshToken) {
    const refreshed = await refreshDeviceToken(account.refreshToken, account.realm);
    if (refreshed) {
      updateCredential?.(account.id, refreshed);
      // 就地更新调用方手里的 account：否则同一个对象下一次进函数时
      // credential 还是旧的，缓存 key 对不上、refresh_token 又已轮换，
      // 只能拿过期 token 去签名 —— 表现就是「短请求好使、长请求 403」。
      account.credential = refreshed.credential;
      if (refreshed.refreshToken) account.refreshToken = refreshed.refreshToken;
      if (refreshed.expiresAt) account.expiresAt = refreshed.expiresAt;
      const id = await ensureIdentity(refreshed.credential, {
        force: true,
        realm: account.realm,
        refreshToken: refreshed.refreshToken,
        uid: account.uid,
        nickname: account.nickname,
      });
      const entry = {
        ...id,
        sourceCredential: refreshed.credential,
        expiresAtMs: expiresAtMs({ expiresAt: refreshed.expiresAt }, 30 * 24 * 3600 * 1000),
      };
      accountCache.set(account.id, entry);
      return entry;
    }
    /* 刷新失败就退回用现有 token，它可能还没真的过期 */
  }

  const id = await ensureIdentity(account.credential, {
    force,
    realm: account.realm,
    refreshToken: account.refreshToken,
    uid: account.uid,
    nickname: account.nickname,
  });
  // PAT 换来的 jobToken 是 24 小时；OAuth 沿用池里记的到期时间
  const span = isPat ? 24 * 3600 * 1000 : 30 * 24 * 3600 * 1000;
  const entry = { ...id, sourceCredential: account.credential, expiresAtMs: expiresAtMs(account, span) };
  accountCache.set(account.id, entry);
  return entry;
}

/** 对外模型名 → 上游 model_config.key（取自 /v1/models 的 upstream_key）。 */
export const MODEL_KEYS = {
  'Qwen3.8-Flash': 'qfmodel',
  'Qwen3.8-Max': 'qmodel_38max',
  'Qwen3.7-Plus': 'qmodel',
  'DeepSeek-V4-Pro': 'dmodel',
  'DeepSeek-Flash': 'dfmodel',
  'GLM-5.3': 'gmodel',
  'GLM-5.3-Flash': 'gfmodel',
  'Kimi-K3': 'kmodel_latest',
  'Kimi-K2.8-Preview': 'kmodel',
  'MiniMax-M3.1-Flash': 'mmodel',
  Auto: 'auto',
  Fast: 'fast',
};

/** baseprompt 里的 14 个官方工具名，用于判断模型是否支持结构化工具。 */
const TOOL_MODELS = new Set(['qfmodel', 'qmodel', 'qmodel_38max', 'dmodel', 'dfmodel', 'gmodel', 'gfmodel']);

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => (p && p.type === 'text' && typeof p.text === 'string' ? p.text : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * Harness messages → 上游 OpenAI 形态。
 *
 * 关键：assistant 的 `tool-call` 块必须转成 `tool_calls`，`role:'tool'` 消息必须转成
 * `{role:'tool', tool_call_id}`。少了这两步，工具执行完的回传会丢上下文，
 * 模型只能看到「用户说了句话」而看不到自己调用过什么。
 */
function toWireMessages(messages) {
  // ── 第一遍：算出「既发起过、也有结果」的 tool_call_id ──
  // 上游要求 assistant.tool_calls 里的每个 id 都有配对的 role:'tool' 消息，
  // 否则整条请求 400：An assistant message with 'tool_calls' must be followed
  // by tool messages responding to each 'tool_call_id'。
  // DSH 的历史里常见「调用了但没结果」（并行调用只跑了一部分、被拒绝、被中断），
  // 也存在「有结果但没发起」（历史被裁剪过）。两者都会让上游直接 400。
  const issued = new Set();
  for (const m of messages) {
    if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b && b.type === 'tool-call' && b.id) issued.add(String(b.id));
    }
  }
  const answered = new Set();
  for (const m of messages) {
    if (m?.role !== 'tool') continue;
    const callId = String(m.toolCallId ?? m.source?.callId ?? '');
    if (callId.length > 0 && issued.has(callId)) answered.add(callId);
  }

  const out = [];
  for (const m of messages) {
    if (!m || m.role === 'system' || m.role === 'developer') continue;

    if (m.role === 'tool') {
      const callId = m.toolCallId ?? m.source?.callId ?? '';
      // 孤儿 tool 消息（没有对应的 assistant.tool_calls）同样会被上游拒绝
      if (!answered.has(String(callId))) continue;
      out.push({ role: 'tool', tool_call_id: String(callId), content: textOf(m.content) });
      continue;
    }

    const blocks = Array.isArray(m.content) ? m.content : [];
    // content 已经是上游形态（字符串或含 image_url 的 parts 数组）时原样透传，
    // 这样图片不会在适配器和客户端之间被压成文本。
    const raw = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content : '';
    const isParts = Array.isArray(raw) && raw.some((p) => p && p.type === 'image_url');
    const content = isParts ? raw : textOf(m.content).trim();
    const hasText = typeof content === 'string' ? content.length > 0 : true;
    // 只保留「有答复」的工具调用；其余整条丢弃，否则上游直接 400
    const calls = blocks.filter((b) => b && b.type === 'tool-call' && answered.has(String(b.id ?? '')));

    if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: typeof content === 'string' ? content : textOf(m.content).trim() };
      if (calls.length > 0) {
        msg.tool_calls = calls.map((b) => ({
          id: String(b.id ?? ''),
          type: 'function',
          function: {
            name: String(b.name ?? ''),
            arguments: typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments ?? {}),
          },
        }));
      }
      if (hasText || calls.length > 0) out.push(msg);
      continue;
    }

    if (hasText) out.push({ role: 'user', content });
  }
  return out;
}

/** 构造上游请求体（baseprompt 骨架 + 覆盖会话/模型/参数）。 */
export function buildBody({ messages = [], model = 'DeepSeek-Flash', tools, maxTokens, reasoningEffort }) {
  const body = JSON.parse(JSON.stringify(TEMPLATE));
  const modelKey = MODEL_KEYS[model] ?? 'dfmodel';

  const sys = messages.filter((m) => m.role === 'system' || m.role === 'developer').map((m) => textOf(m.content)).join('\n\n');
  const turns = toWireMessages(messages);

  body.messages = [];
  if (sys.length > 0) body.messages.push({ role: 'system', content: sys });
  body.messages.push(...turns);

  // Harness 的工具定义 {name, description, parameters} → 上游的 OpenAI function 形态。
  // 注意：上游只接受 function 类型；没有工具时保留模板自带的官方工具集会让模型
  // 调用我们执行不了的工具，所以显式传空数组时也要真的清空。
  //
  // 关键：没传 tools 时必须清空，不能沿用模板自带的 14 个官方工具
  // （Bash / Edit / Read / Glob / Grep / WebSearch …）。那些工具的 description
  // 里带有行为约束，模型会以为「我能跑命令」，进而按那套行为习惯作答。
  body.tools = Array.isArray(tools)
    ? tools
        .filter((t) => t && typeof t.name === 'string' && t.name.length > 0)
        .map((t) => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description ?? '',
            parameters: t.parameters ?? { type: 'object', properties: {} },
          },
        }))
    : [];

  const nid = crypto.randomUUID();
  body.request_id = nid;
  body.chat_record_id = nid;
  body.request_set_id = crypto.randomUUID();
  body.session_id = crypto.randomUUID();
  body.stream = true;
  body.agent_id = 'agent_common';
  body.aliyun_user_type = 'personal_professional_trial';

  body.model_config = {
    ...body.model_config,
    key: modelKey,
    display_name: model,
    model: '',
    format: 'openai',
    is_vl: false,
    is_reasoning: TOOL_MODELS.has(modelKey),
    api_key: '',
    url: '',
    source: 'system',
    max_input_tokens: 180000,
  };

  const lastUser = [...turns].reverse().find((m) => m.role === 'user');
  const prompt = lastUser?.content ?? '';
  const cc = body.chat_context ?? {};
  cc.text = { ...(cc.text ?? {}), text: prompt };
  const extra = cc.extra ?? {};
  extra.originalContent = { ...(extra.originalContent ?? {}), text: prompt };
  extra.modelConfig = { ...body.model_config };
  cc.extra = extra;
  body.chat_context = cc;
  body.chat_prompt = '';

  if (maxTokens) body.parameters = { ...(body.parameters ?? {}), max_tokens: Number(maxTokens) };
  if (reasoningEffort) body.parameters = { ...(body.parameters ?? {}), reasoning_effort: String(reasoningEffort) };

  body.business = {
    ...body.business,
    id: crypto.randomUUID(),
    name: prompt.slice(0, 60) || 'untitled',
    begin_at: Date.now(),
    stage: 'start',
  };

  return { body, modelKey };
}

/** 可中断的等待，用于排队重试。 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/**
 * 从排队响应里挖出排队信息。
 *
 * 上游把 JSON 套了三层字符串：
 *   {"code":"403","message":"{\"code\":\"10605\",\"message\":\"{\\\"isQueued\\\":true,…}"}
 * 逐层 parse 直到找到 isQueued，找不到就当普通错误。
 */
function parseQueueInfo(text, depth = 0) {
  if (depth > 5 || typeof text !== 'string' || text.length === 0) return undefined;
  let obj;
  try {
    obj = JSON.parse(text.replace(/^data:\s*/, '').split('\n')[0]);
  } catch {
    return undefined;
  }
  if (!obj || typeof obj !== 'object') return undefined;
  if (obj.isQueued === true) return obj;
  if (typeof obj.message === 'string') {
    const inner = parseQueueInfo(obj.message, depth + 1);
    if (inner) return inner;
  }
  if (typeof obj.body === 'string') {
    const inner = parseQueueInfo(obj.body, depth + 1);
    if (inner) return inner;
  }
  return undefined;
}

/**
 * 发一次流式请求。yield 内层 OpenAI 形态的 chunk（已解 SSE 信封）。
 *
 * 传 `account`（池里的账号对象）时，凭证续期由 {@link resolveAccount} 负责：
 * OAuth 用 `drt-` 换新 `dt-` 并回写池，PAT 换 jobToken。
 * 也可以传扁平的 `credential` / `realm` / `refreshToken`（低层调用、测试用）。
 *
 * `bodyOverride(body)` 用来改写请求体，比如把 `model_config.max_input_tokens`
 * 提到 400K / 1M（上游目录的 context_config 支持，默认 200K）。
 */
export async function* streamChat({
  messages,
  model,
  tools,
  maxTokens,
  reasoningEffort,
  account,
  updateCredential,
  bodyOverride,
  credential,
  realm,
  refreshToken,
  uid,
  nickname,
  signal,
}) {
  const id = account
    ? await resolveAccount(account, { updateCredential })
    : await ensureIdentity(credential, { realm, refreshToken, uid, nickname });
  const targetRealm = account?.realm ?? realm;
  const built = buildBody({ messages, model, tools, maxTokens, reasoningEffort });
  let { body } = built;
  const { modelKey } = built;
  // 允许调用方改写请求体（例如调 max_input_tokens 扩上下文窗口）
  if (typeof bodyOverride === 'function') body = bodyOverride(body) ?? body;
  const encoded = qoderEncode(Buffer.from(JSON.stringify(body), 'utf8'));
  const url = `https://${realmConfig(targetRealm).gateway}${PATH_SSE}${QUERY}`;

  /**
   * 排队是正常状态，不是错误。
   *
   * 免费账号在 `queueType: "p3"` 队列里。上游两种回应方式：
   *   - HTTP 200，但 **SSE 信封里** statusCodeValue=403 且 body 嵌 `{"isQueued":true,"retryAfterSeconds":N}`
   *   - 直接挂住连接，等排到了再吐 token
   * 关键是第一种：HTTP 层完全成功，不看信封就会把它当成 "envelope 403" 直接失败。
   * 排队期间还没有 yield 任何 chunk，所以可以安全地重来。
   */
  const MAX_QUEUE_RETRIES = 6;

  async function* streamOnce() {
    // 每次尝试都重新签名：COSY 的 datetime 有时效窗口
    const session = new CosySession({
      uid: id.uid,
      nickname: id.nickname,
      accessToken: id.token,
      refreshToken: id.refreshToken,
      userType: id.userType,
      orgId: id.orgId,
      orgName: id.orgName,
    });
    const headers = { ...session.headers(encoded, url, { modelKey }) };
    const res = await fetch(url, { method: 'POST', headers, body: encoded, signal });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const queue = parseQueueInfo(text);
      if (queue?.isQueued) throw queueError(queue);
      if (res.status === 401) invalidateIdentity(credential ?? account?.credential, targetRealm);
      throw new Error(`upstream ${res.status}: ${text.slice(0, 300)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === '[DONE]') return;

        let env;
        try {
          env = JSON.parse(payload);
        } catch {
          continue;
        }
        // SSE 信封：{"headers","body","statusCodeValue"}
        const status = Number(env.statusCodeValue ?? env.status_code ?? 200);
        if (status !== 200) {
          const raw = typeof env.body === 'string' ? env.body : JSON.stringify(env.body ?? '');
          const queue = parseQueueInfo(raw);
          if (queue?.isQueued) {
            reader.cancel().catch(() => {});
            throw queueError(queue);
          }
          if (status === 401 || status === 403) invalidateIdentity(credential ?? account?.credential, targetRealm);
          throw new Error(`envelope ${status}: ${raw.slice(0, 300)}`);
        }
        const inner = typeof env.body === 'string' ? env.body : JSON.stringify(env.body ?? '');
        if (!inner) continue;
        let chunk;
        try {
          chunk = JSON.parse(inner);
        } catch {
          continue;
        }
        yield chunk;
      }
    }
  }

  for (let attempt = 0; attempt <= MAX_QUEUE_RETRIES; attempt += 1) {
    let emitted = false;
    try {
      for await (const chunk of streamOnce()) {
        emitted = true;
        yield chunk;
      }
      return;
    } catch (error) {
      // 只有「还没吐任何内容 + 确实是排队」才重试
      if (error?.isQueue && !emitted && attempt < MAX_QUEUE_RETRIES) {
        const seconds = Math.min(Math.max(Number(error.queue?.retryAfterSeconds) || 3, 1), 30);
        await sleep(seconds * 1000, signal);
        continue;
      }
      if (error?.isQueue) {
        throw new Error(
          `Qoder 排队超时（重试 ${attempt} 次仍被排队，队列 ${error.queue?.queueType ?? '?'}，` +
            `队列长度 ${error.queue?.queueCount ?? '?'}）。这是免费账号的排队机制，稍后再试或换账号。`,
        );
      }
      throw error;
    }
  }
}

/** 把排队信息包成一个可识别的错误。 */
function queueError(queue) {
  const error = new Error('queued');
  error.isQueue = true;
  error.queue = queue;
  return error;
}
