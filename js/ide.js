/**
 * VS Code IDE 视图 —— 把知乎渲染成 "ZHIHU WORKSPACE"
 *
 * 页面支持：
 *  · 首页      → recommend.ts / following.ts / hot_rank.ts（信息流代码化）
 *  · 搜索页    → search.json（结果代码化，可从搜索弹窗发起搜索）
 *  · 问题详情页 → {问题名}.ts（TargetQuestion 接口 + answer_N 代码块，
 *                 图片 [图片] token 点击展开/收起，评论终端面板，查看全部回答）
 *  · 任意页    → settings.json（回答数 / 皮肤 / 图片默认态设置）
 *
 * 结构：固定定位 overlay 盖住原页面（原 DOM 保留，Boss Key 秒切）
 * 快捷键：Alt+V = Boss Key；Ctrl/Cmd+Shift+P = 命令面板；Esc = 关闭面板
 * 依赖：content.js（html[data-zvsc] 总开关）、parse.js（window.ZVSC 解析器）
 */
(function () {
  'use strict';

  if (window.__ZVSC_IDE__) return;
  window.__ZVSC_IDE__ = true;

  var ZVSC = window.ZVSC || {};
  var page = (ZVSC.pageType && ZVSC.pageType()) || 'other';
  if (page === 'other') return;

  /* ------------------------------ 状态 ------------------------------ */

  var enabled = document.documentElement.getAttribute('data-zvsc') === 'on';
  var built = false;
  var overlay = null;
  var refs = {};

  var settings = { answersPerView: 'zhihu', imageDefault: 'collapsed', theme: 'dark' };
  var THEMES = ['dark', 'light', 'monokai', 'github'];
  var THEME_LABELS = { dark: 'Dark+', light: 'Light+', monokai: 'Monokai', github: 'GitHub Dark' };
  var OPTS = {
    answersPerView: ['zhihu', 1, 3, 5, 10],
    imageDefault: ['collapsed', 'expanded'],
    theme: THEMES
  };
  var OPT_LABELS = { zhihu: '跟知乎一致', collapsed: '收起', expanded: '展开' };

  var state = {
    file: 'recommend',
    items: [],
    detail: null,
    article: null,
    lines: 0,
    exhausted: false,
    loading: false,
    vueMode: false, // 老板键伪装中（右侧显示假 Vue 代码）
    expanded: {} // 手动展开过的图片 "ans:idx"，重渲染后保持
  };

  var FILES = {
    recommend: { tree: 'recommend.ts', doc: '首页.ts', badge: 'TS', kind: 'feed', tab: '推荐', varName: 'feedStream', typeName: 'ZhihuStream', heading: '首页' },
    following: { tree: 'following.ts', doc: '关注.ts', badge: 'TS', kind: 'feed', tab: '关注', varName: 'followingStream', typeName: 'ZhihuStream', heading: '关注' },
    hot:       { tree: 'hot_rank.ts',  doc: '热榜.ts', badge: 'TS', kind: 'feed', tab: '热榜', varName: 'hotRank', typeName: 'HotRank', heading: '热榜' },
    search:    { tree: 'search.json',  doc: '搜索.json', badge: '{}', kind: 'search' },
    settings:  { tree: 'settings.json', doc: 'settings.json', badge: '{}', kind: 'settings' },
    detail:    { tree: 'detail.ts', doc: 'detail.ts', badge: 'TS', kind: 'detail' },
    article:   { tree: 'article.md', doc: '文章.md', badge: 'MD', kind: 'article' },
    vue:       { tree: 'App.vue', doc: 'App.vue', badge: 'VUE', kind: 'vue' }
  };

  var vueSavedFile = null; // 老板键进入 Vue 伪装前的文件，退出时恢复

  /* ------------------------------ 工具 ------------------------------ */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
    });
  }
  function escAttr(s) {
    return esc(s).replace(/"/g, '&quot;');
  }
  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }
  function fetchJSON(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }
  function fmtTime(sec) {
    var d = new Date((sec || 0) * 1000);
    if (!sec || isNaN(d.getTime())) return '';
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function stripHtml(html) {
    var d = document.createElement('div');
    d.innerHTML = html || '';
    Array.prototype.forEach.call(d.querySelectorAll('img'), function (im) {
      im.replaceWith(' [表情] ');
    });
    return (d.textContent || '').replace(/\s+/g, ' ').trim();
  }
  /** 问题标题 → 文件名 */
  function shortName(t, ext) {
    var s = String(t || 'detail').replace(/[\\/:*?"<>|#\s，。！？：；、“”‘’（）()【】《》\[\]]+/g, '_');
    s = s.replace(/_+/g, '_').replace(/^_+|_+$/g, '');
    if (s.length > 24) s = s.slice(0, 24);
    return (s || 'detail') + (ext || '.ts');
  }

  /* ------------------------- 设置存取与迁移 ------------------------- */

  function normalizeSettings(s) {
    if (s.answersPerView === 'all') s.answersPerView = 'zhihu'; // 旧版本值迁移
    if (s.answersPerView !== 'zhihu' && typeof s.answersPerView !== 'number') s.answersPerView = 'zhihu';
    if (OPTS.imageDefault.indexOf(s.imageDefault) < 0) s.imageDefault = 'collapsed';
    if (THEMES.indexOf(s.theme) < 0) s.theme = 'dark';
    return s;
  }

  /** 同步读 localStorage 缓存（document_start 防闪烁用） */
  function loadCachedSettings() {
    try {
      var raw = localStorage.getItem('zvsc-settings');
      if (raw) Object.assign(settings, JSON.parse(raw) || {});
    } catch (e) { /* ignore */ }
    normalizeSettings(settings);
  }

  function cacheSettings() {
    try {
      localStorage.setItem('zvsc-settings', JSON.stringify(settings));
    } catch (e) { /* ignore */ }
  }

  // 语法着色 span（色值经 CSS 变量随皮肤切换）
  var C = {
    kw:   function (t) { return '<span class="zvsc-kw">' + esc(t) + '</span>'; },
    ty:   function (t) { return '<span class="zvsc-ty">' + esc(t) + '</span>'; },
    vr:   function (t) { return '<span class="zvsc-var">' + esc(t) + '</span>'; },
    key:  function (t) { return '<span class="zvsc-key">' + esc(t) + '</span>'; },
    num:  function (t) { return '<span class="zvsc-num">' + esc(t) + '</span>'; },
    cmt:  function (t) { return '<span class="zvsc-cmt">' + esc(t) + '</span>'; },
    p:    function (t) { return '<span class="zvsc-punc">' + esc(t) + '</span>'; },
    link: function (url, t) {
      if (!url) return '<span class="zvsc-str">' + esc(t) + '</span>';
      return '<a class="zvsc-str zvsc-link-str" href="' + escAttr(url) + '" title="' + escAttr(t) + '">' + esc(t) + '</a>';
    },
    str:  function (t) { return '<span class="zvsc-str">' + esc(t) + '</span>'; }
  };

  /* --------------------------- 代码生成器 --------------------------- */

  function tsLines(items, f) {
    var now = new Date();
    var ts = pad2(now.getHours()) + ':' + pad2(now.getMinutes()) + ':' + pad2(now.getSeconds());
    var L = [];
    var I1 = '    ';
    var I2 = '        ';

    L.push(C.kw('import') + C.p(' { ') + C.ty('FeedItem') + C.p(', ') + C.ty('ZhihuStream') + C.p(' } ') + C.kw('from') + ' ' + C.str("'@zhihu/feed'") + C.p(';'));
    L.push('');
    L.push(C.p('/**'));
    L.push(C.cmt(' * Zhihu Stream - ' + f.heading));
    L.push(C.cmt(' * Generated at ' + ts));
    L.push(C.p(' */'));
    L.push('');
    L.push(C.kw('export') + ' ' + C.kw('const') + ' ' + C.vr(f.varName) + C.p(': ') + C.ty(f.typeName) + ' ' + C.p('= ['));
    items.forEach(function (it, i) {
      L.push(I1 + C.p('{'));
      L.push(I2 + C.key('id') + C.p(': ') + C.num(it.id) + C.p(','));
      L.push(I2 + C.key('title') + C.p(': ') + C.link(it.url, '"' + it.title + '"') + C.p(','));
      L.push(I2 + C.key('author') + C.p(': ') + C.str('"' + (it.author || '') + '"') + C.p(','));
      if (f.tab === '热榜') L.push(I2 + C.key('heat') + C.p(': ') + C.str('"' + (it.heat || '') + '"') + C.p(','));
      L.push(I2 + C.key('url') + C.p(': ') + C.link(it.url, '"' + it.url + '"') + C.p(','));
      L.push(I2 + C.key('excerpt') + C.p(': ') + C.link(it.url, '"' + (it.excerpt || '') + '"') + (i === items.length - 1 ? '' : C.p(',')));
      L.push(I1 + C.p('},'));
    });
    L.push(C.p('];'));
    return L;
  }

  function jsonLines(items) {
    var query = '';
    try {
      query = new URLSearchParams(location.search).get('q') || '';
    } catch (e) { /* ignore */ }
    var L = [];
    L.push(C.p('{'));
    L.push('  ' + C.key('"query"') + C.p(': ') + C.str('"' + query + '"') + C.p(','));
    L.push('  ' + C.cmt('// 点击此处或左侧 search.json 重新搜索'));
    L.push('  ' + C.key('"results"') + C.p(': ['));
    items.forEach(function (it, i) {
      L.push('    ' + C.p('{'));
      L.push('      ' + C.key('"id"') + C.p(': ') + C.num(it.id) + C.p(','));
      L.push('      ' + C.key('"title"') + C.p(': ') + C.link(it.url, '"' + it.title + '"') + C.p(','));
      L.push('      ' + C.key('"url"') + C.p(': ') + C.link(it.url, '"' + it.url + '"') + C.p(','));
      L.push('      ' + C.key('"excerpt"') + C.p(': ') + C.link(it.url, '"' + (it.excerpt || '') + '"'));
      L.push('    ' + C.p('}' + (i === items.length - 1 ? '' : ',')));
    });
    L.push('  ' + C.p(']'));
    L.push(C.p('}'));
    return L;
  }

  function detailLines(d) {
    var L = [];
    var shown = Math.min(d.shown || 0, d.answers.length);

    L.push(C.kw('import') + C.p(' { ') + C.ty('Question') + C.p(', ') + C.ty('Answer') + C.p(', ') + C.ty('User') + C.p(' } ') + C.kw('from') + ' ' + C.str("'@zhihu/core'") + C.p(';'));
    L.push('');
    L.push(C.p('/**'));
    L.push(C.cmt(' * QUESTION: ' + (d.title || '')));
    L.push(C.p(' */'));
    L.push('');
    L.push(C.kw('export') + ' ' + C.kw('interface') + ' ' + C.ty('TargetQuestion') + ' ' + C.kw('extends') + ' ' + C.ty('Question') + ' ' + C.p('{'));
    L.push('  ' + C.key('title') + C.p(': ') + C.str('"' + (d.title || '') + '"') + C.p(';'));
    L.push('  ' + C.key('totalAnswers') + C.p(': ') + C.num(d.total || d.answers.length) + C.p(';'));
    L.push(C.p('}'));

    for (var i = 0; i < shown; i++) {
      var a = d.answers[i];
      L.push('');
      L.push(C.p('/**'));
      L.push(C.cmt(' * ANSWER #' + (i + 1) + ' by @' + (a.author || '知乎用户') + (a.headline ? ' (' + a.headline + ')' : '')));
      L.push(C.cmt(' * Votes: ▲ ' + (a.votes || 0) + ' | Comments: 💬 ' + (a.comments || 0)));
      L.push(C.p(' */'));
      L.push(C.kw('export') + ' ' + C.kw('const') + ' ' + C.vr('answer_' + (i + 1)) + C.p(': ') + C.ty('Answer') + ' ' + C.p('{'));
      L.push('  ' + C.key('author') + C.p(': ') + C.str('"' + (a.author || '') + '"') + C.p(','));
      L.push('  ' + C.key('voteCount') + C.p(': ') + C.num(a.votes || 0) + C.p(','));
      L.push('  ' + C.key('getContent') + C.p(': ') + C.kw('function') + C.p('(): ') + C.ty('string') + ' ' + C.p('{'));
      L.push('    ' + C.kw('return') + ' ' + C.p('`'));
      (a.lines || []).forEach(function (line) {
        L.push('      <span class="zvsc-str">' + line + '</span>');
      });
      L.push('    ' + C.p('`') + C.p(';'));
      L.push('  ' + C.p('},'));
      L.push('  ' + C.cmt('// 点击下方「评论/回复区」加载实时评论 (💬 ' + (a.comments || 0) + ')'));
      L.push(C.p('};'));
      L.push('');
      L.push(
        '<span class="zvsc-btn" data-btn="vote:' + i + '">▲ 赞同 ' + (a.votes || 0) + '</span>' +
        '<span class="zvsc-btn" data-btn="comments:' + i + '">💬 ' + (a.comments || 0) + ' 评论/回复区</span>'
      );
    }

    if (!shown) {
      L.push(C.cmt('// 未解析到回答内容'));
      L.push(C.cmt('// 知乎可能改版了，或当前未登录 / 页面仍在加载'));
      L.push(C.cmt('// 试试刷新页面'));
    } else if (d.loadingMore) {
      L.push('');
      L.push(C.cmt('// 正在加载更多回答 …'));
    } else if (d.allLoaded) {
      L.push('');
      L.push(C.cmt('// ─── 已加载全部 ' + d.answers.length + ' 个回答 ───'));
    }
    return L;
  }

  function settingsLines() {
    var L = [];
    L.push(C.p('{'));
    L.push('  ' + C.cmt('// 点击任意值进行修改，自动保存并即时生效'));
    L.push(
      '  ' + C.key('"answersPerView"') + C.p(': ') +
      '<span class="zvsc-set-val" data-set="answersPerView">' +
      (settings.answersPerView === 'zhihu' ? C.str('"跟知乎一致"') : C.num(settings.answersPerView)) + '</span>' + C.p(',') +
      C.cmt('   // 详情页初始回答数：跟知乎一致 / 1 / 3 / 5 / 10（下滑自动加载更多）')
    );
    L.push(
      '  ' + C.key('"imageDefault"') + C.p(': ') +
      '<span class="zvsc-set-val" data-set="imageDefault">' +
      C.str('"' + OPT_LABELS[settings.imageDefault] + '"') + '</span>' + C.p(',') +
      C.cmt('     // 正文图片默认收起 / 展开（点击 [图片] 可切换）')
    );
    L.push(
      '  ' + C.key('"theme"') + C.p(': ') +
      '<span class="zvsc-set-val" data-set="theme">' +
      C.str('"' + (THEME_LABELS[settings.theme] || settings.theme) + '"') + '</span>' + C.p(',') +
      C.cmt('            // 皮肤：Dark+ / Light+ / Monokai / GitHub Dark')
    );
    L.push(C.p('}'));
    return L;
  }

  function commentLines(texts) {
    return texts.map(function (t) { return C.cmt('// ' + t); });
  }

  /** 专栏文章 → {标题}.md 视图（front-matter + 正文 + 图片 token + 操作按钮） */
  function articleLines(a) {
    var L = [];
    L.push(C.p('---'));
    L.push('  ' + C.key('title') + C.p(': ') + C.str('"' + (a.title || '') + '"'));
    L.push('  ' + C.key('author') + C.p(': ') + C.str('"' + (a.author || '') + '"'));
    L.push('  ' + C.key('url') + C.p(': ') + C.str('"' + location.href + '"'));
    L.push(C.p('---'));
    L.push('');
    L.push(C.key('# ' + (a.title || '')));
    L.push('');
    (a.lines || []).forEach(function (line) {
      L.push('<span class="zvsc-str">' + line + '</span>');
    });
    L.push('');
    L.push(C.p('---'));
    L.push(
      '<span class="zvsc-btn">▲ 赞同 ' + (a.votes || 0) + '</span>' +
      '<span class="zvsc-btn" data-btn="comments:0">💬 ' + (a.comments || 0) + ' 评论/回复区</span>'
    );
    return L;
  }

  /* ------------------------------ 模板 ------------------------------ */

  var ICONS = {
    files: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M13.5 3h-6l-1-1H2.5l-1 1v9l1 1h11l1-1V4l-1-1zm0 9.5h-11V4h3.6l1 1h6.4v7.5z"/></svg>',
    search: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="6.8" cy="6.8" r="4.3"/><path d="M10 10l4 4"/></svg>',
    git: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M11.5 2a2 2 0 0 0-.5 3.94V6c0 1-1 2-2.5 2-1 0-1.9.4-2.5 1V4.94a2 2 0 1 0-1 0v6.12a2 2 0 1 0 1 0V10c0-1 1-2 2.5-2 2.2 0 3.5-1.3 3.5-3v-.06A2 2 0 0 0 11.5 2zm-6 11.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm0-9a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm6 0a1 1 0 1 1 0-2 1 1 0 0 1 0 2z"/></svg>',
    play: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5v11l9-5.5-9-5.5z"/></svg>',
    ext: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M7 2h3v3h3v3h-3v3h3v3h-3v-3H7v3H4v-3H2V8h2V5h3V2zM5.5 6.5v6h6v-6h-6z"/></svg>',
    gear: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M9.1 1l.4 1.8c.4.1.8.3 1.2.6l1.7-.7 1.4 2.4-1.3 1.2a5 5 0 0 1 0 1.4L13.8 9l-1.4 2.4-1.7-.7c-.4.3-.8.5-1.2.6L9.1 13H6.9l-.4-1.8c-.4-.1-.8-.3-1.2-.6l-1.7.7L2.2 9l1.3-1.3a5 5 0 0 1 0-1.4L2.2 5.1l1.4-2.4 1.7.7c.4-.3.8-.5 1.2-.6L6.9 1h2.2zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/></svg>',
    vue: '<svg width="16" height="16" viewBox="0 0 256 221" fill="currentColor"><path d="M204.8 0H256L128 220.8 0 0h97.92L128 51.2 157.44 0h47.36z"/><path d="M0 0l128 220.8L256 0h-51.2L128 132.48 50.56 0H0z" opacity=".65"/></svg>'
  };

  function badge(b) {
    var cls = b === '{}' ? 'json' : b === 'VUE' ? 'vue' : b === 'MD' ? 'md' : 'ts';
    return '<span class="zvsc-badge zvsc-badge-' + cls + '">' + esc(b) + '</span>';
  }

  function fileLabel(id) {
    if (id === 'detail' && state.detail) return shortName(state.detail.title, '.ts');
    if (id === 'article' && state.article) return shortName(state.article.title, '.md');
    return FILES[id].tree;
  }
  function docLabel(id) {
    if (id === 'detail' && state.detail) return shortName(state.detail.title, '.ts');
    if (id === 'article' && state.article) return shortName(state.article.title, '.md');
    return FILES[id].doc || FILES[id].tree;
  }

  function buildOverlay() {
    overlay = document.createElement('div');
    overlay.className = 'zvsc-ov zvsc-theme-' + settings.theme;
    overlay.innerHTML =
      '<div class="zvsc-main">' +
        '<div class="zvsc-activity">' +
          '<div class="zvsc-act-item zvsc-active" title="资源管理器">' + ICONS.files + '</div>' +
          '<div class="zvsc-act-item" data-act="search" title="知乎搜索">' + ICONS.search + '</div>' +
          '<div class="zvsc-act-item" title="源代码管理">' + ICONS.git + '</div>' +
          '<div class="zvsc-act-item" title="运行和调试">' + ICONS.play + '</div>' +
          '<div class="zvsc-act-item" title="扩展">' + ICONS.ext + '</div>' +
          '<div class="zvsc-act-bottom">' +
            '<div class="zvsc-act-item" data-act="vue" title="老板键：假装写代码 (Alt+V)">' + ICONS.vue + '</div>' +
            '<div class="zvsc-act-item" data-act="settings" title="设置">' + ICONS.gear + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="zvsc-sidebar">' +
          '<div class="zvsc-sec"><span>OPEN EDITORS</span><span class="zvsc-dots">···</span></div>' +
          '<div id="zvsc-open-editors"></div>' +
          '<div class="zvsc-sec"><span>▼ ZHIHU REPOSITORY</span><span class="zvsc-dots">···</span></div>' +
          '<div id="zvsc-tree"></div>' +
        '</div>' +
        '<div class="zvsc-editor-col">' +
          '<div class="zvsc-tabbar" id="zvsc-tabbar"></div>' +
          '<div class="zvsc-crumbs" id="zvsc-crumbs"></div>' +
          '<div class="zvsc-code-wrap" id="zvsc-code-wrap"><div class="zvsc-code" id="zvsc-code"></div></div>' +
          '<div class="zvsc-panel" id="zvsc-panel" style="display:none">' +
            '<div class="zvsc-panel-tabs">' +
              '<span class="zvsc-ptab">Problems 0</span>' +
              '<span class="zvsc-ptab">Output</span>' +
              '<span class="zvsc-ptab">Terminal</span>' +
              '<span class="zvsc-ptab zvsc-ptab-active" id="zvsc-ptab-comments">Comments</span>' +
              '<span class="zvsc-panel-close" id="zvsc-panel-close" title="关闭 (Esc)">×</span>' +
            '</div>' +
            '<div class="zvsc-panel-body" id="zvsc-panel-body"></div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="zvsc-statusbar">' +
        '<div class="zvsc-sb-left">' +
          '<span class="zvsc-sb-item">⎇ main*</span>' +
          '<span class="zvsc-sb-item">✕ 0</span>' +
          '<span class="zvsc-sb-item">⚠ 0</span>' +
        '</div>' +
        '<div class="zvsc-sb-right">' +
          '<span class="zvsc-sb-item" data-act="palette">Ctrl+Shift+P (Palette)</span>' +
          '<span class="zvsc-sb-item" id="zvsc-sb-pos">Ln 1, Col 1</span>' +
          '<span class="zvsc-sb-item">UTF-8</span>' +
          '<span class="zvsc-sb-item" id="zvsc-sb-lang">TypeScript</span>' +
          '<span class="zvsc-sb-item">😊 Sponsor Pro</span>' +
        '</div>' +
      '</div>' +
      '<div class="zvsc-palette" id="zvsc-palette" style="display:none">' +
        '<input id="zvsc-palette-input" type="text" placeholder="搜索知乎内容，或输入 > 执行命令…" spellcheck="false" />' +
        '<ul id="zvsc-palette-list"></ul>' +
      '</div>' +
      '<div class="zvsc-searchmodal" id="zvsc-searchmodal" style="display:none">' +
        '<div class="zvsc-searchbox">' +
          '<div class="zvsc-searchtitle">知乎搜索</div>' +
          '<input id="zvsc-searchinput" type="text" placeholder="输入关键词，回车搜索…" spellcheck="false" />' +
          '<div class="zvsc-searchhint">Enter 搜索 · Esc 取消</div>' +
        '</div>' +
      '</div>';

    // document_start 时 body 尚未存在，挂在 documentElement 上（fixed 定位不受影响）
    (document.body || document.documentElement).appendChild(overlay);

    refs.tabbar = overlay.querySelector('#zvsc-tabbar');
    refs.crumbs = overlay.querySelector('#zvsc-crumbs');
    refs.code = overlay.querySelector('#zvsc-code');
    refs.codeWrap = overlay.querySelector('#zvsc-code-wrap');
    refs.openEditors = overlay.querySelector('#zvsc-open-editors');
    refs.tree = overlay.querySelector('#zvsc-tree');
    refs.pos = overlay.querySelector('#zvsc-sb-pos');
    refs.lang = overlay.querySelector('#zvsc-sb-lang');
    refs.palette = overlay.querySelector('#zvsc-palette');
    refs.paletteInput = overlay.querySelector('#zvsc-palette-input');
    refs.paletteList = overlay.querySelector('#zvsc-palette-list');
    refs.searchModal = overlay.querySelector('#zvsc-searchmodal');
    refs.searchInput = overlay.querySelector('#zvsc-searchinput');
    refs.panel = overlay.querySelector('#zvsc-panel');
    refs.panelBody = overlay.querySelector('#zvsc-panel-body');
    refs.ptabComments = overlay.querySelector('#zvsc-ptab-comments');
    refs.panelClose = overlay.querySelector('#zvsc-panel-close');

    /* ----- 点击分发 ----- */
    overlay.addEventListener('click', function (e) {
      var t;
      if ((t = e.target.closest('[data-act]'))) {
        var act = t.getAttribute('data-act');
        if (act === 'vue') toggleVue();
        else if (act === 'palette') openPalette();
        else if (act === 'search') openSearchModal();
        else if (act === 'settings') {
          if (state.vueMode) toggleVue(); // 先退出伪装再进设置
          switchToFile('settings');
        }
        return;
      }
      if ((t = e.target.closest('[data-file]'))) {
        var id = t.getAttribute('data-file');
        if (state.vueMode && id !== 'vue') toggleVue(); // 伪装中点文件先复原
        if (id === 'search') { openSearchModal(); return; }
        if (id === 'settings') { switchToFile('settings'); return; }
        if (id === 'detail') return; // 已是当前文件
        if ((id === 'recommend' || id === 'following' || id === 'hot') && page !== 'home') {
          location.href = '/'; // 其他页面没有信息流，回首页
          return;
        }
        switchToFile(id);
        return;
      }
    });

    refs.panelClose.addEventListener('click', closePanel);

    // 详情页：滚动到底部自动加载更多回答（与知乎信息流同逻辑）
    refs.codeWrap.addEventListener('scroll', function () {
      if (state.file !== 'detail' || !state.detail) return;
      if (nearBottom()) autoLoadAnswers();
    });

    refs.code.addEventListener('click', function (e) {
      var t;
      if ((t = e.target.closest('.zvsc-img'))) {
        t.classList.toggle('zvsc-img-clear'); // 点图片本体：虚化 ↔ 清晰
        return;
      }
      if ((t = e.target.closest('.zvsc-imgtok'))) { toggleImage(t); return; }
      if ((t = e.target.closest('.zvsc-btn'))) {
        var b = t.getAttribute('data-btn') || '';
        if (b.indexOf('vote:') === 0) {
          var a = state.detail && state.detail.answers[+b.slice(5)];
          if (a && a.url) location.href = a.url;
        } else if (b.indexOf('comments:') === 0) {
          openComments(+b.slice(9));
        }
        return;
      }
      if ((t = e.target.closest('.zvsc-set-val'))) { cycleSetting(t.getAttribute('data-set')); return; }
      if ((t = e.target.closest('.zvsc-searchline'))) { openSearchModal(); return; }
      if ((t = e.target.closest('.zvsc-more'))) { loadMore(); return; }
    });

    /* ----- 命令面板 ----- */
    refs.paletteInput.addEventListener('input', function () {
      paletteSel = 0;
      renderPalette();
    });
    refs.paletteInput.addEventListener('keydown', paletteKeydown);
    refs.paletteList.addEventListener('click', function (e) {
      var li = e.target.closest('[data-pi]');
      if (!li) return;
      var en = (refs.paletteList._entries || [])[+li.getAttribute('data-pi')];
      if (!en) return;
      closePalette();
      if (en.run) en.run();
      else if (en.url) location.href = en.url;
    });

    /* ----- 搜索弹窗 ----- */
    refs.searchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doSearch();
      else if (e.key === 'Escape') closeSearchModal();
    });
    refs.searchModal.addEventListener('click', function (e) {
      if (e.target === refs.searchModal) closeSearchModal();
    });

    /* ----- 全局快捷键 ----- */
    window.addEventListener('keydown', function (e) {
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault();
        toggleVue(); // Alt+V = Vue 伪装开关
      } else if (e.key === 'Escape') {
        if (refs.palette.style.display !== 'none') closePalette();
        else if (refs.searchModal.style.display !== 'none') closeSearchModal();
        else if (refs.panel.style.display !== 'none') closePanel();
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
        e.preventDefault();
        openPalette();
      }
    }, true);

    built = true;
  }

  /* ------------------------------ 渲染 ------------------------------ */

  function renderChrome() {
    var f = FILES[state.file];
    var label = docLabel(state.file);

    refs.tabbar.innerHTML =
      '<div class="zvsc-tab zvsc-tab-active">' +
        '<span class="zvsc-tab-badge">' + badge(f.badge) + '</span>' +
        '<span>' + esc(label) + '</span>' +
      '</div>';

    var section =
      state.file === 'detail' ? 'question' :
      state.file === 'article' ? 'posts' :
      state.file === 'search' ? 'search' :
      state.file === 'settings' ? 'user' :
      state.file === 'vue' ? 'src' : 'feed';
    refs.crumbs.innerHTML =
      '<span class="zvsc-crumb">zhihu</span><span class="zvsc-crumb-sep">›</span>' +
      '<span class="zvsc-crumb">' + esc(section) + '</span><span class="zvsc-crumb-sep">›</span>' +
      '<span class="zvsc-crumb zvsc-crumb-cur">' + esc(label) + '</span>';

    refs.openEditors.innerHTML =
      '<div class="zvsc-tree-item zvsc-opened" data-file="' + state.file + '">' +
        badge(f.badge) + '<span class="zvsc-tree-name">' + esc(label) + '</span>' +
      '</div>';

    var ids = treeIds();
    refs.tree.innerHTML = ids.map(function (id) {
      return (
        '<div class="zvsc-tree-item' + (id === state.file ? ' zvsc-tree-active' : '') + '" data-file="' + id + '">' +
          badge(FILES[id].badge) + '<span class="zvsc-tree-name">' + esc(fileLabel(id)) + '</span>' +
        '</div>'
      );
    }).join('');

    refs.lang.textContent =
      state.file === 'search' || state.file === 'settings' ? 'JSON'
        : state.file === 'vue' ? 'Vue'
        : state.file === 'article' ? 'Markdown' : 'TypeScript';
  }

  function treeIds() {
    if (page === 'question') return ['detail', 'recommend', 'following', 'hot', 'search', 'settings'];
    if (page === 'article') return ['article', 'recommend', 'following', 'hot', 'search', 'settings'];
    return ['recommend', 'following', 'hot', 'search', 'settings'];
  }

  function setCodeLines(lines, keepScroll) {
    var st = keepScroll ? refs.codeWrap.scrollTop : 0;
    state.lines = lines.length;
    var body = '';
    lines.forEach(function (html, i) {
      // 行号内联在每行里：后续插入图片行不会导致行号错位
      body += '<div class="zvsc-line"><span class="zvsc-ln">' + (i + 1) + '</span><span class="zvsc-lc">' + (html || '&nbsp;') + '</span></div>';
    });
    refs.code.innerHTML = '<div class="zvsc-lines">' + body + '</div>';
    refs.pos.textContent = 'Ln ' + state.lines + ', Col 1';
    refs.codeWrap.scrollTop = keepScroll ? st : 0;
  }

  function renderCode() {
    var f = FILES[state.file];
    var lines;

    if (state.file === 'vue') {
      setCodeLines(vueLines()); // 老板键伪装页
      return;
    }
    if (state.file === 'article') {
      lines = state.article ? articleLines(state.article) : commentLines(['加载中 …']);
      setCodeLines(lines, true); // 保持滚动位置
      if (state.article) reexpandImages();
      return;
    }
    if (state.file === 'settings') {
      lines = settingsLines();
    } else if (state.file === 'detail') {
      lines = state.detail ? detailLines(state.detail) : commentLines(['加载中 …']);
      setCodeLines(lines, true); // 详情页重渲染保持滚动位置
      if (state.detail) reexpandImages();
      return;
    } else if (state.file === 'search') {
      lines = state.items.length
        ? jsonLines(state.items)
        : commentLines([
            state.loading ? '加载中 …' : '未解析到搜索结果',
            '点击此处或左侧 search.json 发起新搜索',
            '（上一行不可点的话，用活动栏放大镜图标）'
          ]);
      // 把提示行变成可点击
      if (!state.items.length) {
        lines = lines.map(function (l, i) {
          return i === 1
            ? '<a class="zvsc-cmt zvsc-searchline" href="javascript:void(0)">' + esc('// 点击此处或左侧 search.json 发起新搜索') + '</a>'
            : l;
        });
      }
    } else {
      lines = state.items.length
        ? tsLines(state.items, f)
        : commentLines([
            state.loading ? '加载中 …' : '未解析到内容',
            '知乎可能改版了，或当前未登录 / 无数据',
            '试试侧边栏的其他文件，或刷新页面'
          ]);

      var canMore = state.items.length > 0 && !state.exhausted;
      if (canMore) {
        lines = lines.slice(0, -1).concat([C.p('];')]);
        lines.push('');
        lines.push('<a class="zvsc-cmt zvsc-more" href="javascript:void(0)">' + esc('// …加载更多') + '</a>');
      }
    }
    setCodeLines(lines);
  }

  /* ---------------------------- 图片折叠 ---------------------------- */

  /** 当前文件对应的图片地址表（详情页按回答分组，专栏文章是平铺数组） */
  function imagesFor(ans) {
    if (state.file === 'article') return (state.article && state.article.images) || [];
    var a = state.detail && state.detail.answers[ans];
    return (a && a.images) || [];
  }

  function insertImageLine(tok) {
    var ans = +tok.getAttribute('data-zvsc-ans');
    var idx = +tok.getAttribute('data-zvsc-img');
    var src = imagesFor(ans)[idx];
    if (!src) return;
    var lineDiv = tok.closest('.zvsc-line');
    var div = document.createElement('div');
    div.className = 'zvsc-line zvsc-imgline';
    div.setAttribute('data-zvsc-ans', ans);
    div.setAttribute('data-zvsc-img', idx);
    div.innerHTML =
      '<span class="zvsc-ln"></span>' +
      '<span class="zvsc-lc"><span class="zvsc-img-indent">      </span>' +
      '<img class="zvsc-img" src="' + escAttr(src) + '" loading="lazy" alt="图片"></span>';
    lineDiv.after(div);
    tok.textContent = '[收起图片]'; // 展开态：token 变为收起提示
  }

  function collapseImage(tok, lineDiv, key) {
    lineDiv.remove();
    delete state.expanded[key];
    tok.textContent = '[图片]';
  }

  function toggleImage(tok) {
    var ans = tok.getAttribute('data-zvsc-ans');
    var idx = tok.getAttribute('data-zvsc-img');
    var key = ans + ':' + idx;
    var lineDiv = tok.closest('.zvsc-line');
    var next = lineDiv.nextElementSibling;
    if (
      next &&
      next.classList.contains('zvsc-imgline') &&
      next.getAttribute('data-zvsc-img') === idx &&
      next.getAttribute('data-zvsc-ans') === ans
    ) {
      collapseImage(tok, next, key);
      return;
    }
    insertImageLine(tok);
    state.expanded[key] = 1;
  }

  /** 重渲染后恢复展开状态：默认展开模式全展开，否则只恢复手动展开过的 */
  function reexpandImages() {
    if (settings.imageDefault === 'expanded') {
      expandAllImages();
      return;
    }
    Object.keys(state.expanded).forEach(function (k) {
      var p = k.split(':');
      var tok = refs.code.querySelector(
        '.zvsc-imgtok[data-zvsc-ans="' + p[0] + '"][data-zvsc-img="' + p[1] + '"]'
      );
      if (tok) insertImageLine(tok);
    });
  }

  function expandAllImages() {
    Array.prototype.forEach.call(refs.code.querySelectorAll('.zvsc-imgtok'), function (tok) {
      var nl = tok.closest('.zvsc-line').nextElementSibling;
      if (!(nl && nl.classList.contains('zvsc-imgline'))) insertImageLine(tok);
    });
  }

  /* --------------------------- 评论面板 --------------------------- */

  function commentCard(c, depth) {
    var h =
      '<div class="zvsc-cmt-card" style="margin-left:' + depth * 22 + 'px">' +
        '<div class="zvsc-cmt-head">' +
          '<span class="zvsc-cmt-corner">' + (depth ? '└' : '┌') + '</span>' +
          '<span class="zvsc-cmt-name">@' + esc(c.name) + '</span>' +
          '<span class="zvsc-cmt-time">(' + esc(c.time) + ')</span>' +
          '<span class="zvsc-cmt-votes">▲ ' + (c.votes || 0) + ' 赞</span>' +
        '</div>' +
        '<div class="zvsc-cmt-body">' + esc(c.content) + '</div>';
    (c.children || []).forEach(function (cc) { h += commentCard(cc, depth + 1); });
    return h + '</div>';
  }

  function mapComment(c) {
    c = c || {};
    var author = c.author || {};
    var member = author.member || {};
    return {
      name: author.name || member.name || '知乎用户',
      content: stripHtml(c.content),
      votes: c.vote_count || 0,
      time: fmtTime(c.created_time),
      children: (c.child_comments || []).map(mapComment)
    };
  }

  function panelHeaderLines(target, author) {
    return (
      '<div class="zvsc-term-line"><span class="zvsc-term-prompt">bash-5.2$</span> zhihu-cli comments --target ' +
        esc(target) + ' --author "@' + esc(author || '') + '"</div>'
    );
  }

  function openComments(i) {
    var isArticle = state.file === 'article';
    var a = isArticle ? state.article : state.detail && state.detail.answers[i];
    if (!a) return;
    var target = isArticle ? 'article/' + (a.id || '?') : 'answer/' + (a.id || '?');
    var apiUrl = isArticle
      ? '/api/v4/articles/' + a.id + '/root_comments?order=normal&status=open&limit=20&offset=0'
      : '/api/v4/answers/' + a.id + '/root_comments?order=normal&status=open&limit=20&offset=0';

    refs.panel.style.display = 'flex';
    refs.ptabComments.textContent =
      'Comments (' + (isArticle ? 'Article' : 'Answer #' + (i + 1)) + ' - @' + (a.author || '未知') + ')';
    refs.panelBody.innerHTML =
      panelHeaderLines(target, a.author) +
      '<div class="zvsc-term-line zvsc-term-dim">[Zhihu API] Connecting to live comment stream for ' +
        esc(target) + '...</div>';

    if (!a.id) {
      refs.panelBody.innerHTML +=
        '<div class="zvsc-term-line zvsc-term-err">// 无法从页面获取 ID，无法加载评论</div>';
      return;
    }

    fetchJSON(apiUrl)
      .then(function (json) {
        var arr = ((json && json.data) || []).map(mapComment);
        var total = (json && json.paging && typeof json.paging.totals === 'number') ? json.paging.totals : arr.length;
        var html =
          panelHeaderLines(target, a.author) +
          '<div class="zvsc-term-line zvsc-term-dim">[Zhihu API] Connecting to live comment stream for ' +
            esc(target) + '...</div>' +
          '<div class="zvsc-term-line zvsc-term-ok">// Successfully loaded ' + arr.length +
            ' root comment threads' + (total > arr.length ? ' (Total: ' + total + ')' : '') + '</div>';
        if (!arr.length) {
          html += '<div class="zvsc-term-line zvsc-term-dim">// 暂无评论</div>';
        }
        arr.forEach(function (c) { html += commentCard(c, 0); });
        refs.panelBody.innerHTML = html;
      })
      .catch(function () {
        refs.panelBody.innerHTML =
          panelHeaderLines(target, a.author) +
          '<div class="zvsc-term-line zvsc-term-err">// 评论加载失败（接口变更、被风控或未登录）</div>';
      });
  }

  function closePanel() {
    refs.panel.style.display = 'none';
  }

  /* --------------------------- 详情页逻辑 --------------------------- */

  function mapApiAnswer(x, idx) {
    var holder = document.createElement('div');
    holder.innerHTML = x.content || '';
    var rich = (ZVSC.extractRich && ZVSC.extractRich(holder, idx)) || { lines: [], images: [] };
    return {
      id: String(x.id || ''),
      author: (x.author && x.author.name) || '',
      headline: (x.author && x.author.headline) || '',
      votes: x.vote_count || 0,
      comments: x.comment_count || 0,
      url: (state.detail && state.detail.qid && x.id)
        ? location.origin + '/question/' + state.detail.qid + '/answer/' + x.id : '',
      lines: rich.lines,
      images: rich.images
    };
  }

  function answersAPIUrl(limit) {
    return '/api/v4/questions/' + state.detail.qid +
      '/answers?include=data[*].content,vote_count,comment_count,author.name,author.headline' +
      '&limit=' + limit + '&offset=' + state.detail.answers.length + '&sort_by=default';
  }

  /** 初始回答数不足设置值时，用 API 补齐 */
  function fillDetail() {
    var d = state.detail;
    if (!d || !d.qid) return;
    var need = Math.min(d.shown - d.answers.length, 20);
    if (need <= 0) return;
    fetchJSON(answersAPIUrl(need))
      .then(function (json) {
        ((json && json.data) || []).forEach(function (x) {
          d.answers.push(mapApiAnswer(x, d.answers.length));
        });
        if ((json && json.paging && json.paging.is_end) || (d.total && d.answers.length >= d.total)) {
          d.allLoaded = true;
        }
        renderCode();
      })
      .catch(function () { renderCode(); });
  }

  function nearBottom() {
    var el = refs.codeWrap;
    return el.scrollTop + el.clientHeight >= el.scrollHeight - 600;
  }

  /** 滚动到底自动加载下一批回答（与知乎信息流同逻辑） */
  function autoLoadAnswers() {
    var d = state.detail;
    if (!d || d.loadingMore || d.allLoaded || !d.qid) return;
    if (state.file !== 'detail') return;
    d.loadingMore = true;
    renderCode();
    fetchJSON(answersAPIUrl(5))
      .then(function (json) {
        ((json && json.data) || []).forEach(function (x) {
          d.answers.push(mapApiAnswer(x, d.answers.length));
        });
        // 关键：新拉到的回答立刻纳入展示（否则只进数组不上屏，
        // 且贴底判断恒真会把全部回答拉完才停——正是「只显示 1 个却说加载了 166 个」的原因）
        d.shown = d.answers.length;
        if ((json && json.paging && json.paging.is_end) || (d.total && d.answers.length >= d.total)) {
          d.allLoaded = true;
        }
        d.loadingMore = false;
        renderCode();
        if (nearBottom()) autoLoadAnswers(); // 一屏内仍贴底则继续补
      })
      .catch(function () {
        d.allLoaded = true;
        d.loadingMore = false;
        renderCode();
      });
  }

  function initDetail() {
    var d = (ZVSC.parseQuestion && ZVSC.parseQuestion()) || null;
    if (!d || (!d.answers.length && !d.qid)) {
      state.detail = { qid: '', title: document.title || '详情', total: 0, answers: [], shown: 0, allLoaded: true, loadingMore: false };
      renderChrome();
      renderCode();
      return;
    }
    state.detail = d;
    // 初始展示数：跟知乎一致（SSR 给多少显示多少）；设置了数字则用 API 补齐
    d.shown = typeof settings.answersPerView === 'number'
      ? settings.answersPerView
      : d.answers.length;
    renderChrome();
    renderCode();
    fillDetail();
    if (nearBottom()) autoLoadAnswers(); // 内容不足一屏时直接续载
  }

  /** 专栏文章页初始化 */
  function initArticle() {
    var a = (ZVSC.parseArticle && ZVSC.parseArticle()) || null;
    state.article = a || {
      id: '', title: document.title || '文章', author: '',
      votes: 0, comments: 0, lines: [], images: []
    };
    renderChrome();
    renderCode();
  }

  /* ---------------------------- 设置 ---------------------------- */

  function saveSettings() {
    cacheSettings();
    try {
      chrome.storage.local.set({ settings: settings });
    } catch (e) { /* ignore */ }
  }

  function cycleSetting(key) {
    var arr = OPTS[key];
    if (!arr) return;
    var i = arr.indexOf(settings[key]);
    settings[key] = arr[(i + 1) % arr.length];
    saveSettings();
    applyTheme();
    if (state.file === 'settings') renderCode();
    else if (state.file === 'detail') renderCode();
  }

  function applyTheme() {
    if (overlay) {
      THEMES.forEach(function (t) { overlay.classList.remove('zvsc-theme-' + t); });
      overlay.classList.add('zvsc-theme-' + settings.theme);
    }
    document.documentElement.setAttribute('data-zvsc-theme', settings.theme);
  }

  /* ---------------------------- 文件切换 ---------------------------- */

  function parseFor(fileId) {
    return (ZVSC.parseFor && ZVSC.parseFor(fileId)) || [];
  }

  function switchToFile(fileId, force) {
    var f = FILES[fileId];
    if (!f || fileId === 'vue') return; // vue 伪装只经老板键进出
    if (state.vueMode) toggleVue();
    if (fileId === state.file && !force && fileId !== 'detail') return;

    if (f.kind === 'feed' && page !== 'home') {
      location.href = '/'; // 非首页没有信息流 DOM，回首页
      return;
    }

    state.file = fileId;

    if (fileId === 'settings') {
      renderChrome();
      renderCode();
      return;
    }
    if (fileId === 'detail') {
      renderChrome();
      if (!state.detail) initDetail();
      else renderCode();
      return;
    }
    if (fileId === 'article') {
      if (page !== 'article') return; // 文件只在专栏页存在
      state.file = fileId;
      renderChrome();
      if (!state.article) initArticle();
      else renderCode();
      return;
    }

    state.loading = true;
    renderChrome();
    setCodeLines(commentLines(['加载中 …']));

    var wantTab = f.tab;
    var tries = 12;

    (function attempt() {
      if (state.file !== fileId) return; // 用户已切到其他文件，放弃本次加载

      var items = parseFor(fileId);
      var activeOk = !wantTab || (ZVSC.activeTabName && ZVSC.activeTabName().indexOf(wantTab) > -1);

      if (items.length && (activeOk || tries <= 0)) {
        state.items = items;
        state.loading = false;
        state.exhausted = false;
        renderCode();
        return;
      }

      // 等待约 1.8 秒后替用户点击知乎自己的 tab，再等渲染
      if (tries === 8 && wantTab && ZVSC.clickTab) ZVSC.clickTab(wantTab);

      if (tries <= 0) {
        state.items = items;
        state.loading = false;
        renderCode();
        return;
      }
      tries--;
      setTimeout(attempt, 300);
    })();
  }

  /** 滚动隐藏的原页面触发知乎无限加载，然后重新解析（信息流） */
  function loadMore() {
    if (state.loading || state.exhausted || state.file === 'detail') return;
    var myFile = state.file;
    var before = state.items.length;
    var sentinel = ZVSC.feedSentinel && ZVSC.feedSentinel();
    if (sentinel) sentinel.scrollIntoView({ block: 'end' });

    state.loading = true;
    setTimeout(function () {
      if (state.file !== myFile) return;
      var items = parseFor(myFile);
      window.scrollTo(0, 0);
      state.loading = false;
      if (items.length > before) {
        state.items = items;
        renderCode();
      } else {
        state.exhausted = true;
        renderCode();
      }
    }, 1200);
  }

  /* ---------------------------- 搜索弹窗 ---------------------------- */

  function openSearchModal() {
    closePalette();
    refs.searchModal.style.display = 'flex';
    refs.searchInput.value = '';
    setTimeout(function () { refs.searchInput.focus(); }, 0);
  }

  function closeSearchModal() {
    refs.searchModal.style.display = 'none';
  }

  function doSearch() {
    var q = refs.searchInput.value.trim();
    if (!q) return;
    closeSearchModal();
    location.href = 'https://www.zhihu.com/search?q=' + encodeURIComponent(q);
  }

  /* --------------------- 老板键：Vue 代码伪装 --------------------- */

  /** 属性片段： name="value" */
  function attr(name, val) {
    return ' ' + C.key(name) + C.p('=') + C.str('"' + val + '"');
  }

  function vueLines() {
    var L = [];

    /* ---------- template ---------- */
    L.push(C.ty('<template>'));
    L.push('  ' + C.ty('<div') + attr('class', 'user-dashboard') + C.ty('>'));
    L.push('    ' + C.ty('<header') + attr('class', 'toolbar') + C.ty('>'));
    L.push('      ' + C.ty('<h1>') + C.p('{{') + ' ' + C.vr('pageTitle') + ' ' + C.p('}}') + C.ty('</h1>'));
    L.push('      ' + C.ty('<el-button') + attr('type', 'primary') + attr('icon', 'Refresh') + attr('@click', 'handleRefresh') + C.ty('>'));
    L.push('        刷新数据');
    L.push('      ' + C.ty('</el-button>'));
    L.push('    ' + C.ty('</header>'));
    L.push('');
    L.push('    ' + C.ty('<el-table') + attr('v-loading', 'loading') + attr(':data', 'filteredList') + attr('stripe', '') + C.ty('>'));
    L.push('      ' + C.ty('<el-table-column') + attr('type', 'index') + attr('label', '#') + attr('width', '60') + ' ' + C.ty('/>'));
    L.push('      ' + C.ty('<el-table-column') + attr('prop', 'name') + attr('label', '姓名') + attr('min-width', '120') + ' ' + C.ty('/>'));
    L.push('      ' + C.ty('<el-table-column') + attr('prop', 'department') + attr('label', '部门') + ' ' + C.ty('/>'));
    L.push('      ' + C.ty('<el-table-column') + attr('prop', 'status') + attr('label', '状态') + attr('align', 'center') + C.ty('>'));
    L.push('        ' + C.ty('<template') + ' ' + C.key('#default') + C.p('=') + C.str('"{ row }"') + C.ty('>'));
    L.push('          ' + C.ty('<el-tag') + ' ' + C.key(':type') + C.p('=') + C.str('"row.status === 1 ? \'success\' : \'info\'"') + C.ty('>'));
    L.push('            ' + C.p('{{') + ' ' + C.vr('row.status') + ' ' + C.kw('===') + ' ' + C.num('1') + ' ' + C.p('?') + ' ' + C.str("'在职'") + ' ' + C.p(':') + ' ' + C.str("'离职'") + ' ' + C.p('}}'));
    L.push('          ' + C.ty('</el-tag>'));
    L.push('        ' + C.ty('</template>'));
    L.push('      ' + C.ty('</el-table-column>'));
    L.push('      ' + C.ty('<el-table-column') + attr('prop', 'updatedAt') + attr('label', '更新时间') + attr('width', '160') + ' ' + C.ty('/>'));
    L.push('    ' + C.ty('</el-table>'));
    L.push('');
    L.push('    ' + C.ty('<footer') + attr('class', 'pager') + C.ty('>'));
    L.push('      ' + C.ty('<el-pagination'));
    L.push('        ' + C.key('v-model:current-page') + C.p('=') + C.str('"page"'));
    L.push('        ' + C.key(':page-size') + C.p('=') + C.str('"pageSize"'));
    L.push('        ' + C.key(':total') + C.p('=') + C.str('"total"'));
    L.push('        ' + attr('layout', 'prev, pager, next, jumper'));
    L.push('        ' + attr('@current-change', 'fetchList'));
    L.push('      ' + C.ty('/>'));
    L.push('    ' + C.ty('</footer>'));
    L.push('  ' + C.ty('</div>'));
    L.push(C.ty('</template>'));
    L.push('');

    /* ---------- script ---------- */
    L.push(C.ty('<script') + ' ' + C.key('setup') + C.ty('>'));
    L.push(C.kw('import') + ' ' + C.p('{ ') + C.vr('ref') + C.p(', ') + C.vr('computed') + C.p(', ') + C.vr('onMounted') + C.p(' } ') + C.kw('from') + ' ' + C.str("'vue'"));
    L.push(C.kw('import') + ' ' + C.p('{ ') + C.vr('getUserList') + C.p(' } ') + C.kw('from') + ' ' + C.str("'@/api/user'"));
    L.push('');
    L.push(C.vr('defineOptions') + C.p('({ ') + C.key('name') + C.p(': ') + C.str("'UserDashboard'") + ' ' + C.p('})'));
    L.push('');
    L.push(C.kw('const') + ' ' + C.vr('pageTitle') + ' ' + C.p('=') + ' ' + C.vr('ref') + C.p('(') + C.str("'用户管理'") + C.p(')'));
    L.push(C.kw('const') + ' ' + C.vr('loading') + ' ' + C.p('=') + ' ' + C.vr('ref') + C.p('(') + C.kw('false') + C.p(')'));
    L.push(C.kw('const') + ' ' + C.vr('userList') + ' ' + C.p('=') + ' ' + C.vr('ref') + C.p('[') + C.p(']'));
    L.push(C.kw('const') + ' ' + C.vr('total') + ' ' + C.p('=') + ' ' + C.vr('ref') + C.p('(') + C.num('0') + C.p(')'));
    L.push(C.kw('const') + ' ' + C.vr('page') + ' ' + C.p('=') + ' ' + C.vr('ref') + C.p('(') + C.num('1') + C.p(')'));
    L.push(C.kw('const') + ' ' + C.vr('pageSize') + ' ' + C.p('=') + ' ' + C.num('20'));
    L.push('');
    L.push(C.kw('const') + ' ' + C.vr('filteredList') + ' ' + C.p('=') + ' ' + C.vr('computed') + C.p('(()') + ' ' + C.kw('=>') + ' ' + C.vr('userList') + C.p('.value.') + C.vr('filter') + C.p('((') + C.vr('u') + C.p(')') + ' ' + C.kw('=>') + ' ' + C.vr('u') + C.p('.value.') + C.vr('status') + ' ' + C.kw('!==') + ' ' + C.num('0') + C.p('))'));
    L.push('');
    L.push(C.kw('async') + ' ' + C.kw('function') + ' ' + C.vr('fetchList') + C.p('() {'));
    L.push('  ' + C.vr('loading') + C.p('.value =') + ' ' + C.kw('true'));
    L.push('  ' + C.kw('try') + ' ' + C.p('{'));
    L.push('    ' + C.kw('const') + ' ' + C.p('{ ') + C.vr('list') + C.p(', ') + C.vr('count') + ' ' + C.p('} =') + ' ' + C.kw('await') + ' ' + C.vr('getUserList') + C.p('({ ') + C.key('page') + C.p(':') + ' ' + C.vr('page') + C.p('.value,') + ' ' + C.key('pageSize') + ' ' + C.p('})'));
    L.push('    ' + C.vr('userList') + C.p('.value =') + ' ' + C.vr('list'));
    L.push('    ' + C.vr('total') + C.p('.value =') + ' ' + C.vr('count'));
    L.push('  ' + C.p('}') + ' ' + C.kw('catch') + ' ' + C.p('(') + C.vr('e') + C.p(')') + ' ' + C.p('{'));
    L.push('    ' + C.vr('console') + C.p('.') + C.vr('error') + C.p('(') + C.str("'[dashboard] 拉取用户列表失败'") + C.p(',') + ' ' + C.vr('e') + C.p(')'));
    L.push('  ' + C.p('}') + ' ' + C.kw('finally') + ' ' + C.p('{'));
    L.push('    ' + C.vr('loading') + C.p('.value =') + ' ' + C.kw('false'));
    L.push('  ' + C.p('}'));
    L.push(C.p('}'));
    L.push('');
    L.push(C.kw('function') + ' ' + C.vr('handleRefresh') + C.p('() {'));
    L.push('  ' + C.vr('page') + C.p('.value =') + ' ' + C.num('1'));
    L.push('  ' + C.vr('fetchList') + C.p('()'));
    L.push(C.p('}'));
    L.push('');
    L.push(C.vr('onMounted') + C.p('(') + C.vr('fetchList') + C.p(')'));
    L.push(C.ty('</script>'));
    L.push('');

    /* ---------- style ---------- */
    L.push(C.ty('<style') + ' ' + C.key('scoped') + C.ty('>'));
    L.push(C.ty('.user-dashboard') + ' ' + C.p('{'));
    L.push('  ' + C.key('padding') + C.p(':') + ' ' + C.num('24px') + C.p(';'));
    L.push('  ' + C.key('min-height') + C.p(':') + ' ' + C.num('100vh') + C.p(';'));
    L.push('  ' + C.key('background') + C.p(':') + ' ' + C.num('#f5f7fa') + C.p(';'));
    L.push(C.p('}'));
    L.push(C.ty('.toolbar') + ' ' + C.p('{'));
    L.push('  ' + C.key('display') + C.p(':') + ' ' + C.vr('flex') + C.p(';'));
    L.push('  ' + C.key('align-items') + C.p(':') + ' ' + C.vr('center') + C.p(';'));
    L.push('  ' + C.key('justify-content') + C.p(':') + ' ' + C.vr('space-between') + C.p(';'));
    L.push('  ' + C.key('margin-bottom') + C.p(':') + ' ' + C.num('16px') + C.p(';'));
    L.push(C.p('}'));
    L.push(C.ty('.pager') + ' ' + C.p('{'));
    L.push('  ' + C.key('display') + C.p(':') + ' ' + C.vr('flex') + C.p(';'));
    L.push('  ' + C.key('justify-content') + C.p(':') + ' ' + C.vr('flex-end') + C.p(';'));
    L.push('  ' + C.key('margin-top') + C.p(':') + ' ' + C.num('16px') + C.p(';'));
    L.push(C.p('}'));
    L.push(C.ty('</style>'));
    return L;
  }

  function toggleVue() {
    if (state.vueMode) {
      state.vueMode = false;
      state.file = vueSavedFile || state.file;
      renderChrome();
      renderCode();
    } else {
      state.vueMode = true;
      vueSavedFile = state.file === 'vue' ? 'recommend' : state.file;
      state.file = 'vue';
      renderChrome();
      setCodeLines(vueLines());
    }
  }

  /* ---------------------------- 命令面板 ---------------------------- */

  var paletteSel = -1;

  function paletteEntries(q) {
    var cmds = [
      { label: '▶ 打开 recommend.ts（推荐）', run: function () { switchToFile('recommend', true); } },
      { label: '▶ 打开 following.ts（关注）', run: function () { switchToFile('following', true); } },
      { label: '▶ 打开 hot_rank.ts（热榜）', run: function () { switchToFile('hot', true); } },
      { label: '▶ 知乎搜索…', run: openSearchModal },
      { label: '▶ 打开 settings.json（设置）', run: function () { switchToFile('settings', true); } },
      { label: '▶ 老板键：Vue 代码伪装 (Alt+V)', run: toggleVue }
    ];
    if (q && q.charAt(0) === '>') {
      var kw = q.slice(1).trim().toLowerCase();
      return cmds.filter(function (c) { return !kw || c.label.toLowerCase().indexOf(kw) > -1; });
    }
    var kw2 = (q || '').trim().toLowerCase();
    var items = state.items
      .filter(function (it) {
        return !kw2 || (it.title + ' ' + (it.author || '')).toLowerCase().indexOf(kw2) > -1;
      })
      .map(function (it) {
        return { label: (it.title || '').slice(0, 80), detail: it.author || '', url: it.url };
      });
    return kw2 ? items : cmds.concat(items.slice(0, 20));
  }

  function renderPalette() {
    var q = refs.paletteInput.value;
    var entries = paletteEntries(q);
    if (paletteSel >= entries.length) paletteSel = entries.length - 1;
    refs.paletteList.innerHTML = entries.length
      ? entries.map(function (en, i) {
          return (
            '<li class="zvsc-pal-item' + (i === paletteSel ? ' zvsc-pal-sel' : '') + '" data-pi="' + i + '">' +
              '<span class="zvsc-pal-label">' + esc(en.label) + '</span>' +
              (en.detail ? '<span class="zvsc-pal-detail">' + esc(en.detail) + '</span>' : '') +
            '</li>'
          );
        }).join('')
      : '<li class="zvsc-pal-empty">没有匹配结果</li>';
    refs.paletteList._entries = entries;
  }

  function openPalette() {
    refs.palette.style.display = '';
    refs.paletteInput.value = '';
    paletteSel = 0;
    renderPalette();
    refs.paletteInput.focus();
  }

  function closePalette() {
    refs.palette.style.display = 'none';
    refs.paletteInput.blur();
  }

  function paletteKeydown(e) {
    var entries = refs.paletteList._entries || [];
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      paletteSel = Math.min(paletteSel + 1, entries.length - 1);
      renderPalette();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      paletteSel = Math.max(paletteSel - 1, 0);
      renderPalette();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      var en = entries[paletteSel];
      if (en) {
        closePalette();
        if (en.run) en.run();
        else if (en.url) location.href = en.url;
      }
    }
  }

  /* ------------------------------ 开关 ------------------------------ */

  function apply() {
    if (!enabled) {
      if (overlay) overlay.style.display = 'none';
      return;
    }
    if (!built) buildOverlay();
    overlay.style.display = '';
  }

  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === 'local' && changes.enabled) {
        enabled = !!changes.enabled.newValue;
        apply();
      }
      if (area === 'local' && changes.settings) {
        settings = normalizeSettings(Object.assign(settings, changes.settings.newValue || {}));
        applyTheme();
        if (state.file === 'settings') renderCode();
        else if (state.file === 'detail') renderCode();
      }
    });
  } catch (e) { /* ignore */ }

  /* ------------------------------ 启动 ------------------------------ */

  /**
   * document_start 立即建 overlay（挂在 documentElement 上，body 尚未存在也能显示），
   * 与 content.js 的首屏遮罩无缝衔接，消灭刷新/跳页时闪现原页面；
   * DOM 就绪后再解析渲染真实内容。
   */
  function boot() {
    loadCachedSettings();
    if (page === 'question') state.file = 'detail';
    else if (page === 'search') state.file = 'search';
    else if (page === 'article') state.file = 'article';
    else state.file = location.pathname.indexOf('/hot') === 0 ? 'hot' : 'recommend';

    applyTheme();
    try {
      apply(); // 立即构建并显示 overlay（内容为「加载中」占位）
      renderChrome();
      setCodeLines(commentLines(['加载中 …']));
    } catch (e) {
      // 初始化出错也要撤 Loader 放行页面，不能把用户卡在 loading
    }
    // overlay 已就位：撤掉 content.js 的首屏 Loader，无缝交接
    if (window.ZVSC_LOADER) window.ZVSC_LOADER.hide();
    document.documentElement.setAttribute('data-zvsc-ready', '1');

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', onDomReady);
    } else {
      onDomReady();
    }
  }

  function onDomReady() {
    // overlay 建于 document_start（当时 body 不存在，挂在 html 上），移进 body 更稳妥
    if (document.body && overlay && overlay.parentElement !== document.body) {
      document.body.appendChild(overlay);
    }

    // storage 异步校准设置（首屏已用 localStorage 缓存，这里只处理差异）
    try {
      chrome.storage.local.get({ settings: settings }, function (res) {
        if (res && res.settings) {
          var merged = normalizeSettings(Object.assign({}, settings, res.settings));
          if (JSON.stringify(merged) !== JSON.stringify(settings)) {
            settings = merged;
            applyTheme();
            if (state.file === 'settings') renderCode();
            else if (state.file === 'detail') { state.expanded = {}; initDetail(); }
          }
        }
      });
    } catch (e) { /* ignore */ }

    if (page === 'home') {
      var tab = (ZVSC.activeTabName && ZVSC.activeTabName()) || '';
      var want = tab.indexOf('关注') > -1 ? 'following' : tab.indexOf('热榜') > -1 ? 'hot' : 'recommend';
      if (location.pathname.indexOf('/hot') === 0) want = 'hot';
      switchToFile(want, true);
    } else if (page === 'search') {
      switchToFile('search', true);
    } else if (page === 'question') {
      initDetail();
    } else if (page === 'article') {
      initArticle();
    }
  }

  /* --------------------- SPA 路由看守 --------------------- */

  /**
   * 知乎是 SPA：站内点击（进详情、回退首页、换搜索词）只改地址不重载，
   * 内容脚本不会重新注入，页面变化后旧视图必然错乱。
   *
   * 防误判（否则会陷入 reload 循环，表现为 loading 特别久）：
   *  · 启动后 1.5s 宽限期内知乎可能 replaceState 规范化 URL——跟随不刷新
   *  · 宽限期后地址变化需连续两次轮询仍在才 reload（滤掉瞬时变更）
   */
  function routeKey() {
    return (
      ((ZVSC.pageType && ZVSC.pageType()) || 'other') +
      '|' + location.pathname + '|' + location.search
    );
  }
  var curRoute = routeKey();
  var bootedAt = Date.now();
  var routePendingSince = 0;

  function watchRoute() {
    var now = routeKey();
    if (now !== curRoute) {
      if (Date.now() - bootedAt < 1500) {
        curRoute = now; // 宽限期：知乎初始化时的地址调整，跟随即可
      } else if (!routePendingSince) {
        routePendingSince = Date.now(); // 第一次发现变化，再观察一轮
      } else if (Date.now() - routePendingSince > 350) {
        location.reload(); // 变化稳定存在：整页刷新重建视图
        return;
      }
    } else {
      routePendingSince = 0;
    }
    setTimeout(watchRoute, 400);
  }
  setTimeout(watchRoute, 400);

  // bfcache（往返缓存）恢复时确保 overlay 状态与开关一致
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) apply();
  });

  boot();
})();
