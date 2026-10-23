#!/usr/bin/env node
/**
 * opencode-go-session-bridge — 本地轻量桥接代理：为 coding agent 补齐 x-opencode-session，透明转发 OpenCode Go
 *
 * 作用：
 *   1. 把发往本地的请求转发到 https://opencode.ai/zen/go/v1/*（白名单，仅此上游）。
 *   2. 补齐上游强制的会话头 x-opencode-session（策略见 sessionFor()）。
 *   3. 全程流式透传（支持 SSE stream:true），不改写响应体与事件顺序。
 *   4. 错误状态码原样透传；代理自身不重试。
 *
 * 安全约束：
 *   - 只监听 127.0.0.1（回环），拒绝其他绑定地址。
 *   - 不存储、不读取、不打印 API Key；Authorization 原样转发。
 *   - 日志默认脱敏；不记录请求体内容（capture 模式也只记结构与头部名）。
 *
 * 运行（零第三方依赖，Node >= 18，建议 22）：
 *   node proxy.mjs --port 14731 [--capture] [--no-inject]
 *
 * 环境变量：
 *   OPENCODE_GO_PROXY_PORT   监听端口（默认 14731）
 *   OPENCODE_GO_PROXY_CAPTURE=1   开启脱敏观测日志 capture.jsonl
 *   OPENCODE_GO_PROXY_NO_INJECT=1 控制组：不注入会话头（仅用于 A/B 验证）
 *   OPENCODE_GO_PROXY_HOME  数据目录（session-secret.key / capture.jsonl），默认与脚本同目录。
 *                           launchd 等对 ~/Documents 无 TCC 授权的环境必须指向保护范围外的目录，
 *                           否则第一个 fs.open 会无限挂起（2026-10-12 实测）。
 */

import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------- 参数 ----------
const HERE = path.dirname(fileURLToPath(import.meta.url));
// 数据目录可用 OPENCODE_GO_PROXY_HOME 覆盖：launchd 直接拉起的裸进程对 ~/Documents 无 TCC 授权，
// 第一个 fs.open 会无限挂起（2026-10-12 实测）；托管模式必须指向非 TCC 保护目录。
const DATA_DIR = process.env.OPENCODE_GO_PROXY_HOME ? path.resolve(process.env.OPENCODE_GO_PROXY_HOME) : HERE;
if (DATA_DIR !== HERE) { try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* 让后续写入报错暴露 */ } }
const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return (i !== -1 && args[i + 1] && !args[i + 1].startsWith('--')) ? args[i + 1] : undefined;
}
const PORT = Number(process.env.OPENCODE_GO_PROXY_PORT || argValue('--port') || 14731);
const CAPTURE = process.env.OPENCODE_GO_PROXY_CAPTURE === '1' || args.includes('--capture');
const NO_INJECT = process.env.OPENCODE_GO_PROXY_NO_INJECT === '1' || args.includes('--no-inject');
const UPSTREAM_ORIGIN = 'https://opencode.ai';       // 白名单上游：仅此主机
const UPSTREAM_BASEPATH = '/zen/go';                 // 仅此前缀
const SESSION_HEADER = 'x-opencode-session';
const USER_AGENT = 'opencode-go-session-bridge/0.0.1 (local loopback; +https://opencode.ai/docs/go/)';
const CLIENT_HEADER_VALUE = 'opencode-go-session-bridge/0.0.1';
const MODEL_ALIAS_PREFIX = 'proxy-';      // Trae 别名前缀：与官方预设重名的模型会被 Trae 云端劫走，客户端填 proxy-<真实模型名>，代理剥前缀还原后发上游
const UUID_PREFIX_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//i;  // Copilot 等给模型加的 <uuid>/ 前缀

/**
 * 规范化模型名：剥离客户端装饰前缀，还原上游真实模型 ID。
 * 已知两类：proxy-<真实名>（Trae 别名，防重名劫持）；<uuid>/<真实名>（Copilot 等的 provider 前缀）。
 * 无前缀时原样返回。用于转发、日志、会话派生统一使用规范化后的真实 ID。
 */
function normalizeModelId(model) {
  if (typeof model !== 'string' || !model) return model;
  if (model.startsWith(MODEL_ALIAS_PREFIX)) {
    const stripped = model.slice(MODEL_ALIAS_PREFIX.length);
    if (stripped) return stripped;
  }
  if (UUID_PREFIX_RE.test(model)) return model.replace(UUID_PREFIX_RE, '');
  return model;
}

if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
  console.error(`[fatal] 非法端口: ${PORT}`);
  process.exit(1);
}

// ---------- 本地会话派生密钥（非上游凭据，仅用于 HMAC，保证重启后映射稳定） ----------
const SECRET_FILE = path.join(DATA_DIR, 'session-secret.key');
function loadSecret() {
  try {
    const s = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(s)) return s;
  } catch { /* 首次运行 */ }
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_FILE, s + '\n', { mode: 0o600 });
  return s;
}
const HMAC_SECRET = loadSecret();

/**
 * 会话标识来源判定（优先级从高到低）：
 *   A. 客户端已带 x-opencode-session      → 原样透传（不做任何改写）
 *   B. 请求带其他稳定会话信号             → HMAC(信号|model)，确定性派生
 *      候选信号：X-Session-Id、vscode-sessionid（VS Code 窗口级稳定标识）
 *   C. 信号缺失                           → 用 body 内稳定字段（user / metadata.*）做 HMAC 派生
 *   D. 全部缺失（退路）                   → HMAC("<unknown-window>"|model)
 *      局限：同一 VS Code 窗口内不同对话将共享同一会话 ID——
 *      会话隔离弱于对话级，但保持“同对话同值、跨窗口不同值”。
 *      该局限将在 README 与最终报告中如实记录，除非 capture 观测找到对话级信号。
 */
function sessionFor(headers, bodyMeta) {
  const client = headers[SESSION_HEADER];
  if (client && typeof client === 'string' && client.trim()) {
    return { value: client.trim(), source: 'A:client-provided' };
  }
  // 实测证据（2026-10-10 capture）：VS Code 1.140 会发送 x-interaction-id，
  // 且其值随「新开对话」变化（27879c… vs 5af37…）、同对话重试链内恒定 —— 对话级稳定标识。
  const alt = headers['x-interaction-id'] || headers['x-session-id'] || headers['vscode-sessionid'] || null;
  if (alt) {
    return { value: derive(`${alt}|${bodyMeta.model || '*'}`), source: 'B:conversation-header' };
  }
  if (bodyMeta.conversationSignal) {
    return { value: derive(`${bodyMeta.conversationSignal}|${bodyMeta.model || '*'}`), source: 'C:body-signal' };
  }
  return { value: derive(`<unknown-window>|${bodyMeta.model || '*'}`), source: 'D:window-fallback' };
}
function derive(sourceKey) {
  const h = crypto.createHmac('sha256', HMAC_SECRET).update(sourceKey).digest('hex');
  return `vsc-${h.slice(0, 32)}`;
}

// ---------- 日志 ----------
const L = {
  info: (...m) => console.log(new Date().toISOString(), ...m),
  cap: null,
};
if (CAPTURE) {
  const capFile = path.join(DATA_DIR, 'capture.jsonl');
  L.cap = (obj) => fs.appendFileSync(capFile, JSON.stringify(obj) + '\n');
  L.info(`[capture] 观测日志 -> ${capFile}（仅头部名/路径/模型/结构，无 Key、无对话内容）`);
}
const hash12 = (v) => (v ? crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 12) : '');
const REDACTED_HEADERS = new Set([
  'authorization', 'api-key', 'x-api-key', 'cookie', 'proxy-authorization', 'x-opencode-session',
]);

// hop-by-hop 与不得转发的头
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'host', 'content-length',
]);

function readBody(req, limitBytes = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 从 JSON 体中提取非内容性元数据（仅允许的字段；失败则返回 unknown） */
function bodyMetaOf(rawBody, contentType) {
  const meta = { model: '*', stream: null, conversationSignal: null, shape: 'unknown', images: 0, tools: 0, bytes: rawBody.length };
  if (!rawBody.length) return meta;
  if (!/application\/json/i.test(contentType || '')) { meta.shape = 'non-json'; return meta; }
  try {
    const b = JSON.parse(rawBody.toString('utf8'));
    meta.shape = 'json';
    meta.model = typeof b.model === 'string' ? b.model : '*';
    meta.stream = typeof b.stream === 'boolean' ? b.stream : null;
    const signals = [
      b.user,
      b.metadata?.conversation_id, b.metadata?.sessionId, b.metadata?.session_id,
      b.session_id, b.metadata?.thread_id,
    ].find((v) => typeof v === 'string' && v.length > 0);
    meta.conversationSignal = signals || null;
    if (Array.isArray(b.messages)) {
      meta.images = b.messages.reduce((n, m) => {
        if (Array.isArray(m?.content)) n += m.content.filter((p) => p?.type === 'image_url' || p?.type === 'image').length;
        return n;
      }, 0);
    }
    meta.tools = Array.isArray(b.tools) ? b.tools.length : 0;
  } catch { meta.shape = 'invalid-json'; }
  return meta;
}

// ---------- Responses API 兼容层 ----------
// Codex 2026 只支持 wire_api="responses"；OpenCode Go 的 /v1/responses 后端返回 503 "Endpoint is unavailable"。
// 因此把 /v1/responses 请求翻译为上游 /v1/chat/completions，再把 chat 响应（JSON / SSE）翻译回 Responses 格式。
function mkId(prefix) { return prefix + crypto.randomUUID().replace(/-/g, '').slice(0, 24); }

function mapUsage(u) {
  const inp = u?.prompt_tokens ?? u?.input_tokens ?? 0;
  const out = u?.completion_tokens ?? u?.output_tokens ?? 0;
  return { input_tokens: inp, output_tokens: out, total_tokens: u?.total_tokens ?? (inp + out) };
}

function responsesToChat(body) {
  const chat = { model: body.model, messages: [], stream: !!body.stream };
  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    chat.messages.push({ role: 'system', content: body.instructions });
  }
  const items = Array.isArray(body.input)
    ? body.input
    : (typeof body.input === 'string' ? [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: body.input }] }] : []);
  let pendingFC = [];
  const flushFC = () => {
    if (!pendingFC.length) return;
    const tcs = pendingFC.map((fc) => ({
      id: fc.call_id || fc.id || mkId('call_'),
      type: 'function',
      function: { name: fc.name || '', arguments: typeof fc.arguments === 'string' ? fc.arguments : JSON.stringify(fc.arguments || {}) },
    }));
    const last = chat.messages[chat.messages.length - 1];
    if (last && last.role === 'assistant' && !last.tool_calls) {
      last.tool_calls = tcs;
      if (!last.content) last.content = null;
    } else {
      chat.messages.push({ role: 'assistant', content: null, tool_calls: tcs });
    }
    pendingFC = [];
  };
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const t = it.type || (it.role ? 'message' : '');
    if (t === 'function_call') { pendingFC.push(it); continue; }
    flushFC();
    if (t === 'message') {
      const role = it.role === 'developer' ? 'system' : (it.role || 'user');
      const parts = Array.isArray(it.content) ? it.content : [{ type: 'input_text', text: String(it.content ?? '') }];
      const imgs = [];
      let text = '';
      for (const p of parts) {
        if (!p || typeof p !== 'object') { text += String(p ?? ''); continue; }
        if (p.type === 'input_image' || p.type === 'image_url') {
          const url = (p.image_url && (p.image_url.url || p.image_url)) || p.url;
          if (url) imgs.push({ type: 'image_url', image_url: { url, ...(p.detail ? { detail: p.detail } : {}) } });
        } else {
          text += (p.text ?? p.content ?? '');
        }
      }
      if (imgs.length) chat.messages.push({ role, content: [...(text ? [{ type: 'text', text }] : []), ...imgs] });
      else chat.messages.push({ role, content: text });
    } else if (t === 'function_call_output') {
      const out = typeof it.output === 'string'
        ? it.output
        : (it.output && typeof it.output === 'object' ? JSON.stringify(it.output) : String(it.output ?? ''));
      chat.messages.push({ role: 'tool', tool_call_id: it.call_id || it.id, content: out });
    }
  }
  flushFC();
  if (typeof body.max_output_tokens === 'number') chat.max_tokens = body.max_output_tokens;
  if (typeof body.temperature === 'number') chat.temperature = body.temperature;
  if (typeof body.top_p === 'number') chat.top_p = body.top_p;
  if (Array.isArray(body.tools)) {
    const tools = [];
    for (const tt of body.tools) {
      if (!tt || typeof tt !== 'object') continue;
      if (tt.type === 'function' && tt.function) tools.push({ type: 'function', function: tt.function });
      else if (tt.type === 'function' && tt.name) tools.push({ type: 'function', function: { name: tt.name, description: tt.description || '', parameters: tt.parameters || { type: 'object', properties: {} } } });
    }
    if (tools.length) chat.tools = tools;
  }
  if (body.tool_choice) {
    const tc = body.tool_choice;
    if (typeof tc === 'string') chat.tool_choice = tc;
    else if (tc && (tc.name || (tc.function && tc.function.name))) chat.tool_choice = { type: 'function', function: { name: tc.name || tc.function.name } };
  }
  if (typeof body.parallel_tool_calls === 'boolean') chat.parallel_tool_calls = body.parallel_tool_calls;
  return chat;
}

function chatToResponses(chat, model) {
  const msg = (chat.choices && chat.choices[0] && chat.choices[0].message) || {};
  const output = [];
  if (typeof msg.content === 'string' && msg.content) {
    output.push({ id: mkId('msg_'), type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: msg.content, annotations: [] }] });
  }
  for (const tc of (Array.isArray(msg.tool_calls) ? msg.tool_calls : [])) {
    output.push({ id: mkId('fc_'), type: 'function_call', call_id: tc.id || mkId('call_'), name: (tc.function && tc.function.name) || '', arguments: (tc.function && tc.function.arguments) || '', status: 'completed' });
  }
  return { id: mkId('resp_'), object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model, output, usage: mapUsage(chat.usage) };
}

function translateChatStream(upRes, res, model) {
  const respId = mkId('resp_');
  const createdAt = Math.floor(Date.now() / 1000);
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  const emit = (type, obj) => { res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...obj }) + '\n\n'); };
  let buf = '', started = false, finished = false, outIndex = 0;
  let msg = null;
  const tools = new Map();
  let usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  const ensureStarted = () => {
    if (started) return;
    started = true;
    emit('response.created', { response: { id: respId, object: 'response', created_at: createdAt, status: 'in_progress', model, output: [] } });
  };
  const ensureMsg = () => {
    if (msg) return msg;
    ensureStarted();
    msg = { itemId: mkId('msg_'), text: '', index: outIndex++ };
    emit('response.output_item.added', { output_index: msg.index, item: { id: msg.itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] } });
    emit('response.content_part.added', { item_id: msg.itemId, output_index: msg.index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    return msg;
  };
  const ensureTool = (idx, tc) => {
    let t = tools.get(idx);
    if (t) return t;
    ensureStarted();
    t = { itemId: mkId('fc_'), callId: tc.id || mkId('call_'), name: (tc.function && tc.function.name) || '', args: '', index: outIndex++ };
    tools.set(idx, t);
    emit('response.output_item.added', { output_index: t.index, item: { id: t.itemId, type: 'function_call', call_id: t.callId, name: t.name, arguments: '', status: 'in_progress' } });
    return t;
  };
  const finalize = () => {
    if (finished) return;
    finished = true;
    ensureStarted();
    const output = [];
    if (msg) {
      emit('response.output_text.done', { item_id: msg.itemId, output_index: msg.index, content_index: 0, text: msg.text });
      emit('response.content_part.done', { item_id: msg.itemId, output_index: msg.index, content_index: 0, part: { type: 'output_text', text: msg.text, annotations: [] } });
      const item = { id: msg.itemId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: msg.text, annotations: [] }] };
      emit('response.output_item.done', { output_index: msg.index, item });
      output.push({ i: msg.index, item });
    }
    for (const t of [...tools.values()].sort((a, b) => a.index - b.index)) {
      emit('response.function_call_arguments.done', { item_id: t.itemId, output_index: t.index, arguments: t.args });
      const item = { id: t.itemId, type: 'function_call', call_id: t.callId, name: t.name, arguments: t.args, status: 'completed' };
      emit('response.output_item.done', { output_index: t.index, item });
      output.push({ i: t.index, item });
    }
    output.sort((a, b) => a.i - b.i);
    emit('response.completed', { response: { id: respId, object: 'response', created_at: createdAt, status: 'completed', model, output: output.map((o) => o.item), usage } });
    res.end();
  };
  const handleLine = (line) => {
    const s = line.trim();
    if (!s.startsWith('data:')) return;
    const data = s.slice(5).trim();
    if (!data) return;
    if (data === '[DONE]') { finalize(); return; }
    let chunk;
    try { chunk = JSON.parse(data); } catch { return; }
    if (chunk.usage) usage = mapUsage(chunk.usage);
    const choice = chunk.choices && chunk.choices[0];
    if (!choice) return;
    const d = choice.delta || {};
    if (typeof d.content === 'string' && d.content.length) {
      const m = ensureMsg();
      m.text += d.content;
      emit('response.output_text.delta', { item_id: m.itemId, output_index: m.index, content_index: 0, delta: d.content });
    }
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const idx = typeof tc.index === 'number' ? tc.index : 0;
        const t = ensureTool(idx, tc);
        if (tc.function && tc.function.name && !t.name) t.name = tc.function.name;
        if (tc.function && typeof tc.function.arguments === 'string' && tc.function.arguments) {
          t.args += tc.function.arguments;
          emit('response.function_call_arguments.delta', { item_id: t.itemId, output_index: t.index, delta: tc.function.arguments });
        }
      }
    }
  };
  upRes.setEncoding('utf8');
  upRes.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      handleLine(line);
    }
  });
  upRes.on('end', () => { if (buf.trim()) handleLine(buf); finalize(); });
  upRes.on('error', () => { finalize(); res.destroy(); });
  res.on('close', () => { if (!upRes.destroyed) upRes.destroy(); });
}

// ---------- 服务器 ----------
const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const inPath = req.url || '/';
  // 精确计时：记录从收到请求到响应完全结束的总时长（SSE 为流结束时刻），用于延迟验收
  res.on('finish', () => {
    if (inPath !== '/healthz') L.info(`[done] ${req.method} ${inPath} -> ${res.statusCode} total=${Date.now() - started}ms`);
  });

  // 本机健康检查：GET /healthz
  if (inPath === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ status: 'ok', port: PORT, upstream: UPSTREAM_ORIGIN + UPSTREAM_BASEPATH, capture: CAPTURE, noInject: NO_INJECT }));
    return;
  }

  // 白名单：路径必须落在上游 /v1/* 下；仅 GET（models 等）与 POST（completions）
  const okPath = inPath.startsWith('/v1/');
  const okMethod = req.method === 'POST' || req.method === 'GET';
  if (!okPath || !okMethod) {
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { message: `proxy: only ${UPSTREAM_BASEPATH}/v1/* via GET/POST is allowed, got ${req.method} ${inPath}` } }));
    return;
  }

  let rawBody;
  let bodyMeta;
  try {
    rawBody = req.method === 'POST' ? await readBody(req) : Buffer.alloc(0);
    bodyMeta = bodyMetaOf(rawBody, req.headers['content-type']);
  } catch {
    res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { message: 'proxy: request body too large or aborted' } }));
    return;
  }

  // 规范化模型名：剥离客户端装饰前缀（proxy- 别名 / uuid/ provider 前缀），还原上游真实 ID（详见 docs/compatibility.md）
  let outBody = rawBody;
  let modelAliasStripped = null;
  if (bodyMeta.shape === 'json' && bodyMeta.model !== '*') {
    const normalized = normalizeModelId(bodyMeta.model);
    if (normalized !== bodyMeta.model) {
      try {
        const parsed = JSON.parse(rawBody.toString('utf8'));
        parsed.model = normalized;
        outBody = Buffer.from(JSON.stringify(parsed), 'utf8');
        modelAliasStripped = `${bodyMeta.model} -> ${normalized}`;
        bodyMeta.model = normalized;   // 日志/会话派生/上游均使用真实模型名
        L.info(`[model-normalize] ${modelAliasStripped}`);
      } catch { /* 解析失败则原样转发 */ }
    }
  }

  // Responses 兼容层：Codex 带 wire_api="responses" 时把 /v1/responses 翻译为上游 chat/completions
  const isResponses = req.method === 'POST' && inPath === '/v1/responses';
  let upstreamPath = inPath;
  if (isResponses) {
    try {
      const parsed = JSON.parse(outBody.toString('utf8'));
      outBody = Buffer.from(JSON.stringify(responsesToChat(parsed)), 'utf8');
      upstreamPath = '/v1/chat/completions';
      L.info('[responses] /v1/responses -> upstream /v1/chat/completions');
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { message: `proxy: invalid responses body: ${e.message}` } }));
      return;
    }
  }

  // 会话头决策
  let session = { value: null, source: 'off:no-inject' };
  if (!NO_INJECT) session = sessionFor(req.headers, bodyMeta);

  // 组装上游请求头
  const upHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(k) || REDACTED_HEADERS.has(k)) continue;
    upHeaders[k] = v;
  }
  upHeaders['host'] = 'opencode.ai';
  upHeaders['user-agent'] = USER_AGENT;                       // 自我标识，不伪装 OpenCode 原生客户端
  upHeaders['x-opencode-client'] = CLIENT_HEADER_VALUE;       // 诚实声明客户端类型
  if (session.value) upHeaders[SESSION_HEADER] = session.value;
  if (req.method === 'POST') upHeaders['content-length'] = String(outBody.length);
  // Authorization 不在 REDACTED_HEADERS 转发名单里被剔除 —— 它必须原样转发：
  if (req.headers.authorization) upHeaders['authorization'] = req.headers.authorization;

  const target = new URL(UPSTREAM_ORIGIN + UPSTREAM_BASEPATH + upstreamPath);
  const startedUp = Date.now();

  const upReq = https.request(target, {
    method: req.method,
    headers: upHeaders,
    timeout: 600000,
  }, (upRes) => {
    if (L.cap) {
      L.cap({
        ts: new Date().toISOString(), kind: 'response',
        path: inPath, model: bodyMeta.model, stream: bodyMeta.stream,
        status: upRes.statusCode,
        contentType: upRes.headers['content-type'] || null,
        headerNames: Object.keys(upRes.headers),
      });
    }
    if (isResponses && upRes.statusCode < 400) {
      const upCt = upRes.headers['content-type'] || '';
      if (/text\/event-stream/i.test(upCt)) {
        translateChatStream(upRes, res, bodyMeta.model);
      } else {
        let raw = '';
        upRes.setEncoding('utf8');
        upRes.on('data', (c) => { raw += c; });
        upRes.on('end', () => {
          let payload = null;
          try { payload = JSON.parse(raw); } catch { /* 保持 null */ }
          if (!payload) {
            res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: { message: 'proxy: invalid upstream chat response' } }));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(chatToResponses(payload, bodyMeta.model)));
        });
        upRes.on('error', () => res.destroy());
      }
      return;
    }
    const outHeaders = {};
    for (const [k, v] of Object.entries(upRes.headers)) {
      if (k === 'transfer-encoding') continue;               // 由 Node 重新决定分块方式
      outHeaders[k] = v;
    }
    // 流式响应绝不能声明 content-length（SSE 没有意义，且会导致客户端挂起）
    const isSSE = /text\/event-stream/i.test(upRes.headers['content-type'] || '');
    if (isSSE) delete outHeaders['content-length'];

    L.info(`${req.method} ${inPath} model=${bodyMeta.model} stream=${bodyMeta.stream} -> ${upRes.statusCode} sess=${session.source}(${hash12(session.value)}) ${Date.now() - started}ms`);
    res.writeHead(upRes.statusCode, outHeaders);
    res.flushHeaders?.();
    upRes.pipe(res);
    upRes.on('error', () => res.destroy());
  });

  upReq.on('timeout', () => { upReq.destroy(new Error('upstream timeout')); });
  upReq.on('error', (err) => {
    if (L.cap) L.cap({ ts: new Date().toISOString(), kind: 'upstream-error', path: inPath, model: bodyMeta.model, message: err.message });
    if (!res.headersSent) {
      const code = err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN' ? 504 : 502;
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { message: `proxy: upstream ${UPSTREAM_ORIGIN}${UPSTREAM_BASEPATH} unreachable: ${err.message}`, upstream_code: err.code || null } }));
    } else {
      res.destroy();
    }
  });

  if (req.method === 'POST') upReq.end(outBody); else upReq.end();

  // 客户端中止（关闭对话页/重试）→ 立刻断开上游
  res.on('close', () => {
    if (!upReq.destroyed && !res.writableEnded) upReq.destroy();
  });

  if (L.cap) {
    L.cap({
      ts: new Date().toISOString(), kind: 'request',
      method: req.method, path: inPath.replace(/([?&](key|api_key)=)[^&]+/gi, '$1<redacted>'),
      contentType: req.headers['content-type'] || null,
      accept: req.headers.accept || null,
      model: bodyMeta.model, stream: bodyMeta.stream,
      bodyShape: bodyMeta.shape, bodyBytes: bodyMeta.bytes,
      modelAliasStripped,
      images: bodyMeta.images, toolSchemas: bodyMeta.tools,
      conversationSignalHash: hash12(bodyMeta.conversationSignal || null),
      headerNames: Object.keys(req.headers).filter((h) => !REDACTED_HEADERS.has(h)),
      interesting: {
        'user-agent': (req.headers['user-agent'] || '').slice(0, 80),
        'x-request-id': req.headers['x-request-id'] ? hash12(req.headers['x-request-id']) : null,
        'x-interaction-id': req.headers['x-interaction-id'] ? hash12(req.headers['x-interaction-id']) : null,
        'x-interaction-type': req.headers['x-interaction-type'] || null,
        'x-agent-task-id': req.headers['x-agent-task-id'] ? hash12(req.headers['x-agent-task-id']) : null,
        'x-initiator': req.headers['x-initiator'] || null,
        'x-github-api-version': req.headers['x-github-api-version'] || null,
        'openai-intent': req.headers['openai-intent'] || null,
        'vscode-sessionid': req.headers['vscode-sessionid'] ? hash12(req.headers['vscode-sessionid']) : null,
        sessionSource: session.source,
        sessionValueHash: hash12(session.value),
      },
    });
  }
});

server.requestTimeout = 0;      // SSE 长连接不受请求头超时约束
server.headersTimeout = 60000;
server.maxRequestsPerSocket = 0;

// 仅绑定回环地址——安全要求（不得监听 0.0.0.0 / 对外暴露）
server.listen(PORT, '127.0.0.1', () => {
  L.info(`[listening] http://127.0.0.1:${PORT}  ->  ${UPSTREAM_ORIGIN}${UPSTREAM_BASEPATH}/v1/*`);
  L.info(`[session]   注入策略：${NO_INJECT ? 'OFF（控制组）' : 'A/B/C/D 分级派生'}  capture=${CAPTURE ? 'ON' : 'OFF'}`);
  L.info(`[ua]        User-Agent: ${USER_AGENT}`);
});
process.on('SIGINT', () => { L.info('[stop] SIGINT'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500); });
process.on('SIGTERM', () => { L.info('[stop] SIGTERM'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500); });
