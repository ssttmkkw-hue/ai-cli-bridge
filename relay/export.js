// 对话备份：把对话记录 + 产出文件 + 附件打成一个 zip，边生成边下载。
// 解压后双击 index.html 就能离线查看（样子和网页版一样，文件点开就能看）；data.json 是原始数据。
//
// zip 结构：
//   index.html                       离线查看页（样式、渲染脚本、对话数据都内嵌在里面）
//   data.json                        原始数据
//   README.txt                       怎么打开
//   c01/files/<路径>          每个产出文件的最终版本（保持 AI 生成时的目录结构，网页之间的相对引用照常可用）
//   c01/history/t3/<路径>     被后面的任务改掉的旧版本（t3 = 第 3 条消息产出的）
//   c01/attachments/t1/<名字> 用户上传的附件
'use strict';
const fs = require('fs');
const path = require('path');
const { ZipWriter } = require('./zip');

const WEB = path.join(__dirname, '..', 'web');
// 和 web/render.js 里的 isDevInfo 保持一致：新记录带 dev: true，旧记录按内容认
const isDevInfo = e => e.k === 'info' && (e.dev || /^模型 .* · 目录 /.test(e.d) || /^文件访问限制在：/.test(e.d));
const safe = s => String(s || '').replace(/[\\/:*?"<>|#%\x00-\x1f]/g, '_').replace(/^\.+/, '_').trim().slice(0, 60) || '未命名';
const safePath = p => String(p || '').split(/[\\/]+/).filter(x => x && x !== '.' && x !== '..').map(safe).join('/') || 'file';
const stamp = (t = Date.now()) => { const d = new Date(t), z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}`; };

// 规划：每个文件放在 zip 的哪里；同时生成给查看页用的数据
function plan(convs, tasksOf, blobPath) {
  const files = {}, items = [], used = new Set();
  const uniq = p => { let q = p, i = 2; while (used.has(q)) { const ext = path.posix.extname(p); q = `${p.slice(0, p.length - ext.length)} (${i++})${ext}`; } used.add(q); return q; };
  const has = id => id && fs.existsSync(blobPath(id));
  const out = convs.map((c, ci) => {
    const dir = `c${String(ci + 1).padStart(2, '0')}`; // 只用英文字母数字：老的解压工具不认 UTF-8 文件名标记，中文目录名会乱码
    const tasks = tasksOf(c).slice().sort((a, b) => a.createdAt - b.createdAt);
    // 每个任务里按路径归类：own = 这条消息新建/修改的（目录对比发现的），ref = 回答里只是引用了一下
    // 同一路径的多条记录只打包一份；「引用」不算新版本
    const byTask = tasks.map(t => {
      const m = new Map();
      for (const f of t.outputs || []) {
        if (!f.stored || f.change === 'delete' || !has(f.id)) continue;
        const p = safePath(f.path || f.name);
        if (!m.has(p)) m.set(p, { own: [], ref: [] });
        m.get(p)[f.change === 'ref' ? 'ref' : 'own'].push(f.id);
      }
      return m;
    });
    const latest = {}; // 路径 → 最后一次真正产出（own）它的任务序号
    byTask.forEach((m, ti) => { for (const [p, e] of m) if (e.own.length) latest[p] = ti; });
    const lastRel = {}; // 路径 → 到目前为止最近一个版本在 zip 里的位置
    tasks.forEach((t, ti) => {
      for (const [p, e] of byTask[ti]) {
        if (!e.own.length && lastRel[p]) { for (const id of e.ref) files[id] = lastRel[p]; continue; } // 只是引用之前的文件
        // 新版本（或对话开始前就有、第一次被引用的文件）：最终版放 files/，之后又被改掉的放 history/
        const isFinal = latest[p] === undefined ? true : latest[p] === ti || (latest[p] < ti);
        const rel = uniq(isFinal ? `${dir}/files/${p}` : `${dir}/history/t${ti + 1}/${p}`);
        for (const id of [...e.own, ...e.ref]) files[id] = rel;
        items.push({ rel, id: (e.own[0] || e.ref[0]), time: t.endedAt || t.createdAt });
        lastRel[p] = rel;
      }
      for (const f of t.inputs || []) {
        if (!f.stored || !has(f.id)) continue;
        const rel = uniq(`${dir}/attachments/t${ti + 1}/${safe(f.name)}`);
        files[f.id] = rel; items.push({ rel, id: f.id, time: t.createdAt });
      }
    });
    return {
      title: c.title, cli: c.cli, model: c.model, createdAt: c.createdAt, updatedAt: c.updatedAt, dir,
      tasks: tasks.map(t => ({
        prompt: t.prompt, status: t.status, cli: t.cli, model: t.model, createdAt: t.createdAt, startedAt: t.startedAt, endedAt: t.endedAt,
        error: t.error, result: t.result, usage: t.usage, linkMap: t.linkMap || {},
        events: (t.events || []).filter(e => !isDevInfo(e)), // 开发用的提示不导出
        inputs: (t.inputs || []).map(f => ({ id: f.id, name: f.name, mime: f.mime, size: f.size, stored: !!files[f.id] })),
        outputs: (t.outputs || []).map(f => ({ id: f.id, name: f.name, path: f.path, mime: f.mime, size: f.size, change: f.change,
          diff: f.diff, diffStat: f.diffStat, note: f.note, stored: !!files[f.id] })),
      })),
    };
  });
  return { convs: out, files, items };
}

function viewerHTML(data) {
  const read = f => fs.readFileSync(path.join(WEB, f), 'utf8');
  // 数据放在 <script type="application/json"> 里；把 < 转义，防止内容里的 </script> 提前结束标签
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${data.title.replace(/[<&]/g, '')} · AI 遥控台备份</title>
<style>${read('style.css')}</style></head>
<body><div id="app"></div>
<script type="application/json" id="data">${json}</script>
<script>${read('render.js')}</script>
<script>${read('export-viewer.js')}</script>
</body></html>`;
}

// convs：要导出的对话；tasksOf(conv)：它的任务；blobPath(id)：文件本体路径
async function exportConvs(res, { convs, tasksOf, blobPath, title }) {
  const p = plan(convs, tasksOf, blobPath);
  const data = { app: 'ai-cli-bridge', version: 1, title, exportedAt: Date.now(), convs: p.convs, files: p.files };
  // 下载的文件名可以用中文（浏览器负责）；zip 里我们自己起的目录名、文件名一律用英文，任何解压工具都不会乱码
  const name = `ai-bridge-backup-${stamp()}`;
  const downloadName = `AI遥控台备份-${safe(title)}-${stamp()}.zip`;
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${name}.zip"; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
    'Cache-Control': 'no-store',
  });
  const zip = new ZipWriter(res);
  await zip.add(`${name}/index.html`, viewerHTML(data));
  await zip.add(`${name}/data.json`, JSON.stringify(data, null, 1));
  await zip.add(`${name}/README.txt`, '﻿' + [ // 开头加 BOM：Windows 老版记事本也能认出是 UTF-8
    'AI 遥控台 · 对话备份',
    '',
    '1. 先把整个 zip 解压（直接在压缩包里打开，图片和文件会显示不出来）',
    '2. 双击 index.html，用浏览器打开就能看对话记录',
    '3. 回答里的文件、产出文件卡片点一下就能打开；AI 做的网页在 c01/files/ 里（c01、c02… 是第几个对话），也可以直接双击打开',
    '',
    'files/       每个文件的最终版本',
    'history/     被后面的消息改掉的旧版本（t3 = 第 3 条消息产出的）',
    'attachments/ 你上传的附件',
    'data.json    原始数据',
  ].join('\r\n'));
  for (const it of p.items) {
    try { await zip.add(`${name}/${it.rel}`, fs.readFileSync(blobPath(it.id)), new Date(it.time || Date.now())); }
    catch (e) { console.error('[relay] 导出时读文件失败', it.rel, e.message); }
  }
  await zip.end();
}

module.exports = { exportConvs, plan };
