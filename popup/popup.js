/**
 * 弹窗逻辑：读写 chrome.storage.local 的 enabled，与内容脚本通过 onChanged 联动
 */
(function () {
  'use strict';

  var toggle = document.getElementById('toggle');
  var status = document.getElementById('status');
  var value = document.getElementById('value');

  function render(on) {
    toggle.checked = on;
    value.textContent = on ? 'true' : 'false';
    value.classList.toggle('false', !on);
    status.textContent = on
      ? '// 换肤已启用：知乎页面即时生效，无需刷新'
      : '// 换肤已关闭：知乎保持原版外观';
    status.classList.toggle('off', !on);
  }

  chrome.storage.local.get({ enabled: true }, function (items) {
    render(!!items.enabled);
  });

  toggle.addEventListener('change', function () {
    chrome.storage.local.set({ enabled: toggle.checked });
  });

  // 多开弹窗 / 内容页之间的状态同步
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'local' && changes.enabled) {
      render(!!changes.enabled.newValue);
    }
  });
})();
