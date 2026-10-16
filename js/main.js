import { createBackend, USERNAME_RE } from './backend.js';
import { createCamera } from './camera.js';
import { $, $$, esc, avatar, fmtTime, toast, haptic, debounce, truncate, normalizeImage, videoDuration } from './util.js';
import { I, LOGO } from './icons.js';

const app = $('#app');
const MAX_VIDEO_BYTES = 45 * 1024 * 1024;

let be = null, me = null, camera = null, main = null;
let data = { friends: [], incoming: [], outgoing: [], convos: {} };
let loaded = false, tab = 'camera', replyTo = null, chat = null, viewing = false;
let unsub = null, poll = null, refreshing = false, again = false;

/* ═══════════ overlays (with Android back-button support) ═══════════ */
const stack = [];

function openOverlay(el, onClose) {
  const entry = { el, onClose, closing: false };
  stack.push(entry);
  document.body.append(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('in')));
  history.pushState({ ov: stack.length }, '');
  syncCamera();
  return {
    close() {
      const i = stack.indexOf(entry);
      if (i < 0 || entry.closing) return;
      entry.closing = true;
      history.go(-(stack.length - i));
    },
  };
}

addEventListener('popstate', e => {
  const depth = (e.state && e.state.ov) || 0;
  while (stack.length > depth) {
    const { el, onClose } = stack.pop();
    el.classList.remove('in');
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
    try { onClose && onClose(); } catch (err) { console.error(err); }
  }
  syncCamera();
});

const closeAllOverlays = () => { if (stack.length) history.go(-stack.length); };

function syncCamera() {
  if (!camera) return;
  if (tab === 'camera' && stack.length === 0 && document.visibilityState === 'visible') camera.start();
  else camera.stop();
}
document.addEventListener('visibilitychange', syncCamera);

/* keep the layout above the on-screen keyboard (iOS + Android) */
function viewportVars() {
  const vv = window.visualViewport;
  const set = () => {
    document.documentElement.style.setProperty('--app-h', `${Math.round(vv ? vv.height : innerHeight)}px`);
    if (vv && vv.offsetTop) window.scrollTo(0, 0);
  };
  set();
  (vv || window).addEventListener('resize', set);
  if (vv) vv.addEventListener('scroll', set);
}

/* ═══════════ boot ═══════════ */
boot();

async function boot() {
  viewportVars();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  app.innerHTML = `<div class="splash">${LOGO}</div>`;
  try {
    be = await createBackend();
    me = await be.init();
  } catch (e) {
    console.error(e);
    app.innerHTML = `<div class="fatal"><h2>Can’t start Blink</h2><p>${esc(e.message || 'Unknown error')}</p><button class="btn primary" onclick="location.reload()">Try again</button></div>`;
    return;
  }
  me ? showMain() : showAuth();
}

/* ═══════════ auth ═══════════ */
function showAuth(mode = 'signup') {
  const live = be.needsEmail;
  const signup = mode === 'signup';
  app.innerHTML = `
    <div class="auth">
      <div class="auth-top">${LOGO}<h1>Blink</h1><p>Send a snap. They watch it once.</p></div>
      <form class="auth-form" novalidate>
        <div class="seg">
          <button type="button" data-m="signup" class="${signup ? 'on' : ''}">Sign up</button>
          <button type="button" data-m="login" class="${signup ? '' : 'on'}">Log in</button>
        </div>
        ${signup ? `<label>Display name<input name="display" maxlength="30" autocomplete="nickname" placeholder="Alex"></label>` : ''}
        ${live ? `<label>Email<input name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="none" placeholder="you@email.com"></label>` : ''}
        ${signup || !live ? `<label>Username<input name="username" maxlength="20" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="alex_99"></label>` : ''}
        <label>Password<input name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" placeholder="At least 6 characters"></label>
        <p class="err" role="alert"></p>
        <button class="btn primary wide" type="submit">${signup ? 'Create account' : 'Log in'}</button>
        ${signup && live ? `<p class="fine">Friends find you by your <b>username</b>.</p>` : ''}
      </form>
      ${!live ? `<p class="demo-note"><b>Demo mode</b> — everything stays in this browser. Three friends are waiting for you. Connect Supabase (see README) to chat with real people.</p>` : ''}
    </div>`;
  const form = $('.auth-form'), errEl = $('.err', form), btn = $('button[type=submit]', form);
  $$('.seg button', form).forEach(b => b.addEventListener('click', () => showAuth(b.dataset.m)));
  const fail = msg => { errEl.textContent = msg; };
  form.addEventListener('submit', async e => {
    e.preventDefault();
    fail('');
    const f = Object.fromEntries(new FormData(form));
    const username = (f.username || '').trim().toLowerCase().replace(/^@/, '');
    const email = (f.email || '').trim();
    if (live && !/^\S+@\S+\.\S+$/.test(email)) return fail('Enter a valid email address.');
    if ((signup || !live) && !USERNAME_RE.test(username)) return fail('Username: 3–20 characters — letters, numbers, _ or .');
    if (!f.password || f.password.length < 6) return fail('Password needs at least 6 characters.');
    btn.disabled = true; btn.textContent = 'One sec…';
    try {
      me = signup
        ? await be.signUp({ username, displayName: (f.display || '').trim(), email, password: f.password })
        : await be.signIn({ username, email, password: f.password });
      showMain();
    } catch (ex) {
      fail(ex.message || 'Something went wrong.');
      btn.disabled = false; btn.textContent = signup ? 'Create account' : 'Log in';
    }
  });
}

/* ═══════════ main shell ═══════════ */
function showMain() {
  tab = 'camera'; loaded = false; replyTo = null;
  app.innerHTML = `
    <div class="main" data-tab="camera">
      <section class="pane pane-chats"></section>
      <section class="pane pane-camera"></section>
      <section class="pane pane-friends"></section>
      <nav class="nav">
        <button data-tab="chats">${I.chat}<span>Chats</span><i class="badge" hidden></i></button>
        <button data-tab="camera" class="on">${I.camera}<span>Camera</span></button>
        <button data-tab="friends">${I.friends}<span>Friends</span><i class="badge" hidden></i></button>
      </nav>
    </div>`;
  main = $('.main');
  camera = createCamera($('.pane-camera'), {
    onCapture: showPreview,
    onFile: f => handleFile(f),
    onClearReply: () => { replyTo = null; camera.setReply(null); },
  });
  $('.nav').addEventListener('click', e => {
    const b = e.target.closest('button[data-tab]');
    if (b) setTab(b.dataset.tab);
  });
  main.addEventListener('click', onMainClick);
  main.addEventListener('submit', onMainSubmit);
  unsub = be.onChange(debounce(refresh, 150));
  if (be.mode === 'live') poll = setInterval(refresh, 10000);   // safety net if realtime drops
  setTab('camera');
  refresh();
}

function setTab(t) {
  tab = t;
  if (!main) return;
  main.dataset.tab = t;
  $$('.nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  syncCamera();
}

async function logout() {
  closeAllOverlays();
  if (unsub) unsub();
  clearInterval(poll);
  if (camera) camera.stop();
  await be.signOut();
  me = null; main = null; camera = null; chat = null; replyTo = null;
  data = { friends: [], incoming: [], outgoing: [], convos: {} };
  document.title = 'Blink';
  showAuth('login');
}

/* ═══════════ data refresh ═══════════ */
async function refresh() {
  if (!me) return;
  if (refreshing) { again = true; return; }
  refreshing = true;
  try {
    const next = await be.loadAll();
    notifyNew(data, next);
    data = next; loaded = true;
    renderChats(); renderFriends(); renderBadges();
    if (chat) await refreshChat();
  } catch (e) {
    console.warn('refresh failed', e);
  } finally {
    refreshing = false;
    if (again) { again = false; refresh(); }
  }
}

const unreadTotal = d => Object.values(d.convos).reduce((a, c) => a + c.unread, 0);

function notifyNew(prev, next) {
  if (!loaded) return;
  if (unreadTotal(next) > unreadTotal(prev)) {
    const id = Object.keys(next.convos).find(k => next.convos[k].unread > ((prev.convos[k] && prev.convos[k].unread) || 0));
    if (id && !(chat && chat.friend.id === id)) {
      const f = next.friends.find(x => x.id === id);
      const kind = next.convos[id].last.kind;
      toast(`${kind === 'text' ? 'New message' : 'New snap'} from ${f ? f.display_name || f.username : 'a friend'}`);
      haptic([20, 40, 20]);
    }
  }
  if (next.incoming.length > prev.incoming.length) { toast('You have a new friend request'); haptic(20); }
}

function renderBadges() {
  const n = unreadTotal(data), r = data.incoming.length;
  const set = (t, v) => {
    const b = $(`.nav button[data-tab=${t}] .badge`);
    if (!b) return;
    b.hidden = !v; b.textContent = v > 9 ? '9+' : v;
  };
  set('chats', n); set('friends', r);
  document.title = n ? `(${n}) Blink` : 'Blink';
}

/* ═══════════ chats tab ═══════════ */
const snapChip = (kind, hollow) => `<span class="chip ${kind}${hollow ? ' hollow' : ''}"></span>`;

function lastLine(last) {
  if (!last) return '<span class="muted">Tap to start chatting</span>';
  const mine = last.sender === me.id;
  if (last.kind === 'text') return `${mine ? 'You: ' : ''}${esc(truncate(last.body, 40))}`;
  const label = last.kind === 'image' ? 'Photo' : 'Video';
  if (mine) return `${snapChip(last.kind, true)}${last.opened_at ? 'Opened' : 'Delivered'} · ${label}`;
  return last.opened_at
    ? `${snapChip(last.kind, true)}Opened · ${label}`
    : `${snapChip(last.kind, false)}<b>New ${label} Snap</b>`;
}

function renderChats() {
  const pane = $('.pane-chats');
  if (!pane) return;
  const ts = x => (x && x.last ? Date.parse(x.last.created_at) : 0);
  const rows = data.friends
    .map(f => ({ f, c: data.convos[f.id] }))
    .sort((a, b) => ts(b.c) - ts(a.c) || a.f.username.localeCompare(b.f.username));
  pane.innerHTML = `
    <header class="bar"><h2>Chats</h2>
      <button class="icon-btn" data-act="goto-friends" aria-label="Add friends">${I.plus}</button></header>
    <div class="scroll">${rows.length ? rows.map(({ f, c }) => `
      <button class="item ${c && c.unread ? 'unread' : ''}" data-chat="${f.id}">
        ${avatar(f, 50)}
        <span class="item-main"><b>${esc(f.display_name || f.username)}</b><small>${lastLine(c && c.last)}</small></span>
        <span class="item-side">${c && c.last ? fmtTime(c.last.created_at) : ''}${c && c.unread ? '<i class="dot"></i>' : ''}</span>
      </button>`).join('') : `
      <div class="empty"><div class="empty-ic">${I.friends}</div>
        <h3>No friends yet</h3><p>Add someone by their username to start sending snaps.</p>
        <button class="btn primary" data-act="goto-friends">Add a friend</button></div>`}
    </div>`;
}

/* ═══════════ friends tab ═══════════ */
function renderFriends() {
  const pane = $('.pane-friends');
  if (!pane) return;
  const prevInput = $('input[name=u]', pane);
  const keep = prevInput ? { v: prevInput.value, focus: document.activeElement === prevInput } : null;
  const person = (u, actions) => `
    <div class="item static">${avatar(u, 46)}
      <span class="item-main"><b>${esc(u.display_name || u.username)}</b><small>@${esc(u.username)}</small></span>
      <span class="item-actions">${actions}</span></div>`;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  pane.innerHTML = `
    <header class="bar"><h2>Friends</h2></header>
    <div class="scroll pad">
      <div class="me-card">${avatar(me, 58)}
        <div class="item-main"><b>${esc(me.display_name || me.username)}</b><small>@${esc(me.username)}</small></div>
        <button class="btn small" data-act="share">${I.share}Share</button></div>
      <form class="add" data-form="add">
        <span class="at">@</span>
        <input name="u" placeholder="Add friend by username" maxlength="21" autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="off" enterkeyhint="go">
        <button class="btn primary small">Add</button></form>
      <p class="err" id="add-msg"></p>
      ${data.incoming.length ? `<h4>Requests</h4>${data.incoming.map(u => person(u,
        `<button class="btn primary small" data-accept="${u.friendshipId}">Accept</button><button class="btn small" data-decline="${u.friendshipId}">Ignore</button>`)).join('')}` : ''}
      ${data.outgoing.length ? `<h4>Sent</h4>${data.outgoing.map(u => person(u,
        `<span class="muted">Pending</span><button class="btn small" data-decline="${u.friendshipId}">Cancel</button>`)).join('')}` : ''}
      <h4>My friends · ${data.friends.length}</h4>
      ${data.friends.length ? data.friends.map(u => person(u,
        `<button class="btn small" data-chat="${u.id}">Chat</button><button class="icon-btn small" data-remove="${u.friendshipId}" data-name="${esc(u.username)}" aria-label="Remove @${esc(u.username)}">${I.close}</button>`)).join('')
        : '<p class="muted pad-s">No friends yet — type a username above.</p>'}
      <button class="btn ghost wide" data-act="logout">Log out</button>
      ${!standalone ? `<p class="fine">Tip: use your browser’s <b>Add to Home Screen</b> to open Blink like a real app.</p>` : ''}
    </div>`;
  if (keep) {
    const inp = $('input[name=u]', pane);
    inp.value = keep.v;
    if (keep.focus) inp.focus();
  }
}

async function act(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg); refresh(); }
  catch (e) { toast(e.message || 'Something went wrong'); }
}

function onMainClick(e) {
  const t = e.target.closest('[data-chat],[data-act],[data-accept],[data-decline],[data-remove]');
  if (!t) return;
  const d = t.dataset;
  if (d.chat) return openChat(d.chat);
  if (d.accept) return act(() => be.respond(d.accept, true), 'Friend added');
  if (d.decline) return act(() => be.respond(d.decline, false));
  if (d.remove) { if (confirm(`Remove @${d.name} from your friends?`)) act(() => be.removeFriend(d.remove)); return; }
  if (d.act === 'goto-friends') setTab('friends');
  else if (d.act === 'share') share();
  else if (d.act === 'logout') logout();
}

async function onMainSubmit(e) {
  if (!e.target.matches('[data-form=add]')) return;
  e.preventDefault();
  const input = $('input[name=u]', e.target), msg = $('#add-msg');
  const name = input.value.trim();
  if (!name) return;
  msg.textContent = '';
  try {
    const res = await be.addFriend(name);
    input.value = '';
    toast(res);
    refresh();
  } catch (ex) { msg.textContent = ex.message; }
}

async function share() {
  const text = `Add me on Blink — my username is @${me.username}`;
  try {
    if (navigator.share) { await navigator.share({ title: 'Blink', text, url: location.href.split('#')[0] }); return; }
    await navigator.clipboard.writeText(`${text} ${location.href.split('#')[0]}`);
    toast('Copied to clipboard');
  } catch { /* cancelled */ }
}

/* ═══════════ chat thread ═══════════ */
async function openChat(friendId) {
  const friend = data.friends.find(f => f.id === friendId);
  if (!friend || chat) return;
  const el = document.createElement('div');
  el.className = 'overlay chat';
  el.innerHTML = `
    <header class="chat-bar">
      <button class="icon-btn" data-x aria-label="Back">${I.back}</button>
      ${avatar(friend, 40)}
      <div class="item-main"><b>${esc(friend.display_name || friend.username)}</b><small>@${esc(friend.username)}</small></div>
    </header>
    <div class="thread" role="log" aria-live="polite"></div>
    <form class="composer">
      <button type="button" class="icon-btn" data-cam aria-label="Send a snap">${I.camera}</button>
      <button type="button" class="icon-btn" data-pick aria-label="Send a photo or video">${I.image}</button>
      <input name="t" placeholder="Send a chat" maxlength="1000" autocomplete="off" enterkeyhint="send">
      <button class="send" aria-label="Send">${I.send}</button>
      <input type="file" accept="image/*,video/*" hidden>
    </form>`;
  chat = { friend, el, messages: [], first: true, handle: null };
  const c = chat;
  c.handle = openOverlay(el, () => { chat = null; refresh(); });

  $('[data-x]', el).addEventListener('click', () => c.handle.close());
  const input = $('input[name=t]', el), file = $('input[type=file]', el);
  $('[data-cam]', el).addEventListener('click', () => {
    replyTo = friend; camera.setReply(friend); setTab('camera'); c.handle.close();
  });
  $('[data-pick]', el).addEventListener('click', () => file.click());
  file.addEventListener('change', () => { const f = file.files[0]; file.value = ''; if (f) handleFile(f, friend); });
  $('.composer', el).addEventListener('submit', async e => {
    e.preventDefault();
    const body = input.value.trim();
    if (!body) return;
    input.value = ''; input.focus();
    const tmp = { id: 'tmp-' + Date.now(), sender: me.id, recipient: friend.id, kind: 'text', body, created_at: new Date().toISOString() };
    c.messages.push(tmp); renderThread(true);
    try { await be.sendText(friend.id, body); }
    catch (ex) {
      toast(ex.message || 'Couldn’t send');
      c.messages = c.messages.filter(m => m !== tmp); renderThread(); input.value = body;
    }
    refreshChat();
  });
  $('.thread', el).addEventListener('click', e => {
    const t = e.target.closest('[data-open]');
    if (!t) return;
    const m = c.messages.find(x => x.id === t.dataset.open);
    if (m) openViewer(m);
  });
  await refreshChat();
}

async function refreshChat() {
  const c = chat;
  if (!c) return;
  try {
    const msgs = await be.getMessages(c.friend.id);
    if (chat !== c) return;
    c.messages = msgs;
    renderThread();
    if (msgs.some(m => m.sender !== me.id && m.kind === 'text' && !m.read_at)) await be.markRead(c.friend.id);
  } catch (e) { console.warn('chat refresh failed', e); }
}

function renderMsg(m, isLastMine) {
  const mine = m.sender === me.id;
  if (m.kind === 'text') {
    const meta = mine && isLastMine ? `<div class="meta">${m.read_at ? 'Read' : m.id.startsWith('tmp-') ? 'Sending…' : 'Delivered'}</div>` : '';
    return `<div class="row ${mine ? 'me' : 'them'}"><div><div class="bubble">${esc(m.body)}</div>${meta}</div></div>`;
  }
  const label = m.kind === 'image' ? 'Photo' : 'Video';
  const ic = `<span class="snap-ic"></span>`;
  if (mine) {
    return `<div class="row me"><div class="snap ${m.kind} sent">${ic}<span>${m.opened_at ? 'Opened' : 'Delivered'}</span><small>${label}</small></div></div>`;
  }
  return m.opened_at
    ? `<div class="row them"><div class="snap ${m.kind} done">${ic}<span>Opened</span><small>${label}</small></div></div>`
    : `<button class="row them snap-btn" data-open="${m.id}"><span class="snap ${m.kind} new">${ic}<span>New ${label} Snap</span><small>Tap to view</small></span></button>`;
}

function renderThread(forceBottom = false) {
  if (!chat) return;
  const box = $('.thread', chat.el);
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
  let html = '', prev = 0;
  const lastMineIdx = chat.messages.map(m => m.sender === me.id).lastIndexOf(true);
  chat.messages.forEach((m, i) => {
    const t = Date.parse(m.created_at);
    if (t - prev > 15 * 60e3) html += `<div class="divider">${fmtTime(m.created_at, true)}</div>`;
    prev = t;
    html += renderMsg(m, i === lastMineIdx);
  });
  if (!chat.messages.length) {
    html = `<div class="empty small"><p>Say hi to <b>${esc(chat.friend.display_name || chat.friend.username)}</b> 👋<br>or send a snap with the camera button.</p></div>`;
  }
  box.innerHTML = html;
  if (atBottom || forceBottom || chat.first) box.scrollTop = box.scrollHeight;
  chat.first = false;
}

/* ═══════════ snap viewer (view once, then it's gone) ═══════════ */
async function openViewer(m) {
  if (viewing) return;
  viewing = true;
  const sender = data.friends.find(f => f.id === m.sender) || { username: '?', display_name: '?' };
  const el = document.createElement('div');
  el.className = 'overlay viewer';
  el.innerHTML = `<div class="v-load"><span class="spinner"></span></div>`;
  let url = null, timer = null, vid = null, opened = false;
  const onHide = () => { if (document.visibilityState === 'hidden') h.close(); };
  document.addEventListener('visibilitychange', onHide);
  const h = openOverlay(el, () => {
    clearTimeout(timer);
    if (vid) vid.pause();
    if (url) URL.revokeObjectURL(url);
    document.removeEventListener('visibilitychange', onHide);
    viewing = false;
    refresh();
  });
  el.addEventListener('contextmenu', e => e.preventDefault());

  let blob;
  try {
    blob = await be.fetchSnap(m);
    await be.discardSnap(m);            // delete the file first (the server only allows it while unopened)...
    opened = true;
    await be.openSnap(m.id);            // ...then mark it opened: it can never be opened again
  } catch (e) {
    if (e.gone) be.openSnap(m.id).catch(() => {});   // file already gone → stop showing it as new
    toast(e.message || 'Couldn’t load this snap');
    h.close();
    return;
  }
  url = URL.createObjectURL(blob);
  const dur = Math.max(1, Math.min(30, m.duration || 5));
  el.innerHTML = `
    ${m.kind === 'image' ? `<div class="v-bg" style="background-image:url(${url})"></div>` : ''}
    ${m.kind === 'image'
      ? `<img class="v-media" src="${url}" alt="" draggable="false">`
      : `<video class="v-media" src="${url}" playsinline autoplay></video>`}
    <div class="v-top">
      <div class="v-bar"><i></i></div>
      <div class="v-head">${avatar(sender, 36)}
        <div class="item-main"><b>${esc(sender.display_name || sender.username)}</b><small>${fmtTime(m.created_at)}</small></div>
        <button class="icon-btn" data-x aria-label="Close">${I.close}</button></div>
    </div>
    ${m.body ? `<div class="v-cap"><span>${esc(m.body)}</span></div>` : ''}
    <button class="v-sound" hidden>${I.sound}Tap for sound</button>
    <p class="v-hint">Tap anywhere to close</p>`;
  const bar = $('.v-bar i', el);
  if (m.kind === 'image') {
    bar.style.animation = `v-fill ${dur}s linear forwards`;
    timer = setTimeout(() => h.close(), dur * 1000);
  } else {
    vid = $('video', el);
    vid.onended = () => h.close();
    vid.ontimeupdate = () => {
      const total = Number.isFinite(vid.duration) ? vid.duration : dur;
      bar.style.width = `${Math.min(100, (vid.currentTime / total) * 100)}%`;
    };
    timer = setTimeout(() => h.close(), 31000);
    vid.play().catch(() => {
      vid.muted = true; vid.play().catch(() => {});
      const s = $('.v-sound', el); s.hidden = false;
      s.addEventListener('click', ev => { ev.stopPropagation(); vid.muted = false; s.hidden = true; });
    });
  }
  el.addEventListener('click', () => h.close());
}

/* ═══════════ capture → preview → send ═══════════ */
async function handleFile(file, friend) {
  if (friend) { replyTo = friend; camera && camera.setReply(friend); }
  try {
    if (file.type.startsWith('image/')) {
      showPreview({ blob: await normalizeImage(file), kind: 'image' });
    } else if (file.type.startsWith('video/')) {
      if (file.size > MAX_VIDEO_BYTES) return toast('That video is too big — keep it under 45 MB.');
      const d = await videoDuration(file);
      showPreview({ blob: file, kind: 'video', duration: Math.max(1, Math.min(30, Math.round(d || 10))) });
    } else {
      toast('Please choose a photo or a video.');
    }
  } catch (e) {
    console.error(e);
    toast('Couldn’t open that file.');
  }
}

function showPreview({ blob, kind, duration = 5 }) {
  const url = URL.createObjectURL(blob);
  const st = { caption: '', dur: 5 };
  const type = (blob.type || '').split(';')[0];
  const ext = kind === 'image' ? 'jpg' : type.includes('mp4') ? 'mp4' : type.includes('quicktime') ? 'mov' : 'webm';
  const el = document.createElement('div');
  el.className = 'overlay preview';
  el.innerHTML = `
    ${kind === 'image' ? `<div class="v-bg" style="background-image:url(${url})"></div>` : ''}
    ${kind === 'image'
      ? `<img class="v-media" src="${url}" alt="Your snap">`
      : `<video class="v-media" src="${url}" playsinline autoplay loop muted></video>`}
    <div class="p-top">
      <button class="icon-btn glass" data-x aria-label="Discard">${I.close}</button>
      <div class="p-tools">
        ${kind === 'image' ? `<button class="tool" data-dur aria-label="Viewing time">${I.timer}<span>5s</span></button>` : ''}
        <button class="tool" data-cap aria-label="Add caption"><b>Aa</b></button>
        <a class="tool" href="${url}" download="blink-${Date.now()}.${ext}" aria-label="Save to your device">${I.download}</a>
      </div>
    </div>
    <div class="p-cap" hidden><input maxlength="80" placeholder="Add a caption" autocomplete="off" enterkeyhint="done"></div>
    <div class="p-bottom"><button class="btn primary send-to">Send to ${I.send}</button></div>`;
  const h = openOverlay(el, () => URL.revokeObjectURL(url));
  $('[data-x]', el).addEventListener('click', () => h.close());

  const capWrap = $('.p-cap', el), capIn = $('input', capWrap);
  $('[data-cap]', el).addEventListener('click', () => { capWrap.hidden = false; capIn.focus(); });
  capIn.addEventListener('input', () => { st.caption = capIn.value; });
  capIn.addEventListener('blur', () => { if (!capIn.value.trim()) capWrap.hidden = true; });
  capIn.addEventListener('keydown', e => { if (e.key === 'Enter') capIn.blur(); });

  const durBtn = $('[data-dur]', el);
  if (durBtn) {
    const opts = [3, 5, 10];
    durBtn.addEventListener('click', () => {
      st.dur = opts[(opts.indexOf(st.dur) + 1) % opts.length];
      $('span', durBtn).textContent = `${st.dur}s`;
    });
  }
  $('.send-to', el).addEventListener('click', () => openSendSheet(st, blob, kind, kind === 'image' ? null : duration));
}

function openSendSheet(st, blob, kind, videoSecs) {
  const el = document.createElement('div');
  el.className = 'overlay sheet-wrap';
  el.innerHTML = `
    <div class="sheet" role="dialog" aria-label="Send to">
      <div class="grab"></div><h3>Send to</h3>
      <div class="sheet-list">${data.friends.length ? data.friends.map(f => `
        <label class="pick"><input type="checkbox" value="${f.id}" ${replyTo && replyTo.id === f.id ? 'checked' : ''}>
          <span class="check">${I.check}</span>${avatar(f, 42)}
          <span class="item-main"><b>${esc(f.display_name || f.username)}</b><small>@${esc(f.username)}</small></span></label>`).join('')
        : `<p class="muted pad-s">You have no friends yet. Add someone by username first.</p>`}
      </div>
      ${data.friends.length ? `<button class="btn primary wide" data-go disabled>Send</button>`
        : `<button class="btn primary wide" data-friends>Add friends</button>`}
    </div>`;
  const h = openOverlay(el);
  el.addEventListener('click', e => { if (e.target === el) h.close(); });
  const go = $('[data-go]', el);
  const update = () => {
    const n = $$('input:checked', el).length;
    go.disabled = !n;
    go.textContent = n ? `Send to ${n} friend${n > 1 ? 's' : ''}` : 'Send';
  };
  if (go) {
    $$('input', el).forEach(i => i.addEventListener('change', update));
    update();
    go.addEventListener('click', async () => {
      const ids = $$('input:checked', el).map(i => i.value);
      if (!ids.length) return;
      go.disabled = true; go.textContent = 'Sending…';
      try {
        await be.sendSnap(ids, blob, kind, st.caption.trim(), kind === 'image' ? st.dur : videoSecs);
        toast(`Snap sent to ${ids.length} friend${ids.length > 1 ? 's' : ''}`);
        haptic(15);
        replyTo = null; camera.setReply(null);
        closeAllOverlays();
        setTab('chats');
        refresh();
      } catch (e) {
        toast(e.message || 'Couldn’t send');
        update();
      }
    });
  } else {
    $('[data-friends]', el).addEventListener('click', () => { closeAllOverlays(); setTab('friends'); });
  }
}
