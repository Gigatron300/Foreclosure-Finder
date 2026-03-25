// ==UserScript==
// @name         NJ Courts Status Checker Loader
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Loads the live Camden NJ Courts checker from the server so bookmarklet and Tampermonkey stay aligned
// @match        https://portal.njcourts.gov/*
// @match        https://portal-cloud.njcourts.gov/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(async function () {
  'use strict';

  const SERVER = 'https://foreclosure-finder.onrender.com';
  const TOKEN = 'website';
  const SCRIPT_URL = `${SERVER}/api/camden/court-status-script?token=${encodeURIComponent(TOKEN)}`;
  const LOADER_FLAG = '__camdenCourtStatusLoaderRan';

  if (window[LOADER_FLAG]) return;
  window[LOADER_FLAG] = true;

  try {
    const resp = await fetch(SCRIPT_URL, { credentials: 'omit' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const scriptText = await resp.text();
    // Execute the server-served script as the single source of truth.
    new Function(scriptText)();
  } catch (error) {
    console.error('NJ Courts Status Checker Loader failed:', error);
  }
})();
