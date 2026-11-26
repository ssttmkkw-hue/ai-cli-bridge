// 环境变量账号测试：起一个临时中继（数据放系统临时目录，测完删掉），检查 ADMIN_PASSWORD / GUESTn_PASSWORD / GUESTn_NAME。
// 用法：node dev/env-accounts-test.mjs     （不需要先启动别的服务，不花额度）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aib-env-test-'));
const PORT = 5297, B = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, failN = 0;
const ok = (c, name, extra = '') => { c ? pass++ : failN++; console.log(`${c ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`); };

async function relay(env) {
  const child = spawn(process.execPath, [path.join(ROOT, 'relay', 'server.js')], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(PORT), RELAY_DATA: DATA, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', d => (log += d)); child.stderr.on('data', d => (log += d));
  for (let i = 0; i < 50 && !log.includes('已启动'); i++) await sleep(100);
  return { stop: async () => { child.kill(); await new Promise(r => child.on('exit', r)); }, log: () => log };
}
const login = async (u, p) => {
  const r = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, cookie: r.headers.get('set-cookie')?.split(';')[0], user: j.user };
};
const call = async (ck, m, u, b) => {
  const r = await fetch(B + u, { method: m, headers: { 'Content-Type': 'application/json', cookie: ck }, body: b ? JSON.stringify(b) : m !== 'GET' ? '{}' : undefined });
  return { status: r.status, j: await r.json().catch(() => ({})) };
};

try {
  // ---- 第一次启动
  let r = await relay({ ADMIN_PASSWORD: 'admin-pass-1', GUEST1_PASSWORD: 'guest1-pass-1', GUEST2_PASSWORD: 'guest2-pass-1', GUEST2_NAME: '妈妈', GUEST3_PASSWORD: 'short',
    GUEST4_PASSWORD: 'guest4-pass ', GUEST5_PASSWORD: 'guest5-pass-1', GUEST5_NAME: 'my mom' });
  const admin = await login('admin', 'admin-pass-1');
  const g1 = await login('guest1', 'guest1-pass-1');
  const mom = await login('妈妈', 'guest2-pass-1');
  ok(admin.status === 200 && g1.status === 200 && mom.status === 200, '管理员、guest1、改了名的 guest2（妈妈）都能用环境变量里的密码登录');
  ok((await login('guest3', 'short')).status === 401 && r.log().includes('GUEST3_PASSWORD 太短'), '密码太短（< 8 位）的 GUEST3 不创建，日志里有提示');
  const warns = (await call(admin.cookie, 'GET', '/api/users')).j.envWarnings || [];
  ok(warns.some(w => w.includes('GUEST3_PASSWORD 太短')) && warns.some(w => w.includes('GUEST4_PASSWORD') && w.includes('空格')) && warns.some(w => w.includes('GUEST5_NAME「my mom」不合法')),
    '用户权限页能看到环境变量账号的问题（太短、多了空格、用户名不合法）', `${warns.length} 条`);
  ok((await login('guest4', 'guest4-pass ')).status === 200 && (await login('guest4', 'guest4-pass')).status === 401, '密码末尾的空格算密码的一部分（所以要提示）');
  ok((await call(g1.cookie, 'GET', '/api/users')).status === 403, '非管理员看不到这些提示');
  const p = g1.user?.perms || {};
  ok(g1.user?.role === 'user' && g1.user?.env === 'GUEST1' && p.maxLevel === 'edit' && p.clis.join() === 'claude' && p.dailyLimit === 50,
    'guest 默认权限：成员、只能用 Claude、最高「可改文件」、每天 50 条', JSON.stringify(p));
  ok((await call(g1.cookie, 'POST', '/api/me/password', { old: 'guest1-pass-1', password: 'changed-123' })).status === 400, 'guest 不能在网页上改自己的密码');
  ok((await call(admin.cookie, 'PUT', '/api/users/' + g1.user.id, { password: 'changed-123' })).status === 400
    && (await call(admin.cookie, 'DELETE', '/api/users/' + g1.user.id)).status === 400, '管理员也不能在网页上重置 / 删除环境变量账号');
  ok((await call(admin.cookie, 'PUT', '/api/users/' + g1.user.id, { perms: { ...p, dailyLimit: 10 } })).j.user?.perms?.dailyLimit === 10, '环境变量账号的权限可以在网页上调整');
  const web = await call(admin.cookie, 'POST', '/api/users', { username: 'friend', password: 'friend-123', perms: { clis: ['claude'], maxLevel: 'read' } });
  ok(web.status === 200 && (await login('friend', 'friend-123')).status === 200, '网页上新建普通账号照常可用');
  await sleep(2500); // 等登录会话写进磁盘，模拟重启后还在
  await r.stop();

  // ---- 第二次启动：改 guest1 密码、删掉 guest2、改管理员密码
  r = await relay({ ADMIN_PASSWORD: 'admin-pass-2', GUEST1_PASSWORD: 'guest1-pass-2' });
  ok((await call(g1.cookie, 'GET', '/api/me')).status === 401, 'guest1 改了密码：之前登录的设备被踢下线');
  ok((await login('guest1', 'guest1-pass-1')).status === 401 && (await login('guest1', 'guest1-pass-2')).status === 200, 'guest1：旧密码不能用，新密码能登录');
  ok((await login('妈妈', 'guest2-pass-1')).status === 401 && r.log().includes('账号 妈妈 已停用'), '删掉 GUEST2_PASSWORD 后，「妈妈」账号停用');
  ok((await login('admin', 'admin-pass-1')).status === 401 && (await login('admin', 'admin-pass-2')).status === 200, '管理员密码也以环境变量为准');
  ok((await login('friend', 'friend-123')).status === 200, '网页上建的普通账号不受影响');
  await r.stop();

  // ---- 第三次启动：把 GUEST2 加回来
  r = await relay({ ADMIN_PASSWORD: 'admin-pass-2', GUEST1_PASSWORD: 'guest1-pass-2', GUEST2_PASSWORD: 'guest2-pass-3', GUEST2_NAME: '妈妈' });
  ok((await login('妈妈', 'guest2-pass-3')).status === 200, '把 GUEST2_PASSWORD 加回来，账号重新启用');
  await r.stop();
} finally {
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(`\n${pass} 项通过，${failN} 项失败`);
  process.exit(failN ? 1 : 0);
}
