/* Jobtracker PWA
 *
 * Statisk app utan server. Den anropar GitHubs REST-API direkt från webbläsaren —
 * GitHub skickar `Access-Control-Allow-Origin: *`, så CORS tillåter det.
 *
 * Token lagras i localStorage på telefonen och finns aldrig i källkoden. Därför kan
 * appen ligga publikt hos Cloudflare Pages utan att läcka något: jobbdatan hämtas
 * med användarens egen token från det privata repot och når aldrig en publik URL.
 */
'use strict';

const STORE_KEY = 'jobtracker.settings';
const DEFAULTS = { owner: 'Skaneby', repo: 'jobtracker', token: '' };

const $ = (id) => document.getElementById(id);

/* ---------- inställningar ---------------------------------------------- */

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') };
  } catch {
    return { ...DEFAULTS }; // trasig/blockerad localStorage ska inte döda appen
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

/* ---------- GitHub ------------------------------------------------------ */

function apiHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function dispatch(settings, clientPayload) {
  const url = `https://api.github.com/repos/${settings.owner}/${settings.repo}/dispatches`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...apiHeaders(settings.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_type: 'new_job_link', client_payload: clientPayload }),
  });
  // 204 No Content = accepterat. Allt annat är ett fel värt att visa.
  if (res.status !== 204) {
    let detail = '';
    try { detail = (await res.json()).message || ''; } catch { /* tomt svar */ }
    throw new Error(`GitHub svarade ${res.status}. ${detail}`);
  }
}

async function readRepoJson(settings, path) {
  const url = `https://api.github.com/repos/${settings.owner}/${settings.repo}/contents/${path}`;
  const res = await fetch(url, { headers: apiHeaders(settings.token) });
  if (res.status === 404) return null; // filen finns inte än
  if (!res.ok) throw new Error(`Kunde inte läsa ${path} (${res.status})`);
  const body = await res.json();
  return JSON.parse(decodeBase64Utf8(body.content || ''));
}

/* atob ger en byte-sträng; åäö kräver att den avkodas som UTF-8. */
function decodeBase64Utf8(b64) {
  const binary = atob(b64.replace(/\n/g, ''));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

/* ---------- skicka in --------------------------------------------------- */

const URL_ONLY = /^\s*https?:\/\/\S+\s*$/i;

function buildPayload(raw, title) {
  const value = raw.trim();
  const payload = {};
  if (URL_ONLY.test(value)) {
    payload.url = value;
  } else {
    payload.text = value;
    // Om texten inleds med en URL tar vi vara på den som referens.
    const found = value.match(/https?:\/\/\S+/);
    if (found) payload.url = found[0];
  }
  if (title.trim()) payload.title = title.trim();
  return payload;
}

function describePayload(raw) {
  const value = raw.trim();
  if (!value) return '';
  if (URL_ONLY.test(value)) return 'Tolkas som: länk — annonsen hämtas och skrapas.';
  return `Tolkas som: annonstext — ${value.length} tecken skickas som de är.`;
}

/* GitHub tar max 64KB i client_payload. Vi håller oss med god marginal. */
const MAX_TEXT = 50000;

async function onSend() {
  const settings = loadSettings();
  const status = $('submit-status');
  const raw = $('payload').value;

  if (!settings.token) {
    status.className = 'status error';
    status.textContent = 'Ingen token sparad. Gå till Inställningar först.';
    return;
  }
  if (!raw.trim()) {
    status.className = 'status error';
    status.textContent = 'Klistra in en länk eller annonstext först.';
    return;
  }
  if (raw.length > MAX_TEXT) {
    status.className = 'status error';
    status.textContent = `Texten är ${raw.length} tecken — max ${MAX_TEXT}. Korta ner den.`;
    return;
  }

  $('send').disabled = true;
  status.className = 'status';
  status.textContent = 'Skickar ...';
  try {
    await dispatch(settings, buildPayload(raw, $('jobtitle').value));
    status.className = 'status ok';
    status.textContent = 'Skickat. Utkasten dyker upp i Drive om någon minut.';
    $('payload').value = '';
    $('jobtitle').value = '';
    $('detected').textContent = '';
  } catch (err) {
    status.className = 'status error';
    status.textContent = err.message;
  } finally {
    $('send').disabled = false;
  }
}

/* ---------- träffar ----------------------------------------------------- */

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* Drive-indexet nycklas på filsökväg (drafts/<datum>_<slug>_cv.md). */
function driveLinksFor(index, title) {
  const slug = String(title || '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  const out = {};
  for (const [path, entry] of Object.entries(index || {})) {
    if (!path.includes(`_${slug}_`)) continue;
    if (path.endsWith('_cv.md')) out.cv = entry;
    if (path.endsWith('_brev.md')) out.brev = entry;
  }
  return out;
}

function renderMatches(jobs, index) {
  if (!jobs || !jobs.length) return '<p class="hint">Inga träffar sparade än.</p>';
  return jobs.map((job) => {
    const links = driveLinksFor(index, job.title);
    const docs = [];
    if (links.cv?.doc_link) docs.push(`<a href="${escapeHtml(links.cv.doc_link)}" target="_blank" rel="noopener">CV</a>`);
    if (links.cv?.pdf_link) docs.push(`<a href="${escapeHtml(links.cv.pdf_link)}" target="_blank" rel="noopener">CV (PDF)</a>`);
    if (links.brev?.doc_link) docs.push(`<a href="${escapeHtml(links.brev.doc_link)}" target="_blank" rel="noopener">Brev</a>`);
    if (links.brev?.pdf_link) docs.push(`<a href="${escapeHtml(links.brev.pdf_link)}" target="_blank" rel="noopener">Brev (PDF)</a>`);

    return `<article class="job">
      <h3><a href="${escapeHtml(job.url)}" target="_blank" rel="noopener">${escapeHtml(job.title)}</a></h3>
      <div class="meta">${escapeHtml(job.employer || '—')} · relevans ${escapeHtml(job.score ?? '—')}</div>
      <div class="meta">${escapeHtml((job.matched_keywords || []).join(', ') || '—')}</div>
      <div class="docs">${docs.length ? docs.join(' · ') : '<span class="muted">Inga dokument än</span>'}</div>
    </article>`;
  }).join('');
}

async function loadMatches() {
  const settings = loadSettings();
  const status = $('matches-status');
  if (!settings.token) {
    status.className = 'status error';
    status.textContent = 'Ingen token sparad. Gå till Inställningar först.';
    return;
  }
  status.className = 'status';
  status.textContent = 'Hämtar ...';
  try {
    const [jobs, index] = await Promise.all([
      readRepoJson(settings, 'data/matched_jobs.json'),
      readRepoJson(settings, 'data/drive_index.json').catch(() => null),
    ]);
    $('matches').innerHTML = renderMatches(jobs, index || {});
    status.textContent = jobs ? `${jobs.length} träffar.` : 'Inga data än.';
  } catch (err) {
    status.className = 'status error';
    status.textContent = err.message;
  }
}

/* ---------- delningsmål (Android) --------------------------------------- */

/* manifestets share_target skickar hit ?title=&text=&url= när du delar från
 * t.ex. LinkedIn. Vi fyller i formuläret så det bara är att trycka Skicka. */
function applyShareTarget() {
  const params = new URLSearchParams(location.search);
  const shared = [params.get('url'), params.get('text')].filter(Boolean).join('\n\n');
  if (shared) $('payload').value = shared.trim();
  if (params.get('title')) $('jobtitle').value = params.get('title');
  if (shared || params.get('title')) {
    $('detected').textContent = describePayload($('payload').value);
    history.replaceState({}, '', location.pathname); // rensa URL:en
  }
}

/* ---------- vyer -------------------------------------------------------- */

function showView(name) {
  for (const section of document.querySelectorAll('main section')) {
    section.hidden = section.id !== `view-${name}`;
  }
  for (const tab of document.querySelectorAll('.tab')) {
    tab.setAttribute('aria-current', tab.dataset.view === name ? 'true' : 'false');
  }
  if (name === 'matches') loadMatches();
}

function init() {
  const settings = loadSettings();
  $('owner').value = settings.owner;
  $('repo').value = settings.repo;
  $('token').value = settings.token;

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => showView(tab.dataset.view));
  }
  $('payload').addEventListener('input', (e) => {
    $('detected').textContent = describePayload(e.target.value);
  });
  $('send').addEventListener('click', onSend);
  $('refresh').addEventListener('click', loadMatches);

  $('save-settings').addEventListener('click', () => {
    const next = {
      owner: $('owner').value.trim() || DEFAULTS.owner,
      repo: $('repo').value.trim() || DEFAULTS.repo,
      token: $('token').value.trim(),
    };
    const status = $('settings-status');
    if (saveSettings(next)) {
      status.className = 'status ok';
      status.textContent = 'Sparat på den här enheten.';
    } else {
      status.className = 'status error';
      status.textContent = 'Kunde inte spara — blockerar webbläsaren lagring?';
    }
  });

  $('test-settings').addEventListener('click', async () => {
    const status = $('settings-status');
    status.className = 'status';
    status.textContent = 'Testar ...';
    try {
      const s = loadSettings();
      const res = await fetch(
        `https://api.github.com/repos/${s.owner}/${s.repo}`,
        { headers: apiHeaders(s.token) }
      );
      if (!res.ok) throw new Error(`GitHub svarade ${res.status}.`);
      status.className = 'status ok';
      status.textContent = 'Anslutningen fungerar.';
    } catch (err) {
      status.className = 'status error';
      status.textContent = err.message;
    }
  });

  applyShareTarget();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* appen funkar ändå */ });
  }
}

document.addEventListener('DOMContentLoaded', init);
