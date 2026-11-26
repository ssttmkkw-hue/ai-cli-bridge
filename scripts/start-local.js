// 本地联调：同时启动中继 + 一个本机 agent（Windows 上测试用，Mac 上也可以直接这样跑）
'use strict';
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const port = process.argv[2] || '5227';

const localCfg = path.join(ROOT, 'agent', 'agent.local.json');
if (!fs.existsSync(localCfg)) {
  fs.writeFileSync(localCfg, JSON.stringify({
    name: 'local-dev',
    relayUrl: `http://127.0.0.1:${port}`,
    maxConcurrent: 3,
    clis: { claude: { bin: 'auto', models: ['sonnet', 'opus', 'haiku'] }, codex: { bin: 'auto' }, mock: { enabled: true } },
    workspaces: [
      // 沙盒：每个对话独立子文件夹，可以同时跑；只读：共用一个目录，同一时间只跑一个任务
      { name: '沙盒', path: path.join(ROOT, 'test-workspaces', 'sandbox'), maxLevel: 'full', isolate: true, note: '测试用目录' },
      { name: '只读', path: path.join(ROOT, 'test-workspaces', 'readonly'), maxLevel: 'read', note: '只读' },
    ],
  }, null, 2));
}

const relay = spawn(process.execPath, [path.join(ROOT, 'relay', 'server.js'), port], { stdio: 'inherit' });
let agent;
setTimeout(() => {
  agent = spawn(process.execPath, [path.join(ROOT, 'agent', 'agent.js'), localCfg], { stdio: 'inherit' });
}, 800);
const stop = () => { relay.kill(); agent?.kill(); setTimeout(() => process.exit(0), 300); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
relay.on('exit', c => { agent?.kill(); process.exit(c ?? 0); });
