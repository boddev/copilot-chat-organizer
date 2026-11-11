// Copilot Chat Organizer UI. Plain ES module, no build step. All dynamic text is inserted
// with DOM APIs (never innerHTML) because titles and transcripts are untrusted content.

const TOKEN = document.querySelector('meta[name="organizer-token"]')?.getAttribute('content') ?? '';
const SOURCE_SHORT = { m365: 'M365', ghapp: 'GitHub app', vscode: 'VS Code', ghweb: 'github.com' };
const PROJECT_COLORS = {
  gray: '#8a8886',
  green: '#107c10',
  blue: '#0f6cbd',
  pumpkin: '#ca5010',
  purple: '#8764b8',
  pink: '#e3008c',
  yellow: '#c19c00',
};
const COLLECTION_COLORS = ['#0f6cbd', '#107c10', '#ca5010', '#8764b8', '#e3008c', '#c19c00', '#038387', '#8a8886'];
const KIND_LABELS = {
  chat: 'Chat',
  'cowork-task': 'Cowork task',
  'app-chat': 'App chat',
  'app-session': 'App session',
  'app-cli-session': 'App CLI session',
  'cli-session': 'CLI session',
  'cli-index-only': 'CLI session (index only)',
  'vscode-chat': 'VS Code chat',
  'web-chat': 'Web chat',
  'cli-task': 'App/CLI session copy',
  'agent-task': 'Agent task',
};
const ROLE_LABELS = { user: 'You', assistant: 'Copilot', tool: 'Tool', system: 'Info', status: 'Status' };
const PAGE_SIZE = 200;
const MESSAGE_PAGE = 300;
const TOOL_PREVIEW_CHARS = 1500;
const DAY = 86_400_000;
const UI_KEY = 'copilot-chat-organizer.ui';
// Matches the app.css breakpoint where the details become a drawer over the list.
const NARROW = matchMedia('(max-width: 1100px)');

const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem(UI_KEY) ?? '{}');
  } catch {
    return {};
  }
})();

const state = {
  sources: [],
  items: [],
  byKey: new Map(),
  fetchedAt: {},
  projects: {},
  collections: [],
  collectionIndex: new Map(),
  places: new Map(),
  handoff: { entries: [], request: '' },
  tab: typeof saved.tab === 'string' ? saved.tab : 'all',
  filter: { q: '', kind: '', location: '', age: '', project: '', collection: '' },
  sort: saved.sort && typeof saved.sort.key === 'string' ? saved.sort : { key: 'updatedAt', dir: -1 },
  selected: new Set(),
  anchor: null,
  focused: null,
  view: [],
  viewIndex: new Map(),
  limit: PAGE_SIZE,
  rendered: 0,
  running: new Map(),
  transcripts: new Map(),
  detailKey: null,
  detailSeq: 0,
};

const $ = (selector) => document.querySelector(selector);
const keyOf = (item) => `${item.source}:${item.id}`;
const persistUi = () => localStorage.setItem(UI_KEY, JSON.stringify({ tab: state.tab, sort: state.sort }));

// ---- DOM helpers ---------------------------------------------------------------------

const PROPS = new Set(['checked', 'disabled', 'value', 'selected', 'hidden', 'readOnly', 'tabIndex', 'draggable', 'indeterminate']);

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (PROPS.has(k)) el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false || c === '') continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

// Element.replaceChildren() shows null children as the text "null", so skip empty ones the way h() does.
function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c !== undefined && c !== null && c !== false && c !== ''));
  return el;
}

const plural = (n, one, many = `${one}s`) => `${Number(n).toLocaleString()} ${n === 1 ? one : many}`;
const humanKind = (kind) => KIND_LABELS[kind] ?? String(kind ?? '').replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
const safeUrl = (url) => (typeof url === 'string' && /^(https?:|vscode:|vscode-insiders:)/i.test(url) ? url : undefined);

function shortLocation(location) {
  if (!location) return '';
  if (!/[\\/]/.test(location) || /^https?:/i.test(location)) return location;
  const parts = location.split(/[\\/]+/).filter(Boolean);
  return parts.length <= 2 ? location : `…/${parts.slice(-2).join('/')}`;
}

// Windows folders are case-insensitive, so c:\src and C:\src are one location.
const locationKey = (location) =>
  location && /^(?:[a-z]:[\\/]|\\\\)/i.test(location) ? location.replace(/\//g, '\\').toLowerCase() : (location ?? '');

/** Groups locations by key and labels each with the shortest path tail no other location shares. */
function indexLocations() {
  const variants = new Map();
  for (const i of state.items) {
    if (!i.location) continue;
    const key = locationKey(i.location);
    let counts = variants.get(key);
    if (!counts) variants.set(key, (counts = new Map()));
    counts.set(i.location, (counts.get(i.location) ?? 0) + 1);
  }
  const places = [...variants].map(([key, counts]) => {
    const [display] = [...counts].reduce((a, b) => (b[1] > a[1] ? b : a));
    const isPath = /[\\/]/.test(display) && !/^https?:/i.test(display);
    return {
      key,
      display: display.replace(/^[a-z](?=:[\\/])/, (c) => c.toUpperCase()),
      parts: isPath ? display.split(/[\\/]+/).filter(Boolean) : [],
      n: 2,
    };
  });
  const label = (p) => (p.parts.length <= p.n ? p.display : `…/${p.parts.slice(-p.n).join('/')}`);
  for (let grew = true; grew; ) {
    grew = false;
    const byLabel = new Map();
    for (const p of places) {
      const l = label(p).toLowerCase();
      const same = byLabel.get(l);
      if (same) same.push(p);
      else byLabel.set(l, [p]);
    }
    for (const same of byLabel.values()) {
      if (same.length < 2) continue;
      for (const p of same) {
        if (p.parts.length > p.n) {
          p.n++;
          grew = true;
        }
      }
    }
  }
  state.places = new Map(places.map((p) => [p.key, { label: label(p), title: p.display }]));
}

const placeLabel = (location) => (location ? (state.places.get(locationKey(location))?.label ?? shortLocation(location)) : '');

function fmtWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (Number.isNaN(diff)) return '';
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < DAY) return `${Math.floor(diff / 3_600_000)} h ago`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} d ago`;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric' });
}
const fmtFull = (iso) => (iso ? new Date(iso).toLocaleString() : '');

function banner(message) {
  const el = $('#banner');
  el.replaceChildren(h('span', {}, message), h('button', { type: 'button', onclick: () => location.reload() }, 'Reload'));
  el.hidden = false;
}

// ---- API -------------------------------------------------------------------------------

async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { 'x-organizer-token': TOKEN, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    banner('The organizer server is not reachable. Start it again with "npm start", then reload this page.');
    throw new Error('The organizer server is not reachable.');
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (res.status === 401) banner('The organizer was restarted. Reload this page to reconnect.');
  if (!res.ok) throw new Error(data?.error || `Request failed (HTTP ${res.status})`);
  return data;
}

const post = (path, body = {}) => api(path, { method: 'POST', body });

// ---- toasts and jobs ---------------------------------------------------------------------

function toast(message, kind = 'info', { timeout, actions = [] } = {}) {
  const el = h(
    'div',
    { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    h('div', { class: 'toast-msg' }, message),
    actions.length
      ? h(
          'div',
          { class: 'toast-actions' },
          actions.map((a) =>
            h('button', {
              type: 'button',
              class: 'link',
              onclick: () => {
                el.remove();
                a.run();
              },
            }, a.label),
          ),
        )
      : null,
    h('button', { type: 'button', class: 'toast-close', 'aria-label': 'Dismiss', onclick: () => el.remove() }, '×'),
  );
  $('#toasts').append(el);
  const ms = timeout ?? (kind === 'error' ? 12_000 : kind === 'warn' ? 10_000 : 5_000);
  if (ms) setTimeout(() => el.remove(), ms);
  return el;
}

function jobToast(job) {
  const msg = h('div', { class: 'toast-msg' });
  const fill = h('div', { class: 'progress-fill' });
  const bar = h('div', { class: 'progress' }, fill);
  const el = h('div', { class: 'toast job' }, h('div', { class: 'toast-title' }, job.label), msg, bar);
  $('#toasts').append(el);
  const update = (j) => {
    msg.textContent = j.progress?.message ?? '';
    const total = j.progress?.total;
    bar.classList.toggle('indeterminate', !total);
    fill.style.width = total ? `${Math.min(100, (100 * (j.progress.done ?? 0)) / total)}%` : '';
  };
  update(job);
  return {
    update,
    finish(j) {
      el.remove();
      const failed = (j.results ?? []).filter((r) => !r.ok).length;
      const details = [{ label: 'Details', run: () => openActivity(j.id) }];
      if (j.status === 'failed') toast(`${j.label} failed: ${j.error}`, 'error', { actions: details });
      else if (failed) toast(`${j.label}: ${j.summary ?? ''}. ${plural(failed, 'item')} failed.`, 'warn', { actions: details });
      else toast(`${j.label}: ${j.summary ?? 'done'}`, 'success');
    },
  };
}

function watchJob(job, { onDone, quiet = false } = {}) {
  return new Promise((resolve) => {
    const t = quiet ? null : jobToast(job);
    state.running.set(job.id, job);
    renderStatus();
    const tick = async () => {
      let j;
      try {
        j = await api(`/api/jobs/${encodeURIComponent(job.id)}`);
      } catch {
        setTimeout(tick, 2_000);
        return;
      }
      state.running.set(j.id, j);
      t?.update(j);
      renderStatus();
      if (j.status === 'running') {
        setTimeout(tick, 700);
        return;
      }
      state.running.delete(j.id);
      t?.finish(j);
      try {
        await onDone?.(j);
      } catch (e) {
        toast(e.message, 'error');
      }
      renderStatus();
      resolve(j);
    };
    tick();
  });
}

async function busy(button, fn) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Working…';
  try {
    return await fn();
  } catch (e) {
    toast(e.message, 'error');
    return undefined;
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

// ---- data ------------------------------------------------------------------------------

const sourceInfo = (id) => state.sources.find((s) => s.id === id);
const sourceHasProjects = (id) => !!sourceInfo(id)?.hasProjects;
const tabSources = () => (state.tab === 'all' ? state.sources : state.sources.filter((s) => s.id === state.tab));
const projectsFor = (source) => state.projects[source] ?? [];

function projectOf(item) {
  const pid = item.projectIds?.[0];
  return pid ? projectsFor(item.source).find((p) => p.id === pid) ?? { id: pid, name: 'Project', color: 'gray' } : undefined;
}

async function loadProjects() {
  await Promise.all(
    state.sources
      .filter((s) => s.hasProjects)
      .map(async (s) => {
        try {
          state.projects[s.id] = await api(`/api/projects?source=${encodeURIComponent(s.id)}`);
        } catch {
          state.projects[s.id] ??= [];
        }
      }),
  );
}

function indexCollections() {
  state.collectionIndex = new Map();
  for (const c of state.collections) {
    for (const k of c.members) state.collectionIndex.set(k, [...(state.collectionIndex.get(k) ?? []), c]);
  }
}

async function loadData() {
  const [sources, items, collections, handoff] = await Promise.all([
    api('/api/sources'),
    api('/api/items'),
    api('/api/collections'),
    api('/api/handoff'),
  ]);
  state.sources = sources;
  state.items = items.items;
  state.fetchedAt = items.fetchedAt;
  state.byKey = new Map(state.items.map((i) => [keyOf(i), i]));
  indexLocations();
  state.collections = collections;
  indexCollections();
  state.handoff = handoff;
  await loadProjects();
  for (const k of [...state.selected]) if (!state.byKey.has(k)) state.selected.delete(k);
  if (state.tab !== 'all' && !sourceInfo(state.tab)) state.tab = 'all';
  if (state.filter.collection && !state.collections.some((c) => c.id === state.filter.collection)) state.filter.collection = '';
  render();
}

async function reloadCollections() {
  state.collections = await api('/api/collections');
  indexCollections();
  renderSidebar();
  applyFilters({ keepScroll: true });
}

async function refreshSources(ids) {
  for (const id of ids) {
    const already = [...state.running.values()].find((j) => j.kind === 'refresh' && j.source === id);
    if (already) continue;
    try {
      const job = await post('/api/refresh', { source: id });
      watchJob(job, { onDone: () => loadData() });
    } catch (e) {
      toast(e.message, 'error');
    }
  }
}

// ---- filtering ---------------------------------------------------------------------------

const hayCache = new WeakMap();
function hay(item) {
  let s = hayCache.get(item);
  if (s === undefined) {
    s = [item.title, item.preview, item.location, humanKind(item.kind), item.status, item.id].filter(Boolean).join('\n').toLowerCase();
    hayCache.set(item, s);
  }
  return s;
}

const SORTERS = {
  title: (i) => (i.title ?? '').toLowerCase(),
  location: (i) => `${humanKind(i.kind)} ${i.location ?? ''}`.toLowerCase(),
  project: (i) => (projectOf(i)?.name ?? '\uffff').toLowerCase(),
  updatedAt: (i) => i.updatedAt ?? i.createdAt ?? '',
};

function computeView() {
  const { q, kind, location, age, project, collection } = state.filter;
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const members = collection ? new Set(state.collections.find((c) => c.id === collection)?.members ?? []) : null;
  const now = Date.now();
  const n = age ? Number(age.slice(2)) : 0;
  const view = state.items.filter((i) => {
    if (state.tab !== 'all' && i.source !== state.tab) return false;
    if (kind && i.kind !== kind) return false;
    if (location && locationKey(i.location) !== location) return false;
    if (project === '__none') {
      if (!sourceHasProjects(i.source) || i.projectIds?.length) return false;
    } else if (project && !(i.projectIds ?? []).includes(project)) return false;
    if (members && !members.has(keyOf(i))) return false;
    if (age) {
      const t = Date.parse(i.updatedAt ?? i.createdAt ?? '');
      if (Number.isNaN(t)) return age.startsWith('gt');
      const days = (now - t) / DAY;
      if (age.startsWith('lt') ? days > n : days < n) return false;
    }
    if (terms.length) {
      const s = hay(i);
      if (!terms.every((t) => s.includes(t))) return false;
    }
    return true;
  });
  const by = SORTERS[state.sort.key] ?? SORTERS.updatedAt;
  const dir = state.sort.dir;
  const keyed = view.map((i) => [by(i), i]);
  keyed.sort((a, b) => (a[0] < b[0] ? -dir : a[0] > b[0] ? dir : 0));
  state.view = keyed.map((x) => x[1]);
  state.viewIndex = new Map(state.view.map((i, idx) => [keyOf(i), idx]));
}

const hasActiveFilters = () => Object.values(state.filter).some(Boolean);

function clearFilters() {
  state.filter = { q: '', kind: '', location: '', age: '', project: '', collection: '' };
  $('#search').value = '';
  $('#ageFilter').value = '';
  renderSidebar();
  applyFilters();
}

function applyFilters({ keepScroll = false } = {}) {
  const list = $('#list');
  const scroll = list.scrollTop;
  computeView();
  if (!keepScroll) state.limit = PAGE_SIZE;
  renderListHeader();
  renderList();
  renderBulkBar();
  if (keepScroll) list.scrollTop = scroll;
}

// ---- selection ---------------------------------------------------------------------------

const selectedItems = () => [...state.selected].map((k) => state.byKey.get(k)).filter(Boolean);

function setSelected(keys, on) {
  const changed = [];
  for (const k of keys) {
    if (state.selected.has(k) === on) continue;
    if (on) state.selected.add(k);
    else state.selected.delete(k);
    changed.push(k);
  }
  updateSelectionUI(changed);
}

function toggleRow(key, range) {
  const on = !state.selected.has(key);
  const a = state.anchor ? state.viewIndex.get(state.anchor) : undefined;
  const b = state.viewIndex.get(key);
  if (range && a !== undefined && b !== undefined && a !== b) {
    const [lo, hi] = a < b ? [a, b] : [b, a];
    setSelected(state.view.slice(lo, hi + 1).map(keyOf), on);
  } else {
    setSelected([key], on);
  }
  state.anchor = key;
}

function clearSelection() {
  const changed = [...state.selected];
  state.selected.clear();
  state.anchor = null;
  updateSelectionUI(changed);
}

// Repaints only the rows whose selection changed, so large lists stay responsive.
function updateSelectionUI(changed) {
  for (const key of changed) {
    const row = rowEls.get(key);
    if (!row) continue;
    const on = state.selected.has(key);
    row.classList.toggle('selected', on);
    row.setAttribute('aria-selected', on ? 'true' : 'false');
    row.querySelector('.check')?.setAttribute('aria-checked', on ? 'true' : 'false');
  }
  renderListHeader();
  renderBulkBar();
}

// ---- rendering: top bar and status ---------------------------------------------------------

function render() {
  const list = $('#list');
  const scroll = list.scrollTop;
  renderTabs();
  renderStatus();
  renderSidebar();
  computeView();
  renderListHeader();
  renderList();
  renderBulkBar();
  renderDetail();
  renderHandoffCount();
  list.scrollTop = scroll;
}

function renderTabs() {
  const counts = {};
  for (const i of state.items) counts[i.source] = (counts[i.source] ?? 0) + 1;
  const tab = (id, label, count) =>
    h(
      'button',
      {
        type: 'button',
        role: 'tab',
        class: `tab${state.tab === id ? ' active' : ''}`,
        'aria-selected': state.tab === id ? 'true' : 'false',
        onclick: () => switchTab(id),
      },
      label,
      count !== undefined ? h('span', { class: 'count' }, count.toLocaleString()) : null,
    );
  $('#tabs').replaceChildren(
    tab('all', 'All', state.items.length),
    ...state.sources.map((s) => tab(s.id, s.label, state.fetchedAt[s.id] ? counts[s.id] ?? 0 : undefined)),
  );
}

function switchTab(id) {
  if (state.tab === id) return;
  state.tab = id;
  persistUi();
  state.filter.kind = '';
  state.filter.location = '';
  if (state.filter.project && id !== 'all' && !sourceHasProjects(id)) state.filter.project = '';
  clearSelection();
  renderTabs();
  renderStatus();
  renderSidebar();
  applyFilters();
}

function renderStatus() {
  const strip = $('#statusStrip');
  const running = [...state.running.values()];
  const chips = tabSources().map((s) => {
    const job = running.find((j) => j.kind === 'refresh' && j.source === s.id);
    const fetched = state.fetchedAt[s.id];
    const count = state.items.filter((i) => i.source === s.id).length;
    const warnings = s.status?.warnings ?? [];
    const unavailable = s.status?.available === false;
    const parts = [h('span', { class: `dot ${unavailable ? 'bad' : job ? 'busy' : fetched ? 'ok' : 'idle'}` }), h('strong', {}, s.label)];
    if (job) parts.push(h('span', { class: 'muted' }, job.progress?.message || 'Refreshing…'));
    else if (unavailable) parts.push(h('span', { class: 'muted' }, s.status?.message ?? 'Unavailable'));
    else if (fetched) parts.push(h('span', { class: 'muted', title: fmtFull(fetched) }, `${plural(count, 'conversation')} · refreshed ${fmtWhen(fetched)}`));
    else parts.push(h('span', { class: 'muted' }, 'Not loaded'), h('button', { type: 'button', class: 'link', onclick: () => refreshSources([s.id]) }, 'Load'));
    if (!job && !unavailable && s.status?.message && s.status?.signedIn === false) parts.push(h('span', { class: 'warn-text' }, s.status.message));
    if (warnings.length) parts.push(h('span', { class: 'warn-text', title: warnings.join('\n') }, `⚠ ${plural(warnings.length, 'warning')}`));
    return h('div', { class: 'status-chip' }, parts);
  });
  const other = running.filter((j) => j.kind !== 'refresh');
  if (other.length) chips.push(h('div', { class: 'status-chip' }, h('span', { class: 'dot busy' }), `${plural(other.length, 'operation')} running`));
  strip.replaceChildren(...chips);
}

function renderHandoffCount() {
  const el = $('#handoffCount');
  const n = state.handoff.entries.length;
  el.hidden = n === 0;
  el.textContent = String(n);
}

// ---- rendering: sidebar ---------------------------------------------------------------------

function fillSelect(select, value, options, allLabel) {
  select.replaceChildren(
    h('option', { value: '' }, allLabel),
    ...options.map(([v, label, title]) => h('option', { value: v, selected: v === value, title }, label)),
  );
  select.value = options.some(([v]) => v === value) ? value : '';
}

function renderSidebar() {
  const inTab = state.items.filter((i) => state.tab === 'all' || i.source === state.tab);
  const kinds = new Map();
  const locations = new Map();
  for (const i of inTab) {
    kinds.set(i.kind, (kinds.get(i.kind) ?? 0) + 1);
    if (i.location) {
      const key = locationKey(i.location);
      locations.set(key, (locations.get(key) ?? 0) + 1);
    }
  }
  fillSelect(
    $('#kindFilter'),
    state.filter.kind,
    [...kinds].sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, `${humanKind(k)} (${n})`]),
    'All types',
  );
  fillSelect(
    $('#locationFilter'),
    state.filter.location,
    [...locations]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 200)
      .map(([key, n]) => {
        const place = state.places.get(key);
        return [key, `${place?.label ?? key} (${n})`, place?.title];
      }),
    'Anywhere',
  );

  // Projects (only sources with native projects; Microsoft 365 today).
  const projectSources = state.sources.filter((s) => s.hasProjects && (state.tab === 'all' || state.tab === s.id) && state.fetchedAt[s.id]);
  $('#projectsSection').hidden = projectSources.length === 0;
  const list = $('#projectList');
  const nodes = [];
  const navItem = (label, value, count, extra = {}) =>
    h(
      'li',
      {
        class: `nav-item${state.filter.project === value ? ' active' : ''}${extra.class ? ` ${extra.class}` : ''}`,
        dataset: extra.dataset,
        onclick: () => {
          state.filter.project = state.filter.project === value && value ? '' : value;
          renderSidebar();
          applyFilters();
        },
      },
      extra.swatch ?? null,
      h('span', { class: 'nav-label', title: label }, label),
      count !== undefined ? h('span', { class: 'nav-count' }, count.toLocaleString()) : null,
      extra.menu ?? null,
    );
  if (projectSources.length) {
    const inProjectSources = state.items.filter((i) => projectSources.some((s) => s.id === i.source));
    nodes.push(navItem('All conversations', '', undefined));
    nodes.push(navItem('Not in a project', '__none', inProjectSources.filter((i) => !i.projectIds?.length).length));
    for (const s of projectSources) {
      const projects = [...projectsFor(s.id)].sort((a, b) => a.name.localeCompare(b.name));
      const active = projects.filter((p) => !p.archived);
      const archived = projects.filter((p) => p.archived);
      const projectNode = (p) =>
        navItem(p.name, p.id, p.itemCount ?? 0, {
          class: 'project droppable',
          dataset: { source: s.id, project: p.id },
          swatch: h('span', { class: 'swatch' , style: { background: PROJECT_COLORS[p.color] ?? PROJECT_COLORS.gray } }),
          menu: h(
            'button',
            {
              type: 'button',
              class: 'icon menu',
              title: 'Project settings',
              'aria-label': `Settings for ${p.name}`,
              onclick: (e) => {
                e.stopPropagation();
                openProjectDialog(s.id, p);
              },
            },
            '⋯',
          ),
        });
      nodes.push(...active.map(projectNode));
      if (archived.length) {
        const details = h('details', { class: 'archived' }, h('summary', {}, `Archived (${archived.length})`), h('ul', { class: 'nav-list' }, archived.map(projectNode)));
        nodes.push(h('li', { class: 'nav-group' }, details));
      }
    }
  }
  list.replaceChildren(...nodes);

  // Collections (local, any source).
  const counts = new Map(state.collections.map((c) => [c.id, c.members.filter((k) => state.byKey.has(k) && (state.tab === 'all' || k.startsWith(`${state.tab}:`))).length]));
  $('#collectionList').replaceChildren(
    ...state.collections
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) =>
        h(
          'li',
          {
            class: `nav-item collection droppable${state.filter.collection === c.id ? ' active' : ''}`,
            dataset: { collection: c.id },
            onclick: () => {
              state.filter.collection = state.filter.collection === c.id ? '' : c.id;
              renderSidebar();
              applyFilters();
            },
          },
          h('span', { class: 'swatch round', style: { background: c.color ?? COLLECTION_COLORS[0] } }),
          h('span', { class: 'nav-label', title: c.name }, c.name),
          h('span', { class: 'nav-count' }, (counts.get(c.id) ?? 0).toLocaleString()),
          h(
            'button',
            {
              type: 'button',
              class: 'icon menu',
              title: 'Collection settings',
              'aria-label': `Settings for ${c.name}`,
              onclick: (e) => {
                e.stopPropagation();
                openCollectionSettings(c);
              },
            },
            '⋯',
          ),
        ),
      ),
  );
}

// ---- rendering: list -----------------------------------------------------------------------

function sortHeader(label, key, cls) {
  const active = state.sort.key === key;
  return h(
    'button',
    {
      type: 'button',
      class: `col-head ${cls}${active ? ' active' : ''}`,
      onclick: () => {
        state.sort = active ? { key, dir: -state.sort.dir } : { key, dir: key === 'updatedAt' ? -1 : 1 };
        persistUi();
        applyFilters();
      },
    },
    label,
    active ? (state.sort.dir > 0 ? ' ▲' : ' ▼') : '',
  );
}

function renderListHeader() {
  const total = state.view.length;
  let selectedShown = 0;
  for (const i of state.view) if (state.selected.has(keyOf(i))) selectedShown++;
  const all = total > 0 && selectedShown === total;
  const check = h('div', {
    class: 'check',
    role: 'checkbox',
    tabIndex: 0,
    'aria-checked': all ? 'true' : selectedShown ? 'mixed' : 'false',
    title: all ? 'Clear the selection' : `Select all ${total.toLocaleString()} shown`,
    onclick: () => (all ? setSelected(state.view.map(keyOf), false) : setSelected(state.view.map(keyOf), true)),
    onkeydown: (e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        e.currentTarget.click();
      }
    },
  });
  $('#listHeader').replaceChildren(
    h('div', { class: 'cell check-cell' }, check),
    h('div', { class: 'cell' }, sortHeader('Conversation', 'title', 'main'), h('span', { class: 'muted shown' }, `${total.toLocaleString()} shown`)),
    h('div', { class: 'cell' }, sortHeader('Type · where', 'location', 'where')),
    h('div', { class: 'cell' }, sortHeader('Project · collections', 'project', 'proj')),
    h('div', { class: 'cell' }, sortHeader('Last activity', 'updatedAt', 'when')),
  );
}

function chip(label, color, title) {
  return h('span', { class: 'chip', title: title ?? label }, h('span', { class: 'swatch round', style: { background: color } }), h('span', {}, label));
}

function renderRow(item) {
  const key = keyOf(item);
  const on = state.selected.has(key);
  const project = projectOf(item);
  const collections = state.collectionIndex.get(key) ?? [];
  return h(
    'div',
    {
      class: `row${on ? ' selected' : ''}${state.focused === key ? ' focused' : ''}`,
      role: 'option',
      'aria-selected': on ? 'true' : 'false',
      draggable: true,
      dataset: { key },
    },
    h('div', { class: 'cell check-cell' }, h('div', { class: 'check', role: 'checkbox', 'aria-checked': on ? 'true' : 'false', title: 'Select (Shift-click selects a range)' })),
    h(
      'div',
      { class: 'cell main' },
      h(
        'div',
        { class: 'title' },
        state.tab === 'all' ? h('span', { class: `src src-${item.source}` }, SOURCE_SHORT[item.source] ?? item.source) : null,
        h('span', { class: 'title-text' }, item.title),
        item.status ? h('span', { class: 'status-tag' }, item.status) : null,
        item.note ? h('span', { class: 'note-flag', title: item.note }, 'ⓘ') : null,
      ),
      item.preview ? h('div', { class: 'preview' }, item.preview) : null,
    ),
    h('div', { class: 'cell where' }, h('div', {}, humanKind(item.kind)), h('div', { class: 'muted', title: item.location ?? '' }, placeLabel(item.location))),
    h(
      'div',
      { class: 'cell proj' },
      project ? chip(project.name, PROJECT_COLORS[project.color] ?? PROJECT_COLORS.gray, `Project: ${project.name}`) : null,
      collections.slice(0, 2).map((c) => chip(c.name, c.color ?? COLLECTION_COLORS[0], `Collection: ${c.name}`)),
      collections.length > 2 ? h('span', { class: 'muted' }, `+${collections.length - 2}`) : null,
    ),
    h('div', { class: 'cell when', title: fmtFull(item.updatedAt ?? item.createdAt) }, fmtWhen(item.updatedAt ?? item.createdAt)),
  );
}

let observer;
const rowEls = new Map();
function renderList() {
  const list = $('#list');
  observer?.disconnect();
  list.replaceChildren();
  rowEls.clear();
  state.rendered = 0;
  if (!state.view.length) {
    list.append(emptyState());
    return;
  }
  appendRows(Math.min(state.limit, state.view.length));
}

function appendRows(to) {
  const list = $('#list');
  list.querySelector('.sentinel')?.remove();
  const frag = document.createDocumentFragment();
  for (let i = state.rendered; i < to; i++) {
    const row = renderRow(state.view[i]);
    rowEls.set(row.dataset.key, row);
    frag.append(row);
  }
  list.append(frag);
  state.rendered = to;
  state.limit = Math.max(state.limit, to);
  if (to < state.view.length) {
    const sentinel = h('div', { class: 'sentinel' }, `Showing ${to.toLocaleString()} of ${state.view.length.toLocaleString()}…`);
    list.append(sentinel);
    observer ??= new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) appendRows(Math.min(state.rendered + PAGE_SIZE, state.view.length));
      },
      { root: list, rootMargin: '600px' },
    );
    observer.disconnect();
    observer.observe(sentinel);
  }
}

function emptyState() {
  const unloaded = tabSources().filter((s) => !state.fetchedAt[s.id]);
  if (unloaded.length && !state.items.some((i) => state.tab === 'all' || i.source === state.tab)) {
    const loadable = unloaded.filter((s) => s.status?.available !== false);
    return h(
      'div',
      { class: 'empty' },
      h('h2', {}, 'Load your conversations'),
      h('p', {}, 'Nothing has been loaded yet from:'),
      h(
        'ul',
        {},
        unloaded.map((s) => h('li', {}, h('strong', {}, s.label), s.status?.available === false ? ` (${s.status.message ?? 'unavailable'})` : '')),
      ),
      loadable.length ? h('button', { type: 'button', class: 'primary', onclick: () => refreshSources(loadable.map((s) => s.id)) }, 'Load now') : null,
      unloaded.some((s) => s.id === 'm365')
        ? h(
            'p',
            { class: 'muted' },
            'Microsoft 365 runs in a separate Edge window. The first time, that window asks you to sign in; the organizer never sees your password.',
          )
        : null,
    );
  }
  if (hasActiveFilters()) {
    return h('div', { class: 'empty' }, h('p', {}, 'No conversations match these filters.'), h('button', { type: 'button', onclick: clearFilters }, 'Clear filters'));
  }
  return h('div', { class: 'empty' }, h('p', {}, 'No conversations here.'));
}

// ---- rendering: bulk bar ---------------------------------------------------------------------

function renderBulkBar() {
  const bar = $('#bulkBar');
  const items = selectedItems();
  const n = items.length;
  bar.hidden = n === 0;
  if (!n) {
    bar.replaceChildren();
    return;
  }
  const hidden = items.filter((i) => !state.viewIndex.has(keyOf(i))).length;
  const sources = [...new Set(items.map((i) => i.source))];
  const projectSource = sources.length === 1 && sourceHasProjects(sources[0]) ? sources[0] : null;
  const inProject = items.filter((i) => i.projectIds?.length).length;
  const collection = state.collections.find((c) => c.id === state.filter.collection);
  fill(
    bar,
    h('strong', {}, `${n.toLocaleString()} selected`),
    hidden ? h('span', { class: 'muted' }, `(${hidden.toLocaleString()} hidden by filters)`) : null,
    h('button', { type: 'button', class: 'link', onclick: clearSelection }, 'Clear'),
    h('span', { class: 'spacer' }),
    h(
      'button',
      {
        type: 'button',
        disabled: !projectSource,
        title: projectSource ? 'Put the selection in a project' : 'Only Microsoft 365 conversations can go in projects. Select items from one source.',
        onclick: () => openMoveDialog(projectSource, items.map(keyOf)),
      },
      'Move to project…',
    ),
    h('button', { type: 'button', disabled: !inProject, title: 'Take the selection out of its projects (the conversations are kept)', onclick: () => removeFromProjects(items) }, 'Remove from project'),
    h('button', { type: 'button', onclick: () => openCollectionDialog(items.map(keyOf)) }, 'Add to collection…'),
    collection ? h('button', { type: 'button', onclick: () => removeFromCollection(collection, items.map(keyOf)) }, `Remove from "${collection.name}"`) : null,
    h('button', { type: 'button', class: 'danger', onclick: () => openDeleteDialog(items.map(keyOf)) }, 'Delete…'),
  );
}

// ---- rendering: detail pane -----------------------------------------------------------------

function focusItem(key, { scroll = false } = {}) {
  const prev = state.focused;
  state.focused = key;
  for (const row of $('#list').querySelectorAll('.row.focused')) row.classList.remove('focused');
  const idx = state.viewIndex.get(key);
  if (idx !== undefined && idx >= state.rendered) appendRows(Math.min(idx + PAGE_SIZE, state.view.length));
  const row = rowEls.get(key);
  row?.classList.add('focused');
  if (scroll) row?.scrollIntoView({ block: 'nearest' });
  if (prev !== key) renderDetail();
}

function closeDetail() {
  const key = state.focused;
  if (!key) return;
  state.focused = null;
  rowEls.get(key)?.classList.remove('focused');
  renderDetail();
  $('#list').focus({ preventScroll: true });
}

function metaRow(label, value) {
  if (value === undefined || value === null || value === '') return null;
  return h('div', { class: 'meta-row' }, h('dt', {}, label), h('dd', {}, value));
}

function renderDetail(force = false) {
  const pane = $('#detail');
  const item = state.focused ? state.byKey.get(state.focused) : undefined;
  document.body.classList.toggle('detail-open', Boolean(item));
  if (!item) {
    state.detailKey = null;
    pane.replaceChildren(
      h(
        'div',
        { class: 'detail-empty' },
        h('h2', {}, 'Nothing open'),
        h('p', {}, 'Click a conversation to read it here.'),
        h(
          'ul',
          { class: 'muted tips' },
          h('li', {}, 'Click the boxes to select; Shift-click selects a range; Ctrl+A selects everything shown.'),
          h('li', {}, 'Drag a selection onto a project or collection in the sidebar.'),
          h('li', {}, 'Use the filters (for example "More than 90 days ago") to find chats to clean up.'),
          h('li', {}, 'Keys: / search, ↑↓ move, Space select, Delete delete, Esc clear.'),
        ),
      ),
    );
    return;
  }
  const key = keyOf(item);
  if (!force && state.detailKey === key) return;
  state.detailKey = key;
  const project = projectOf(item);
  const collections = state.collectionIndex.get(key) ?? [];
  const url = safeUrl(item.url);
  const selected = state.selected.has(key);
  const transcriptBox = h('div', { class: 'transcript' });
  pane.replaceChildren(
    h(
      'div',
      { class: 'detail-head' },
      h('h2', { class: 'detail-title' }, item.title),
      h(
        'div',
        { class: 'detail-actions' },
        url ? h('a', { class: 'button', href: url, target: '_blank', rel: 'noopener noreferrer' }, 'Open ↗') : null,
        h('button', { type: 'button', onclick: () => { setSelected([key], !selected); renderDetail(true); } }, selected ? 'Unselect' : 'Select'),
        sourceHasProjects(item.source) ? h('button', { type: 'button', onclick: () => openMoveDialog(item.source, [key]) }, 'Move…') : null,
        h('button', { type: 'button', class: 'danger', onclick: () => openDeleteDialog([key]) }, 'Delete…'),
        h('button', { type: 'button', class: 'detail-close', title: 'Close (Esc)', onclick: closeDetail }, 'Close'),
      ),
      item.note ? h('div', { class: 'note' }, item.note) : null,
      h(
        'dl',
        { class: 'meta' },
        metaRow('Source', sourceInfo(item.source)?.label ?? item.source),
        metaRow('Type', humanKind(item.kind)),
        metaRow('Where', item.location),
        metaRow('Status', item.status),
        metaRow('Project', project?.name),
        metaRow('Collections', collections.map((c) => c.name).join(', ')),
        metaRow('Created', fmtFull(item.createdAt)),
        metaRow('Last activity', fmtFull(item.updatedAt)),
        metaRow('Messages', item.messageCount),
        metaRow(
          'Id',
          h(
            'span',
            { class: 'id' },
            h('code', {}, item.id),
            h('button', { type: 'button', class: 'link', onclick: () => copyText(item.id, 'Id copied') }, 'Copy'),
          ),
        ),
      ),
    ),
    transcriptBox,
  );
  loadTranscript(item, transcriptBox, false);
}

async function loadTranscript(item, box, full) {
  const key = keyOf(item);
  const seq = ++state.detailSeq;
  const cacheKey = `${key}|${full ? 'full' : 'default'}`;
  let transcript = state.transcripts.get(cacheKey);
  if (!transcript) {
    box.replaceChildren(
      h(
        'div',
        { class: 'loading' },
        h('span', { class: 'spinner' }),
        item.source === 'm365' ? 'Loading from Microsoft 365… (the first load can take a few seconds)' : 'Loading…',
      ),
    );
    try {
      transcript = await api(`/api/transcript?key=${encodeURIComponent(key)}${full ? '&full=1' : ''}`);
      state.transcripts.set(cacheKey, transcript);
      if (state.transcripts.size > 40) state.transcripts.delete(state.transcripts.keys().next().value);
    } catch (e) {
      if (seq !== state.detailSeq) return;
      box.replaceChildren(
        h('div', { class: 'error-box' }, h('p', {}, `Could not load this conversation: ${e.message}`), h('button', { type: 'button', onclick: () => loadTranscript(item, box, full) }, 'Try again')),
      );
      return;
    }
  }
  if (seq !== state.detailSeq) return;
  renderTranscript(item, box, transcript, full);
}

// Tool output, such as terminal logs, can run to tens of thousands of characters.
function messageText(m) {
  const text = String(m.text ?? '');
  if (m.role !== 'tool' || text.length <= TOOL_PREVIEW_CHARS) return h('div', { class: 'msg-text' }, text);
  const box = h('div', { class: 'msg-text' });
  box.append(
    `${text.slice(0, TOOL_PREVIEW_CHARS)}…\n`,
    h('button', { type: 'button', class: 'link', onclick: () => box.replaceChildren(text) }, `Show all ${text.length.toLocaleString()} characters`),
  );
  return box;
}

function renderTranscript(item, box, transcript, full) {
  const messages = transcript.messages ?? [];
  let shown = Math.min(messages.length, MESSAGE_PAGE);
  const list = h('div', { class: 'messages' });
  const more = h('button', { type: 'button', class: 'link' });
  const draw = () => {
    list.replaceChildren(
      ...messages.slice(0, shown).map((m) =>
        h(
          'div',
          { class: `msg role-${m.role}` },
          h('div', { class: 'msg-head' }, h('span', { class: 'msg-role' }, ROLE_LABELS[m.role] ?? m.role), m.at ? h('span', { class: 'muted' }, fmtFull(m.at)) : null),
          messageText(m),
        ),
      ),
    );
    more.hidden = shown >= messages.length;
    more.textContent = `Show ${Math.min(MESSAGE_PAGE, messages.length - shown)} more of ${messages.length - shown} remaining`;
  };
  more.addEventListener('click', () => {
    shown = Math.min(messages.length, shown + MESSAGE_PAGE);
    draw();
  });
  draw();
  fill(
    box,
    transcript.note || transcript.partial
      ? h(
          'div',
          { class: 'note' },
          transcript.note ?? 'Only part of this conversation was loaded.',
          transcript.partial && !full ? h('button', { type: 'button', class: 'link', onclick: () => loadTranscript(item, box, true) }, ' Load the full conversation') : null,
        )
      : null,
    messages.length ? list : h('p', { class: 'muted' }, 'No messages to show.'),
    more,
  );
}

async function copyText(text, message = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(message, 'success', { timeout: 2_500 });
  } catch {
    toast('Copy failed. Select the text and press Ctrl+C.', 'warn');
  }
}

// ---- dialogs ---------------------------------------------------------------------------------

function openDialog(title, body, actions = [], { wide = false } = {}) {
  const d = $('#dialog');
  d.className = `dialog${wide ? ' wide' : ''}`;
  fill(
    d,
    h('div', { class: 'dialog-head' }, h('h2', {}, title), h('button', { type: 'button', class: 'icon', 'aria-label': 'Close', onclick: () => d.close() }, '×')),
    h('div', { class: 'dialog-body' }, body),
    actions.length ? h('div', { class: 'dialog-actions' }, actions) : null,
  );
  if (!d.open) d.showModal();
  return d;
}
const closeDialog = () => $('#dialog').close();
const cancelButton = (label = 'Cancel') => h('button', { type: 'button', onclick: closeDialog }, label);

function backupChooser(name = 'backup') {
  const option = (value, label, hint, checked = false) =>
    h('label', { class: 'radio' }, h('input', { type: 'radio', name, value, checked }), h('span', {}, h('strong', {}, label), h('span', { class: 'muted' }, ` ${hint}`)));
  const box = h(
    'fieldset',
    { class: 'fieldset' },
    h('legend', {}, 'Backup before deleting'),
    option('summary', 'Summary', '(recommended) saves what the list knows plus the readable conversation.', true),
    option('full', 'Full', 'also loads the complete history of Cowork tasks and github.com items. Slower.'),
    option('none', 'None', 'deletes without saving anything.'),
    h('p', { class: 'muted small' }, `Backups are saved on this PC under ${state.info?.dataDir ?? '.data'}\\backups.`),
  );
  return { el: box, value: () => box.querySelector(`input[name="${name}"]:checked`)?.value ?? 'summary' };
}

async function openDeleteDialog(keys) {
  if (!keys.length) return;
  let plan;
  try {
    plan = await post('/api/delete/plan', { keys });
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  if (!plan.total) {
    openDialog('Nothing to delete', h('p', {}, 'The selected conversations are no longer in the list. Refresh and try again.'), [cancelButton('Close')]);
    return;
  }
  const points = [];
  if (plan.direct) points.push(h('li', {}, h('strong', {}, plural(plan.direct, 'conversation')), ' will be permanently deleted from the service. This cannot be undone.'));
  if (plan.trash) points.push(h('li', {}, h('strong', {}, plural(plan.trash, 'local session')), ' will be moved to the organizer trash, where you can restore them.'));
  if (plan.handoff) {
    points.push(
      h('li', {}, h('strong', {}, plural(plan.handoff, 'GitHub Copilot app session')), ' will be added to the hand-off queue. Only the app can delete them; the queue gives you a request to paste into a Copilot app chat.'),
    );
  }
  if (plan.none) points.push(h('li', {}, h('strong', {}, plural(plan.none, 'conversation')), ' cannot be deleted from here and will be skipped.'));
  if (plan.missing) points.push(h('li', {}, `${plural(plan.missing, 'selected item')} no longer exist and will be skipped.`));
  if (plan.cascade) points.push(h('li', { class: 'warn-text' }, `Microsoft 365 also deletes ${plural(plan.cascade, 'Copilot task')} that were created from these chats.`));
  const backup = plan.direct ? backupChooser() : null;
  const phrase = plan.confirmPhrase;
  const input = h('input', { type: 'text', class: 'confirm-input', autocomplete: 'off', spellcheck: 'false', placeholder: phrase, 'aria-label': `Type ${phrase} to confirm` });
  const go = h('button', { type: 'button', class: 'danger', disabled: true }, plan.direct ? `Delete ${plural(plan.total, 'conversation')}` : 'Continue');
  input.addEventListener('input', () => {
    go.disabled = input.value.trim().toLowerCase() !== phrase;
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !go.disabled) go.click();
  });
  go.addEventListener('click', () =>
    busy(go, async () => {
      const job = await post('/api/delete', { keys, backup: backup?.value() ?? 'none', confirm: input.value });
      closeDialog();
      setSelected(keys, false);
      watchJob(job, {
        onDone: async () => {
          state.transcripts.clear();
          await loadData();
          if (plan.handoff) toast('GitHub Copilot app sessions were queued. Open Hand-off to finish deleting them.', 'info', { actions: [{ label: 'Open Hand-off', run: openHandoff }] });
        },
      });
    }),
  );
  openDialog(
    `Delete ${plural(plan.total, 'conversation')}?`,
    [
      h('ul', { class: 'plan' }, points),
      plan.notes.length ? h('details', { class: 'notes' }, h('summary', {}, `Things to know (${plan.notes.length})`), h('ul', {}, plan.notes.map((n) => h('li', {}, n)))) : null,
      backup?.el,
      h('label', { class: 'confirm' }, 'Type ', h('code', {}, phrase), ' to confirm', input),
    ],
    [cancelButton(), go],
  );
  input.focus();
}

function choiceList(options, onPick) {
  let current = null;
  const buttons = options.map((o) =>
    h(
      'button',
      {
        type: 'button',
        class: 'choice',
        onclick: (e) => {
          for (const b of buttons) b.classList.remove('active');
          e.currentTarget.classList.add('active');
          current = o.value;
          onPick(o.value);
        },
      },
      o.swatch ?? null,
      h('span', { class: 'nav-label' }, o.label),
      o.count !== undefined ? h('span', { class: 'nav-count' }, o.count) : null,
    ),
  );
  return { el: h('div', { class: 'choice-list' }, buttons), value: () => current };
}

async function assignToProject(source, projectId, keys, projectName) {
  const job = await post(`/api/projects/${encodeURIComponent(source)}/${encodeURIComponent(projectId)}/assign`, { keys });
  watchJob(job, { onDone: () => loadData() });
  toast(`Moving ${plural(keys.length, 'conversation')} to "${projectName}"…`, 'info', { timeout: 2_500 });
}

function openMoveDialog(source, keys) {
  if (!source) return;
  const items = keys.map((k) => state.byKey.get(k)).filter((i) => i && i.source === source);
  const projects = projectsFor(source)
    .filter((p) => !p.archived)
    .sort((a, b) => a.name.localeCompare(b.name));
  const newName = h('input', { type: 'text', placeholder: 'New project name', maxlength: '200', 'aria-label': 'New project name' });
  const go = h('button', { type: 'button', class: 'primary', disabled: true }, 'Move');
  const picker = choiceList(
    projects.map((p) => ({ value: p.id, label: p.name, count: p.itemCount ?? 0, swatch: h('span', { class: 'swatch', style: { background: PROJECT_COLORS[p.color] ?? PROJECT_COLORS.gray } }) })),
    () => {
      newName.value = '';
      go.disabled = false;
    },
  );
  newName.addEventListener('input', () => {
    if (newName.value.trim()) for (const b of picker.el.querySelectorAll('.choice')) b.classList.remove('active');
    go.disabled = !newName.value.trim() && !picker.value();
  });
  const inOther = items.filter((i) => i.projectIds?.length).length;
  const noThread = items.filter((i) => i.kind === 'chat' && !i.extra?.threadId).length;
  go.addEventListener('click', () =>
    busy(go, async () => {
      let projectId = picker.value();
      let name = projects.find((p) => p.id === projectId)?.name ?? '';
      if (newName.value.trim()) {
        const created = await post('/api/projects', { source, name: newName.value.trim() });
        projectId = created.id;
        name = created.name;
      }
      if (!projectId) return;
      closeDialog();
      await assignToProject(source, projectId, items.map(keyOf), name);
    }),
  );
  openDialog(
    `Move ${plural(items.length, 'conversation')} to a project`,
    [
      projects.length ? picker.el : h('p', { class: 'muted' }, 'You have no projects yet. Name a new one below.'),
      h('label', { class: 'field' }, 'Or create a new project', newName),
      inOther ? h('p', { class: 'muted' }, `${plural(inOther, 'conversation')} already in another project will be moved (an item can be in only one project).`) : null,
      noThread ? h('p', { class: 'warn-text' }, `${plural(noThread, 'chat')} cannot be put in a project because the service did not report a thread id.`) : null,
    ],
    [cancelButton(), go],
  );
}

async function removeFromProjects(items) {
  const bySource = new Map();
  for (const i of items.filter((x) => x.projectIds?.length)) bySource.set(i.source, [...(bySource.get(i.source) ?? []), keyOf(i)]);
  for (const [source, keys] of bySource) {
    try {
      const job = await post('/api/unassign', { source, keys });
      watchJob(job, { onDone: () => loadData() });
    } catch (e) {
      toast(e.message, 'error');
    }
  }
}

function openCollectionDialog(keys) {
  const newName = h('input', { type: 'text', placeholder: 'New collection name', maxlength: '120', 'aria-label': 'New collection name' });
  const go = h('button', { type: 'button', class: 'primary', disabled: true }, 'Add');
  const picker = choiceList(
    state.collections
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => ({ value: c.id, label: c.name, count: c.members.length, swatch: h('span', { class: 'swatch round', style: { background: c.color ?? COLLECTION_COLORS[0] } }) })),
    () => {
      newName.value = '';
      go.disabled = false;
    },
  );
  newName.addEventListener('input', () => {
    if (newName.value.trim()) for (const b of picker.el.querySelectorAll('.choice')) b.classList.remove('active');
    go.disabled = !newName.value.trim() && !picker.value();
  });
  go.addEventListener('click', () =>
    busy(go, async () => {
      let id = picker.value();
      if (newName.value.trim()) {
        const color = COLLECTION_COLORS[state.collections.length % COLLECTION_COLORS.length];
        id = (await post('/api/collections', { name: newName.value.trim(), color })).id;
      }
      if (!id) return;
      const res = await post(`/api/collections/${encodeURIComponent(id)}/add`, { keys });
      closeDialog();
      await reloadCollections();
      const name = state.collections.find((c) => c.id === id)?.name ?? 'collection';
      toast(`Added ${plural(res.added, 'conversation')} to "${name}"${res.added < keys.length ? ` (${keys.length - res.added} were already there)` : ''}.`, 'success');
    }),
  );
  openDialog(
    `Add ${plural(keys.length, 'conversation')} to a collection`,
    [
      state.collections.length ? picker.el : h('p', { class: 'muted' }, 'You have no collections yet. Name a new one below.'),
      h('label', { class: 'field' }, 'Or create a new collection', newName),
      h('p', { class: 'muted small' }, 'Collections are stored only on this PC and can mix Microsoft 365, GitHub and VS Code conversations.'),
    ],
    [cancelButton(), go],
  );
  (state.collections.length ? picker.el.querySelector('button') : newName)?.focus();
}

async function addKeysToCollection(collection, keys) {
  try {
    const res = await post(`/api/collections/${encodeURIComponent(collection.id)}/add`, { keys });
    await reloadCollections();
    toast(`Added ${plural(res.added, 'conversation')} to "${collection.name}".`, 'success');
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function removeFromCollection(collection, keys) {
  try {
    const res = await post(`/api/collections/${encodeURIComponent(collection.id)}/remove`, { keys });
    setSelected(keys, false);
    await reloadCollections();
    toast(`Removed ${plural(res.removed, 'conversation')} from "${collection.name}".`, 'success');
  } catch (e) {
    toast(e.message, 'error');
  }
}

function colorPicker(colors, current, toCss) {
  let value = current;
  const swatches = colors.map((c) =>
    h('button', {
      type: 'button',
      class: `swatch-btn${c === current ? ' active' : ''}`,
      title: c,
      'aria-label': c,
      style: { background: toCss(c) },
      onclick: (e) => {
        value = c;
        for (const s of swatches) s.classList.remove('active');
        e.currentTarget.classList.add('active');
      },
    }),
  );
  return { el: h('div', { class: 'swatches' }, swatches), value: () => value };
}

function openProjectDialog(source, project) {
  const info = sourceInfo(source);
  const name = h('input', { type: 'text', value: project.name, maxlength: '200', 'aria-label': 'Project name' });
  const colors = colorPicker(info?.projectColors ?? Object.keys(PROJECT_COLORS), project.color ?? 'gray', (c) => PROJECT_COLORS[c] ?? c);
  const archived = h('input', { type: 'checkbox', checked: !!project.archived });
  const save = h('button', { type: 'button', class: 'primary' }, 'Save');
  save.addEventListener('click', () =>
    busy(save, async () => {
      const patch = {};
      if (name.value.trim() && name.value.trim() !== project.name) patch.name = name.value.trim();
      if (colors.value() !== (project.color ?? 'gray')) patch.color = colors.value();
      if (archived.checked !== !!project.archived) patch.archived = archived.checked;
      if (Object.keys(patch).length) {
        await api(`/api/projects/${encodeURIComponent(source)}/${encodeURIComponent(project.id)}`, { method: 'PATCH', body: patch });
        await loadProjects();
        render();
        toast('Project updated.', 'success');
      }
      closeDialog();
    }),
  );
  const del = h('button', { type: 'button', class: 'danger', onclick: () => openDeleteProjectDialog(source, project) }, 'Delete project…');
  openDialog(
    'Project settings',
    [
      h('label', { class: 'field' }, 'Name', name),
      h('div', { class: 'field' }, 'Color', colors.el),
      h('label', { class: 'check-field' }, archived, ' Archived (hidden from the main project list in Copilot)'),
      h('div', { class: 'danger-zone' }, h('p', {}, `This project has ${plural(project.itemCount ?? 0, 'conversation')} in the last refresh.`), del),
    ],
    [cancelButton(), save],
  );
}

function openDeleteProjectDialog(source, project) {
  const members = state.items.filter((i) => i.source === source && i.projectIds?.includes(project.id));
  const n = members.length;
  const keep = h('input', { type: 'radio', name: 'contents', value: 'keep', checked: true });
  const drop = h('input', { type: 'radio', name: 'contents', value: 'delete' });
  const backup = backupChooser('project-backup');
  const phrase = `delete ${n}`;
  const input = h('input', { type: 'text', class: 'confirm-input', autocomplete: 'off', spellcheck: 'false', placeholder: phrase });
  const confirmBox = h('div', { class: 'stack', hidden: true }, backup.el, h('label', { class: 'confirm' }, 'Type ', h('code', {}, phrase), ' to confirm', input));
  const go = h('button', { type: 'button', class: 'danger' }, 'Delete project');
  const sync = () => {
    confirmBox.hidden = !drop.checked;
    go.disabled = drop.checked && input.value.trim().toLowerCase() !== phrase;
  };
  keep.addEventListener('change', sync);
  drop.addEventListener('change', sync);
  input.addEventListener('input', sync);
  go.addEventListener('click', () =>
    busy(go, async () => {
      const contents = drop.checked ? 'delete' : 'keep';
      const job = await post(`/api/projects/${encodeURIComponent(source)}/${encodeURIComponent(project.id)}/delete`, {
        contents,
        backup: contents === 'delete' ? backup.value() : undefined,
        confirm: input.value,
      });
      closeDialog();
      if (state.filter.project === project.id) state.filter.project = '';
      watchJob(job, { onDone: () => loadData() });
    }),
  );
  openDialog(
    `Delete the project "${project.name}"?`,
    [
      h(
        'div',
        { class: 'stack' },
        h('label', { class: 'radio' }, keep, h('span', {}, h('strong', {}, `Keep its ${plural(n, 'conversation')}`), h('span', { class: 'muted' }, ' They are taken out of the project first, then the empty project is deleted.'))),
        h('label', { class: 'radio' }, drop, h('span', {}, h('strong', {}, `Delete its ${plural(n, 'conversation')} too`), h('span', { class: 'muted' }, ' Permanently deletes them, then the project.'))),
      ),
      confirmBox,
      h('p', { class: 'muted small' }, 'The organizer checks that the project is really empty before deleting it, so nothing it does not know about is lost.'),
    ],
    [cancelButton(), go],
  );
}

function openNewProjectDialog() {
  const source = state.tab !== 'all' && sourceHasProjects(state.tab) ? state.tab : state.sources.find((s) => s.hasProjects)?.id;
  if (!source) return;
  const name = h('input', { type: 'text', maxlength: '200', placeholder: 'Project name', 'aria-label': 'Project name' });
  const create = h('button', { type: 'button', class: 'primary' }, 'Create');
  const run = () =>
    busy(create, async () => {
      if (!name.value.trim()) return;
      await post('/api/projects', { source, name: name.value.trim() });
      closeDialog();
      await loadProjects();
      renderSidebar();
      toast('Project created.', 'success');
    });
  create.addEventListener('click', run);
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') run();
  });
  openDialog(`New ${sourceInfo(source)?.label ?? ''} project`, [h('label', { class: 'field' }, 'Name', name)], [cancelButton(), create]);
  name.focus();
}

function openNewCollectionDialog() {
  const name = h('input', { type: 'text', maxlength: '120', placeholder: 'Collection name', 'aria-label': 'Collection name' });
  const colors = colorPicker(COLLECTION_COLORS, COLLECTION_COLORS[state.collections.length % COLLECTION_COLORS.length], (c) => c);
  const create = h('button', { type: 'button', class: 'primary' }, 'Create');
  const run = () =>
    busy(create, async () => {
      if (!name.value.trim()) return;
      await post('/api/collections', { name: name.value.trim(), color: colors.value() });
      closeDialog();
      await reloadCollections();
    });
  create.addEventListener('click', run);
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') run();
  });
  openDialog('New collection', [h('label', { class: 'field' }, 'Name', name), h('div', { class: 'field' }, 'Color', colors.el)], [cancelButton(), create]);
  name.focus();
}

function openCollectionSettings(collection) {
  const name = h('input', { type: 'text', value: collection.name, maxlength: '120', 'aria-label': 'Collection name' });
  const colors = colorPicker(COLLECTION_COLORS, collection.color ?? COLLECTION_COLORS[0], (c) => c);
  const save = h('button', { type: 'button', class: 'primary' }, 'Save');
  save.addEventListener('click', () =>
    busy(save, async () => {
      await api(`/api/collections/${encodeURIComponent(collection.id)}`, { method: 'PATCH', body: { name: name.value.trim(), color: colors.value() } });
      closeDialog();
      await reloadCollections();
    }),
  );
  const del = h('button', { type: 'button', class: 'danger' }, 'Delete collection');
  del.addEventListener('click', () =>
    busy(del, async () => {
      await api(`/api/collections/${encodeURIComponent(collection.id)}`, { method: 'DELETE' });
      if (state.filter.collection === collection.id) state.filter.collection = '';
      closeDialog();
      await reloadCollections();
      toast(`Deleted the collection "${collection.name}". Its conversations were not touched.`, 'success');
    }),
  );
  openDialog(
    'Collection settings',
    [
      h('label', { class: 'field' }, 'Name', name),
      h('div', { class: 'field' }, 'Color', colors.el),
      h('div', { class: 'danger-zone' }, h('p', {}, 'Deleting a collection only removes the grouping; the conversations stay.'), del),
    ],
    [cancelButton(), save],
  );
}

async function openHandoff() {
  let data;
  try {
    data = await api('/api/handoff');
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  state.handoff = data;
  renderHandoffCount();
  if (!data.entries.length) {
    openDialog(
      'Hand-off queue',
      [
        h('p', {}, 'Nothing is waiting.'),
        h('p', { class: 'muted' }, 'GitHub Copilot app sessions can only be deleted by the app itself. When you delete them here, they are queued with a ready-made request you paste into a Copilot app chat.'),
      ],
      [cancelButton('Close')],
    );
    return;
  }
  const text = h('textarea', { class: 'request', readOnly: true, rows: '10' });
  text.value = data.request;
  const list = h(
    'ul',
    { class: 'handoff-list' },
    data.entries.map((e) =>
      h(
        'li',
        {},
        h('span', { class: 'nav-label', title: e.id }, e.title),
        h('span', { class: 'muted' }, fmtWhen(e.queuedAt)),
        h(
          'button',
          {
            type: 'button',
            class: 'link',
            onclick: async () => {
              await post('/api/handoff/remove', { keys: [e.key] });
              openHandoff();
            },
          },
          'Remove',
        ),
      ),
    ),
  );
  const clear = h('button', { type: 'button' }, 'Clear queue');
  clear.addEventListener('click', () =>
    busy(clear, async () => {
      state.handoff = await post('/api/handoff/remove', { keys: data.entries.map((e) => e.key) });
      renderHandoffCount();
      closeDialog();
    }),
  );
  const copy = h('button', { type: 'button', class: 'primary', onclick: () => copyText(data.request, 'Request copied. Paste it into a GitHub Copilot app chat.') }, 'Copy request');
  openDialog(
    `Hand-off queue (${data.entries.length})`,
    [
      h(
        'ol',
        { class: 'steps' },
        h('li', {}, 'Copy the request below.'),
        h('li', {}, 'Paste it into a chat in the GitHub Copilot app. The app deletes the sessions.'),
        h('li', {}, 'Refresh the GitHub Copilot tab here. Deleted sessions leave this queue automatically.'),
      ),
      text,
      h('details', {}, h('summary', {}, `Queued sessions (${data.entries.length})`), list),
    ],
    [clear, cancelButton('Close'), copy],
    { wide: true },
  );
}

async function openTrash(sourceId) {
  const sources = state.sources.filter((s) => s.hasTrash);
  if (!sources.length) {
    openDialog('Trash', h('p', {}, 'No source uses the organizer trash.'), [cancelButton('Close')]);
    return;
  }
  const source = sources.some((s) => s.id === sourceId) ? sourceId : sources[0].id;
  let items = [];
  try {
    items = await api(`/api/trash?source=${encodeURIComponent(source)}`);
  } catch (e) {
    toast(e.message, 'error');
  }
  const chosen = new Set();
  const restore = h('button', { type: 'button', class: 'primary', disabled: true }, 'Restore selected');
  const rows = items.map((i) => {
    const box = h('input', {
      type: 'checkbox',
      onchange: (e) => {
        if (e.currentTarget.checked) chosen.add(i.id);
        else chosen.delete(i.id);
        restore.disabled = chosen.size === 0;
      },
    });
    const deletedAt = i.deletedAt ?? i.extra?.deletedAt;
    const when = deletedAt ? `deleted ${fmtWhen(deletedAt)}` : fmtWhen(i.updatedAt);
    return h(
      'label',
      { class: 'trash-row', title: i.note ?? '' },
      box,
      h('span', { class: 'nav-label' }, i.title),
      h('span', { class: 'muted' }, placeLabel(i.location)),
      h('span', { class: 'muted', title: fmtFull(deletedAt ?? i.updatedAt) }, when),
    );
  });
  restore.addEventListener('click', () =>
    busy(restore, async () => {
      const job = await post('/api/trash/restore', { source, ids: [...chosen] });
      closeDialog();
      watchJob(job, { onDone: () => loadData() });
    }),
  );
  openDialog(
    'Trash',
    [
      sources.length > 1
        ? h(
            'div',
            { class: 'tabs small' },
            sources.map((s) => h('button', { type: 'button', class: `tab${s.id === source ? ' active' : ''}`, onclick: () => openTrash(s.id) }, s.label)),
          )
        : null,
      h('p', { class: 'muted' }, 'Local sessions deleted by the organizer are kept here so you can restore them.'),
      rows.length ? h('div', { class: 'trash-list' }, rows) : h('p', {}, 'The trash is empty.'),
    ],
    [cancelButton('Close'), restore],
    { wide: true },
  );
}

async function openActivity(jobId) {
  let jobs = [];
  let ops = [];
  try {
    [jobs, ops] = await Promise.all([api('/api/jobs'), api('/api/ops?limit=100')]);
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  const jobNode = (j) =>
    h(
      'details',
      { class: `job-entry ${j.status}`, open: j.id === jobId },
      h('summary', {}, h('strong', {}, j.label), ' ', h('span', { class: `badge ${j.status}` }, j.status), ' ', h('span', { class: 'muted' }, fmtWhen(j.startedAt))),
      j.status === 'running' ? h('p', {}, j.progress?.message ?? '') : null,
      j.summary ? h('p', {}, j.summary) : null,
      j.error ? h('p', { class: 'error-text' }, j.error) : null,
      (j.results ?? []).some((r) => !r.ok)
        ? h(
            'ul',
            { class: 'results' },
            j.results
              .filter((r) => !r.ok)
              .slice(0, 200)
              .map((r) => h('li', {}, h('strong', {}, r.title ?? r.id), ': ', r.error ?? 'failed')),
          )
        : null,
    );
  openDialog(
    'Activity',
    [
      h('h3', {}, 'This session'),
      jobs.length ? h('div', { class: 'jobs' }, jobs.map(jobNode)) : h('p', { class: 'muted' }, 'No operations yet.'),
      h('h3', {}, 'History'),
      ops.length
        ? h(
            'table',
            { class: 'ops' },
            h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Operation'), h('th', {}, 'Source'), h('th', {}, 'OK'), h('th', {}, 'Failed'))),
            h(
              'tbody',
              {},
              ops.map((o) => h('tr', {}, h('td', { title: fmtFull(o.at) }, fmtWhen(o.at)), h('td', {}, o.op), h('td', {}, o.source ?? ''), h('td', {}, String(o.ok)), h('td', {}, String(o.failed)))),
            ),
          )
        : h('p', { class: 'muted' }, 'Nothing recorded yet.'),
    ],
    [cancelButton('Close')],
    { wide: true },
  );
}

// ---- events ---------------------------------------------------------------------------------

let dragKeys = null;

function wireEvents() {
  const list = $('#list');
  list.addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    const key = row.dataset.key;
    if (e.target.closest('.check') || e.ctrlKey || e.metaKey || e.shiftKey) {
      if (e.shiftKey) document.getSelection()?.removeAllRanges();
      toggleRow(key, e.shiftKey);
      return;
    }
    state.anchor = key;
    focusItem(key);
  });
  list.addEventListener('keydown', (e) => {
    if (!state.view.length) return;
    const idx = state.focused ? state.viewIndex.get(state.focused) ?? -1 : -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = Math.max(0, Math.min(state.view.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)));
      const key = keyOf(state.view[next]);
      if (e.shiftKey) setSelected([key], true);
      state.anchor = key;
      focusItem(key, { scroll: true });
    } else if (e.key === ' ' && state.focused) {
      e.preventDefault();
      toggleRow(state.focused, false);
    } else if (e.key === 'Delete') {
      e.preventDefault();
      const keys = state.selected.size ? [...state.selected] : state.focused ? [state.focused] : [];
      openDeleteDialog(keys);
    }
  });
  list.addEventListener('dragstart', (e) => {
    const row = e.target.closest?.('.row');
    if (!row) return;
    const key = row.dataset.key;
    if (!state.selected.has(key)) {
      const changed = [...state.selected, key];
      state.selected = new Set([key]);
      state.anchor = key;
      updateSelectionUI(changed);
    }
    dragKeys = [...state.selected];
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData('text/plain', `${dragKeys.length} conversations`);
    document.body.classList.add('dragging');
  });
  list.addEventListener('dragend', () => {
    dragKeys = null;
    document.body.classList.remove('dragging');
    for (const el of document.querySelectorAll('.drop-target')) el.classList.remove('drop-target');
  });

  const sidebar = document.querySelector('.sidebar');
  sidebar.addEventListener('dragover', (e) => {
    const target = e.target.closest?.('.droppable');
    if (!dragKeys || !target) return;
    e.preventDefault();
    for (const el of document.querySelectorAll('.drop-target')) if (el !== target) el.classList.remove('drop-target');
    target.classList.add('drop-target');
  });
  sidebar.addEventListener('dragleave', (e) => {
    const target = e.target.closest?.('.droppable');
    if (target && !target.contains(e.relatedTarget)) target.classList.remove('drop-target');
  });
  sidebar.addEventListener('drop', async (e) => {
    const target = e.target.closest?.('.droppable');
    const keys = dragKeys;
    dragKeys = null;
    document.body.classList.remove('dragging');
    target?.classList.remove('drop-target');
    if (!target || !keys?.length) return;
    e.preventDefault();
    if (target.dataset.project) {
      const source = target.dataset.source;
      const wrong = keys.filter((k) => !k.startsWith(`${source}:`)).length;
      if (wrong) {
        toast(`Only ${sourceInfo(source)?.label ?? source} conversations can go in this project; ${plural(wrong, 'item')} skipped.`, 'warn');
      }
      const ok = keys.filter((k) => k.startsWith(`${source}:`));
      if (!ok.length) return;
      const project = projectsFor(source).find((p) => p.id === target.dataset.project);
      try {
        await assignToProject(source, target.dataset.project, ok, project?.name ?? 'project');
      } catch (err) {
        toast(err.message, 'error');
      }
    } else if (target.dataset.collection) {
      const collection = state.collections.find((c) => c.id === target.dataset.collection);
      if (collection) await addKeysToCollection(collection, keys);
    }
  });

  let searchTimer;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.filter.q = e.target.value;
      applyFilters();
    }, 120);
  });
  $('#kindFilter').addEventListener('change', (e) => {
    state.filter.kind = e.target.value;
    applyFilters();
  });
  $('#locationFilter').addEventListener('change', (e) => {
    state.filter.location = e.target.value;
    applyFilters();
  });
  $('#ageFilter').addEventListener('change', (e) => {
    state.filter.age = e.target.value;
    applyFilters();
  });

  $('#refreshBtn').addEventListener('click', () => {
    const ids = tabSources()
      .filter((s) => s.status?.available !== false)
      .map((s) => s.id);
    if (!ids.length) toast('No source is available to refresh.', 'warn');
    refreshSources(ids);
  });
  $('#handoffBtn').addEventListener('click', openHandoff);
  $('#trashBtn').addEventListener('click', () => openTrash());
  $('#activityBtn').addEventListener('click', () => openActivity());
  $('#newProjectBtn').addEventListener('click', openNewProjectDialog);
  $('#newCollectionBtn').addEventListener('click', openNewCollectionDialog);

  document.addEventListener('keydown', (e) => {
    const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
    if ($('#dialog').open) return;
    if (e.key === '/' && !typing) {
      e.preventDefault();
      $('#search').focus();
    } else if (e.key === 'Escape' && !typing) {
      if (NARROW.matches && state.focused) closeDetail();
      else if (state.selected.size) clearSelection();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !typing) {
      e.preventDefault();
      setSelected(state.view.map(keyOf), true);
    }
  });

  // Keep relative times and the source status fresh.
  setInterval(async () => {
    if (document.hidden) return;
    try {
      state.sources = await api('/api/sources');
      renderStatus();
    } catch {
      // The banner already explains connection problems.
    }
  }, 30_000);
}

async function start() {
  if (!TOKEN || TOKEN.includes('%%')) {
    banner('Open the organizer from the address printed by "npm start".');
    return;
  }
  wireEvents();
  try {
    state.info = await api('/api/info');
    await loadData();
    const jobs = await api('/api/jobs');
    for (const j of jobs.filter((x) => x.status === 'running')) watchJob(j, { onDone: () => loadData() });
  } catch (e) {
    toast(`Could not load data: ${e.message}`, 'error');
  }
}

start();
