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

// 1b. 实时推送的文本和最终保存的一致（工具调用后同一批多段文本曾被重复推送）
{
  const ctl = new AbortController();
  const es = await fetch(B + '/api/stream', { headers: { cookie: await login('admin', pw) }, signal: ctl.signal });
  let live = '', sseBuf = '', taskId = null;
  const pending = [];
  const reading = (async () => {
    const dec = new TextDecoder();
    try {
      for await (const part of es.body) {
        sseBuf += dec.decode(part, { stream: true });
        let i;
        while ((i = sseBuf.indexOf('\n\n')) >= 0) {
          const block = sseBuf.slice(0, i); sseBuf = sseBuf.slice(i + 2);
          if (!block.startsWith('event: chunk')) continue;
          const d = JSON.parse(block.slice(block.indexOf('data: ') + 6));
          if (taskId === null) pending.push(d); else if (d.taskId === taskId) for (const e of d.events) if (e.k === 'text') live += e.d;
        }
      }
    } catch {}
  })();
  const ts = (await A('POST', `/api/convs/${conv.id}/send`, { prompt: '分段回复' })).j.task;
  taskId = ts.id;
  for (const d of pending.splice(0)) if (d.taskId === taskId) for (const e of d.events) if (e.k === 'text') live += e.d;
  const rs = await waitTask(A, ts.id);
  await sleep(300); ctl.abort(); await reading;
  const stored = (rs?.events || []).filter(e => e.k === 'text').map(e => e.d).join('');
  ok(rs?.status === 'done' && stored.includes('第4段') && live === stored, '实时推送的文本与保存的一致（不重复）', live === stored ? '' : `实时 ${live.length} 字 / 保存 ${stored.length} 字`);
}

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

// 3a. 对话备份：zip 里有离线查看页、原始数据、产出文件和附件
{
  const zipNames = buf => { // 读 zip 末尾的中央目录，列出所有文件名
    const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) return null;
    const n = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16); const names = [];
    for (let i = 0; i < n; i++) { const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32); names.push(buf.slice(p + 46, p + 46 + nl).toString('utf8')); p += 46 + nl + el + cl; }
    return names;
  };
  const r = await fetch(`${B}/api/convs/${conv.id}/export`, { headers: { cookie: await login('admin', pw) } });
  const buf = Buffer.from(await r.arrayBuffer());
  const names = (zipNames(buf) || []).map(n => n.replace(/^[^/]+\//, ''));
  ok(r.status === 200 && r.headers.get('content-type') === 'application/zip' && ['index.html', 'data.json', 'README.txt'].every(n => names.includes(n)), '对话备份：zip 里有离线查看页和原始数据', `${names.length} 个文件`);
  ok(['chart.svg', 'report.html', 'notes.md'].every(f => names.some(n => n.startsWith('c01/files/') && n.endsWith('/' + f) || n === 'c01/files/' + f)) && names.some(n => n.startsWith('c01/attachments/')), '对话备份：产出文件和附件都打包了');
  ok((await fetch(`${B}/api/convs/${conv.id}/export`)).status === 401 && (await fetch(`${B}/api/export`)).status === 401, '对话备份：未登录不能下载');
}

// 3b. 并发与产出归属：产出靠「任务前后目录对比」收集，不能串到别的任务（可能是别的用户）
//   - 开了 isolate 的目录：每个对话独立子文件夹，可以同时跑
//   - 共用的目录：同一时间只跑一个，后来的排队
{
  const SLOW = '生成文件 慢一点'; // 模拟 CLI：先写 chart.svg / report.html / notes.md，再跑 10 秒
  const FILES = ['chart.svg', 'report.html', 'notes.md'];
  const conv = async (workspace, level, title) => (await A('POST', '/api/convs', { agent: AGENT, cli: 'mock', workspace, level, title })).j.conv;
  const send = async (c, prompt) => (await A('POST', `/api/convs/${c.id}/send`, { prompt })).j.task;
  const untilRunning = async id => { for (let i = 0; i < 40; i++) { if ((await A('GET', '/api/tasks/' + id)).j.task.status === 'running') return; await sleep(200); } };
  const noForeign = r => !(r?.outputs || []).some(o => FILES.includes(o.name));
  const wsOf = n => agent.workspaces?.find(w => w.name === n);

  // 独立子文件夹：同一目录 3 个任务同时跑
  if (wsOf(WS)?.isolate) {
    const [ca, cb, cc] = [await conv(WS, 'edit', '并发A'), await conv(WS, 'edit', '并发B'), await conv(WS, 'edit', '并发C')];
    const ta = await send(ca, SLOW); await untilRunning(ta.id);
    const [tb, tc] = [await send(cb, '你好'), await send(cc, '你好')];
    const [rb, rc] = [await waitTask(A, tb.id, 8000), await waitTask(A, tc.id, 8000)];
    const aMid = (await A('GET', '/api/tasks/' + ta.id)).j.task.status;
    ok(rb?.status === 'done' && rc?.status === 'done' && aMid === 'running', '独立子文件夹：同一目录 3 个任务同时跑', `A 还在 ${aMid}`);
    ok(noForeign(rb) && noForeign(rc), '独立子文件夹：产出不串到别的对话');
    await A('POST', `/api/tasks/${ta.id}/cancel`); await waitTask(A, ta.id, 15000);
    for (const c of [ca, cb, cc]) await A('DELETE', '/api/convs/' + c.id);
  } else console.log('- 跳过独立子文件夹测试：', WS, '没开 isolate');

  // 共用目录：后来的排队，开始后也不会把前一个的文件算成自己的
  const SHARED = process.env.WORKSPACE2 || '只读';
  if (wsOf(SHARED) && !wsOf(SHARED).isolate) {
    const [ca, cb] = [await conv(SHARED, 'read', '排队A'), await conv(SHARED, 'read', '排队B')];
    const ta = await send(ca, SLOW); await untilRunning(ta.id);
    const tb = await send(cb, '你好');
    await sleep(1500);
    const bMid = (await A('GET', '/api/tasks/' + tb.id)).j.task;
    ok(bMid.status === 'queued' && bMid.waitingFor === 'workspace', '共用目录：第二个任务排队并说明原因', bMid.status);
    await A('POST', `/api/tasks/${ta.id}/cancel`);
    const ra = await waitTask(A, ta.id, 15000), rb = await waitTask(A, tb.id);
    ok(rb?.status === 'done' && rb.startedAt >= ra.endedAt && noForeign(rb), '共用目录：排队任务没把前一个任务的文件算成产出', (rb?.outputs || []).map(o => o.name).join(', '));
    for (const c of [ca, cb]) await A('DELETE', '/api/convs/' + c.id);
  } else console.log('- 跳过共用目录排队测试：没有名为', SHARED, '的共用目录（可用 WORKSPACE2 指定）');
}

// 3c. 文件夹限制（macOS）：所有级别都只能访问自己的文件夹
if (agent.confine && agent.workspaces?.find(w => w.name === WS)?.isolate) {
  const outside = path.join(ROOT, 'README.md'); // 项目目录，不在任何用户的文件夹里
  const probe = async (level, prompt) => {
    const c = (await A('POST', '/api/convs', { agent: AGENT, cli: 'mock', workspace: WS, level, title: '文件夹限制' })).j.conv;
    const r = await waitTask(A, (await A('POST', `/api/convs/${c.id}/send`, { prompt })).j.task.id);
    await A('DELETE', '/api/convs/' + c.id);
    return { text: (r?.events || []).filter(e => e.k === 'text').map(e => e.d).join(''), info: (r?.events || []).filter(e => e.k === 'info').map(e => e.d).join(' ') };
  };
  const e = await probe('edit', `读取:${outside} 写入:../../escape-${Date.now()}.txt 写入:../mine.txt 写入:./own.txt 读取:./own.txt`);
  ok(/文件访问限制在/.test(e.info), '可改文件级别启用了文件夹限制', e.info.match(/文件访问限制在：\S+/)?.[0]);
  ok(e.text.includes(`读取 ${outside}：失败 EPERM`) && /写入 \.\.\/\.\.\/escape-\d+\.txt：失败 EPERM/.test(e.text), '读写自己文件夹以外的文件被系统拒绝');
  ok(e.text.includes('写入 ../mine.txt：成功') && e.text.includes('写入 ./own.txt：成功') && e.text.includes('读取 ./own.txt：成功'), '自己的文件夹（含同用户的其他对话）可以正常读写');
  const esc = ['/usr/bin/open', '/usr/bin/osascript', '/bin/launchctl'];
  const f = await probe('full', `读取:${outside} 写入:./full.txt ${esc.map(p => '执行:' + p).join(' ')} 执行:/bin/ls`);
  ok(f.text.includes(`读取 ${outside}：失败 EPERM`) && f.text.includes('写入 ./full.txt：成功') && /文件访问限制在/.test(f.info), '完全放开级别也只能访问自己的文件夹');
  ok(esc.every(p => f.text.includes(`执行 ${p}：失败`)) && f.text.includes('执行 /bin/ls：成功'), '沙盒里不能用 open / osascript / launchctl 绕出去，普通命令照常');
} else console.log('- 跳过文件夹限制测试：', agent.confine ? `${WS} 没开 isolate` : '这台设备没开文件夹限制（只支持 macOS）');

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
