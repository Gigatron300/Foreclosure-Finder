// Hides nav tabs the signed-in password can't open, shared by every page.
// The server decides the tabs (POST /api/auth); this only keeps the nav in step.
// The last answer is cached so a reload hides tabs before the server replies.
(function () {
    var KEY = 'navTabs';

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

    // Pages call this once they know the password is good. Resolves to the
    // server's answer ({ tabs, owner }) or null.
    window.syncNavTabs = function (token) {
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

    document.addEventListener('DOMContentLoaded', function () { apply(cached()); });
})();
