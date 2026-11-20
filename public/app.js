/**
 * 三个页面共用的前端小工具：会话探测、接口请求、跳转、退出。
 * 不依赖任何框架，页面脚本通过 window.CF 使用。
 */
(function () {
  var CF = {};

  /** 统一的 JSON 请求：永远返回 { ok, status, data }，不抛异常 */
  CF.api = function (path, options) {
    var init = Object.assign({ credentials: 'same-origin', cache: 'no-store' }, options || {});
    return fetch(path, init)
      .then(function (res) {
        return res
          .json()
          .catch(function () { return {}; })
          .then(function (data) { return { ok: res.ok, status: res.status, data: data }; });
      })
      .catch(function () { return { ok: false, status: 0, data: {} }; });
  };

  /** 当前登录用户，未登录返回 null */
  CF.me = function () {
    return CF.api('/api/me').then(function (out) {
      return out.ok && out.data && out.data.user ? out.data.user : null;
    });
  };

  /** 只允许站内相对路径，避免 ?next= 被拿来做开放重定向 */
  CF.safeNext = function (raw) {
    if (!raw) return '/';
    if (raw.charAt(0) !== '/' || raw.charAt(1) === '/') return '/';
    return raw;
  };

  CF.toLogin = function (next) {
    var back = CF.safeNext(next || location.pathname + location.search);
    location.replace('/login.html?next=' + encodeURIComponent(back));
  };

  CF.logout = function () {
    return CF.api('/api/logout', { method: 'POST' }).then(function () {
      location.replace('/login.html');
    });
  };

  CF.fmtTime = function (s) {
    if (!s) return '—';
    try {
      return new Date(s).toLocaleString('zh-CN', { hour12: false });
    } catch (e) {
      return s;
    }
  };

  /** 按钮点击期间的忙碌态：返回一个恢复函数 */
  CF.busy = function (btn, text) {
    var old = btn.textContent;
    btn.textContent = text || '请稍候…';
    btn.disabled = true;
    return function () {
      btn.textContent = old;
      btn.disabled = false;
    };
  };

  window.CF = CF;
})();
