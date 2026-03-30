(function(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.CourtStatusCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  function parseFlexibleDate(value) {
    if (!value) return null;
    let match = value.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (match) return new Date(+match[3], +match[1] - 1, +match[2]);
    match = value.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (match) return new Date(+match[1], +match[2] - 1, +match[3]);
    return null;
  }

  function parseName(full) {
    const parts = normalizeNameParts(full);
    if (!parts.length) return null;
    return {
      last: parts[0] || '',
      first: (parts[1] || '').slice(0, 9),
      mid: (parts[2] || '').slice(0, 1)
    };
  }

  function normalizeNameParts(full) {
    if (!full) return [];
    return full.toUpperCase().trim()
      .replace(/\b(JR|SR|II|III|IV|ESQ|MD|PHD)\b\.?/g, '')
      .trim()
      .replace(/\s+/g, ' ')
      .split(' ')
      .filter(Boolean);
  }

  function isSkippableBridgeToken(token) {
    return ['DA', 'DE', 'DEL', 'DELA', 'DI', 'DO', 'DOS', 'DU', 'LA', 'LE', 'VAN', 'VON'].includes((token || '').toUpperCase());
  }

  function buildSearchName(last, first, mid) {
    return [last, first, mid].filter(Boolean).join(' ').trim();
  }

  function expandSearchName(name) {
    const parts = normalizeNameParts(name);
    if (parts.length < 2) return [];

    const variants = [];
    const add = (last, first, mid) => {
      const full = buildSearchName(last, first, mid);
      if (full) variants.push(full);
    };

    const last = parts[0];
    const first = parts[1];
    const middle = parts[2] || '';

    add(last, first, middle);
    if (middle) add(last, first, middle.slice(0, 1));
    add(last, first, '');

    // Some clerk rows inject a bridging token before the true first name, e.g. "HAENEL DO LOUIS C".
    if (parts.length >= 4 && isSkippableBridgeToken(parts[1])) {
      const altFirst = parts[2];
      const altMiddle = parts[3] || '';
      add(last, altFirst, altMiddle);
      if (altMiddle) add(last, altFirst, altMiddle.slice(0, 1));
      add(last, altFirst, '');
    }

    return uniqueNames(variants);
  }

  function expandThreePartTailFirst(name) {
    const parts = normalizeNameParts(name);
    if (parts.length !== 3) return [];
    return uniqueNames([
      buildSearchName(parts[0], parts[2], '')
    ]);
  }

  function plaintiffKeyword(name) {
    if (!name) return '';
    const upper = name.toUpperCase().trim();
    const cleaned = upper
      .replace(/\b(LLC|INC|CORP|N\.?A\.?|BANK|MORTGAGE|SERVICING|TRUST|LP|L\.P\.|CO|COMPANY)\b/g, '')
      .trim();
    const parts = cleaned.split(/\s+/).filter(part => part.length > 2);
    return parts[0] || upper.split(/\s+/)[0] || '';
  }

  function dateDistanceDays(csvDate, courtDate) {
    if (!csvDate || !courtDate) return null;
    try {
      const d1 = parseFlexibleDate(csvDate);
      const d2 = parseFlexibleDate(courtDate);
      if (!d1 || !d2) return null;
      return Math.abs(d1 - d2) / 86400000;
    } catch {
      return null;
    }
  }

  function dateProximity(csvDate, courtDate, windowDays) {
    const days = dateDistanceDays(csvDate, courtDate);
    if (days == null) return 0;
    if (days <= 30) return 1.0;
    if (days <= windowDays) return 0.7;
    if (days <= 180) return 0.4;
    if (days <= 365) return 0.2;
    return 0;
  }

  function isWithinDateWindow(csvDate, courtDate, windowDays) {
    const days = dateDistanceDays(csvDate, courtDate);
    return days != null && days <= windowDays;
  }

  function rowContainsAllNameTokens(rowName, expectedName) {
    const rowParts = normalizeNameParts(rowName);
    const expectedParts = normalizeNameParts(expectedName);
    if (!rowParts.length || expectedParts.length < 3) return false;
    return expectedParts.every(part => rowParts.includes(part));
  }

  function findBestMatch(rows, plaintiffName, csvDate, windowDays, searchCandidate) {
    const pKey = plaintiffKeyword(plaintiffName).toUpperCase();
    const candidateMode = searchCandidate && searchCandidate.mode ? searchCandidate.mode : '';
    const candidateSourceName = searchCandidate && searchCandidate.sourceFullName
      ? searchCandidate.sourceFullName
      : (searchCandidate && searchCandidate.name ? searchCandidate.name : '');
    let best = null;
    let bestScore = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      let score = 0;

      if ((row.venue || '').toUpperCase().includes('CAMDEN')) score += 3;
      if (pKey && (row.caption || '').toUpperCase().includes(pKey)) score += 2;
      if (!isWithinDateWindow(csvDate, row.date, windowDays)) continue;
      score += dateProximity(csvDate, row.date, windowDays) * 2;
      if ((row.docket || '').startsWith('F-')) score += 1;
      if (candidateMode === 'three-part-tail-first' && rowContainsAllNameTokens(row.name, candidateSourceName)) {
        score += 4;
      }

      if (score > bestScore) {
        bestScore = score;
        best = { ...row, rowIndex: i, matchScore: score };
      }
    }

    return bestScore >= 3 ? best : null;
  }

  function classify(status, disposition) {
    const combined = ((status || '') + ' ' + (disposition || '')).toUpperCase();
    if (/REINSTATED/.test(combined)) return 'REINSTATED';
    if (/BANKRUPTCY STAY|AUTOMATIC STAY|STAYED|CASE STAYED|\bSTAY\b/.test(combined)) return 'STAY';
    if (/CLOSED|DISMISSED|DISPOSED|RESOLVED|SETTLED|TERMINATED/.test(combined)) return 'CLOSED';
    if (/OPEN|ACTIVE|PENDING|DEFAULTED/.test(combined)) return 'OPEN';
    return 'UNKNOWN';
  }

  function buildStatusNote(reason, extra) {
    const parts = [reason];
    if (extra) parts.push(extra);
    return parts.join(' | ');
  }

  function uniqueNames(names) {
    return Array.from(new Set((names || []).map(name => (name || '').trim()).filter(Boolean)));
  }

  function getSearchSkipWholeWords() {
    return Array.isArray(globalThis.__CSC_SEARCH_SKIP_WHOLE_WORDS__)
      ? globalThis.__CSC_SEARCH_SKIP_WHOLE_WORDS__
      : [];
  }

  function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function normalizeNameForSkipMatch(name) {
    return String(name || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  function shouldSkipCourtSearchName(name) {
    const normalizedName = normalizeNameForSkipMatch(name);
    if (!normalizedName) return true;
    return getSearchSkipWholeWords().some(phrase => {
      const normalizedPhrase = normalizeNameForSkipMatch(phrase);
      if (!normalizedPhrase) return false;
      const re = new RegExp(`(?:^|\\s)${escapeRegex(normalizedPhrase)}(?:\\s|$)`);
      return re.test(normalizedName);
    });
  }

  function getSearchNames(c) {
    return getSearchCandidates(c).map(candidate => candidate.name);
  }

  function uniqueCandidateKey(candidate) {
    return [
      candidate && candidate.name ? candidate.name : '',
      candidate && candidate.mode ? candidate.mode : '',
      candidate && candidate.partyCode ? candidate.partyCode : '',
      candidate && candidate.dateWindowDays ? candidate.dateWindowDays : ''
    ].join('|');
  }

  function uniqueCandidates(candidates) {
    const seen = new Set();
    const out = [];
    (candidates || []).forEach(candidate => {
      if (!candidate || !candidate.name) return;
      if (!candidate.allowSkipOverride && shouldSkipCourtSearchName(candidate.name)) return;
      const key = uniqueCandidateKey(candidate);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(candidate);
    });
    return out;
  }

  function getSearchCandidates(c) {
    const allowSkipOverride = !!(c && c.courtDocketNumber);
    if (Array.isArray(c && c.searchCandidates) && c.searchCandidates.length) {
      const standard = [];
      c.searchCandidates.forEach(candidate => {
        const baseName = candidate && candidate.name ? candidate.name : '';
        if (!baseName) return;
        expandSearchName(baseName).forEach(name => {
          standard.push({
            name,
            partyCode: candidate.partyCode || '',
            mode: 'standard',
            dateWindowDays: 90,
            sourceFullName: baseName,
            allowSkipOverride
          });
        });
        expandThreePartTailFirst(baseName).forEach(name => {
          standard.push({
            name,
            partyCode: candidate.partyCode || '',
            mode: 'three-part-tail-first',
            dateWindowDays: 90,
            sourceFullName: baseName,
            allowSkipOverride
          });
        });
      });
      return uniqueCandidates(standard);
    }

    const sourceNames = uniqueNames([
      ...(Array.isArray(c && c.searchNames) ? c.searchNames : []),
      ...(Array.isArray(c && c.allDefendants) ? c.allDefendants : []),
      c && c.defendant ? c.defendant : ''
    ]);
    const expanded = [];
    sourceNames.filter(name => allowSkipOverride || !shouldSkipCourtSearchName(name)).forEach(name => {
      expandSearchName(name).forEach(variant => {
        expanded.push({ name: variant, partyCode: '', mode: 'standard', dateWindowDays: 90, sourceFullName: name, allowSkipOverride });
      });
      expandThreePartTailFirst(name).forEach(variant => {
        expanded.push({ name: variant, partyCode: '', mode: 'three-part-tail-first', dateWindowDays: 90, sourceFullName: name, allowSkipOverride });
      });
    });
    return uniqueCandidates(expanded.length ? expanded : sourceNames.filter(name => allowSkipOverride || !shouldSkipCourtSearchName(name)).map(name => ({
      name,
      partyCode: '',
      mode: 'standard',
      dateWindowDays: 90,
      sourceFullName: name,
      allowSkipOverride
    })));
  }

  function evaluateJacketMatch(params) {
    const filingDate = params && params.filingDate ? params.filingDate : '';
    const jacketDate = params && params.jacketDate ? params.jacketDate : '';
    const currentNameIndex = params && typeof params.currentNameIndex === 'number' ? params.currentNameIndex : 0;
    const names = uniqueNames(params && Array.isArray(params.names) ? params.names : []);
    const windowDays = params && params.windowDays ? params.windowDays : 90;
    const hasLockedDocket = !!(params && params.hasLockedDocket);
    const hasProvidedDocket = !!(params && params.hasProvidedDocket);

    const daysDiff = dateDistanceDays(filingDate, jacketDate);
    if (daysDiff == null || daysDiff <= windowDays || hasLockedDocket || hasProvidedDocket) {
      return { action: 'accept', daysDiff };
    }

    const nextNameIndex = currentNameIndex + 1;
    if (nextNameIndex < names.length) {
      return {
        action: 'next-name',
        daysDiff,
        nextNameIndex,
        reason: buildStatusNote('RECHECK_REASON:DATE_MISMATCH', `filing=${filingDate} court=${jacketDate} diffDays=${Math.round(daysDiff)}`)
      };
    }

    return {
      action: 'recheck',
      daysDiff,
      reason: buildStatusNote('RECHECK_REASON:DATE_MISMATCH', `filing=${filingDate} court=${jacketDate} diffDays=${Math.round(daysDiff)}`)
    };
  }

  return {
    parseFlexibleDate,
    parseName,
    expandThreePartTailFirst,
    plaintiffKeyword,
    dateDistanceDays,
    dateProximity,
    isWithinDateWindow,
    findBestMatch,
    classify,
    buildStatusNote,
    expandSearchName,
    uniqueNames,
    getSearchCandidates,
    getSearchNames,
    evaluateJacketMatch
  };
});
