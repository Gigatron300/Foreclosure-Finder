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
    if (!full) return null;
    let normalized = full.toUpperCase().trim()
      .replace(/\b(JR|SR|II|III|IV|ESQ|MD|PHD)\b\.?/g, '')
      .trim()
      .replace(/\s+/g, ' ');
    const parts = normalized.split(' ').filter(Boolean);
    if (!parts.length) return null;
    return {
      last: parts[0] || '',
      first: (parts[1] || '').slice(0, 9),
      mid: parts[2] || ''
    };
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

  function findBestMatch(rows, plaintiffName, csvDate, windowDays) {
    const pKey = plaintiffKeyword(plaintiffName).toUpperCase();
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

      if (score > bestScore) {
        bestScore = score;
        best = { ...row, rowIndex: i, matchScore: score };
      }
    }

    return bestScore >= 3 ? best : null;
  }

  function classify(status, disposition) {
    const combined = ((status || '') + ' ' + (disposition || '')).toUpperCase();
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

  function getSearchNames(c) {
    return uniqueNames([
      ...(Array.isArray(c && c.searchNames) ? c.searchNames : []),
      ...(Array.isArray(c && c.allDefendants) ? c.allDefendants : []),
      c && c.defendant ? c.defendant : ''
    ]);
  }

  function evaluateJacketMatch(params) {
    const filingDate = params && params.filingDate ? params.filingDate : '';
    const jacketDate = params && params.jacketDate ? params.jacketDate : '';
    const currentNameIndex = params && typeof params.currentNameIndex === 'number' ? params.currentNameIndex : 0;
    const names = uniqueNames(params && Array.isArray(params.names) ? params.names : []);
    const windowDays = params && params.windowDays ? params.windowDays : 90;
    const hasLockedDocket = !!(params && params.hasLockedDocket);

    const daysDiff = dateDistanceDays(filingDate, jacketDate);
    if (daysDiff == null || daysDiff <= windowDays || hasLockedDocket) {
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
    plaintiffKeyword,
    dateDistanceDays,
    dateProximity,
    isWithinDateWindow,
    findBestMatch,
    classify,
    buildStatusNote,
    uniqueNames,
    getSearchNames,
    evaluateJacketMatch
  };
});
