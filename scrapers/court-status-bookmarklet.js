javascript:(async function() {
  const SERVER = '__SERVER_URL__';
  const TOKEN = '__AUTH_TOKEN__';
  const TEST_MODE = __TEST_MODE__;
  const STORAGE_KEY = 'csc_state_v8';

  // Check if already running
  if (localStorage.getItem(STORAGE_KEY)) {
    if (!confirm('A session is already in progress. Clear it and start fresh?')) return;
    localStorage.removeItem(STORAGE_KEY);
  }

  alert('Fetching cases from server...');

  let cases = [];
  try {
    const r = await fetch(`${SERVER}/api/camden?sortBy=daysSinceFiling&sortOrder=desc`, {
      headers: { 'X-Auth-Token': TOKEN }
    });
    const data = await r.json();
    cases = (data.cases || []).filter(c => {
      const cs = c.courtStatus || '';
      return !cs || cs === 'NOT_FOUND' || cs === 'ERROR';
    });
  } catch (e) {
    alert('Error fetching cases: ' + e.message);
    return;
  }

  if (TEST_MODE) cases = cases.slice(0, 10);

  if (!cases.length) {
    alert('No cases need checking!');
    return;
  }

  const state = {
    cases: cases.map(c => ({
      instrumentNumber: c.instrumentNumber,
      defendant: c.primaryDefendant,
      plaintiff: c.primaryPlaintiff,
      filingDate: c.filingDateISO || c.filingDate
    })),
    currentIndex: 0,
    currentCase: null,
    step: 'NEED_SEARCH',
    total: cases.length,
    done: 0,
    open: 0,
    closed: 0,
    notFound: 0,
    errors: 0,
    resultsRows: [],
    currentRowIndex: 0,
    bestMatch: null
  };

  state.currentCase = state.cases[0];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

  alert(`Ready! ${cases.length} cases to check.\n\nMake sure:\n1. Tampermonkey script is installed\n2. You're on the Search By Party Name tab\n\nClick OK to start.`);
  location.reload();
})();
