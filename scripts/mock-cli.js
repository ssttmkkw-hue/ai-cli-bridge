// 假 CLI：输出和 codex --json 同格式的事件，用来不花额度地测试整条链路
'use strict';
const crypto = require('crypto');
const args = process.argv.slice(2);
const ri = args.indexOf('--resume');
const thread = ri >= 0 ? args[ri + 1] : crypto.randomUUID();
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => (input += d));
process.stdin.on('end', async () => {
  const out = o => process.stdout.write(JSON.stringify(o) + '\n');
  const wait = ms => new Promise(r => setTimeout(r, ms));
  out({ type: 'thread.started', thread_id: thread });
  out({ type: 'turn.started' });
  if (/fail|报错/.test(input)) { out({ type: 'turn.failed', error: { message: '模拟失败' } }); process.exit(1); }
  out({ type: 'item.started', item: { type: 'command_execution', command: 'ls -la' } });
  await wait(400);
  out({ type: 'item.completed', item: { type: 'command_execution', command: 'ls -la', aggregated_output: 'README.md\nsrc/\n', exit_code: 0 } });
  // 产出文件：测试「文件通道」
  let extra = '';
  if (/文件|file/i.test(input)) {
    const fs = require('fs');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#eef4ff"/>${[60, 120, 90, 150, 40].map((h, i) => `<rect x="${30 + i * 55}" y="${160 - h}" width="36" height="${h}" fill="#3b82f6"/>`).join('')}</svg>`;
    fs.writeFileSync('chart.svg', svg);
    fs.writeFileSync('report.html', `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:20px"><h2>模拟报告</h2><p id="t">脚本运行中…</p><script>let c;try{c='读到了 cookie（不安全！）'+document.cookie}catch(e){c='✓ 脚本能运行，但读取本站 cookie 被浏览器拒绝（沙盒隔离生效）'}document.getElementById('t').textContent=c</script></body>`);
    const old = fs.existsSync('notes.md') ? fs.readFileSync('notes.md', 'utf8') : '# 笔记\n\n第一行\n第二行\n第三行\n';
    fs.writeFileSync('notes.md', old.replace('第二行', '第二行（已修改 ' + new Date().toLocaleTimeString() + '）') + '新增一行\n');
    out({ type: 'item.completed', item: { type: 'file_change', changes: [{ kind: 'add', path: 'chart.svg' }, { kind: 'add', path: 'report.html' }, { kind: 'update', path: 'notes.md' }] } });
    extra = '\n\n生成的图表：\n\n![柱状图](./chart.svg)\n\n完整报告见 [report.html](report.html)';
  }
  const att = input.match(/\[用户附件\][\s\S]*/);
  if (att) extra += '\n\n收到附件：\n' + att[0].split('\n').slice(1).join('\n');
  const slow = /slow|慢/.test(input) ? 20 : 1;
  for (let i = 0; i < slow; i++) await wait(500);
  out({ type: 'item.completed', item: { type: 'agent_message', text: `（模拟回复 · 会话 ${thread.slice(0, 8)}${ri >= 0 ? ' · 续接' : ''}）\n你说的是：**${input.trim().slice(0, 200)}**\n\n\`\`\`js\nconsole.log("hello")\n\`\`\`${extra}` } });
  out({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 20 } });
});
