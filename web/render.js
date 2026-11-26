'use strict';
// 网页版（app.js）和离线备份查看页（export-viewer.js）共用：Markdown、工具步骤、文件卡片、改动对比
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ST = { queued: '排队中', dispatched: '已派发', running: '运行中', done: '完成', failed: '失败', cancelled: '已取消' };
const CLI_NAME = { claude: 'Claude Code', codex: 'Codex', mock: '模拟 CLI' };
const fmtTime = t => { if (!t) return ''; const d = new Date(t), n = new Date(); const hm = d.toTimeString().slice(0, 5); return d.toDateString() === n.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`; };
const fmtDur = ms => ms == null ? '' : ms < 60000 ? (ms / 1000).toFixed(1) + 's' : Math.floor(ms / 60000) + 'm' + Math.round(ms % 60000 / 1000) + 's';

const unesc = s => String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
// 文件地址：网页版指向中继；离线备份的查看页会把它换成 zip 里的相对路径
let fileUrl = (id, dl) => `/api/files/${encodeURIComponent(id)}${dl ? '?dl=1' : ''}`;

// 极简 markdown（先转义，安全）。linkMap：回答里的本地路径 → 中继上的文件 id
function md(src, linkMap) {
  linkMap ||= {};
  const blocks = [];
  let s = String(src || '').replace(/```(\w*)\n?([\s\S]*?)(```|$)/g, (_, lang, code) => { blocks.push(code.replace(/\n$/, '')); return `\u0000${blocks.length - 1}\u0000`; });
  s = esc(s);
  const img = (alt, src) => {
    const raw = unesc(src).replace(/^<|>$/g, '');
    const id = linkMap[raw];
    if (id) return `<img class="md-img" src="${fileUrl(id)}" alt="${alt}" data-file="${id}" loading="lazy">`;
    if (/^https:\/\//i.test(raw)) return `<img class="md-img" src="${esc(raw)}" alt="${alt}" loading="lazy" referrerpolicy="no-referrer">`;
    return `<span class="faint">[图片：${alt || esc(raw)}（文件不在可访问目录，未上传）]</span>`;
  };
  const link = (text, href) => {
    const raw = unesc(href).replace(/^<|>$/g, '');
    const id = linkMap[raw];
    if (id) return `<a href="${fileUrl(id)}" data-file="${id}">📎 ${text}</a>`;
    if (/^https?:\/\//i.test(raw)) return `<a href="${esc(raw)}" target="_blank" rel="noopener">${text}</a>`;
    return `${text} <code>${esc(raw)}</code>`;
  };
  const inline = t => {
    // 先把代码片段抠出来，避免里面的 * [ ] 被误解析
    const codes = [];
    t = t.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0001${codes.length - 1}\u0001`; });
    t = t
      .replace(/!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, a, s) => img(a, s))
      .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, a, h) => link(a, h))
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<i>$2</i>');
    return t.replace(/\u0001(\d+)\u0001/g, (_, n) => `<code>${codes[+n]}</code>`);
  };
  const out = []; let list = null, para = [];
  const flushP = () => { if (para.length) { out.push('<p>' + inline(para.join('<br>')) + '</p>'); para = []; } };
  const flushL = () => { if (list) { out.push(`<${list.t}>` + list.items.map(i => '<li>' + inline(i) + '</li>').join('') + `</${list.t}>`); list = null; } };
  const lines = s.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if ((m = l.match(/^\u0000(\d+)\u0000$/))) { flushP(); flushL(); out.push(`<pre><button class="copy">复制</button><code>${esc(blocks[+m[1]])}</code></pre>`); continue; }
    if (/\u0000\d+\u0000/.test(l)) { para.push(l.replace(/\u0000(\d+)\u0000/g, (_, n) => `<code>${esc(blocks[+n])}</code>`)); continue; }
    if ((m = l.match(/^(#{1,4})\s+(.*)/))) { flushP(); flushL(); out.push(`<h${m[1].length + 1}>${inline(m[2])}</h${m[1].length + 1}>`); continue; }
    if (/^\|.*\|\s*$/.test(l) && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      flushP(); flushL();
      const row = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim()));
      let html = '<table><tr>' + row(l).map(c => `<th>${c}</th>`).join('') + '</tr>'; i++;
      while (i + 1 < lines.length && /^\|.*\|\s*$/.test(lines[i + 1])) { i++; html += '<tr>' + row(lines[i]).map(c => `<td>${c}</td>`).join('') + '</tr>'; }
      out.push(html + '</table>'); continue;
    }
    if ((m = l.match(/^\s*[-*]\s+(.*)/))) { flushP(); if (!list || list.t !== 'ul') { flushL(); list = { t: 'ul', items: [] }; } list.items.push(m[1]); continue; }
    if ((m = l.match(/^\s*\d+[.)]\s+(.*)/))) { flushP(); if (!list || list.t !== 'ol') { flushL(); list = { t: 'ol', items: [] }; } list.items.push(m[1]); continue; }
    if (!l.trim()) { flushP(); flushL(); continue; }
    flushL(); para.push(l);
  }
  flushP(); flushL();
  return out.join('');
}

document.addEventListener('click', e => {
  const b = e.target.closest('pre .copy'); if (!b) return;
  navigator.clipboard?.writeText(b.nextElementSibling.textContent).then(() => { b.textContent = '已复制'; setTimeout(() => (b.textContent = '复制'), 1200); });
});

const CLAUDE_MODELS = [['claude-opus-5-5', 'Opus 5.5'], ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-haiku-5-5', 'Haiku 5.5']];

const modelLabel = (cli, v) => CLAUDE_MODELS.find(([id]) => id === v)?.[1] || v || '默认';

const fmtSize = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
const kindOf = f => {
  const m = f.mime || '';
  if (m.startsWith('image/')) return 'image';
  if (m === 'text/html') return 'html';
  if (m === 'application/pdf') return 'pdf';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  // docx/xlsx/pptx 的 MIME 里也带 "xml"，但它们是 zip 二进制，不能当文本显示
  if (/^text\/|^application\/(json|xml)$|\+(json|xml)$/.test(m)) return 'text';
  return 'other';
};
const ICON = { image: '🖼', html: '🌐', pdf: '📕', audio: '🎵', video: '🎬', text: '📄', other: '📦' };
const CHANGE = { add: ['新增', 'done'], modify: ['修改', 'running'], delete: ['删除', 'failed'], ref: ['引用', ''] };

function diffHTML(diff) {
  return `<pre class="diff">${diff.split('\n').map(l => {
    const c = l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : l.startsWith('@@') ? 'hunk' : '';
    return `<span class="${c}">${esc(l) || ' '}</span>`;
  }).join('')}</pre>`;
}

function outputsHTML(t) {
  const outs = t.outputs || [];
  if (!outs.length) return '';
  const imgs = outs.filter(f => f.stored && kindOf(f) === 'image' && f.change !== 'delete');
  const linked = new Set(Object.values(t.linkMap || {}));
  const rest = outs.filter(f => !imgs.includes(f));
  return `<div class="outputs">
    <div class="outputs-head">产出文件 · ${outs.length}</div>
    ${imgs.filter(f => !linked.has(f.id)).length ? `<div class="thumbs">${imgs.filter(f => !linked.has(f.id)).map(f => `<button class="thumb" data-file="${f.id}" title="${esc(f.path)}"><img src="${fileUrl(f.id)}" loading="lazy" alt=""><span>${esc(f.name)}</span></button>`).join('')}</div>` : ''}
    ${[...imgs.filter(f => linked.has(f.id)), ...rest].map(f => {
      const [cn, cc] = CHANGE[f.change] || CHANGE.add;
      const st = f.diffStat ? `<span class="dstat"><b class="a">+${f.diffStat.add}</b> <b class="d">-${f.diffStat.del}</b></span>` : '';
      return `<div class="fcard">
        <div class="frow">
          <span class="ficon">${ICON[kindOf(f)]}</span>
          <div class="fmain"><div class="fname">${esc(f.name)}</div><div class="faint fpath">${esc(f.path)}${f.size ? ' · ' + fmtSize(f.size) : ''}${f.note ? ' · ' + esc(f.note) : ''}</div></div>
          <span class="chip ${cc}">${cn}</span>${st}
          <div class="factions">
            ${f.diff ? `<button class="btn sm" data-diff="${f.id}">改动</button>` : ''}
            ${f.stored ? `<button class="btn sm" data-file="${f.id}">预览</button><a class="btn sm" href="${fileUrl(f.id, 1)}" download>下载</a>` : ''}
          </div>
        </div>
        ${f.diff ? `<div class="fdiff" id="diff-${f.id}" hidden>${diffHTML(f.diff)}</div>` : ''}
      </div>`;
    }).join('')}
  </div>`;
}

function inputsHTML(t) {
  const ins = t.inputs || [];
  if (!ins.length) return '';
  return `<div class="inputs">${ins.map(f => kindOf(f) === 'image'
    ? `<button class="thumb sm" data-file="${f.id}"><img src="${fileUrl(f.id)}" alt=""></button>`
    : `<button class="chip att" data-file="${f.id}">${ICON[kindOf(f)]} ${esc(f.name)}</button>`).join('')}</div>`;
}

// 开发用的提示：新记录带 dev: true；旧记录没有这个标记，按内容认出来
const isDevInfo = e => e.k === 'info' && (e.dev || /^模型 .* · 目录 /.test(e.d) || /^文件访问限制在：/.test(e.d));
function eventsHTML(events, linkMap, showDev = false) {
  let html = '', tools = [], lastInfo = null; // lastInfo：连续重复的提示只显示一条
  const flushTools = () => {
    if (!tools.length) return;
    const inner = tools.join('');
    html += tools.length > 6 ? `<details class="fold tools"><summary>${tools.length} 步工具调用</summary>${inner}</details>` : `<div class="tools">${inner}</div>`;
    tools = [];
  };
  for (const e of events) {
    if (e.k === 'tool') tools.push(`<div class="tool"><b>${esc(e.name)}</b> ${esc(e.d)}</div>`);
    else if (e.k === 'tool_out') { if (e.d) tools.push(`<div class="tool-out ${e.err ? 'err' : ''}">${esc(e.d)}</div>`); }
    else if (e.k === 'think') { flushTools(); html += `<details class="fold"><summary>思考过程</summary><div class="info">${esc(e.d)}</div></details>`; }
    else if (e.k === 'info') { if ((isDevInfo(e) && !showDev) || e.d === lastInfo) continue; lastInfo = e.d; flushTools(); html += `<div class="info">ℹ ${esc(e.d)}</div>`; }
    else if (e.k === 'err') { flushTools(); html += `<div class="errbox">${esc(e.d)}</div>`; }
    else if (e.k === 'text') { flushTools(); html += `<div class="md">${md(e.d, linkMap)}</div>`; }
  }
  flushTools();
  return html;
}

function usageText(t) {
  const u = t.usage || {}; const bits = [];
  if (t.startedAt && t.endedAt) bits.push('耗时 ' + fmtDur(t.endedAt - t.startedAt));
  if (u.in != null) bits.push(`输入 ${u.in} / 输出 ${u.out} tokens`);
  if (u.cost) bits.push('$' + u.cost.toFixed(4));
  if (u.turns) bits.push(u.turns + ' 轮');
  return bits.join(' · ');
}

document.addEventListener('click', e => {
  const d = e.target.closest('[data-diff]');
  if (d) { const box = document.getElementById('diff-' + d.dataset.diff); if (box) { box.hidden = !box.hidden; d.classList.toggle('on', !box.hidden); } }
});
