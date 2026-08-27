/**
 * 知乎 DOM 解析器 —— 从页面真实 DOM 提取信息流/热榜/搜索/问题详情数据
 * 供 ide.js 生成代码视图。全部字段带多套候选选择器容错改版。
 */
(function () {
  'use strict';

  var ZVSC = (window.ZVSC = window.ZVSC || {});

  function txt(el) {
    return ((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
  }

  function q1(root, sels) {
    for (var i = 0; i < sels.length; i++) {
      var el = root.querySelector(sels[i]);
      if (el) return el;
    }
    return null;
  }

  function qall(root, sels) {
    for (var i = 0; i < sels.length; i++) {
      var list = root.querySelectorAll(sels[i]);
      if (list.length) return Array.prototype.slice.call(list);
    }
    return [];
  }

  function absUrl(href) {
    if (!href) return '';
    try {
      return new URL(href, location.origin).href;
    } catch (e) {
      return href;
    }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
    });
  }

  /** 从 "赞同 1,190" / "397 条评论" 之类文本里取整数 */
  function intOf(s) {
    var m = String(s || '').replace(/,/g, '').match(/(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  }

  function pageType() {
    if (location.hostname === 'zhuanlan.zhihu.com') return 'article';
    var p = location.pathname;
    if (p === '/' || p === '' || p.indexOf('/hot') === 0) return 'home';
    if (p.indexOf('/search') === 0) return 'search';
    if (p.indexOf('/question/') === 0) return 'question';
    return 'other';
  }

  ZVSC.pageType = pageType;

  /** 当前信息流 tab 名称（推荐 / 关注 / 热榜） */
  ZVSC.activeTabName = function () {
    return txt(
      q1(document, [
        '.TopstoryTabs .Tabs-link.is-active a',
        '.TopstoryTabs .Tabs-link.active a',
        '.Topstory-tabs .Tabs-link.is-active a',
        '.Topstory-tabs .Tabs-link.active a'
      ])
    );
  };

  /** 点击知乎自己的 tab（推荐/关注/热榜），触发其 SPA 切换 */
  ZVSC.clickTab = function (name) {
    var links = qall(document, [
      '.TopstoryTabs .Tabs-link a',
      '.Topstory-tabs .Tabs-link a'
    ]);
    for (var i = 0; i < links.length; i++) {
      if (txt(links[i]).indexOf(name) > -1) {
        links[i].click();
        return true;
      }
    }
    return false;
  };

  /** 信息流条目（推荐/关注 tab 通用） */
  function parseItems() {
    var nodes = qall(document, ['.TopstoryItem', '.FeedSource']);
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var a = q1(node, ['.ContentItem-title a', 'h2 a', '.ContentItem-title']);
      if (!a || !a.href) continue;
      out.push({
        id: out.length + 1,
        title: txt(a),
        author: txt(q1(node, ['.AuthorInfo-name'])),
        url: absUrl(a.getAttribute('href')),
        excerpt: txt(q1(node, ['.RichContent-inner', '.RichText'])).slice(0, 140)
      });
    }
    return out;
  }

  /** 热榜条目（独立 HotItem 结构，找不到时回落到信息流结构） */
  function parseHotItems() {
    var nodes = qall(document, ['.HotItem']);
    if (!nodes.length) return parseItems();
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var a = q1(node, ['.HotItem-title a', '.HotItem-title']);
      if (!a) continue;
      out.push({
        id: out.length + 1,
        title: txt(a),
        url: absUrl(a.getAttribute('href')),
        heat: txt(q1(node, ['.HotItem-metrics'])),
        excerpt: txt(q1(node, ['.HotItem-excerpt'])).slice(0, 140)
      });
    }
    return out;
  }

  /** 搜索结果 */
  function parseSearch() {
    var nodes = qall(document, ['.SearchResult-Card', '.Card.SearchResult-Card']);
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var a = q1(node, ['.ContentItem-title a', 'h2 a']);
      if (!a) continue;
      out.push({
        id: out.length + 1,
        title: txt(a),
        url: absUrl(a.getAttribute('href')),
        excerpt: txt(q1(node, ['.RichContent-inner', '.RichText', '.Highlight'])).slice(0, 140)
      });
    }
    return out;
  }

  ZVSC.parseFor = function (fileId) {
    if (fileId === 'search') return parseSearch();
    if (fileId === 'hot') return parseHotItems();
    return parseItems();
  };

  /** 信息流容器最后一个条目（用于触发知乎的无限加载） */
  ZVSC.feedSentinel = function () {
    return q1(document, [
      '.TopstoryItem:last-of-type',
      '.List-item:last-of-type',
      '.SearchResult-Card:last-of-type'
    ]);
  };

  /* ============================ 问题详情页 ============================ */

  /**
   * 把富文本 DOM 摘成代码行：
   * · 文本按行拆分并 HTML 转义
   * · <img>/<figure> 变成可点击的 [图片] token（data-zvsc-img 存索引）
   * · 返回 { lines: [...], images: [...] }
   */
  ZVSC.extractRich = function (el, ansIdx) {
    ansIdx = ansIdx || 0;
    var images = [];
    var lines = [''];

    function escText(s) {
      return esc(String(s).replace(/\s+/g, ' '));
    }

    function addImg(img) {
      var src =
        img.getAttribute('data-original') ||
        img.getAttribute('data-actualsrc') ||
        img.getAttribute('src') ||
        '';
      if (!src || src.indexOf('data:') === 0) return;
      if (src.indexOf('//') === 0) src = 'https:' + src;
      images.push(src);
      lines[lines.length - 1] +=
        '<span class="zvsc-imgtok" data-zvsc-ans="' + ansIdx +
        '" data-zvsc-img="' + (images.length - 1) + '">[图片]</span>';
    }

    function walk(node) {
      var c;
      if (!node) return;
      if (node.nodeType === 3) {
        lines[lines.length - 1] += escText(node.textContent);
        return;
      }
      if (node.nodeType !== 1) return;
      var tag = node.tagName;
      if (tag === 'BR') {
        lines.push('');
        return;
      }
      if (tag === 'IMG') {
        addImg(node);
        return;
      }
      if (tag === 'HR') {
        lines[lines.length - 1] += '────────────';
        lines.push('');
        return;
      }
      var block = /^(P|DIV|LI|UL|OL|BLOCKQUOTE|PRE|H[1-6]|FIGURE|TABLE|THEAD|TBODY|TR|SECTION|ARTICLE)$/.test(tag);
      if (block && lines[lines.length - 1] !== '') lines.push('');
      if (tag === 'FIGURE') {
        var img = node.querySelector('img');
        if (img) {
          addImg(img);
        } else if (node.querySelector('video')) {
          lines[lines.length - 1] += '<span class="zvsc-dimtext">[视频]</span>';
        }
        var cap = node.querySelector('figcaption');
        if (cap) {
          lines.push('');
          Array.prototype.forEach.call(cap.childNodes, walk);
        }
      } else {
        for (c = node.firstChild; c; c = c.nextSibling) walk(c);
      }
      if (block) lines.push('');
    }

    if (el) Array.prototype.forEach.call(el.childNodes, walk);

    // 收尾：去掉多余空行与行尾空白
    var out = [];
    var prevEmpty = true;
    lines.forEach(function (l) {
      var t = l.replace(/\s+$/, '');
      var empty = t === '';
      if (empty && prevEmpty) return;
      out.push(t);
      prevEmpty = empty;
    });
    while (out.length && !out[out.length - 1]) out.pop();
    return { lines: out, images: images };
  };

  /** 解析问题详情页：标题 / 回答总数 / 可见回答列表 */
  ZVSC.parseQuestion = function () {
    var title = txt(q1(document, ['.QuestionHeader-title h1', '.QuestionHeader-title']));
    var m = location.pathname.match(/\/question\/(\d+)/);
    var qid = m ? m[1] : '';

    var total = 0;
    var metaTotal = document.querySelector('meta[itemprop="answerCount"]');
    if (metaTotal) total = intOf(metaTotal.getAttribute('content'));
    if (!total) total = intOf(txt(q1(document, ['.AnswerCount', '.List-headerText'])));

    var answers = [];
    qall(document, ['.List-item .AnswerItem', '.AnswerItem']).forEach(function (node) {
      // 回答 id：优先 data-zop（JSON），回落到 id="Answer-xxx"
      var aid = '';
      var zop = node.getAttribute('data-zop');
      if (zop) {
        try {
          aid = String((JSON.parse(zop) || {}).itemId || '');
        } catch (e) { /* ignore */ }
      }
      if (!aid) {
        var am = (node.id || '').match(/(\d{5,})/);
        if (am) aid = am[1];
      }

      var cmtCount = 0;
      qall(node, ['.ContentItem-actions button', '.ContentItem-actions a']).forEach(function (b) {
        if (b.textContent.indexOf('条评论') > -1) cmtCount = intOf(b.textContent);
      });

      var rich = ZVSC.extractRich(q1(node, ['.RichContent-inner', '.RichText']), answers.length);
      answers.push({
        id: aid,
        author: txt(q1(node, ['.AuthorInfo-name'])),
        headline: txt(q1(node, ['.AuthorInfo-badgeText'])),
        votes: intOf(txt(q1(node, ['.VoteButton--up']))),
        comments: cmtCount,
        url: qid && aid ? absUrl('/question/' + qid + '/answer/' + aid) : '',
        lines: rich.lines,
        images: rich.images
      });
    });

    return { qid: qid, title: title, total: total, answers: answers, allLoaded: false, loadingMore: false };
  };

  /** 专栏文章页（zhuanlan.zhihu.com/p/xxx） */
  ZVSC.parseArticle = function () {
    var m = location.pathname.match(/\/p\/(\d+)/);
    var id = m ? m[1] : '';
    var title = txt(q1(document, ['.Post-Title', 'h1.Post-Title', 'h1']));

    var votes = 0;
    var vb = q1(document, ['.VoteButton--up', 'button.VoteButton']);
    if (vb) votes = intOf(txt(vb));

    var comments = 0;
    qall(document, ['button', 'a']).forEach(function (b) {
      if (!comments && b.textContent.indexOf('条评论') > -1) comments = intOf(b.textContent);
    });

    var rich = ZVSC.extractRich(
      q1(document, ['.Post-RichTextContainer .RichText', '.Post-RichText', '.RichText.ztext']),
      0
    );

    return {
      id: id,
      title: title,
      author: txt(q1(document, ['.AuthorInfo-name'])),
      votes: votes,
      comments: comments,
      lines: rich.lines,
      images: rich.images
    };
  };
})();
