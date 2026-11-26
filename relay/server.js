// 中继服务器（Relay）：网页平台 + 任务队列 + 实时状态同步
// 零依赖，Node 18+。职责相当于架构图里的「网页平台 + Firebase/Supabase」两层。
// Mac 上的 agent 主动连进来领任务（长轮询），所以 Mac 不需要公网 IP、不需要开端口。
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const WEB_DIR = path.join(ROOT, 'web');
const DATA_DIR = process.env.RELAY_DATA || path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || process.argv[2] || 5227);
const HOST = process.env.HOST || '127.0.0.1';

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------- 存储
const files = {
  config: path.join(DATA_DIR, 'config.json'),
  users: path.join(DATA_DIR, 'users.json'),
  db: path.join(DATA_DIR, 'db.json'),
};
function readJSON(f, dflt) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; }
}
function writeJSONAtomic(f, obj) {
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, f);
}

const config = readJSON(files.config, {});
if (!config.agentToken) config.agentToken = crypto.randomBytes(24).toString('base64url');
if (!config.sessionDays) config.sessionDays = 14;
if (!config.taskOutputLimit) config.taskOutputLimit = 400000; // 单任务保存的输出事件字符上限
writeJSONAtomic(files.config, config);

let users = readJSON(files.users, []);
const db = readJSON(files.db, { convs: [], tasks: [] });
db.convs ||= []; db.tasks ||= []; db.uploads ||= [];

// ---------------------------------------------------------------- 文件（AI 产出 / 用户附件）
// 文件本体存 data/files/<id>，元数据挂在 task.outputs / task.inputs / db.uploads 上
const FILE_DIR = path.join(DATA_DIR, 'files');
fs.mkdirSync(FILE_DIR, { recursive: true });
const MAX_FILE = 25 * 1024 * 1024;
const blobPath = id => path.join(FILE_DIR, id.replace(/[^\w-]/g, ''));
function findFile(id) {
  const up = db.uploads.find(f => f.id === id);
  if (up) return { meta: up, task: null };
  for (const t of db.tasks) {
    const f = (t.outputs || []).find(x => x.id === id) || (t.inputs || []).find(x => x.id === id);
    if (f) return { meta: f, task: t };
  }
  return null;
}
function removeBlobs(metas) { for (const f of metas || []) if (f.stored) fs.rm(blobPath(f.id), () => {}); }
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpError(413, '文件太大')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function sendFile(req, res, meta, download) {
  const f = blobPath(meta.id);
  fs.stat(f, (err, st) => {
    if (err) { res.writeHead(404); return res.end('file gone'); }
    const mime = meta.mime || 'application/octet-stream';
    const headers = {
      'Content-Type': mime, 'Content-Length': st.size, 'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
    };
    // HTML / SVG / XML 等可执行内容：放进沙盒（独立的不透明源），拿不到本站 cookie、调不了 API
    if (/html|svg|xml|javascript/i.test(mime)) headers['Content-Security-Policy'] = "sandbox allow-scripts allow-popups allow-modals";
    res.writeHead(200, headers);
    fs.createReadStream(f).pipe(res);
  });
}

let dbDirty = false, usersDirty = false;
function saveSoon() { dbDirty = true; }
setInterval(() => {
  if (dbDirty) { dbDirty = false; writeJSONAtomic(files.db, db); }
  if (usersDirty) { usersDirty = false; writeJSONAtomic(files.users, users); }
}, 1000);
function flushAll() {
  try { writeJSONAtomic(files.db, db); writeJSONAtomic(files.users, users); } catch {}
}
process.on('SIGINT', () => { flushAll(); process.exit(0); });
process.on('SIGTERM', () => { flushAll(); process.exit(0); });

// 重启后：还在跑的任务无法恢复，标记失败；排队的保留
for (const t of db.tasks) {
  if (t.status === 'running' || t.status === 'dispatched') {
    t.status = 'failed'; t.error = '中继重启，任务中断'; t.endedAt = Date.now();
  }
}

// ---------------------------------------------------------------- 用户与权限
const LEVELS = ['read', 'edit', 'full'];
const DEFAULT_PERMS = { clis: ['claude', 'codex'], maxLevel: 'edit', agents: ['*'], workspaces: ['*'], dailyLimit: 50 };

function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return { salt, hash };
}
function checkPassword(user, pw) {
  const { hash } = hashPassword(pw, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
}
function newId(prefix) { return prefix + '_' + crypto.randomBytes(6).toString('hex'); }

if (!users.length) {
  const pw = crypto.randomBytes(6).toString('base64url');
  users.push({
    id: newId('u'), username: 'admin', role: 'admin', disabled: false, createdAt: Date.now(),
    perms: { clis: ['*'], maxLevel: 'full', agents: ['*'], workspaces: ['*'], dailyLimit: 0 },
    ...hashPassword(pw),
  });
  writeJSONAtomic(files.users, users);
  fs.writeFileSync(path.join(DATA_DIR, 'INITIAL_ADMIN.txt'), `用户名: admin\n初始密码: ${pw}\n登录后请到「用户权限」里改密码，然后删除本文件。\n`);
  console.log(`\n[relay] 已创建管理员 admin，初始密码：${pw}（也写在 data/INITIAL_ADMIN.txt）\n`);
}

function publicUser(u) {
  return { id: u.id, username: u.username, role: u.role, disabled: !!u.disabled, perms: u.perms, createdAt: u.createdAt };
}
const allow = (list, v) => !list || list.includes('*') || list.includes(v);
function levelAllowed(user, level) {
  return LEVELS.indexOf(level) >= 0 && LEVELS.indexOf(level) <= LEVELS.indexOf(user.perms.maxLevel || 'read');
}
function tasksToday(userId) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  return db.tasks.filter(t => t.userId === userId && t.createdAt >= start.getTime()).length;
}

// ---------------------------------------------------------------- 会话 cookie
// 登录会话持久化到 data/sessions.json（只存 token 的哈希），中继重启不用重新登录
const SESS_FILE = path.join(DATA_DIR, 'sessions.json');
const tokHash = t => crypto.createHash('sha256').update(t).digest('hex');
class SessionStore extends Map {
  get(tok) { return super.get(tokHash(tok)); }
  set(tok, v) { super.set(tokHash(tok), v); this.dirty = true; return this; }
  delete(tok) { const r = super.delete(tokHash(tok)) || super.delete(tok); this.dirty = true; return r; }
}
const sessions = new SessionStore();
for (const [h, v] of Object.entries(readJSON(SESS_FILE, {}))) if (v.exp > Date.now()) Map.prototype.set.call(sessions, h, v);
setInterval(() => {
  if (!sessions.dirty) return; sessions.dirty = false;
  const obj = {}; for (const [h, v] of Map.prototype.entries.call(sessions)) if (v.exp > Date.now()) obj[h] = v;
  writeJSONAtomic(SESS_FILE, obj);
}, 2000);
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function currentUser(req) {
  const tok = parseCookies(req).sid;
  const s = tok && sessions.get(tok);
  if (!s || s.exp < Date.now()) return null;
  const u = users.find(x => x.id === s.userId);
  return u && !u.disabled ? u : null;
}

// 简单登录限流：同 IP 10 分钟内失败 8 次即锁
const loginFails = new Map();
function ipOf(req) { return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); }

// ---------------------------------------------------------------- agents（Mac 等执行端）
const agents = new Map(); // name -> { name, platform, clis, workspaces, lastSeen, running:Set, waiter }
function agentOnline(a) { return a && Date.now() - a.lastSeen < 45000; }
function publicAgent(a) {
  return {
    name: a.name, platform: a.platform, hostname: a.hostname, online: agentOnline(a),
    clis: a.clis, workspaces: a.workspaces, maxConcurrent: a.maxConcurrent,
    running: [...a.running], lastSeen: a.lastSeen, version: a.version,
  };
}

// ---------------------------------------------------------------- SSE 实时推送
const streams = new Set(); // { res, user }
function canSeeTask(user, t) { return user.role === 'admin' || t.userId === user.id; }
function push(event, data, filter) {
  const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const s of streams) {
    if (filter && !filter(s.user)) continue;
    s.res.write(line);
  }
}
function pushTask(t) { push('task', taskSummary(t), u => canSeeTask(u, t)); }
function pushAgents() { push('agents', [...agents.values()].map(publicAgent)); }
setInterval(() => { for (const s of streams) s.res.write(': ping\n\n'); }, 20000);

// 在线状态变化检测
const lastOnline = new Map();
setInterval(() => {
  let changed = false;
  for (const a of agents.values()) {
    const on = agentOnline(a);
    if (lastOnline.get(a.name) !== on) { lastOnline.set(a.name, on); changed = true; }
  }
  if (changed) pushAgents();
}, 5000);

// ---------------------------------------------------------------- 任务
function taskSummary(t) {
  const { events, ...rest } = t;
  return { ...rest, eventCount: events.length };
}
function convOf(t) { return db.convs.find(c => c.id === t.convId); }
function userName(id) { return users.find(u => u.id === id)?.username || '?'; }

function appendEvents(t, evs) {
  for (const e of evs) {
    // 连续文本合并，减少存储条数
    const last = t.events[t.events.length - 1];
    if (e.k === 'text' && last && last.k === 'text') last.d += e.d;
    else t.events.push({ ...e }); // 存副本：后续文本会合并进存储的这条，不能改到正要推给网页的原事件
    t.outputSize = (t.outputSize || 0) + (e.d ? e.d.length : 0);
  }
  if (t.outputSize > config.taskOutputLimit && !t.truncated) {
    t.truncated = true;
    t.events.push({ k: 'info', d: '（输出过长，后续内容不再保存，只显示最终结果）' });
  }
}

// 把排队任务派给某个 agent（每个对话串行，保证 resume 顺序）
function pickTasksFor(agent, free) {
  const out = [];
  if (free <= 0) return out;
  const busyConvs = new Set(db.tasks.filter(t => t.status === 'running' || t.status === 'dispatched').map(t => t.convId));
  for (const t of db.tasks) {
    if (out.length >= free) break;
    if (t.status !== 'queued' || t.agent !== agent.name || busyConvs.has(t.convId)) continue;
    const conv = convOf(t);
    if (!conv) { t.status = 'cancelled'; continue; }
    t.status = 'dispatched'; t.dispatchedAt = Date.now();
    t.resumeSessionId = conv.sessionId || null;
    busyConvs.add(t.convId);
    out.push({
      id: t.id, cli: t.cli, prompt: t.prompt, workspace: t.workspace, level: t.level,
      model: t.model || null, resumeSessionId: t.resumeSessionId,
      inputs: (t.inputs || []).map(f => ({ id: f.id, name: f.name, mime: f.mime, size: f.size })),
    });
    pushTask(t);
  }
  if (out.length) saveSoon();
  return out;
}
function wakeAgent(name) {
  const a = agents.get(name);
  if (a && a.waiter) a.waiter();
}

// 派出去却一直没回音的任务（agent 掉线）→ 失败
setInterval(() => {
  for (const t of db.tasks) {
    // 点了停止 30 秒还没停下：中继这边直接判为已取消，不让对话一直卡着
    if ((t.status === 'dispatched' || t.status === 'running') && t.cancelRequested && Date.now() - (t.cancelRequestedAt || 0) > 30000) {
      t.status = 'cancelled'; t.error = '执行端 30 秒内没有停下，已强制结束这条任务'; t.endedAt = Date.now();
      agents.get(t.agent)?.running.delete(t.id);
      saveSoon(); pushTask(t); wakeAgent(t.agent);
      continue;
    }
    if ((t.status === 'dispatched' || t.status === 'running') && !agentOnline(agents.get(t.agent))) {
      const since = t.lastEventAt || t.dispatchedAt || 0;
      if (Date.now() - since > 90000) {
        t.status = 'failed'; t.error = '执行端离线，任务中断'; t.endedAt = Date.now();
        saveSoon(); pushTask(t);
      }
    }
  }
}, 15000);

// ---------------------------------------------------------------- HTTP 工具
function send(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function readBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const fail = (code, msg) => { throw new HttpError(code, msg); };

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
function serveStatic(req, res, pathname) {
  let p = pathname === '/' ? '/index.html' : pathname;
  const f = path.normalize(path.join(WEB_DIR, decodeURIComponent(p)));
  if (!f.startsWith(WEB_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

function agentAuth(req) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  const a = Buffer.from(tok), b = Buffer.from(config.agentToken);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) fail(401, 'agent token 不对');
}

// ---------------------------------------------------------------- 路由
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const m = req.method;
  let mm;

  if (!p.startsWith('/api/')) return serveStatic(req, res, p);

  // 防 CSRF：写操作必须是 JSON，或带自定义头的上传（跨站表单两者都发不出来，必触发预检）
  const isUpload = p === '/api/uploads' && req.headers['x-upload'] === '1';
  if (m !== 'GET' && !p.startsWith('/api/agent/') && !isUpload && !(req.headers['content-type'] || '').includes('application/json')) fail(415, '需要 JSON');

  // ===== agent 接口 =====
  if (p.startsWith('/api/agent/')) {
    agentAuth(req);
    if (p === '/api/agent/hello' && m === 'POST') {
      const b = await readBody(req);
      if (!b.name) fail(400, '缺少 name');
      const old = agents.get(b.name);
      const a = {
        name: String(b.name).slice(0, 40), platform: b.platform, hostname: b.hostname, version: b.version,
        clis: b.clis || {}, workspaces: b.workspaces || [], maxConcurrent: b.maxConcurrent || 1,
        lastSeen: Date.now(), running: old?.running || new Set(), waiter: null,
      };
      agents.set(a.name, a);
      // agent 重启：它报告的正在跑的任务以外的 running 任务都已丢失
      const alive = new Set(b.running || []);
      for (const t of db.tasks) {
        if (t.agent === a.name && (t.status === 'running' || t.status === 'dispatched') && !alive.has(t.id)) {
          t.status = 'failed'; t.error = '执行端重启，任务中断'; t.endedAt = Date.now(); pushTask(t);
        }
      }
      a.running = new Set([...alive]);
      saveSoon(); pushAgents();
      return send(res, 200, { ok: true, serverTime: Date.now() });
    }
    if (p === '/api/agent/poll' && m === 'GET') {
      const name = url.searchParams.get('name');
      const a = agents.get(name);
      if (!a) fail(409, '请先 hello');
      const free = Number(url.searchParams.get('free') || 0);
      a.lastSeen = Date.now();
      const collect = () => {
        // 停止指令只发一次；10 秒后还没停才补发一次（防丢），否则会让 agent 空转
        const now = Date.now();
        const cancel = db.tasks.filter(t => t.agent === name && t.cancelRequested && (t.status === 'running' || t.status === 'dispatched')
          && (!t.cancelSentAt || now - t.cancelSentAt > 10000)).map(t => { t.cancelSentAt = now; return t.id; });
        const tasks = pickTasksFor(a, free);
        return { tasks, cancel };
      };
      let r = collect();
      if (r.tasks.length || r.cancel.length) return send(res, 200, r);
      // 长轮询：最多挂 25 秒，有新任务立即返回
      let done = false;
      const finish = () => {
        if (done) return; done = true; clearTimeout(timer); a.waiter = null; a.lastSeen = Date.now();
        if (res.writableEnded) return;
        send(res, 200, collect());
      };
      const timer = setTimeout(finish, 25000);
      a.waiter = finish;
      req.on('close', () => { done = true; clearTimeout(timer); if (a.waiter === finish) a.waiter = null; });
      return;
    }
    // agent 上传 AI 产出的文件（原始字节），返回文件 id
    if (p === '/api/agent/files' && m === 'POST') {
      const t = db.tasks.find(x => x.id === req.headers['x-task']);
      if (!t) fail(404, '任务不存在');
      const buf = await readRaw(req, MAX_FILE);
      const id = newId('f');
      fs.writeFileSync(blobPath(id), buf);
      return send(res, 200, { id, size: buf.length });
    }
    // agent 下载用户附件
    if ((mm = p.match(/^\/api\/agent\/files\/([\w-]+)$/)) && m === 'GET') {
      const hit = findFile(mm[1]);
      if (!hit || !hit.meta.stored) fail(404, '文件不存在');
      return sendFile(req, res, hit.meta, true);
    }
    if (p === '/api/agent/events' && m === 'POST') {
      const b = await readBody(req, 5_000_000);
      const a = agents.get(b.agent);
      if (a) a.lastSeen = Date.now();
      for (const up of b.updates || []) {
        const t = db.tasks.find(x => x.id === up.taskId);
        if (!t || ['done', 'failed', 'cancelled'].includes(t.status)) continue;
        t.lastEventAt = Date.now();
        if (up.status === 'running' && t.status !== 'running') { t.status = 'running'; t.startedAt = Date.now(); a?.running.add(t.id); }
        if (up.events?.length) {
          const room = t.truncated ? [] : up.events;
          appendEvents(t, room);
          push('chunk', { taskId: t.id, events: room }, u => canSeeTask(u, t));
        }
        if (up.sessionId) {
          t.sessionId = up.sessionId;
          const c = convOf(t); if (c) c.sessionId = up.sessionId;
        }
        if (up.usage) t.usage = up.usage;
        if (up.outputs) t.outputs = sanitizeOutputs(up.outputs, t);
        if (up.linkMap) t.linkMap = up.linkMap;
        if (up.final) {
          t.status = up.final.status; // done | failed | cancelled
          t.result = up.final.result || '';
          t.error = up.final.error || null;
          t.exitCode = up.final.exitCode;
          t.endedAt = Date.now();
          a?.running.delete(t.id);
          const c = convOf(t); if (c) c.updatedAt = Date.now();
          // 这个对话还有排队的后续消息 → 叫醒 agent
          wakeAgent(t.agent);
        }
        saveSoon(); pushTask(t);
      }
      if (a) pushAgents();
      return send(res, 200, { ok: true });
    }
    fail(404, 'no route');
  }

  // ===== 登录 =====
  if (p === '/api/login' && m === 'POST') {
    const ip = ipOf(req);
    const lf = loginFails.get(ip) || { n: 0, t: Date.now() };
    if (Date.now() - lf.t > 600000) { lf.n = 0; lf.t = Date.now(); }
    if (lf.n >= 8) fail(429, '失败次数过多，10 分钟后再试');
    const b = await readBody(req);
    const u = users.find(x => x.username === String(b.username || '').trim());
    if (!u || u.disabled || !checkPassword(u, b.password || '')) {
      lf.n++; loginFails.set(ip, lf);
      fail(401, '用户名或密码错误');
    }
    loginFails.delete(ip);
    const tok = crypto.randomBytes(32).toString('base64url');
    const maxAge = config.sessionDays * 86400;
    sessions.set(tok, { userId: u.id, exp: Date.now() + maxAge * 1000 });
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return send(res, 200, { user: publicUser(u) }, {
      'Set-Cookie': `sid=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`,
    });
  }
  if (p === '/api/logout' && m === 'POST') {
    const tok = parseCookies(req).sid; if (tok) sessions.delete(tok);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }

  const user = currentUser(req);
  if (!user) fail(401, '未登录');
  const isAdmin = user.role === 'admin';

  if (p === '/api/me' && m === 'GET') return send(res, 200, { user: publicUser(user), today: tasksToday(user.id) });
  if (p === '/api/me/password' && m === 'POST') {
    const b = await readBody(req);
    if (!checkPassword(user, b.old || '')) fail(400, '原密码不对');
    if (String(b.password || '').length < 6) fail(400, '新密码至少 6 位');
    Object.assign(user, hashPassword(b.password)); usersDirty = true;
    return send(res, 200, { ok: true });
  }

  // SSE
  if (p === '/api/stream' && m === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    const s = { res, user };
    streams.add(s);
    res.write(`event: agents\ndata: ${JSON.stringify(visibleAgents(user))}\n\n`);
    req.on('close', () => streams.delete(s));
    return;
  }

  if (p === '/api/agents' && m === 'GET') {
    const out = { agents: visibleAgents(user) };
    if (isAdmin) out.agentToken = config.agentToken;
    return send(res, 200, out);
  }

  // ===== 对话 =====
  if (p === '/api/convs' && m === 'GET') {
    const list = db.convs.filter(c => isAdmin && url.searchParams.get('all') ? true : c.userId === user.id)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .map(c => ({ ...c, username: userName(c.userId) }));
    return send(res, 200, { convs: list });
  }
  if (p === '/api/convs' && m === 'POST') {
    const b = await readBody(req);
    checkRunPerms(user, b);
    const c = {
      id: newId('c'), userId: user.id, title: String(b.title || '新对话').slice(0, 60),
      agent: b.agent, cli: b.cli, workspace: b.workspace, level: b.level, model: b.model || null,
      sessionId: null, createdAt: Date.now(), updatedAt: Date.now(),
    };
    db.convs.push(c); saveSoon();
    return send(res, 200, { conv: c });
  }
  if ((mm = p.match(/^\/api\/convs\/([\w-]+)$/))) {
    const c = db.convs.find(x => x.id === mm[1]);
    if (!c || (!isAdmin && c.userId !== user.id)) fail(404, '对话不存在');
    if (m === 'GET') {
      const tasks = db.tasks.filter(t => t.convId === c.id);
      return send(res, 200, { conv: c, tasks });
    }
    if (m === 'PATCH') {
      const b = await readBody(req);
      if (b.title) c.title = String(b.title).slice(0, 60);
      if (b.level) { checkRunPerms(user, { ...c, level: b.level }); c.level = b.level; }
      if (b.resetSession) c.sessionId = null;
      saveSoon(); return send(res, 200, { conv: c });
    }
    if (m === 'DELETE') {
      for (const t of db.tasks) if (t.convId === c.id && ['running', 'dispatched'].includes(t.status) && !t.cancelRequested) { t.cancelRequested = true; t.cancelRequestedAt = Date.now(); wakeAgent(t.agent); }
      db.convs = db.convs.filter(x => x !== c);
      for (const t of db.tasks) if (t.convId === c.id && !['running', 'dispatched'].includes(t.status)) { removeBlobs(t.outputs); removeBlobs(t.inputs); }
      removeBlobs(db.uploads.filter(f => f.convId === c.id));
      db.uploads = db.uploads.filter(f => f.convId !== c.id);
      db.tasks = db.tasks.filter(t => t.convId !== c.id || ['running', 'dispatched'].includes(t.status));
      saveSoon(); return send(res, 200, { ok: true });
    }
  }
  if ((mm = p.match(/^\/api\/convs\/([\w-]+)\/send$/)) && m === 'POST') {
    const c = db.convs.find(x => x.id === mm[1]);
    if (!c || c.userId !== user.id) fail(404, '对话不存在');
    const b = await readBody(req);
    const prompt = String(b.prompt || '').trim();
    const attachIds = Array.isArray(b.attachments) ? b.attachments.slice(0, 10) : [];
    const inputs = attachIds.map(id => db.uploads.find(f => f.id === id && f.userId === user.id && f.convId === c.id)).filter(Boolean);
    if (inputs.length !== attachIds.length) fail(400, '附件已失效，请重新上传');
    if (!prompt && !inputs.length) fail(400, '内容为空');
    if (prompt.length > 100000) fail(400, '内容太长');
    checkRunPerms(user, c);
    const lim = user.perms.dailyLimit || 0;
    if (lim > 0 && tasksToday(user.id) >= lim) fail(429, `今日额度已用完（${lim} 次）`);
    if (c.title === '新对话' && prompt) c.title = prompt.replace(/\s+/g, ' ').slice(0, 30);
    const t = {
      id: newId('t'), convId: c.id, userId: user.id, agent: c.agent, cli: c.cli, workspace: c.workspace,
      level: c.level, model: c.model, prompt, status: 'queued', createdAt: Date.now(), events: [], inputs,
    };
    db.uploads = db.uploads.filter(f => !inputs.includes(f));
    db.tasks.push(t); c.updatedAt = Date.now(); saveSoon();
    pushTask(t); wakeAgent(c.agent);
    return send(res, 200, { task: taskSummary(t) });
  }

  // ===== 任务管理 =====
  if (p === '/api/tasks' && m === 'GET') {
    const st = url.searchParams.get('status');
    const uid = url.searchParams.get('user');
    let list = db.tasks.filter(t => canSeeTask(user, t));
    if (st) list = list.filter(t => t.status === st);
    if (uid && isAdmin) list = list.filter(t => t.userId === uid);
    list = list.sort((a, b) => b.createdAt - a.createdAt).slice(0, 300)
      .map(t => ({ ...taskSummary(t), username: userName(t.userId), convTitle: convOf(t)?.title }));
    return send(res, 200, { tasks: list });
  }
  if ((mm = p.match(/^\/api\/tasks\/([\w-]+)(\/cancel|\/retry)?$/))) {
    const t = db.tasks.find(x => x.id === mm[1]);
    if (!t || !canSeeTask(user, t)) fail(404, '任务不存在');
    if (!mm[2] && m === 'GET') return send(res, 200, { task: { ...t, username: userName(t.userId), convTitle: convOf(t)?.title } });
    if (mm[2] === '/cancel' && m === 'POST') {
      if (t.status === 'queued') { t.status = 'cancelled'; t.error = '已手动停止'; t.endedAt = Date.now(); }
      else if (['running', 'dispatched'].includes(t.status) && !t.cancelRequested) {
        t.cancelRequested = true; t.cancelRequestedAt = Date.now();
        console.log(`[relay] ✕ ${new Date().toISOString().slice(11, 23)} 请求停止 ${t.id}（agent ${agents.get(t.agent)?.waiter ? '在等待，立即通知' : '不在等待'}）`);
        wakeAgent(t.agent);
      }
      saveSoon(); pushTask(t); return send(res, 200, { ok: true });
    }
    if (mm[2] === '/retry' && m === 'POST') {
      const c = convOf(t); if (!c) fail(400, '对话已删除');
      if (t.userId !== user.id) fail(403, '只能重试自己的任务');
      checkRunPerms(user, c);
      const nt = { ...t, id: newId('t'), status: 'queued', createdAt: Date.now(), events: [], result: undefined, error: null,
        startedAt: undefined, endedAt: undefined, cancelRequested: false, outputSize: 0, truncated: false, sessionId: undefined,
        outputs: undefined, linkMap: undefined, usage: undefined, cancelRequestedAt: undefined, cancelSentAt: undefined, exitCode: undefined };
      db.tasks.push(nt); saveSoon(); pushTask(nt); wakeAgent(nt.agent);
      return send(res, 200, { task: taskSummary(nt) });
    }
  }
  // ===== 文件 =====
  // 用户上传附件：原始字节 + 头信息（X-Upload: 1 防 CSRF）
  if (p === '/api/uploads' && m === 'POST') {
    const c = db.convs.find(x => x.id === req.headers['x-conv']);
    if (!c || c.userId !== user.id) fail(404, '对话不存在');
    if (db.uploads.filter(f => f.userId === user.id).length > 50) fail(429, '未发送的附件太多');
    const name = decodeURIComponent(String(req.headers['x-name'] || 'file')).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120) || 'file';
    const buf = await readRaw(req, MAX_FILE);
    if (!buf.length) fail(400, '空文件');
    const meta = { id: newId('f'), kind: 'input', name, mime: String(req.headers['x-mime'] || 'application/octet-stream').slice(0, 100),
      size: buf.length, userId: user.id, convId: c.id, stored: true, createdAt: Date.now() };
    fs.writeFileSync(blobPath(meta.id), buf);
    db.uploads.push(meta); saveSoon();
    return send(res, 200, { file: meta });
  }
  if ((mm = p.match(/^\/api\/uploads\/([\w-]+)$/)) && m === 'DELETE') {
    const f = db.uploads.find(x => x.id === mm[1] && x.userId === user.id);
    if (f) { removeBlobs([f]); db.uploads = db.uploads.filter(x => x !== f); saveSoon(); }
    return send(res, 200, { ok: true });
  }
  if ((mm = p.match(/^\/api\/files\/([\w-]+)$/)) && m === 'GET') {
    const hit = findFile(mm[1]);
    const okUser = hit && (hit.task ? canSeeTask(user, hit.task) : hit.meta.userId === user.id || isAdmin);
    if (!okUser || !hit.meta.stored) fail(404, '文件不存在');
    return sendFile(req, res, hit.meta, url.searchParams.get('dl') === '1');
  }

  if (p === '/api/stats' && m === 'GET') {
    const mine = isAdmin ? db.tasks : db.tasks.filter(t => t.userId === user.id);
    const by = {}; for (const t of mine) by[t.status] = (by[t.status] || 0) + 1;
    return send(res, 200, { byStatus: by, today: tasksToday(user.id) });
  }

  // ===== 用户管理（仅管理员）=====
  if (p.startsWith('/api/users')) {
    if (!isAdmin) fail(403, '需要管理员');
    if (p === '/api/users' && m === 'GET') {
      return send(res, 200, { users: users.map(u => ({ ...publicUser(u), today: tasksToday(u.id), total: db.tasks.filter(t => t.userId === u.id).length })) });
    }
    if (p === '/api/users' && m === 'POST') {
      const b = await readBody(req);
      const name = String(b.username || '').trim();
      if (!/^[\w一-龥.-]{2,24}$/.test(name)) fail(400, '用户名 2-24 位，字母数字中文');
      if (users.some(u => u.username === name)) fail(400, '用户名已存在');
      if (String(b.password || '').length < 6) fail(400, '密码至少 6 位');
      const u = { id: newId('u'), username: name, role: b.role === 'admin' ? 'admin' : 'user', disabled: false, createdAt: Date.now(),
        perms: sanitizePerms(b.perms || DEFAULT_PERMS), ...hashPassword(b.password) };
      users.push(u); usersDirty = true;
      return send(res, 200, { user: publicUser(u) });
    }
    if ((mm = p.match(/^\/api\/users\/([\w-]+)$/))) {
      const u = users.find(x => x.id === mm[1]); if (!u) fail(404, '用户不存在');
      if (m === 'PUT') {
        const b = await readBody(req);
        if (u.id === user.id && (b.role === 'user' || b.disabled)) fail(400, '不能降级或停用自己');
        if (b.role) u.role = b.role === 'admin' ? 'admin' : 'user';
        if (typeof b.disabled === 'boolean') u.disabled = b.disabled;
        if (b.perms) u.perms = sanitizePerms(b.perms);
        if (b.password) { if (String(b.password).length < 6) fail(400, '密码至少 6 位'); Object.assign(u, hashPassword(b.password)); }
        if (u.disabled) for (const [k, s] of sessions) if (s.userId === u.id) sessions.delete(k);
        usersDirty = true; return send(res, 200, { user: publicUser(u) });
      }
      if (m === 'DELETE') {
        if (u.id === user.id) fail(400, '不能删除自己');
        users = users.filter(x => x !== u); usersDirty = true;
        for (const [k, s] of sessions) if (s.userId === u.id) sessions.delete(k);
        return send(res, 200, { ok: true });
      }
    }
  }
  if (p === '/api/agent-token/rotate' && m === 'POST') {
    if (!isAdmin) fail(403, '需要管理员');
    config.agentToken = crypto.randomBytes(24).toString('base64url');
    writeJSONAtomic(files.config, config);
    return send(res, 200, { agentToken: config.agentToken });
  }

  fail(404, 'no route');
}

function visibleAgents(user) {
  return [...agents.values()].filter(a => allow(user.perms.agents, a.name)).map(a => {
    const pa = publicAgent(a);
    if (user.role !== 'admin') {
      pa.workspaces = pa.workspaces.filter(w => allow(user.perms.workspaces, w.name));
      pa.clis = Object.fromEntries(Object.entries(pa.clis).filter(([k]) => allow(user.perms.clis, k)));
    }
    return pa;
  });
}
function sanitizePerms(p) {
  const arr = v => Array.isArray(v) ? v.map(String).filter(Boolean).slice(0, 50) : ['*'];
  return {
    clis: arr(p.clis), agents: arr(p.agents), workspaces: arr(p.workspaces),
    maxLevel: LEVELS.includes(p.maxLevel) ? p.maxLevel : 'read',
    dailyLimit: Math.max(0, Math.min(100000, Number(p.dailyLimit) || 0)),
  };
}
function sanitizeOutputs(list, t) {
  const str = (v, n) => String(v ?? '').slice(0, n);
  return (Array.isArray(list) ? list : []).slice(0, 200).map(f => {
    const stored = !!(f.id && /^f_[0-9a-f]{12}$/.test(f.id) && fs.existsSync(blobPath(f.id)));
    return {
      id: stored ? f.id : newId('f'), kind: 'output', stored, taskId: t.id,
      path: str(f.path, 500), name: str(f.name || path.basename(String(f.path || 'file')), 200),
      mime: str(f.mime || 'application/octet-stream', 100), size: Number(f.size) || 0,
      change: ['add', 'modify', 'delete', 'ref'].includes(f.change) ? f.change : 'add',
      diff: f.diff ? str(f.diff, 80000) : undefined, diffStat: f.diffStat || undefined,
      note: f.note ? str(f.note, 200) : undefined,
    };
  });
}
function checkRunPerms(user, b) {
  const a = agents.get(b.agent);
  if (!a) fail(400, '执行端不存在或从未上线');
  if (!allow(user.perms.agents, b.agent)) fail(403, '无权使用这台设备');
  if (!allow(user.perms.clis, b.cli)) fail(403, `无权使用 ${b.cli}`);
  if (!a.clis[b.cli]?.ok) fail(400, `这台设备上 ${b.cli} 不可用`);
  if (!a.workspaces.some(w => w.name === b.workspace)) fail(400, '工作目录不存在');
  if (!allow(user.perms.workspaces, b.workspace)) fail(403, '无权使用这个工作目录');
  if (!levelAllowed(user, b.level)) fail(403, `权限级别超出（你最高：${user.perms.maxLevel}）`);
  const ws = a.workspaces.find(w => w.name === b.workspace);
  if (ws.maxLevel && LEVELS.indexOf(b.level) > LEVELS.indexOf(ws.maxLevel)) fail(403, `这个目录最高只允许 ${ws.maxLevel}`);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    if (res.headersSent) return res.end();
    const code = err instanceof HttpError ? err.code : 500;
    if (code === 500) console.error(err);
    send(res, code, { error: err.message || '服务器错误' });
  });
});
server.requestTimeout = 0; // 长轮询/SSE 需要
server.listen(PORT, HOST, () => {
  console.log(`[relay] 已启动 http://${HOST}:${PORT}`);
  console.log(`[relay] agent token: ${config.agentToken}`);
});
module.exports = { server, config };
