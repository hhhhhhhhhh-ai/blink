import { toast, pickMime, esc } from './util.js';
import { I } from './icons.js';

const MAX_REC_SECONDS = 15;

/**
 * Full-screen camera: tap the shutter for a photo, hold it for a video.
 * handlers: { onCapture({blob, kind, duration?}), onFile(file), onClearReply() }
 */
export function createCamera(root, h) {
  root.innerHTML = `
    <video class="cam-video" playsinline muted autoplay></video>
    <div class="cam-flash"></div>
    <div class="cam-fallback" hidden>
      <p class="cf-msg"></p>
      <button class="btn primary" data-open>Open camera</button>
      <button class="btn ghost" data-pick>Choose photo or video</button>
    </div>
    <div class="cam-top">
      <button class="reply-pill" hidden></button>
      <button class="icon-btn glass cam-flip" aria-label="Flip camera">${I.flip}</button>
    </div>
    <div class="cam-rec" hidden><i></i><span>0:00</span></div>
    <div class="cam-bottom">
      <button class="icon-btn glass big cam-gallery" aria-label="Choose from gallery">${I.image}</button>
      <button class="shutter" aria-label="Tap for a photo, hold to record a video">
        <svg viewBox="0 0 100 100" aria-hidden="true"><circle class="ring-bg" cx="50" cy="50" r="44"/><circle class="ring" cx="50" cy="50" r="44"/></svg><i></i>
      </button>
      <span></span>
    </div>
    <p class="cam-hint">Tap for photo · Hold for video</p>
    <input class="f-pick" type="file" accept="image/*,video/*" hidden>
    <input class="f-cap" type="file" accept="image/*,video/*" capture="environment" hidden>`;

  const q = s => root.querySelector(s);
  const video = q('.cam-video'), shutter = q('.shutter'), fallback = q('.cam-fallback');
  const recBadge = q('.cam-rec'), fPick = q('.f-pick'), fCap = q('.f-cap'), replyPill = q('.reply-pill');

  let stream = null, starting = false, facing = 'environment';
  let holdTimer = null, pressing = false;
  let recorder = null, chunks = [], t0 = 0, tick = null, autoStop = null, recMime = '';

  /* ---------- stream ---------- */
  const getStream = audio => navigator.mediaDevices.getUserMedia({
    audio,
    video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 1920 } },
  });

  function showFallback(msg) {
    q('.cf-msg').textContent = msg;
    fallback.hidden = false;
  }

  async function start() {
    if (stream || starting) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return showFallback('The live camera isn’t available in this browser.');
    }
    starting = true;
    try {
      try { stream = await getStream(true); }
      catch (e) { stream = await getStream(false); }   // no mic? still allow photos/silent video
      video.srcObject = stream;
      video.classList.toggle('mirror', facing === 'user');
      fallback.hidden = true;
      await video.play().catch(() => {});
    } catch (e) {
      stream = null;
      showFallback('Camera access is blocked. Allow it in your browser settings, or use your phone’s camera instead.');
    } finally {
      starting = false;
    }
  }

  function stop() {
    if (recorder) { try { recorder.onstop = null; recorder.stop(); } catch { /* ignore */ } cleanupRec(); }
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null;
    video.srcObject = null;
  }

  /* ---------- photo ---------- */
  function photo() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;
    const scale = Math.min(1, 1280 / Math.max(vw, vh));
    const c = document.createElement('canvas');
    c.width = Math.round(vw * scale); c.height = Math.round(vh * scale);
    const ctx = c.getContext('2d');
    if (facing === 'user') { ctx.translate(c.width, 0); ctx.scale(-1, 1); }
    ctx.drawImage(video, 0, 0, c.width, c.height);
    root.classList.add('flash');
    setTimeout(() => root.classList.remove('flash'), 160);
    c.toBlob(b => b && h.onCapture({ blob: b, kind: 'image' }), 'image/jpeg', 0.85);
  }

  /* ---------- video ---------- */
  function startRec() {
    if (!stream || typeof MediaRecorder === 'undefined') {
      toast('Video recording isn’t supported in this browser');
      return;
    }
    const mime = pickMime();
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 2_500_000 } : {});
    } catch (e) {
      recorder = null;
      toast('Couldn’t start recording');
      return;
    }
    recMime = (recorder.mimeType || mime || 'video/webm').split(';')[0];
    chunks = [];
    recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      const elapsed = (Date.now() - t0) / 1000;
      const blob = new Blob(chunks, { type: recMime });
      cleanupRec();
      if (elapsed < 0.8 || !blob.size) { toast('Hold a little longer to record'); return; }
      h.onCapture({ blob, kind: 'video', duration: Math.max(1, Math.min(30, Math.round(elapsed))) });
    };
    t0 = Date.now();
    recorder.start(250);
    shutter.classList.add('rec');
    recBadge.hidden = false;
    tick = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      recBadge.querySelector('span').textContent = `0:${String(s).padStart(2, '0')}`;
    }, 250);
    autoStop = setTimeout(stopRec, MAX_REC_SECONDS * 1000);
    try { navigator.vibrate && navigator.vibrate(12); } catch { /* ignore */ }
  }

  function stopRec() {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  function cleanupRec() {
    clearInterval(tick); clearTimeout(autoStop);
    shutter.classList.remove('rec');
    recBadge.hidden = true;
    recBadge.querySelector('span').textContent = '0:00';
    recorder = null;
  }

  /* ---------- shutter: tap = photo, hold = video ---------- */
  shutter.addEventListener('pointerdown', e => {
    if (!stream) return;
    e.preventDefault();
    pressing = true;
    shutter.classList.add('down');
    if (shutter.setPointerCapture) { try { shutter.setPointerCapture(e.pointerId); } catch { /* ignore */ } }
    holdTimer = setTimeout(() => { holdTimer = null; startRec(); }, 320);
  });
  const release = () => {
    if (!pressing) return;
    pressing = false;
    shutter.classList.remove('down');
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; photo(); }
    else if (recorder) stopRec();
  };
  shutter.addEventListener('pointerup', release);
  shutter.addEventListener('pointercancel', release);
  shutter.addEventListener('contextmenu', e => e.preventDefault());
  shutter.addEventListener('click', () => { if (!stream) fCap.click(); });   // no live camera → system camera

  /* ---------- other controls ---------- */
  q('.cam-flip').addEventListener('click', async () => {
    facing = facing === 'user' ? 'environment' : 'user';
    stop();
    await start();
  });
  q('.cam-gallery').addEventListener('click', () => fPick.click());
  fallback.querySelector('[data-open]').addEventListener('click', () => fCap.click());
  fallback.querySelector('[data-pick]').addEventListener('click', () => fPick.click());
  for (const inp of [fPick, fCap]) {
    inp.addEventListener('change', () => {
      const f = inp.files && inp.files[0];
      inp.value = '';
      if (f) h.onFile(f);
    });
  }
  replyPill.addEventListener('click', () => h.onClearReply && h.onClearReply());

  function setReply(user) {
    replyPill.hidden = !user;
    if (user) replyPill.innerHTML = `To <b>@${esc(user.username)}</b> ${I.close}`;
  }

  return { start, stop, setReply };
}
