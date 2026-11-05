// Hides nav tabs the signed-in password can't open, shared by every page.
// The server decides the tabs (POST /api/auth); this only keeps the nav in step.
// The last answer is cached so a reload hides tabs before the server replies.
(function () {
    var KEY = 'navTabs';

    // One saved login for every page. Sheriff Sales used to keep its own copy
    // (sessionStorage 'authToken') apart from MontCo/Camden (localStorage
    // 'pipelineAuth'), so signing in on one tab left a different password
    // active on the others.
    var AUTH_KEY = 'siteAuth';
    var LEGACY_LOCAL = 'pipelineAuth';
    var LEGACY_SESSION = 'authToken';

    function dropLegacy() {
        try { localStorage.removeItem(LEGACY_LOCAL); } catch (e) {}
        try { sessionStorage.removeItem(LEGACY_SESSION); } catch (e) {}
    }

    window.siteAuth = {
        get: function () {
            try {
                var t = localStorage.getItem(AUTH_KEY);
                if (t) return t;
                // First load after the change: adopt an old saved login once.
                // The per-tab Sheriff login is the more recent of the two.
                var legacy = null;
                try { legacy = sessionStorage.getItem(LEGACY_SESSION); } catch (e) {}
                if (!legacy) legacy = localStorage.getItem(LEGACY_LOCAL);
                dropLegacy();
                if (legacy) { localStorage.setItem(AUTH_KEY, legacy); return legacy; }
            } catch (e) {}
            return '';
        },
        set: function (token) {
            try { localStorage.setItem(AUTH_KEY, token); } catch (e) {}
            dropLegacy();
        },
        clear: function () {
            try { localStorage.removeItem(AUTH_KEY); localStorage.removeItem(KEY); } catch (e) {}
            dropLegacy();
        }
    };

    // Signing in or out in one tab reloads the others, so no open tab keeps
    // acting as the previous password.
    window.addEventListener('storage', function (e) {
        if (e.key === AUTH_KEY) location.reload();
    });

    function cached() {
        try { return JSON.parse(localStorage.getItem(KEY)); } catch (e) { return null; }
    }

    function apply(tabs) {
        if (!Array.isArray(tabs)) return;
        var links = document.querySelectorAll('.nav-links a[data-tab]');
        for (var i = 0; i < links.length; i++) {
            links[i].style.display = tabs.indexOf(links[i].getAttribute('data-tab')) === -1 ? 'none' : '';
        }
    }

    // "Sign out" at the end of the nav, shown while a login is saved. It signs out
    // of every page (one shared login), which is how you switch passwords.
    function ensureSignOut() {
        var nav = document.querySelector('.nav-links');
        if (!nav) return;
        var link = nav.querySelector('a.nav-signout');
        if (!link) {
            link = document.createElement('a');
            link.href = '#';
            link.className = 'nav-signout';
            link.textContent = 'Sign out';
            link.title = 'Sign out of every tab on this site';
            link.addEventListener('click', function (e) {
                e.preventDefault();
                window.siteAuth.clear();
                location.reload();
            });
            nav.appendChild(link);
        }
        link.style.display = window.siteAuth.get() ? '' : 'none';
    }

    // Pages call this once they know the password is good. Resolves to the
    // server's answer ({ tabs, owner }) or null.
    window.syncNavTabs = function (token) {
        ensureSignOut();
        if (!token) return Promise.resolve(null);
        return fetch('/api/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: token })
        })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (data) {
                var tabs = data && data.tabs;
                if (!Array.isArray(tabs)) return null;
                try { localStorage.setItem(KEY, JSON.stringify(tabs)); } catch (e) {}
                apply(tabs);
                return data;
            })
            .catch(function () { return null; });
    };

    document.addEventListener('DOMContentLoaded', function () { apply(cached()); ensureSignOut(); });
})();
