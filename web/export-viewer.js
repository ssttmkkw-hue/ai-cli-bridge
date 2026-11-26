'use strict';
// 离线备份查看页：备份 zip 解压后，双击 index.html 打开。不联网、不需要登录。
// 渲染函数（Markdown、工具步骤、文件卡片、改动对比）来自 render.js，和网页版一模一样；
// 区别只是文件地址：指向 zip 里的相对路径，而不是中继。
const DATA = JSON.parse(document.getElementById('data').textContent);
const relHref = rel => rel.split('/').map(encodeURIComponent).join('/');
fileUrl = id => (DATA.files[id] ? relHref(DATA.files[id]) : '#'); // 覆盖 render.js 里指向中继的版本
const fullTime = t => {
  if (!t) return '';
  const d = new Date(t), z = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
};
const multi = DATA.convs.length > 1;
let cur = 0, sideOpen = false;

function turnHTML(t) {
  const hasText = t.events.some(e => e.k === 'text' && e.d.trim());
  return `<div class="turn">
    ${t.prompt ? `<div class="bubble-user">${esc(t.prompt)}</div>` : ''}
    ${inputsHTML(t)}
    <div class="reply">
      <div class="reply-head"><span class="chip ${t.status}">${ST[t.status] || esc(t.status)}</span><span>${fullTime(t.createdAt)}</span></div>
      ${eventsHTML(t.events, t.linkMap)}
      ${t.status === 'done' && !hasText && t.result ? `<div class="md">${md(t.result, t.linkMap)}</div>` : ''}
      ${outputsHTML(t)}
      ${t.error && t.status !== 'cancelled' ? `<div class="errbox">${esc(t.error)}</div>` : ''}
      ${t.endedAt && t.usage ? `<div class="usage">${esc(usageBrief(t))}</div>` : ''}
    </div></div>`;
}

function render() {
  const c = DATA.convs[cur];
  document.getElementById('app').innerHTML = `
    <header class="top"><div class="brand"><i>&gt;_</i><span>AI 遥控台 · 备份</span></div>
      <div class="faint" style="margin-left:auto;font-size:13px">导出于 ${fullTime(DATA.exportedAt)}</div></header>
    <div class="main">
      ${multi ? `<aside class="side ${sideOpen ? 'open' : ''}" id="side"><div class="convs">${DATA.convs.map((x, i) => `
        <div class="conv ${i === cur ? 'on' : ''}" data-i="${i}"><div class="t">${esc(x.title)}</div>
          <div class="s">${esc(CLI_NAME[x.cli] || x.cli)} · ${esc(modelLabel(x.cli, x.model))} · ${fullTime(x.updatedAt)}</div></div>`).join('')}</div></aside>
        <div class="side-mask ${sideOpen ? 'open' : ''}" id="sideMask"></div>` : ''}
      <section class="chat">
        <div class="chat-head">${multi ? '<button class="icon-btn menu-btn" id="menuBtn">☰</button>' : ''}
          <div style="min-width:0;flex:1"><div class="title">${esc(c.title)}</div>
            <div class="meta"><span class="chip">${esc(CLI_NAME[c.cli] || c.cli)} · ${esc(modelLabel(c.cli, c.model))}</span><span class="chip">${fullTime(c.createdAt)}</span></div></div></div>
        <div class="msgs"><div class="msgs-inner">${c.tasks.map(turnHTML).join('') || '<div class="empty">这个对话没有消息</div>'}</div></div>
      </section>
    </div>`;
  document.title = `${c.title} · AI 遥控台备份`;
  document.querySelectorAll('[data-i]').forEach(d => d.onclick = () => { cur = +d.dataset.i; sideOpen = false; render(); });
  const toggle = open => { sideOpen = open; render(); };
  document.getElementById('menuBtn')?.addEventListener('click', () => toggle(!sideOpen));
  document.getElementById('sideMask')?.addEventListener('click', () => toggle(false));
}

// 回答里的文件链接、图片、产出文件卡片：在新标签页打开 zip 里的文件
document.addEventListener('click', e => {
  const f = e.target.closest('[data-file]');
  if (f && !e.ctrlKey && !e.metaKey) { e.preventDefault(); window.open(fileUrl(f.dataset.file), '_blank'); }
});
render();
