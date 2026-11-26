// Mac 端保存网页对话与 CLI 会话的对应关系。索引跟随 agent 配置，放在用户项目之外。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const WEB_ID = /^c_[0-9a-f]{12}$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function originalDirectory(ws, username, id) {
  if (!ws || !WEB_ID.test(id)) return null;
  if (ws.isolate && (!username || username === '..' || path.basename(username) !== username)) return null;
  const root = fs.realpathSync(ws.path);
  const dir = ws.isolate ? path.join(root, username, id) : root;
  return fs.existsSync(dir) && fs.realpathSync(dir) === dir && fs.statSync(dir).isDirectory() ? dir : null;
}

// 旧版没有索引。只在管理员自己的独立目录里核实 transcript 里的工作目录与 UUID。
async function matchesTranscript(file, dirs, sessionId) {
  const input = fs.createReadStream(file, { flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW, end: 1024 * 1024 - 1 });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.sessionId === sessionId && dirs.includes(o.cwd)) return true;
    }
    return false;
  } finally { lines.close(); input.destroy(); }
}

class SessionIndex {
  constructor(file, workspaces, projects) {
    this.file = file;
    this.workspaces = workspaces;
    this.projects = projects;
    this.rows = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  }
  save(id, row) {
    const rows = { ...this.rows, [id]: row };
    const tmp = this.file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(rows), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.rows = rows;
  }
  remember(t, dir, sessionId) {
    if (!t.ownerKey || !WEB_ID.test(t.convId) || !UUID.test(sessionId)) return;
    const old = this.rows[t.convId];
    if (old && (old.deleted || old.ownerKey !== t.ownerKey || old.revision > t.revision)) return;
    this.save(t.convId, { id: t.convId, ownerKey: t.ownerKey, username: t.username, cli: t.cli, level: t.level,
      model: t.model, workspace: t.workspace, title: t.title, revision: t.revision, sessionId, dir: fs.realpathSync(dir) });
  }
  forget(pr) {
    const old = this.rows[pr.convId];
    if (!WEB_ID.test(pr.convId) || (old && old.ownerKey !== pr.ownerKey)) throw Error('对话归属不匹配');
    if (old?.deleted || old?.revision > pr.revision) return;
    this.save(pr.convId, { ownerKey: pr.ownerKey, revision: pr.revision, deleted: pr.remove, sessionId: null });
  }
  async lookup(pr) {
    const row = WEB_ID.test(pr.key) ? this.rows[pr.key] : Object.values(this.rows).find(r => r.ownerKey === pr.ownerKey && r.sessionId === pr.key);
    if (row) {
      if (row.ownerKey !== pr.ownerKey || !row.sessionId || row.username !== pr.username) return null;
      const ws = this.workspaces.find(w => w.name === row.workspace);
      if (originalDirectory(ws, row.username, row.id) !== row.dir) throw Error('原工作目录已移动或丢失');
      const { ownerKey, dir, ...conv } = row;
      return { conv };
    }
    if (!pr.legacyAdmin || !WEB_ID.test(pr.key)) return null;
    const candidates = [];
    for (const ws of this.workspaces.filter(w => w.isolate && pr.workspaces.includes(w.name))) {
      const dir = originalDirectory(ws, pr.username, pr.key);
      if (!dir) continue;
      const dirs = [...new Set([dir, path.join(ws.path, pr.username, pr.key)])];
      for (const cwd of dirs) {
        const project = path.join(this.projects, cwd.replace(/[^a-zA-Z0-9]/g, '-'));
        if (!fs.existsSync(project) || !fs.lstatSync(project).isDirectory()) continue;
        for (const entry of fs.readdirSync(project, { withFileTypes: true })) {
          const sessionId = entry.name.replace(/\.jsonl$/, '');
          if (!entry.isFile() || !entry.name.endsWith('.jsonl') || !UUID.test(sessionId)) continue;
          const file = path.join(project, entry.name);
          if (!await matchesTranscript(file, dirs, sessionId)) continue;
          if (!candidates.some(c => c.workspace === ws.name && c.sessionId === sessionId))
            candidates.push({ workspace: ws.name, sessionId, at: fs.statSync(file).mtimeMs });
        }
      }
    }
    // 扫描期间另一个请求可能已经选择、删除或清空了这段对话。
    if (this.rows[pr.key]) return this.lookup(pr);
    if (!candidates.length) return null;
    const hit = pr.choice ? candidates.find(c => c.workspace === pr.choice.workspace && c.sessionId === pr.choice.sessionId) :
      candidates.length === 1 ? candidates[0] : null;
    if (!hit) return { choices: candidates.sort((a,b) => b.at - a.at) };
    const ws = this.workspaces.find(w => w.name === hit.workspace);
    const dir = originalDirectory(ws, pr.username, pr.key);
    if (!dir) throw Error('原工作目录已变化');
    const task = { convId: pr.key, ownerKey: pr.ownerKey, username: pr.username, workspace: hit.workspace,
      cli: 'claude', level: 'edit', revision: 0, title: '找回的旧对话', model: null };
    this.remember(task, dir, hit.sessionId);
    return this.lookup(pr);
  }
}
module.exports = { SessionIndex, originalDirectory, WEB_ID, UUID };
