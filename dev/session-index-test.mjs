// node --test dev/session-index-test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import recovery from '../agent/session-index.js';

function fixture(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-index-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ws = { name: 'demo', path: path.join(tmp, 'work'), isolate: true };
  const id = 'c_abcdef123456', sessionId = randomUUID();
  const task = { convId: id, ownerKey: 'lease1', username: 'admin', cli: 'claude', workspace: 'demo', level: 'edit', revision: 0 };
  const dir = path.join(ws.path, 'admin', id);
  fs.mkdirSync(dir, { recursive: true });
  const projects = path.join(tmp, 'projects');
  const load = () => new recovery.SessionIndex(path.join(tmp, 'index.json'), [ws], projects);
  const pr = { key: id, ownerKey: 'lease1', username: 'admin', workspaces: ['demo'] };
  function transcript(sid, cwd = dir) {
    const project = path.join(projects, dir.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, sid + '.jsonl'), JSON.stringify({ sessionId: sid, cwd }) + '\n');
  }
  return { dir, id, sessionId, task, load, pr, transcript };
}

test('索引可在重启后按两种 ID 找回，校验租期和原目录', async t => {
  const { dir, sessionId, task, load, pr } = fixture(t);
  load().remember(task, dir, sessionId);
  for (const key of [task.convId, sessionId]) {
    assert.equal((await load().lookup({ ...pr, key })).conv.sessionId, sessionId);
    assert.equal(await load().lookup({ ...pr, key, ownerKey: 'new-lease' }), null);
  }
  fs.renameSync(dir, dir + '-moved');
  await assert.rejects(load().lookup(pr), /工作目录/);
});

test('清空与删除记录不会被迟到的 CLI 事件或旧 transcript 覆盖', async t => {
  const { dir, id, sessionId, task, load, pr, transcript } = fixture(t);
  const index = load();
  index.remember(task, dir, sessionId);
  transcript(sessionId);
  for (const remove of [false, true]) {
    index.forget({ ...pr, convId: id, revision: 1, remove });
    index.remember(task, dir, sessionId);
    assert.equal(await load().lookup({ ...pr, legacyAdmin: true }), null);
    if (!remove) {
      index.remember({ ...task, revision: 1 }, dir, randomUUID());
      assert.ok(await load().lookup(pr));
    }
  }
});

test('旧版管理员目录：唯一会话恢复，多条显式选择，忽略其他目录和访客', async t => {
  const { dir, sessionId, load, pr, transcript } = fixture(t);
  transcript(sessionId);
  transcript(randomUUID(), dir + '-other');
  assert.equal(await load().lookup(pr), null);
  const admin = { ...pr, legacyAdmin: true };
  assert.equal((await load().lookup(admin)).conv.sessionId, sessionId);
  // 模拟另一个尚未建立索引的老版本目录。
  fs.unlinkSync(load().file);
  const another = randomUUID();
  transcript(another);
  assert.equal((await load().lookup(admin)).choices.length, 2);
  const chosen = await load().lookup({ ...admin, choice: { workspace: 'demo', sessionId: another } });
  assert.equal(chosen.conv.sessionId, another);
});

test('恢复列表只返回本账号、本租期、有权限的会话摘要', t => {
  const { dir, id, sessionId, task, load, pr } = fixture(t);
  const scope = { ...pr, clis: ['claude'] };
  const index = load();
  index.remember({ ...task, title: '续写网页' }, dir, sessionId);
  const [row] = load().list(scope);
  assert.ok(row.lastUsedAt > 0);
  assert.deepEqual(row, { id, title: '续写网页', lastUsedAt: row.lastUsedAt });
  for (const change of [{ username: 'other' }, { ownerKey: 'next-lease' }, { clis: [] }, { workspaces: [] }]) {
    assert.deepEqual(index.list({ ...scope, ...change }), []);
  }
  delete index.rows[id].lastUsedAt;
  assert.equal(index.list(scope)[0].lastUsedAt, null);
  index.forget({ ...pr, convId: id, revision: 1, remove: true });
  assert.deepEqual(load().list(scope), []);
});
