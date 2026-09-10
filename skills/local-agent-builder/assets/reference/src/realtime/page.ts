/**
 * La page d'appel (client du hub), embarquée telle quelle : AUCUNE ressource externe.
 *
 * Trois raisons, dans l'ordre d'importance :
 *   1. un agent local tourne souvent derrière un VPN ou un pare-feu — une page qui a besoin
 *      d'internet pour ouvrir le micro est une page qui ne marche pas là où elle sert ;
 *   2. le CSP est `'unsafe-inline'` et rien d'autre : aucun code tiers ne peut se glisser
 *      dans une page qui tient le micro de l'utilisateur ;
 *   3. ce qui est testé est exactement ce qui est servi (le test de non-régression vérifie
 *      justement qu'aucune URL externe n'apparaît dans ce contenu).
 *
 * Le contrat avec le hub :
 *   montante  binaire `[0x42][u32 temps][PCM16 16 kHz]`, un cadre de 40 ms ;
 *   descendante binaire `[0x41][u16 rate][u32 réservé][u32 longueur][PCM16 24 kHz]` ;
 *   contrôle  JSON `{t:'hello'|'caption'|'note'|'state'|'speech'|'interrupt'|'closed'|'error'}` ;
 *   le client renvoie `{t:'flush'}` quand son dernier échantillon est sorti du
 *   haut-parleur — c'est LUI qui le sait, pas le serveur — plus `{t:'mute'}` et `{t:'stop'}`.
 */
export const CALL_PAGE_HTML = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Appel avec l’agent</title>
<style>
  :root{color-scheme:dark;color:#eef1f5;background:#0d1117;font:16px/1.45 system-ui,sans-serif}
  main{margin:0 auto;padding:18px;max-width:46em}
  h1{font-size:1.12rem;font-weight:600;margin:0 0 2px}
  .sub{color:#93a0b4;font-size:.84rem;margin:0 0 14px}
  .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:12px 0}
  button{font:inherit;padding:.62em .95em;border-radius:11px;border:1px solid #2b3543;background:#182029;color:inherit;cursor:pointer}
  button:focus-visible{outline:2px solid #68b4ff;outline-offset:2px}
  button.stop{border-color:#5d2a30;background:#221416}
  .dot{width:10px;height:10px;border-radius:50%;background:#3a4756;flex:0 0 auto}
  .dot.on{background:#41d98d}.dot.warn{background:#e5b93c}.dot.out{background:#e5544f}
  #meter{height:5px;border-radius:3px;background:#1b232e;overflow:hidden;flex:1 1 120px;min-width:90px}
  #meter i{display:block;height:100%;width:0;background:#3d8ef7;transition:width 60ms linear}
  .bub{border-radius:14px;padding:9px 12px;margin:8px 0;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}
  .bub.in{background:#161d26;border:1px solid #222c38}
  .bub.out{background:#141b23;border:1px solid #26405c}
  .live{color:#c6d2e2;font-size:.9rem;margin:10px 0 0;min-height:1.2em}
  .note{color:#e5b93c;font-size:.82rem;margin-top:10px;min-height:1em}
  #thread{margin-top:10px}
</style>
</head>
<body>
<main>
  <h1>Appel avec l’agent</h1>
  <p class="sub">Le son ne passe pas par Telegram : cette page tient le micro et le haut-parleur. Rien n’est écrit sur le disque.</p>
  <div class="row">
    <span class="dot" id="dot"></span><span id="state">connexion…</span><span class="sub" id="clock"></span>
    <span id="meter"><i></i></span>
  </div>
  <div class="row">
    <button id="start" type="button">Activer le micro</button>
    <button id="mute" type="button" hidden>Muet</button>
    <button id="hangup" class="stop" type="button" hidden>Raccrocher</button>
  </div>
  <p class="live" id="live"></p>
  <div id="thread" aria-live="polite"></div>
  <p class="note" id="note"></p>
</main>
<script>
'use strict';
/* Un seul jeton, une seule connexion, aucune donnée envoyée ailleurs que vers cette origine. */
var ws = null, ctx = null, workletNode = null, stream = null;
var muted = false, speaking = false, ended = false;
var playQ = [], srcs = [], nextT = 0, t0 = 0;
function el(id) { return document.getElementById(id) }
var dot = el('dot'), stateEl = el('state'), live = el('live'), thread = el('thread'), noteEl = el('note');
function setState(txt, kind) { stateEl.textContent = txt; dot.className = 'dot' + (kind ? (' ' + kind) : '') }
function say(txt) { noteEl.textContent = txt }

function ensureCtx() { if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 }); return ctx }
/* Lecture : chaque cadre arrive à 24 kHz, est horodaté ici, et se suit sans trou. */
function enqueue(f32) {
  var c = ensureCtx();
  if (c.state === 'suspended') c.resume();
  var o = c.createBufferSource();
  var b = c.createBuffer(1, f32.length, 24000);
  b.getChannelData(0).set(f32);
  o.buffer = b; o.connect(c.destination);
  var start = Math.max(c.currentTime + 0.02, nextT);
  nextT = start + f32.length / 24000;
  o.start(start); srcs.push(o);
  o.onended = function () {
    var i = srcs.indexOf(o); if (i >= 0) srcs.splice(i, 1);
    if (speaking && srcs.length === 0 && playQ.length === 0) endSpeech();
  };
}
function stopPlay() { srcs.forEach(function (o) { try { o.stop(); o.disconnect() } catch (e) {} }); srcs = []; playQ = []; nextT = 0 }
function beginSpeech() { speaking = true; if (ctx) nextT = ctx.currentTime }
/* C'est le navigateur qui sait que le dernier échantillon est sorti : le serveur, lui,
   ne voit que des octets envoyés. Sans ce signal, l'agent se réécoute lui-même. */
function endSpeech() { speaking = false; send({ t: 'flush' }) }

var WORKLET = 'class P extends AudioWorkletProcessor{constructor(){super();this.b=new Float32Array(640);this.n=0}process(i){var ch=i[0];if(ch&&ch[0]){var s=ch[0],r=context.sampleRate/16000;for(var p=0;p<s.length;p+=r){var a=Math.floor(p),b=Math.min(s.length-1,a+1);if(this.n<640)this.b[this.n++]=s[a]+(s[b]-s[a])*(p-a)}for(;this.n>=640;){var f=new Float32Array(this.b.subarray(0,640)),p16=new Int16Array(640),m=0;for(var q=0;q<640;q++){var v=Math.max(-1,Math.min(1,f[q]));p16[q]=v*32767|0;var a2=Math.abs(v);if(a2>m)m=a2}var out=new Uint8Array(p16.buffer),fr=new Uint8Array(5+out.length);fr[0]=0x42;new DataView(fr.buffer).setUint32(1,performance.now()>>>0,true);fr.set(out,5);this.port.postMessage({bytes:fr,level:m});this.b.copyWithin(0,640);this.n-=640}}return true}};registerProcessor("og-pcm",P);'

function token() { var m = /[#&]t=([A-Za-z0-9_-]{8,128})/.exec(location.hash || ''); return m ? m[1] : '' }
function wsUrl(t) { return (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws?t=' + encodeURIComponent(t) }
function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)) }

function connect(t) {
  if (!t) { setState('aucun lien', 'warn'); say('Ouvrez l’appel depuis le bouton reçu dans Telegram : le lien est à usage unique.'); el('start').disabled = true; return }
  ws = new WebSocket(wsUrl(t)); ws.binaryType = 'arraybuffer';
  ws.onopen = function () { setState('connecté — micro non ouvert', 'on') };
  ws.onmessage = function (ev) {
    if (typeof ev.data === 'string') { try { control(JSON.parse(ev.data)) } catch (e) {} return }
    var v = new DataView(ev.data);
    if (ev.data.byteLength < 11 || v.getUint8(0) !== 0x41) return;
    var len = v.getUint32(7, true), off = 11;
    if (off + len > ev.data.byteLength) return;
    var i16 = new Int16Array(ev.data, off, len >> 1), f32 = new Float32Array(i16.length);
    for (var i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
    if (speaking) enqueue(f32); else playQ.push(f32);
  };
  ws.onclose = function () { if (!ended) { ended = true; setState('appel fermé', 'out'); stopMic(); say('Lien périmé (usage unique). Relancez /call dans Telegram pour un nouvel appel.') } };
  ws.onerror = function () { setState('erreur de connexion', 'out') };
}

function control(m) {
  if (m.t === 'caption') { bubble(m.role, m.text, !!m.final); return }
  if (m.t === 'state') {
    if (m.state === 'speaking') { beginSpeech(); while (playQ.length) enqueue(playQ.shift()) }
    if (m.state === 'listening' || m.state === 'thinking') { stopPlay(); live.textContent = '' }
    if (m.state === 'listening') setState('à l’écoute', 'on');
    else if (m.state === 'thinking') setState('je réfléchis…', 'on');
    else if (m.state === 'speaking') setState('je parle', 'warn');
    else if (m.state === 'muted') setState('micro coupé', 'warn');
    else if (m.state === 'ended') { ended = true; stopPlay(); stopMic(); setState('appel terminé', 'out') }
    return;
  }
  if (m.t === 'speech') { if (m.state === 'start') beginSpeech(); else endSpeech(); return }
  if (m.t === 'interrupt') { stopPlay(); setState('interrompu — à l’écoute', 'on'); return }
  if (m.t === 'note') { say(m.text); return }
  if (m.t === 'closed') { ended = true; stopPlay(); stopMic(); setState('appel terminé', 'out'); say(m.reason || ''); return }
  if (m.t === 'error') { say(m.text || 'erreur') }
}

function bubble(role, text, final) {
  if (!final) { if (role === 'in') live.textContent = text; return }
  live.textContent = '';
  var d = document.createElement('div'); d.className = 'bub ' + (role === 'in' ? 'in' : 'out');
  d.textContent = text; thread.prepend(d);
  while (thread.children.length > 25) thread.lastChild.remove();
}

async function startMic() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { say('Ce navigateur n’expose pas le micro.'); return }
  if (!window.isSecureContext) { say('Micro refusé : la page doit être servie en HTTPS (ou depuis localhost).'); return }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: { ideal: true }, noiseSuppression: { ideal: true }, autoGainControl: { ideal: true } }, video: false });
  } catch (e) { say('Micro refusé : ' + (e && e.name ? e.name : e)); setState('micro indisponible', 'warn'); return }
  var c = ensureCtx(); await c.resume();
  try { await c.audioWorklet.addModule('data:text/javascript,' + encodeURIComponent(WORKLET)) }
  catch (e) { say('AudioWorklet indisponible : impossible de capter le micro dans cette page.'); return }
  workletNode = new AudioWorkletNode(c, 'og-pcm');
  workletNode.port.onmessage = function (ev) {
    el('meter').firstElementChild.style.width = Math.min(100, Math.round(ev.data.level * 420)) + '%';
    if (ws && ws.readyState === 1 && !muted && !ended) ws.send(ev.data.bytes);
  };
  c.createMediaStreamSource(stream).connect(workletNode);
  workletNode.connect(c.destination);
  el('start').hidden = true; el('mute').hidden = false; el('hangup').hidden = false;
  if (!t0) { t0 = Date.now(); setInterval(function () {
    var s = Math.round((Date.now() - t0) / 1000);
    el('clock').textContent = String((s / 60) | 0).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }, 1000) }
  send({ t: 'ready' });
}

function stopMic() {
  if (workletNode) { try { workletNode.disconnect() } catch (e) {} workletNode = null }
  if (stream) { stream.getTracks().forEach(function (t) { t.stop() }); stream = null }
}

function hangUp() { ended = true; stopPlay(); stopMic(); send({ t: 'stop' }); if (ws) { try { ws.close() } catch (e) {} } setState('raccroché', 'out') }

el('start').addEventListener('click', function () { startMic().catch(function (e) { say('micro : ' + e.message) }) });
el('mute').addEventListener('click', function () {
  muted = !muted; this.textContent = muted ? 'Parler' : 'Muet';
  send({ t: 'mute', muted: muted }); setState(muted ? 'micro coupé' : 'à l’écoute', muted ? 'warn' : 'on');
});
el('hangup').addEventListener('click', hangUp);
document.addEventListener('keydown', function (e) {
  if (e.key === ' ' && speaking && !ended) { e.preventDefault(); stopPlay(); send({ t: 'flush' }); say('Interrompu.') }
  if (e.key === 'm' && !ended) el('mute').click();
  if (e.key === 'Escape' && !ended) hangUp();
});
window.addEventListener('pagehide', function () { if (ws) { try { ws.close() } catch (e) {} } });
connect(token());
</script>
</body>
</html>
`;
