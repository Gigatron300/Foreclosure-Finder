// Light/night theme switch shared by every page.
// Load it in <head> (no defer) so the saved theme is applied before first paint.
(function () {
    var KEY = 'blakeTheme';
    var root = document.documentElement;

    function saved() {
        try { return localStorage.getItem(KEY); } catch (e) { return null; }
    }

    function current() {
        return root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    }

    // Logos have a cream-lettered twin for night mode: blake-logo-<name>-dark.png
    function swapLogos(theme) {
        var imgs = document.querySelectorAll('img[src*="blake-logo-"]');
        for (var i = 0; i < imgs.length; i++) {
            var src = imgs[i].getAttribute('src').replace(/-dark(\.png)$/, '$1');
            imgs[i].setAttribute('src', theme === 'dark' ? src.replace(/\.png$/, '-dark.png') : src);
        }
    }

    function syncButtons(theme) {
        var btns = document.querySelectorAll('.theme-toggle');
        for (var i = 0; i < btns.length; i++) {
            var label = theme === 'dark' ? 'Switch to light mode' : 'Switch to night mode';
            btns[i].setAttribute('aria-label', label);
            btns[i].setAttribute('title', label);
            btns[i].setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
        }
    }

    function apply(theme) {
        if (theme === 'dark') root.setAttribute('data-theme', 'dark');
        else root.removeAttribute('data-theme');
        swapLogos(theme);
        syncButtons(theme);
    }

    if (saved() === 'dark') root.setAttribute('data-theme', 'dark');

    var SUN = '<svg class="icon-sun" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/></svg>';
    var MOON = '<svg class="icon-moon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 14.2A8.5 8.5 0 1 1 9.8 3.5a6.8 6.8 0 0 0 10.7 10.7z"/></svg>';

    var style = document.createElement('style');
    style.textContent =
        '.theme-toggle{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;' +
        'margin-left:.5rem;padding:0;border-radius:50%;cursor:pointer;flex:none;' +
        'background:transparent;border:1px solid var(--theme-toggle-border,#D3C8B2);color:var(--theme-toggle-ink,#4A463F);' +
        'transition:color .2s,border-color .2s,background .2s}' +
        '.theme-toggle:hover{border-color:#C9943A;color:var(--theme-toggle-hover,#8F6A22)}' +
        '.theme-toggle:focus-visible{outline:2px solid #C9943A;outline-offset:2px}' +
        '.theme-toggle .icon-sun{display:none}' +
        '[data-theme="dark"] .theme-toggle{--theme-toggle-border:#46413A;--theme-toggle-ink:#C7C0B2;--theme-toggle-hover:#E0B865}' +
        '[data-theme="dark"] .theme-toggle .icon-sun{display:block}' +
        '[data-theme="dark"] .theme-toggle .icon-moon{display:none}' +
        '.login-theme-toggle{position:fixed;top:16px;right:16px;z-index:10001}';
    document.head.appendChild(style);

    function makeButton(extraClass) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'theme-toggle' + (extraClass ? ' ' + extraClass : '');
        b.innerHTML = SUN + MOON;
        b.addEventListener('click', function () {
            var next = current() === 'dark' ? 'light' : 'dark';
            try { localStorage.setItem(KEY, next); } catch (e) {}
            apply(next);
        });
        return b;
    }

    document.addEventListener('DOMContentLoaded', function () {
        var nav = document.querySelector('header .nav-links');
        if (nav) {
            nav.style.alignItems = 'center';
            nav.appendChild(makeButton());
        }
        // A corner toggle for the login screen, which covers the header.
        document.body.appendChild(makeButton('login-theme-toggle'));
        var corner = document.querySelector('.login-theme-toggle');
        var login = document.querySelector('#loginScreen, #loginOverlay');
        function syncCorner() {
            var visible = login && getComputedStyle(login).display !== 'none' && !login.classList.contains('hidden');
            corner.style.display = visible ? '' : 'none';
        }
        syncCorner();
        if (login) new MutationObserver(syncCorner).observe(login, { attributes: true, attributeFilter: ['style', 'class'] });
        apply(current());
    });
})();
