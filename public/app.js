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

  /* 账号菜单里的小图标，纯静态字符串，直接塞进 innerHTML */
  var ICONS = {
    me: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    admin: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
    home: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V21h13V9.5"/></svg>',
    logout: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></svg>',
    chevron: '<svg class="chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>'
  };

  /**
   * 顶部用户栏：显示当前用户（头像 + 用户名 + 角色），点开是账号菜单。
   * 个人中心 / 控制台 / 返回主页 / 退出登录 都在菜单里，页头不再堆一排按钮。
   *
   * @param {object} user  /api/me 返回的用户
   * @param {object} opts  { mount: 容器 id, current: 'home'|'me'|'admin'|'ip',
   *                         nav: [{ text, href }] 页头保留的功能入口 }
   */
  CF.userBar = function (user, opts) {
    opts = opts || {};
    var mount = document.getElementById(opts.mount || 'userBar');
    if (!mount || !user) return null;

    var current = opts.current || '';
    var isAdmin = user.role === 'admin';
    var roleText = isAdmin ? '管理员' : '用户';
    var name = user.username || '未命名';

    mount.innerHTML = '';

    (opts.nav || []).forEach(function (item) {
      var a = document.createElement('a');
      a.className = 'btn';
      a.href = item.href;
      a.textContent = item.text;
      mount.appendChild(a);
    });

    var wrap = document.createElement('div');
    wrap.className = 'user-menu';

    /* 触发按钮：头像 + 用户名 + 角色，点击展开菜单 */
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'user-btn';
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', '账号菜单：' + name);
    btn.title = name;

    var avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.textContent = name.trim().charAt(0).toUpperCase();

    var nameEl = document.createElement('span');
    nameEl.className = 'user-btn-name';
    nameEl.textContent = name;

    var tag = document.createElement('span');
    tag.className = 'role-tag' + (isAdmin ? ' admin' : '');
    tag.textContent = roleText;

    btn.appendChild(avatar);
    btn.appendChild(nameEl);
    btn.appendChild(tag);
    btn.insertAdjacentHTML('beforeend', ICONS.chevron);

    /* 菜单本体 */
    var menu = document.createElement('div');
    menu.className = 'menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', '账号菜单');
    menu.hidden = true;

    var head = document.createElement('div');
    head.className = 'menu-head';
    var headAvatar = avatar.cloneNode(true);
    headAvatar.className = 'avatar avatar-lg';
    var headText = document.createElement('div');
    headText.className = 'menu-head-text';
    var headName = document.createElement('div');
    headName.className = 'menu-name';
    headName.appendChild(document.createTextNode(name));
    headName.appendChild(tag.cloneNode(true));
    var headSub = document.createElement('div');
    headSub.className = 'menu-sub';
    headSub.textContent = 'ID ' + (user.id == null ? '—' : user.id);
    headText.appendChild(headName);
    headText.appendChild(headSub);
    head.appendChild(headAvatar);
    head.appendChild(headText);
    menu.appendChild(head);

    function addLink(key, text, href) {
      var a = document.createElement('a');
      a.className = 'menu-item';
      a.href = href;
      a.setAttribute('role', 'menuitem');
      a.insertAdjacentHTML('afterbegin', ICONS[key]);
      var label = document.createElement('span');
      label.textContent = text;
      a.appendChild(label);
      menu.appendChild(a);
    }

    // 当前所在页面的入口不再重复出现，菜单保持短
    if (current !== 'me') addLink('me', '个人中心', '/me');
    if (isAdmin && current !== 'admin') addLink('admin', '管理控制台', '/admin');
    if (current !== 'home') addLink('home', '返回主页', '/');

    var sep = document.createElement('div');
    sep.className = 'menu-sep';
    menu.appendChild(sep);

    var out = document.createElement('button');
    out.type = 'button';
    out.className = 'menu-item danger';
    out.setAttribute('role', 'menuitem');
    out.insertAdjacentHTML('afterbegin', ICONS.logout);
    var outLabel = document.createElement('span');
    outLabel.textContent = '退出登录';
    out.appendChild(outLabel);
    out.addEventListener('click', function () {
      out.disabled = true;
      CF.logout();
    });
    menu.appendChild(out);

    function onDocClick(e) {
      if (!wrap.contains(e.target)) close();
    }
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(true);
      }
    }
    function open() {
      menu.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      document.addEventListener('click', onDocClick);
      document.addEventListener('keydown', onKey);
    }
    function close(focusBack) {
      if (menu.hidden) return;
      menu.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKey);
      if (focusBack) btn.focus();
    }

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (menu.hidden) open(); else close();
    });
    // 点菜单里的链接跳走前先收起，避免从 bfcache 返回时菜单还开着
    menu.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('a')) close();
    });

    wrap.appendChild(btn);
    wrap.appendChild(menu);
    mount.appendChild(wrap);
    mount.hidden = false;
    return wrap;
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
