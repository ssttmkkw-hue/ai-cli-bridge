// 冒烟测试：只用「模拟 CLI」，不花任何额度。
// 先启动本地联调：npm run local   然后另开终端：node dev/smoke-test.mjs
// 管理员密码默认从 data/INITIAL_ADMIN.txt 读取，改过密码的话用环境变量 ADMIN_PASSWORD 传入。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const B = process.env.RELAY_URL || 'http://127.0.0.1:5227';
const AGENT = process.env.AGENT_NAME || 'local-dev';
const WS = process.env.WORKSPACE || '沙盒';
let pw = process.env.ADMIN_PASSWORD;
if (!pw) {
  try { pw = fs.readFileSync(path.join(ROOT, 'data', 'INITIAL_ADMIN.txt'), 'utf8').match(/初始密码: (\S+)/)[1]; }
  catch { console.error('找不到管理员密码：请设置 ADMIN_PASSWORD'); process.exit(1); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, failN = 0;
const ok = (cond, name, extra = '') => { if (cond) pass++; else failN++; console.log(`${cond ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`); };

async function login(u, p) {
  const r = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
  return r.ok ? r.headers.get('set-cookie').split(';')[0] : null;
}
const client = ck => async (m, u, b, extraHeaders) => {
  const r = await fetch(B + u, { method: m, headers: { 'Content-Type': 'application/json', cookie: ck, ...(extraHeaders || {}) },
    body: b instanceof Uint8Array || typeof b === 'string' ? b : b ? JSON.stringify(b) : m !== 'GET' ? '{}' : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, j };
};
async function waitTask(api, id, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const { j } = await api('GET', '/api/tasks/' + id);
    if (j?.task && ['done', 'failed', 'cancelled'].includes(j.task.status)) return j.task;
    await sleep(300);
  }
  return null;
}

const A = client(await login('admin', pw));
const { j: ag } = await A('GET', '/api/agents');
const agent = ag?.agents?.find(a => a.name === AGENT);
ok(agent?.online, `执行端 ${AGENT} 在线`);
ok(agent?.clis?.mock?.ok, '模拟 CLI 可用（agent 配置里 mock.enabled = true）');
if (!agent?.online || !agent?.clis?.mock?.ok) process.exit(1);

// 1. 基本对话 + 上下文续接
const conv = (await A('POST', '/api/convs', { agent: AGENT, cli: 'mock', workspace: WS, level: 'edit', title: '冒烟测试' })).j.conv;
const t1 = (await A('POST', `/api/convs/${conv.id}/send`, { prompt: '你好' })).j.task;
const t2 = (await A('POST', `/api/convs/${conv.id}/send`, { prompt: '第二句' })).j.task;
const r1 = await waitTask(A, t1.id), r2 = await waitTask(A, t2.id);
ok(r1?.status === 'done', '第一条完成');
ok(r2?.status === 'done' && r2.resumeSessionId === r1.sessionId, '第二条续接了第一条的会话');

// 2. 停止：连点 5 下只产生一条提示，且很快停下
const t3 = (await A('POST', `/api/convs/${conv.id}/send`, { prompt: '慢一点 slow' })).j.task;
for (let i = 0; i < 40; i++) { if ((await A('GET', '/api/tasks/' + t3.id)).j.task.status === 'running') break; await sleep(200); }
await sleep(800);
const s0 = Date.now();
await Promise.all(Array.from({ length: 5 }, () => A('POST', `/api/tasks/${t3.id}/cancel`)));
const r3 = await waitTask(A, t3.id, 15000);
const stopSecs = (Date.now() - s0) / 1000;
ok(r3?.status === 'cancelled', '停止生效', `${stopSecs.toFixed(1)}s`);
ok(r3?.events.filter(e => e.k === 'info' && /停止/.test(e.d)).length === 1, '连点只出现一条停止提示');
const t4 = (await A('POST', `/api/convs/${conv.id}/send`, { prompt: '停止后再发' })).j.task;
ok((await waitTask(A, t4.id))?.status === 'done', '停止后同一对话还能继续');

// 3. 附件上传 + 产出文件 + 改动对比 + Markdown 引用
const up = await A('POST', '/api/uploads', 'hello 附件', { 'Content-Type': 'application/octet-stream', 'X-Upload': '1', 'X-Conv': conv.id, 'X-Name': encodeURIComponent('note.txt'), 'X-Mime': 'text/plain' });
ok(up.status === 200, '上传附件');
const t5 = (await A('POST', `/api/convs/${conv.id}/send`, { prompt: '生成文件', attachments: [up.j.file.id] })).j.task;
const r5 = await waitTask(A, t5.id);
ok(r5?.events.some(e => e.k === 'text' && e.d.includes('note.txt')), 'CLI 收到了附件路径');
const outNames = (r5?.outputs || []).map(o => o.name);
ok(['chart.svg', 'report.html', 'notes.md'].every(n => outNames.includes(n)), '产出文件被收集', outNames.join(', '));
ok(r5?.linkMap?.['./chart.svg'], '回答里的本地图片被映射成可访问地址');
const t6 = (await A('POST', `/api/convs/${conv.id}/send`, { prompt: '再改一次文件' })).j.task;
const r6 = await waitTask(A, t6.id);
const notes = r6?.outputs?.find(o => o.name === 'notes.md');
ok(notes?.change === 'modify' && notes.diff?.includes('+新增一行'), '修改的文件带改动对比');
const svg = r5.outputs.find(o => o.name === 'chart.svg');
const html = r5.outputs.find(o => o.name === 'report.html');
const fsvg = await fetch(B + '/api/files/' + svg.id, { headers: { cookie: (await login('admin', pw)) } });
ok(fsvg.status === 200 && fsvg.headers.get('content-security-policy')?.includes('sandbox'), 'SVG 带沙盒响应头');
ok((await fetch(B + '/api/files/' + html.id)).status === 401, '未登录拿不到文件');

// 4. 权限隔离
const stamp = Date.now().toString(36);
const name = 'smoke' + stamp;
await A('POST', '/api/users', { username: name, password: 'smoke123', perms: { clis: ['mock'], agents: ['*'], workspaces: [WS], maxLevel: 'read', dailyLimit: 1 } });
const U = client(await login(name, 'smoke123'));
ok((await U('GET', '/api/agents')).j.agentToken === undefined, '普通用户看不到 agent token');
ok((await U('POST', '/api/convs', { agent: AGENT, cli: 'mock', workspace: WS, level: 'edit' })).status === 403, '超出权限级别被拒');
ok((await U('GET', '/api/files/' + html.id)).status === 404, '看不到别人的文件');
ok((await U('GET', '/api/users')).status === 403, '普通用户不能管理用户');
const uc = (await U('POST', '/api/convs', { agent: AGENT, cli: 'mock', workspace: WS, level: 'read' })).j.conv;
await U('POST', `/api/convs/${uc.id}/send`, { prompt: 'a' });
ok((await U('POST', `/api/convs/${uc.id}/send`, { prompt: 'b' })).status === 429, '每日额度生效');
ok((await fetch(B + '/api/convs', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status === 415, '非 JSON 写请求被拒（防 CSRF）');
ok((await fetch(B + '/api/agent/poll?name=x', { headers: { Authorization: 'Bearer nope' } })).status === 401, '错误的 agent token 被拒');

// 清理
const uid = (await A('GET', '/api/users')).j.users.find(u => u.username === name).id;
await A('DELETE', '/api/users/' + uid);
await A('DELETE', '/api/convs/' + uc.id);
await A('DELETE', '/api/convs/' + conv.id);

console.log(`\n${pass} 项通过，${failN} 项失败`);
process.exit(failN ? 1 : 0);
