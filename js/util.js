"use strict";

// Global UI helpers — used by all tabs.
const UI = (() => {
  function el(id) { return document.getElementById(id); }
  function log(msg, cls='') {
    const logEl = el('log');
    if (!logEl) { console.log(msg); return; }
    const line = document.createElement('div');
    if (cls) line.className = cls;
    line.textContent = msg;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }
  function clearLog() { const logEl = el('log'); if (logEl) logEl.innerHTML = ''; }
  function setStatus(s, kind='') {
    const status = el('status'), text = el('statusText');
    if (text) text.textContent = s;
    if (status) status.className = kind;
  }
  function setProgress(pct) {
    const bar = document.querySelector('#progress > div');
    if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
  }
  function fmt(n) { return (Math.round(n*1000)/1000).toFixed(3); }

  // Tabs
  function initTabs() {
    document.querySelectorAll('nav.tabs button').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
  }
  function switchTab(name) {
    document.querySelectorAll('nav.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));
    window.dispatchEvent(new CustomEvent('tabchange', {detail:{name}}));
  }

  return { el, log, clearLog, setStatus, setProgress, fmt, initTabs, switchTab };
})();
