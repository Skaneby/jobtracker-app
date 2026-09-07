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

const APP_VERSION = 'v3.2';
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
    // Nästa steg är att GRANSKA i appen — inte Drive. Drive får bara det färdiga.
    status.textContent =
      'Skickat. Om 1–2 minuter finns annonsen under Träffar med CV och brev att granska ' +
      '(tryck Uppdatera där). Word och PDF hamnar i Drive automatiskt efter det.';
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
    if (entry.name.endsWith(`_${slug}_noteringar.md`)) found.notes = entry.path;
  }
  return found;
}

/* Status läses ur noteringsfilen: "**Status: GODKÄND 2026-09-07**" eller
 * "**Status: VÄNTAR PÅ GODKÄNNANDE**". Samma fil hamnar i Drive, så statusen
 * syns även där efter nästa synk. */
function isApproved(notesText) {
  return /Status:\s*GODKÄND/i.test(notesText || '');
}

function renderMatches(jobs, draftFiles, notesByPath) {
  if (!jobs || !jobs.length) return '<p class="hint">Inga träffar sparade än.</p>';
  return jobs.map((job) => {
    const drafts = draftPathsFor(draftFiles, job.title);
    const approved = drafts.notes ? isApproved(notesByPath[drafts.notes]) : false;
    const badge = drafts.cv
      ? (approved ? '<span class="badge ok">Godkänd</span>' : '<span class="badge">Utkast</span>')
      : '';

    const open = [];
    if (drafts.cv) open.push(`<button class="link-button" data-edit="${escapeHtml(drafts.cv)}" data-notes="${escapeHtml(drafts.notes || '')}" data-label="CV — ${escapeHtml(job.title)}">Öppna CV</button>`);
    if (drafts.brev) open.push(`<button class="link-button" data-edit="${escapeHtml(drafts.brev)}" data-notes="${escapeHtml(drafts.notes || '')}" data-label="Brev — ${escapeHtml(job.title)}">Öppna brev</button>`);
    if (drafts.notes && !approved) open.push(`<button class="link-button" data-approve="${escapeHtml(drafts.notes)}">Godkänn</button>`);

    const folder = job.drive_folder
      ? `<div class="meta">I Drive: privat/arbete och kunder/<strong>${escapeHtml(job.drive_folder)}</strong></div>`
      : '';

    return `<article class="job">
      <h3><a href="${escapeHtml(job.url)}" target="_blank" rel="noopener">${escapeHtml(job.title)}</a>${badge}</h3>
      <div class="meta">${escapeHtml(job.employer || '—')} · relevans ${escapeHtml(job.score ?? '—')}</div>
      <div class="meta">${escapeHtml((job.matched_keywords || []).join(', ') || '—')}</div>
      ${folder}
      <div class="docs">${open.length ? open.join(' · ') : '<span class="muted">Dokumenten genereras — kommer inom några minuter</span>'}</div>
    </article>`;
  }).join('');
}

/* Godkänn: skriv om statusraden i noteringsfilen. */
async function approve(notesPath) {
  const settings = loadSettings();
  const file = await readRepoFile(settings, notesPath);
  const today = new Date().toISOString().slice(0, 10);
  const updated = /\*\*Status:[^*]*\*\*/.test(file.text)
    ? file.text.replace(/\*\*Status:[^*]*\*\*/, `**Status: GODKÄND ${today}**`)
    : `**Status: GODKÄND ${today}**\n\n${file.text}`;
  await writeRepoFile(settings, notesPath, updated, file.sha, 'Godkänd från mobilen');
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
    const [jobs, draftFiles] = await Promise.all([
      readRepoJson(settings, 'data/matched_jobs.json'),
      listDrafts(settings),
    ]);
    if (jobs && jobs.length && (!draftFiles || !draftFiles.length)) {
      status.className = 'status error';
      status.textContent =
        'Kunde inte läsa drafts/ — kontrollera att token har Contents: read and write.';
      return;
    }

    // Status per annons ligger i noteringsfilerna — läs dem parallellt.
    const notesPaths = (draftFiles || []).filter((e) => e.name.endsWith('_noteringar.md')).map((e) => e.path);
    const notesByPath = {};
    await Promise.all(notesPaths.map(async (p) => {
      try { notesByPath[p] = (await readRepoFile(settings, p)).text; } catch { notesByPath[p] = ''; }
    }));

    $('matches').innerHTML = renderMatches(jobs, draftFiles || [], notesByPath);

    // Knapparna skapas dynamiskt, så lyssnarna sätts efter renderingen.
    for (const button of $('matches').querySelectorAll('[data-edit]')) {
      button.addEventListener('click', () =>
        openEditor(button.dataset.edit, button.dataset.label, button.dataset.notes));
    }
    for (const button of $('matches').querySelectorAll('[data-approve]')) {
      button.addEventListener('click', async () => {
        button.disabled = true;
        try { await approve(button.dataset.approve); await loadMatches(); }
        catch (err) { status.className = 'status error'; status.textContent = err.message; }
      });
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
const editing = { path: null, sha: null, original: '', title: '', notes: null };

/* Minimal Markdown -> HTML för det Gemini skriver: rubriker, fetstil, kursiv,
 * punktlistor, stycken, länkar och avdelare. Texten HTML-escapas först, så
 * innehållet aldrig kan köra skript i appen. */
function renderMarkdown(md) {
  const inline = (t) => t
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');

  let html = '', inList = false, para = [];
  const flush = () => { if (para.length) { html += `<p>${inline(para.join(' '))}</p>`; para = []; } };
  const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };

  for (const raw of escapeHtml(md).split('\n')) {
    const line = raw.trim();
    const h = line.match(/^(#{1,3})\s+(.*)/);
    if (h) { flush(); closeList(); const n = h[1].length; html += `<h${n}>${inline(h[2])}</h${n}>`; continue; }
    const li = line.match(/^[-*]\s+(.*)/);
    if (li) { flush(); if (!inList) { html += '<ul>'; inList = true; } html += `<li>${inline(li[1])}</li>`; continue; }
    if (line === '&amp;nbsp;') { flush(); closeList(); html += '<p>&nbsp;</p>'; continue; }
    if (/^-{3,}$/.test(line)) { flush(); closeList(); html += '<hr>'; continue; }
    if (!line) { flush(); closeList(); continue; }
    para.push(line);
  }
  flush(); closeList();
  return html;
}

function setEditorMode(mode) {
  const preview = mode === 'preview';
  if (preview) $('editor-preview').innerHTML = renderMarkdown($('editor-text').value);
  $('editor-preview').hidden = !preview;
  $('editor-edit-pane').hidden = preview;
  $('findreplace').hidden = preview;
  $('mode-preview').setAttribute('aria-pressed', String(preview));
  $('mode-edit').setAttribute('aria-pressed', String(!preview));
}

async function openEditor(path, title, notesPath) {
  const settings = loadSettings();
  const status = $('editor-status');
  showView('editor');

  $('editor-title').textContent = title;
  $('editor-path').textContent = '';
  $('editor-text').value = '';
  $('editor-preview').innerHTML = '';
  $('fr-status').textContent = '';
  $('editor-approve').hidden = !notesPath;
  status.className = 'status';
  status.textContent = 'Hämtar ...';

  try {
    const file = await readRepoFile(settings, path);
    editing.path = path;
    editing.sha = file.sha;
    editing.original = file.text;
    editing.title = title;
    editing.notes = notesPath || null;
    $('editor-text').value = file.text;
    setEditorMode('preview');
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
    status.textContent = 'Sparat. Word och PDF uppdateras i Drive inom 15 minuter.';
    setEditorMode('preview');
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
  $('mode-preview').addEventListener('click', () => setEditorMode('preview'));
  $('mode-edit').addEventListener('click', () => setEditorMode('edit'));
  $('editor-approve').addEventListener('click', async () => {
    const status = $('editor-status');
    if (!editing.notes) return;
    if ($('editor-text').value !== editing.original) {
      status.className = 'status error';
      status.textContent = 'Spara dina ändringar först, godkänn sedan.';
      return;
    }
    $('editor-approve').disabled = true;
    try {
      await approve(editing.notes);
      status.className = 'status ok';
      status.textContent = 'Godkänd. Syns som Godkänd i listan och i Noteringar.md i Drive.';
    } catch (err) {
      status.className = 'status error';
      status.textContent = err.message;
    } finally {
      $('editor-approve').disabled = false;
    }
  });
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
    // Gammal cache visade en föråldrad app två gånger idag. Därför: kolla efter ny
    // version vid varje start, och när den nya tagit över — ladda om en gång.
    // (Inte vid allra första installationen: då fanns ingen gammal version.)
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js')
      .then((reg) => reg.update())
      .catch(() => { /* appen funkar ändå */ });
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !reloaded) { reloaded = true; location.reload(); }
    });
  }
}

document.addEventListener('DOMContentLoaded', init);
