// Hides nav tabs the signed-in password can't open, shared by every page.
// The server decides the tabs (POST /api/auth); this only keeps the nav in step.
// The last answer is cached so a reload hides tabs before the server replies.
(function () {
    var KEY = 'navTabs';

    // One login per visit, shared by every page. It lives in sessionStorage, which
    // a browser tab keeps while you click between Sheriff Sales / MontCo / Camden
    // but which is gone when the site is opened fresh, so the site asks for the
    // password each visit instead of signing in as whoever used it last.
    // Open site tabs talk over a BroadcastChannel so that:
    //  - a new site tab opened while another is signed in picks up that login,
    //  - signing in or out in one tab does the same in the others.
    var AUTH_KEY = 'siteAuth';

    // Saved logins from earlier versions would keep auto-signing in; remove them.
    try {
        localStorage.removeItem(AUTH_KEY);       // the shared, persistent login
        localStorage.removeItem('pipelineAuth'); // older MontCo/Camden copy
        sessionStorage.removeItem('authToken');  // older Sheriff Sales copy
    } catch (e) {}

    function readToken() {
        try { return sessionStorage.getItem(AUTH_KEY) || ''; } catch (e) { return ''; }
    }
    function writeToken(token) {
        try {
            if (token) sessionStorage.setItem(AUTH_KEY, token);
            else sessionStorage.removeItem(AUTH_KEY);
        } catch (e) {}
    }

    var channel = (typeof BroadcastChannel === 'function') ? new BroadcastChannel('site-auth') : null;
    function post(msg) { if (channel) { try { channel.postMessage(msg); } catch (e) {} } }

    window.siteAuth = {
        get: readToken,
        set: function (token) {
            var had = readToken();
            writeToken(token);
            if (token && token !== had) post({ type: 'signin', token: token });
        },
        clear: function () {
            var had = readToken();
            writeToken('');
            try { localStorage.removeItem(KEY); } catch (e) {}
            // Only a tab that was signed in signs the others out; a fresh tab
            // showing its login screen must not.
            if (had) post({ type: 'signout' });
        }
    };

    if (channel) {
        channel.onmessage = function (e) {
            var msg = e.data || {};
            var mine = readToken();
            if (msg.type === 'request' && mine) {
                post({ type: 'token', token: mine });
            } else if (msg.type === 'signin' && msg.token && msg.token !== mine) {
                writeToken(msg.token);
                location.reload();
            } else if (msg.type === 'signout' && mine) {
                writeToken('');
                location.reload();
            } else if (msg.type === 'token' && msg.token && !mine && waitingForHandoff) {
                // Another open tab is signed in: use its login instead of asking again.
                waitingForHandoff = false;
                writeToken(msg.token);
                location.reload();
            }
        };
    }

    // A tab that opens without a login asks the other open site tabs for theirs.
    var waitingForHandoff = false;
    if (channel && !readToken()) {
        waitingForHandoff = true;
        post({ type: 'request' });
        setTimeout(function () { waitingForHandoff = false; }, 1500);
    }

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
