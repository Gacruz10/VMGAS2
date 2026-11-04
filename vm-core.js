/* ============================================================
   VMGAS2 · núcleo común de tema y sesión
   - Un solo tema persistente: localStorage.vm_theme
   - Token cacheado en sessionStorage (no se consulta Firebase
     en cada ingreso); se revalida cada 10 minutos o al vencer.
   - Timeout único de 20 minutos de inactividad -> inicio.html
   ============================================================ */
(function () {
  'use strict';

  var THEME_KEY = 'vm_theme';
  var TOKEN_CACHE_KEY = 'vm_token_cache_v1';
  var USER_CACHE_KEY = 'vm_user_cache_v1';
  var ACTIVITY_KEY = 'vm_last_activity';
  var TIMEOUT_MS = 20 * 60 * 1000;       // permanencia máxima sin actividad
  var RECHECK_MS = 10 * 60 * 1000;       // revalidar token online cada 10 min
  var USER_RECHECK_MS = 30 * 60 * 1000;  // permisos: revalidar cada 30 min
  var FS_KEY = 'AIzaSyCesmFFsn7LvgmcFMWFfi6F5_Zvco79ucM';
  var FS_PROJECT = 'vmgaslr';

  // ---------- almacenamiento seguro ----------
  function sget(key) {
    try { return sessionStorage.getItem(key); } catch (e) { return null; }
  }
  function sset(key, value) {
    try { sessionStorage.setItem(key, value); } catch (e) {}
  }
  function sdel(key) {
    try { sessionStorage.removeItem(key); } catch (e) {}
  }
  function lget(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function lset(key, value) {
    try { localStorage.setItem(key, value); } catch (e) {}
  }
  function readJSON(storageGet, key) {
    try {
      var raw = storageGet(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  // ---------- tema ----------
  function temaGuardado() {
    var t = lget(THEME_KEY);
    if (t !== 'light' && t !== 'dark') {
      t = 'light';
      lset(THEME_KEY, t);
    }
    return t;
  }
  function esOscuro() { return temaGuardado() === 'dark'; }

  function aplicarTema() {
    var dark = esOscuro();
    var body = document.body;
    if (body) {
      // Se usan las tres clases para convivir con todas las pantallas:
      // light-mode (mayoría), tema-claro (index4) y dark (treeview).
      body.classList.toggle('dark', dark);
      body.classList.toggle('light-mode', !dark);
      body.classList.toggle('tema-claro', !dark);
    }
    var btn = document.getElementById('btnTheme');
    if (btn) btn.textContent = dark ? '🌙' : '☀️';
    var btnTema = document.getElementById('btnTema');
    if (btnTema) btnTema.textContent = dark ? '☀️ Claro' : '🌙 Oscuro';
  }

  function alternarTema() {
    lset(THEME_KEY, esOscuro() ? 'light' : 'dark');
    aplicarTema();
  }

  // ---------- Firestore REST (solo lectura de token/usuario) ----------
  function decodificarValor(v) {
    if (!v || typeof v !== 'object') return v;
    if ('stringValue' in v) return v.stringValue;
    if ('integerValue' in v) return Number(v.integerValue);
    if ('doubleValue' in v) return Number(v.doubleValue);
    if ('booleanValue' in v) return !!v.booleanValue;
    if ('nullValue' in v) return null;
    if ('timestampValue' in v) return v.timestampValue;
    if ('mapValue' in v) {
      var mapOut = {};
      var mf = (v.mapValue && v.mapValue.fields) || {};
      Object.keys(mf).forEach(function (k) { mapOut[k] = decodificarValor(mf[k]); });
      return mapOut;
    }
    if ('arrayValue' in v) {
      var arr = (v.arrayValue && v.arrayValue.values) || [];
      return arr.map(decodificarValor);
    }
    return v;
  }

  function decodificarDoc(doc) {
    var out = {};
    var fields = (doc && doc.fields) || {};
    Object.keys(fields).forEach(function (k) { out[k] = decodificarValor(fields[k]); });
    return out;
  }

  async function fsGet(path) {
    var url = 'https://firestore.googleapis.com/v1/projects/' + FS_PROJECT +
      '/databases/(default)/documents/' + path + '?key=' + FS_KEY;
    var res = await fetch(url, { cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('Firestore ' + res.status);
    return decodificarDoc(await res.json());
  }

  function tokenVigente(data) {
    return !!data && (!data.expira || Number(data.expira) > Date.now());
  }

  function leerTokenCache() {
    var cache = readJSON(sget, TOKEN_CACHE_KEY);
    if (!cache || !cache.token || !cache.data) return null;
    return cache;
  }

  /**
   * Devuelve los datos del token sin ir a Firebase si la copia local
   * sigue vigente. Si no hay copia o pasaron 10 minutos, revalida.
   * Ante un corte de red usa la copia local aún vigente.
   */
  async function validarToken(k, opciones) {
    k = String(k || '').trim();
    if (!k) return null;
    var opts = opciones || {};
    var ttl = Number(opts.recheckMs) || RECHECK_MS;
    var ahora = Date.now();
    var cache = leerTokenCache();

    if (cache && cache.token === k && tokenVigente(cache.data) &&
        (ahora - Number(cache.checkedAt || 0)) < ttl) {
      if (cache.data.usuario) sset('usuarioActivo', String(cache.data.usuario));
      return cache.data;
    }

    try {
      var data = await fsGet('tokens/' + encodeURIComponent(k));
      if (!tokenVigente(data)) {
        sdel(TOKEN_CACHE_KEY);
        return null;
      }
      sset(TOKEN_CACHE_KEY, JSON.stringify({ token: k, data: data, checkedAt: ahora }));
      if (data.usuario) sset('usuarioActivo', String(data.usuario));
      return data;
    } catch (e) {
      if (cache && cache.token === k && tokenVigente(cache.data)) return cache.data;
      throw e;
    }
  }

  /** Datos del usuario (permisos) cacheados por sesión. */
  async function usuario(usuarioId, opciones) {
    usuarioId = String(usuarioId || '').trim();
    if (!usuarioId) return null;
    var opts = opciones || {};
    var ttl = Number(opts.recheckMs) || USER_RECHECK_MS;
    var ahora = Date.now();
    var cache = readJSON(sget, USER_CACHE_KEY);

    if (cache && cache.usuario === usuarioId && cache.data &&
        (ahora - Number(cache.checkedAt || 0)) < ttl) {
      return cache.data;
    }

    try {
      var data = await fsGet('usuarios/' + encodeURIComponent(usuarioId));
      if (!data) return null;
      sset(USER_CACHE_KEY, JSON.stringify({ usuario: usuarioId, data: data, checkedAt: ahora }));
      return data;
    } catch (e) {
      if (cache && cache.usuario === usuarioId && cache.data) return cache.data;
      throw e;
    }
  }

  // ---------- token / navegación ----------
  function tokenActual() {
    var params = new URLSearchParams(window.location.search);
    var k = params.get('k') || params.get('token') ||
      sget('vm_token') || sget('k') || '';
    k = String(k || '').trim();
    if (k) {
      sset('vm_token', k);
      sset('k', k);
    }
    return k;
  }

  function limpiarUrl() {
    if (window.history && window.history.replaceState) {
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }

  function irInicio(k) {
    k = String(k || tokenActual() || '').trim();
    window.location.href = 'inicio.html' + (k ? '?k=' + encodeURIComponent(k) : '');
  }

  function expulsar() {
    try { sessionStorage.clear(); } catch (e) {}
    window.location.replace('index.html');
  }

  // ---------- timeout de 20 minutos ----------
  var timerId = null;
  var listenersInstalados = false;
  var timeoutActual = TIMEOUT_MS;
  var tokenActualTimeout = '';

  function marcarActividad() {
    sset(ACTIVITY_KEY, String(Date.now()));
  }

  function expirarSesion() {
    if (timerId) { clearInterval(timerId); timerId = null; }
    marcarActividad(); // que inicio.html arranque con 20 minutos nuevos
    sset('vm_session_expired', '1');
    var k = tokenActualTimeout || tokenActual();
    var destino = 'inicio.html' + (k ? '?k=' + encodeURIComponent(k) : '');
    window.location.replace(destino);
  }

  function iniciarSesion(k, opciones) {
    var opts = opciones || {};
    timeoutActual = Number(opts.timeoutMs) || TIMEOUT_MS;
    tokenActualTimeout = String(k || '').trim();
    var ahora = Date.now();
    var ultima = Number(sget(ACTIVITY_KEY)) || 0;

    // Si la pestaña estuvo quieta más de 20 minutos, no se permite seguir.
    if (ultima && (ahora - ultima) >= timeoutActual) {
      expirarSesion();
      return;
    }
    if (!ultima) marcarActividad();

    if (!listenersInstalados) {
      ['click', 'mousedown', 'keydown', 'touchstart', 'scroll'].forEach(function (evt) {
        document.addEventListener(evt, marcarActividad, { passive: true });
      });
      // mousemove se limita para no escribir en storage en cada píxel
      var ultimoMouse = 0;
      document.addEventListener('mousemove', function () {
        var t = Date.now();
        if (t - ultimoMouse >= 1000) { ultimoMouse = t; marcarActividad(); }
      }, { passive: true });
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') {
          var last = Number(sget(ACTIVITY_KEY)) || 0;
          if (last && (Date.now() - last) >= timeoutActual) expirarSesion();
        }
      });
      listenersInstalados = true;
    }

    if (timerId) clearInterval(timerId);
    timerId = setInterval(function () {
      var last = Number(sget(ACTIVITY_KEY)) || 0;
      if (last && (Date.now() - last) >= timeoutActual) expirarSesion();
    }, 15000);
  }

  // ---------- API pública ----------
  window.VM = {
    // tema
    tema: temaGuardado,
    esOscuro: esOscuro,
    aplicarTema: aplicarTema,
    alternarTema: alternarTema,
    // sesión
    tokenActual: tokenActual,
    validarToken: validarToken,
    usuario: usuario,
    iniciarSesion: iniciarSesion,
    irInicio: irInicio,
    expulsar: expulsar,
    limpiarUrl: limpiarUrl,
    TIMEOUT_MS: TIMEOUT_MS
  };

  // compatibilidad con los onclick="toggleTheme()" / "toggleTema()"
  window.toggleTheme = alternarTema;
  window.toggleTema = alternarTema;

  // Aplicar el tema apenas exista el body y refrescar el icono.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', aplicarTema);
  } else {
    aplicarTema();
  }
})();
