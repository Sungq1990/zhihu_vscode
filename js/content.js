/**
 * 知乎 VS Code 换肤 —— 开关状态管理 + 首屏 Loader
 *
 * 在 document_start 运行（先于 ide.js）：
 *  1. 同步读源站 localStorage 缓存的开关状态，立刻设置 <html data-zvsc="on|off">
 *  2. IDE 页面（首页/热榜/搜索/问题详情）同步挂出一个全屏 Loader 元素
 *     （内联样式、真实 DOM，不依赖任何 CSS 文件加载），在 ide.js 接管前
 *     盖住原页面——刷新/站内跳转全程只见 VS Code 界面，绝不闪现知乎样式
 *  3. ide.js 就绪后调用 ZVSC_LOADER.hide() 撤掉 Loader；若 ide.js 异常，
 *     5 秒保险自动放行，页面不会卡死
 *  4. chrome.storage 异步校准 + onChanged 实时响应弹窗开关
 */
(function () {
  'use strict';

  var LS_KEY = 'zvsc-enabled';
  var root = document.documentElement;

  /* ---- 首屏 Loader：真实 DOM + 内联样式，document_start 立即生效 ---- */

  var loader = null;

  function showLoader() {
    if (loader) return;
    loader = document.createElement('div');
    loader.setAttribute('data-zvsc-loader', '');
    loader.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;background:#1e1e1e;' +
      'display:flex;flex-direction:column;gap:12px;align-items:center;justify-content:center;' +
      "font:13px/1.7 Consolas,'Cascadia Mono',Menlo,'Courier New',monospace;";
    loader.innerHTML =
      '<div style="color:#569cd6;font-size:15px;font-weight:700;letter-spacing:1px;">ZHIHU WORKSPACE</div>' +
      '<div style="color:#6a9955;">Loading<span class="zvsc-dot">.</span><span class="zvsc-dot">.</span><span class="zvsc-dot">.</span></div>';
    var st = document.createElement('style');
    st.textContent =
      '@keyframes zvsc-blink{0%,80%{opacity:.15}40%{opacity:1}}' +
      '[data-zvsc-loader] .zvsc-dot{animation:zvsc-blink 1.2s infinite}' +
      '[data-zvsc-loader] .zvsc-dot:nth-of-type(2){animation-delay:.2s}' +
      '[data-zvsc-loader] .zvsc-dot:nth-of-type(3){animation-delay:.4s}';
    (document.head || root).appendChild(st);
    // document_start 时 body 尚未存在，挂在 documentElement 上（fixed 定位不受影响）
    (document.body || root).appendChild(loader);
  }

  function hideLoader() {
    if (loader) {
      loader.remove();
      loader = null;
    }
  }

  // 暴露给 ide.js：overlay 就绪后撤掉 Loader
  window.ZVSC_LOADER = { hide: hideLoader };

  /** 失败保险：ide.js 1.5 秒内没接手（异常/未注入）也撤掉 Loader，不让页面卡死 */
  setTimeout(hideLoader, 1500);

  /** 当前页面是否由 IDE 视图接管 */
  function idePage() {
    if (location.hostname === 'zhuanlan.zhihu.com') return true;
    var p = location.pathname;
    return (
      p === '/' ||
      p === '' ||
      p.indexOf('/hot') === 0 ||
      p.indexOf('/search') === 0 ||
      p.indexOf('/question/') === 0
    );
  }

  function apply(on) {
    root.setAttribute('data-zvsc', on ? 'on' : 'off');
    if (on && idePage()) {
      showLoader();
    } else {
      hideLoader();
    }
  }

  function persist(on) {
    try {
      localStorage.setItem(LS_KEY, on ? '1' : '0');
    } catch (e) {
      /* 隐私模式等场景 localStorage 不可用，忽略 */
    }
  }

  // 1) 同步路径：无缓存时默认开启（装了插件就是要用的）
  var cached = null;
  try {
    cached = localStorage.getItem(LS_KEY);
  } catch (e) {
    /* ignore */
  }
  apply(cached !== '0');

  // 2) 异步校准 + 实时切换
  try {
    chrome.storage.local.get({ enabled: true }, function (items) {
      var on = !!items.enabled;
      apply(on);
      persist(on);
    });

    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === 'local' && changes.enabled) {
        var on = !!changes.enabled.newValue;
        apply(on);
        persist(on);
      }
    });
  } catch (e) {
    // 扩展上下文失效等异常：保持上面的缓存状态即可
  }
})();
