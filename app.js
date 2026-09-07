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

const APP_VERSION = 'v2 (redigering + sök/ersätt)';
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

/* Motsvarande åt andra hållet. btoa() klarar bara tecken 0-255, så texten måste
 * först kodas till UTF-8-bytes — annars kastar den på å, ä och ö. */
function encodeBase64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/* Hämtar en fil med både innehåll och sha. sha krävs för att kunna skriva
 * tillbaka — GitHub använder den för att upptäcka samtidiga ändringar. */
async function readRepoFile(settings, path) {
  const url = `https://api.github.com/repos/${settings.owner}/${settings.repo}/contents/${path}`;
  const res = await fetch(url, { headers: apiHeaders(settings.token) });
  if (!res.ok) throw new Error(`Kunde inte läsa ${path} (${res.status})`);
  const body = await res.json();
  return { text: decodeBase64Utf8(body.content || ''), sha: body.sha };
}

async function writeRepoFile(settings, path, text, sha, message) {
  const url = `https://api.github.com/repos/${settings.owner}/${settings.repo}/contents/${path}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...apiHeaders(settings.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: encodeBase64Utf8(text), sha }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).message || ''; } catch { /* tomt svar */ }
    if (res.status === 409) {
      throw new Error('Filen har ändrats någon annanstans. Ladda om och gör om ändringen.');
    }
    throw new Error(`Kunde inte spara (${res.status}). ${detail}`);
  }
  return (await res.json()).content.sha;
}

/* Listar drafts/ så vi vet de faktiska filnamnen (datumet varierar). */
async function listDrafts(settings) {
  const url = `https://api.github.com/repos/${settings.owner}/${settings.repo}/contents/drafts`;
  const res = await fetch(url, { headers: apiHeaders(settings.token) });
  if (!res.ok) return [];
  const entries = await res.json();
  return Array.isArray(entries) ? entries.filter((e) => e.name.endsWith('.md')) : [];
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

/* Samma slug-logik som common.py:slugify — måste hållas identisk. */
function slugify(title) {
  return String(title || '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

/* Kopplar annonsen till dess faktiska filnamn i drafts/ (datumet varierar). */
function draftPathsFor(draftFiles, title) {
  const slug = slugify(title);
  const found = {};
  for (const entry of draftFiles) {
    if (entry.name.endsWith(`_${slug}_cv.md`)) found.cv = entry.path;
    if (entry.name.endsWith(`_${slug}_brev.md`)) found.brev = entry.path;
  }
  return found;
}

function renderMatches(jobs, index, draftFiles) {
  if (!jobs || !jobs.length) return '<p class="hint">Inga träffar sparade än.</p>';
  return jobs.map((job) => {
    const links = driveLinksFor(index, job.title);
    const drafts = draftPathsFor(draftFiles, job.title);

    const docs = [];
    if (links.cv?.doc_link) docs.push(`<a href="${escapeHtml(links.cv.doc_link)}" target="_blank" rel="noopener">CV i Drive</a>`);
    if (links.brev?.doc_link) docs.push(`<a href="${escapeHtml(links.brev.doc_link)}" target="_blank" rel="noopener">Brev i Drive</a>`);

    const edit = [];
    if (drafts.cv) edit.push(`<button class="link-button" data-edit="${escapeHtml(drafts.cv)}" data-label="CV — ${escapeHtml(job.title)}">Redigera CV</button>`);
    if (drafts.brev) edit.push(`<button class="link-button" data-edit="${escapeHtml(drafts.brev)}" data-label="Brev — ${escapeHtml(job.title)}">Redigera brev</button>`);

    return `<article class="job">
      <h3><a href="${escapeHtml(job.url)}" target="_blank" rel="noopener">${escapeHtml(job.title)}</a></h3>
      <div class="meta">${escapeHtml(job.employer || '—')} · relevans ${escapeHtml(job.score ?? '—')}</div>
      <div class="meta">${escapeHtml((job.matched_keywords || []).join(', ') || '—')}</div>
      <div class="docs">${edit.length ? edit.join(' · ') : '<span class="muted">Inga utkast än</span>'}</div>
      ${docs.length ? `<div class="docs">${docs.join(' · ')}</div>` : ''}
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
    const [jobs, index, draftFiles] = await Promise.all([
      readRepoJson(settings, 'data/matched_jobs.json'),
      readRepoJson(settings, 'data/drive_index.json').catch(() => null),
      listDrafts(settings),
    ]);
    $('matches').innerHTML = renderMatches(jobs, index || {}, draftFiles || []);
    if (jobs && jobs.length && (!draftFiles || !draftFiles.length)) {
      status.className = 'status error';
      status.textContent =
        'Kunde inte läsa drafts/ — kontrollera att token har Contents: read and write.';
      return;
    }

    // Knapparna skapas dynamiskt, så lyssnaren sätts efter renderingen.
    for (const button of $('matches').querySelectorAll('[data-edit]')) {
      button.addEventListener('click', () => openEditor(button.dataset.edit, button.dataset.label));
    }
    status.textContent = jobs ? `${jobs.length} träffar.` : 'Inga data än.';
  } catch (err) {
    status.className = 'status error';
    status.textContent = err.message;
  }
}

/* ---------- redigering -------------------------------------------------- */

/* Aktuellt dokument i editorn. sha uppdateras efter varje sparning så att flera
 * sparningar i rad fungerar utan omladdning. */
const editing = { path: null, sha: null, original: '', title: '' };

async function openEditor(path, title) {
  const settings = loadSettings();
  const status = $('editor-status');
  showView('editor');

  $('editor-title').textContent = title;
  $('editor-path').textContent = path;
  $('editor-text').value = '';
  $('fr-status').textContent = '';
  status.className = 'status';
  status.textContent = 'Hämtar ...';

  try {
    const file = await readRepoFile(settings, path);
    editing.path = path;
    editing.sha = file.sha;
    editing.original = file.text;
    editing.title = title;
    $('editor-text').value = file.text;
    status.textContent = '';
  } catch (err) {
    status.className = 'status error';
    status.textContent = err.message;
  }
}

async function saveEditor() {
  const settings = loadSettings();
  const status = $('editor-status');
  const text = $('editor-text').value;

  if (!editing.path) return;
  if (text === editing.original) {
    status.className = 'status';
    status.textContent = 'Inget har ändrats.';
    return;
  }

  $('editor-save').disabled = true;
  status.className = 'status';
  status.textContent = 'Sparar ...';
  try {
    editing.sha = await writeRepoFile(
      settings, editing.path, text, editing.sha,
      `Redigerat ${editing.title} från mobilen`
    );
    editing.original = text;
    status.className = 'status ok';
    status.textContent = 'Sparat i repot.';
  } catch (err) {
    status.className = 'status error';
    status.textContent = err.message;
  } finally {
    $('editor-save').disabled = false;
  }
}

/* Bygger ett regex av söksträngen. Escapar allt, så användaren kan söka efter
 * tecken som ( och . utan att det tolkas som regex. */
function findRegex(needle, caseSensitive) {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped, caseSensitive ? 'g' : 'gi');
}

function countMatches() {
  const needle = $('fr-find').value;
  const status = $('fr-status');
  if (!needle) {
    status.className = 'status';
    status.textContent = 'Skriv något att söka efter.';
    return 0;
  }
  const matches = $('editor-text').value.match(findRegex(needle, $('fr-case').checked));
  const n = matches ? matches.length : 0;
  status.className = 'status';
  status.textContent = n === 0 ? 'Inga träffar.' : `${n} träff${n === 1 ? '' : 'ar'}.`;
  return n;
}

/* Hittar nästa träff efter markörens position och markerar den. */
function findNext() {
  const area = $('editor-text');
  const needle = $('fr-find').value;
  const status = $('fr-status');
  if (!needle) { countMatches(); return; }

  const re = findRegex(needle, $('fr-case').checked);
  re.lastIndex = area.selectionEnd || 0;
  let match = re.exec(area.value);
  if (!match) {                 // slut på texten — börja om från början
    re.lastIndex = 0;
    match = re.exec(area.value);
  }
  if (!match) {
    status.className = 'status';
    status.textContent = 'Inga träffar.';
    return;
  }
  area.focus();
  area.setSelectionRange(match.index, match.index + match[0].length);
  // Rulla så träffen syns — textarea saknar scrollIntoView för markeringar.
  const before = area.value.slice(0, match.index).split('\n').length;
  area.scrollTop = Math.max(0, (before - 5) * 20);
  status.className = 'status';
  status.textContent = '';
}

function replaceAll() {
  const needle = $('fr-find').value;
  const status = $('fr-status');
  if (!needle) { countMatches(); return; }

  const area = $('editor-text');
  const n = countMatches();
  if (n === 0) return;

  // $ har särskild betydelse i replace(); en funktion undviker det helt.
  const replacement = $('fr-replace').value;
  area.value = area.value.replace(findRegex(needle, $('fr-case').checked), () => replacement);
  status.className = 'status ok';
  status.textContent = `Ersatte ${n} förekomst${n === 1 ? '' : 'er'}. Glöm inte att spara.`;
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

  $('token-show').addEventListener('change', (e) => {
    $('token').type = e.target.checked ? 'text' : 'password';
  });

  $('editor-back').addEventListener('click', () => showView('matches'));
  $('editor-save').addEventListener('click', saveEditor);
  $('editor-revert').addEventListener('click', () => {
    $('editor-text').value = editing.original;
    $('editor-status').className = 'status';
    $('editor-status').textContent = 'Återställt till senast sparade version.';
  });
  $('fr-count').addEventListener('click', countMatches);
  $('fr-next').addEventListener('click', findNext);
  $('fr-all').addEventListener('click', replaceAll);

  // Varna om man lämnar sidan med osparade ändringar.
  window.addEventListener('beforeunload', (e) => {
    if (editing.path && $('editor-text').value !== editing.original) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

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
      if (!s.token) throw new Error('Ingen token ifylld.');
      if (!s.token.startsWith('github_pat_') && !s.token.startsWith('ghp_')) {
        throw new Error(
          'Det ser inte ut som en GitHub-token (ska börja med github_pat_). ' +
          'Har webbläsaren fyllt i ett sparat lösenord? Bocka i "Visa token".'
        );
      }
      const res = await fetch(
        `https://api.github.com/repos/${s.owner}/${s.repo}`,
        { headers: apiHeaders(s.token) }
      );
      if (res.status === 401) {
        throw new Error('401: token ogiltig eller utgången. Skapa en ny och klistra in igen.');
      }
      if (res.status === 404) {
        throw new Error('404: token saknar åtkomst till repot, eller fel användare/repo ovan.');
      }
      if (!res.ok) throw new Error(`GitHub svarade ${res.status}.`);
      status.className = 'status ok';
      status.textContent = 'Anslutningen fungerar.';
    } catch (err) {
      status.className = 'status error';
      status.textContent = err.message;
    }
  });

  $('app-version').textContent = APP_VERSION;
  applyShareTarget();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* appen funkar ändå */ });
  }
}

document.addEventListener('DOMContentLoaded', init);
