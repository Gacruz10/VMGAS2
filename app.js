import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getFirestore, doc, getDoc, collection, getDocs, query, where, writeBatch, increment, runTransaction, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyCesmFFsn7LvgmcFMWFfi6F5_Zvco79ucM",
    authDomain: "vmgaslr.firebaseapp.com",
    projectId: "vmgaslr",
    storageBucket: "vmgaslr.firebasestorage.app",
    messagingSenderId: "75859850089",
    appId: "1:75859850089:web:fc551c770bbf4ae25803f8",
    measurementId: "G-RJCWWBMBFF"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzi1x000HsPSQsWgz65jYWDWZI3cNQoKhoU5XCKagYcqs4en-d1YzO2sbnmzWlLIa9Vvw/exec";
const params = new URLSearchParams(window.location.search);
const k = VM.tokenActual();

if (!k) VM.expulsar();
if (window.history.replaceState) window.history.replaceState({}, document.title, window.location.pathname);

window.addEventListener('online', function () {
    actualizarIndicadorOffline();
    sincronizarCola();
});
window.addEventListener('pageshow', function () {
    actualizarIndicadorOffline();
    if (navigator.onLine) sincronizarCola();
});

let clientesData = []; let preciosData = []; let zonasActivas = []; let clienteSeleccionado = null;
let comisionesData = { "10": [], "15": [], "45": [] };
let idClienteSeleccionado = '';
let deudasData = {};
let mediaRecorder = null;
let audioChunks = [];
let audioBase64 = null;
let recordingTimer = null;
let recSeconds = 0;
let isSyncing = false;

// Nota de voz desactivada por ahora. Para restaurarla: cambiar a true.
const AUDIO_HABILITADO = false;

// Evita que un pago supere lo que falta cobrar (venta normal / consignación)
function limitarPagoAlTotal(inputId) {
    if (document.getElementById('pagoDeuda').checked) return;
    const objetivo = Number(window.__objetivoCaja) || 0;
    if (objetivo <= 0) return;
    const esEfec = inputId === 'montoEfectivo';
    const otroId = esEfec ? 'montoTransferencia' : 'montoEfectivo';
    const otroChk = esEfec ? 'pagoTransferencia' : 'pagoEfectivo';
    const otro = document.getElementById(otroChk).checked ? parseM(otroId) : 0;
    const maximo = Math.max(0, objetivo - otro);
    if (parseM(inputId) > maximo) {
        document.getElementById(inputId).value = maximo ? maximo.toLocaleString('es-AR') : '';
        showToast(`Ajustado: solo quedaban $${maximo.toLocaleString('es-AR')} por cobrar.`, 'warning');
    }
}

function autocompletarFaltante() {
    const el = document.getElementById('pagoEstado');
    if (!el.classList.contains('clickable')) return;

    const faltante = Number(el.dataset.faltante);
    if (!faltante || faltante <= 0) return;

    const chkEfectivo = document.getElementById('pagoEfectivo');
    const chkTransferencia = document.getElementById('pagoTransferencia');
    const inputEfectivo = document.getElementById('montoEfectivo');
    const inputTransferencia = document.getElementById('montoTransferencia');

    let valEfec = parseM('montoEfectivo');
    let valTransf = parseM('montoTransferencia');

    if (chkEfectivo.checked && valEfec === 0 && (!chkTransferencia.checked || valTransf > 0)) {
        inputEfectivo.value = faltante.toLocaleString('es-AR');
    } else if (chkTransferencia.checked && valTransf === 0 && (!chkEfectivo.checked || valEfec > 0)) {
        inputTransferencia.value = faltante.toLocaleString('es-AR');
    } else if (chkEfectivo.checked && valEfec === 0 && chkTransferencia.checked && valTransf === 0) {
        inputEfectivo.value = faltante.toLocaleString('es-AR');
    }
    actualizarTotales();
}

function round2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
}

// Identidad estable para agrupar ventas/comisiones de un mismo chofer,
// aunque el nombre venga con mayúsculas, acentos o puntos.
function claveChofer(valor) {
    return String(valor || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[.,]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Valor de la venta (gas + envases), no lo que el cliente pagó.
// Se usa para mostrar la venta en Control de Comisiones.
function totalVentaDeMovimiento(data) {
    let total = 0;
    try {
        const arr = Array.isArray(data.garrafas) ? data.garrafas : JSON.parse(data.garrafas || '[]');
        if (Array.isArray(arr)) {
            arr.forEach(g => {
                total += (Number(g?.cantidad) || 0) * (Number(g?.precio) || 0);
            });
        }
    } catch (e) { /* datos viejos o JSON inválido */ }

    if (String(data.operacionEnvase || '').toLowerCase() === 'venta') {
        total += (Number(data['CE10$']) || 0) + (Number(data['CE15$']) || 0) + (Number(data['CE45$']) || 0);
    }
    if (total <= 0) total = Number(data.TOTAL) || 0;
    return round2(total);
}

function normalizarRangoComision(r, tipo) {
    const min = Number(r?.min ?? r?.MIN ?? r?.RANGO_MENOR ?? r?.rango_menor);
    const max = Number(r?.max ?? r?.MAX ?? r?.RANGO_MAYOR ?? r?.rango_mayor);
    const com = Number(r?.com ?? r?.COM ?? r?.[`COMISION_${tipo}`] ?? r?.[`comision_${tipo}`]);
    return {
        min: Number.isFinite(min) ? min : 0,
        max: Number.isFinite(max) ? max : 999999999,
        com: Number.isFinite(com) && com >= 0 ? com : 0
    };
}

function normalizarComisiones(raw) {
    const out = { "10": [], "15": [], "45": [] };
    if (!raw) return out;
    if (Array.isArray(raw)) raw = { comisiones: raw };

    // Formato ya normalizado en memoria: { "10": [...], "15": [...], "45": [...] }
    if (Array.isArray(raw["10"]) || Array.isArray(raw["15"]) || Array.isArray(raw["45"])) {
        ["10", "15", "45"].forEach(t => {
            out[t] = (Array.isArray(raw[t]) ? raw[t] : []).map(r => normalizarRangoComision(r, t));
        });
        return out;
    }

    // Formato Firestore actual: comisiones_10 / comisiones_15 / comisiones_45
    let encontrado = false;
    ["10", "15", "45"].forEach(t => {
        const arr = raw[`comisiones_${t}`] ?? raw[`COMISIONES_${t}`] ?? raw[`comisiones${t}`];
        if (Array.isArray(arr)) {
            out[t] = arr.map(r => normalizarRangoComision(r, t));
            encontrado = true;
        }
    });
    if (encontrado) return out;

    // Formato legacy: comisiones: [{ RANGO_MENOR, RANGO_MAYOR, COMISION_10, ... }]
    if (Array.isArray(raw.comisiones)) {
        ["10", "15", "45"].forEach(t => {
            out[t] = raw.comisiones
                .map(r => normalizarRangoComision(r, t))
                .filter(r => r.com > 0);
        });
    }
    return out;
}

function getComisionPorRango(precioUnitario, tipoStr) {
    const tipo = String(tipoStr || "");
    const arr = comisionesData[tipo] || [];
    const p = Number(precioUnitario) || 0;
    const matches = arr.filter(r => p >= r.min && p <= r.max);
    if (!matches.length) return 0;
    // Si dos escalas se tocan en el límite, gana la de rango inferior más alto.
    matches.sort((a, b) => (a.min - b.min) || (a.max - b.max));
    return Number(matches[matches.length - 1].com) || 0;
}

function calcularComision(garrafas, esRetiroPlanta) {
    if (esRetiroPlanta) return { total: 0, detalle: [] };

    const detalle = [];
    let total = 0;
    (Array.isArray(garrafas) ? garrafas : []).forEach(g => {
        const tipo = String(g?.tipo ?? "");
        const cantidad = Number(g?.cantidad) || 0;
        const precio = Number(g?.precio) || 0;
        if (cantidad <= 0) return;

        const comUnit = getComisionPorRango(precio, tipo);
        if (comUnit <= 0) return;

        const subtotal = round2(cantidad * comUnit);
        detalle.push({ tipo, cantidad, precio, comUnit, subtotal });
        total += subtotal;
    });
    return { total: round2(total), detalle };
}

function esAcuerdoVigente(fechaStr) {
    if (!fechaStr) return false;
    try {
        let d;
        if (fechaStr.includes('-')) {
            let p = fechaStr.split('-');
            d = new Date(p[0], p[1] - 1, p[2]);
        } else if (fechaStr.includes('/')) {
            let p = fechaStr.split('/');
            d = new Date(p[2], p[1] - 1, p[0]);
        } else { return false; }

        let hoy = new Date();
        hoy.setHours(0, 0, 0, 0);
        return d >= hoy;
    } catch (e) { return false; }
}

function startTimer() {
    const timerDisplay = document.getElementById('timerDisplay');

    const verificarTiempo = () => {
        const limite = (window.VM && VM.TIMEOUT_MS) ? VM.TIMEOUT_MS : 20 * 60 * 1000;
        const ultima = Number(sessionStorage.getItem('vm_last_activity')) || Date.now();
        const timeLeft = Math.max(0, Math.floor((limite - (Date.now() - ultima)) / 1000));

        if (timerDisplay) {
            const m = Math.floor(timeLeft / 60).toString().padStart(2, '0');
            const s = (timeLeft % 60).toString().padStart(2, '0');
            timerDisplay.textContent = `${m}:${s}`;
        }
    };

    setInterval(verificarTiempo, 1000);
    verificarTiempo();

    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
            verificarTiempo();
        }
    });
}

function obtenerUbicacionFantasma() {
    return new Promise((resolve) => {
        if (!navigator.geolocation) {
            resolve("SIN_GPS_NO_SOPORTADO");
            return;
        }

        const timeoutGPS = setTimeout(() => {
            resolve("SIN_GPS_TIMEOUT_FORZADO");
        }, 15000);

        navigator.geolocation.getCurrentPosition(
            (position) => {
                clearTimeout(timeoutGPS);
                const lat = position.coords.latitude;
                const lon = position.coords.longitude;
                resolve(`${lat},${lon}`);
            },
            (error) => {
                clearTimeout(timeoutGPS);
                let motivo = "SIN_GPS_DESCONOCIDO";
                if (error.code === 1) motivo = "SIN_GPS_DENEGADO";
                if (error.code === 2) motivo = "SIN_GPS_SIN_SEÑAL";
                if (error.code === 3) motivo = "SIN_GPS_TIMEOUT_API";
                resolve(motivo);
            },
            {
                enableHighAccuracy: true,
                timeout: 10000,
                maximumAge: 30000
            }
        );
    });
}

async function calentarGPS() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
        () => { },
        () => { },
        { enableHighAccuracy: true, maximumAge: 30000, timeout: 5000 }
    );
}

// La actividad la registra VM.iniciarSesion (timeout de 20 minutos).
// Se mantiene esta función sin efecto para no romper referencias históricas.

const pad = (n) => n.toString().padStart(2, '0');
function generarID() { const d = new Date(); return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + Math.floor(100 + Math.random() * 900); }

function showToast(msg, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div'); toast.className = `toast ${type}`; toast.textContent = msg; container.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 3500);
}

let guardandoUI = false;

function updateLoader(title, sub) {
    if (guardandoUI) {
        const t = document.getElementById('ssTitle'), st = document.getElementById('ssSub');
        if (t) t.textContent = title;
        if (st) st.textContent = sub;
        return;
    }
    document.getElementById('txtLoading').textContent = title;
    document.getElementById('txtSubLoading').textContent = sub;
}

function setEstadoGuardado(estado, titulo, sub) {
    const pill = document.getElementById('saveStatus');
    if (!pill) return;
    pill.className = `save-status show ss-${estado}`;
    const icon = document.getElementById('ssIcon');
    icon.className = 'ss-icon';
    if (estado === 'yellow') {
        if (!icon.querySelector('.ss-spinner')) icon.innerHTML = '<div class="ss-spinner"></div>';
    } else {
        icon.innerHTML = estado === 'green' ? '✓' : '✕';
        icon.classList.add('pop');
    }
    document.getElementById('ssTitle').textContent = titulo;
    document.getElementById('ssSub').textContent = sub;
}

function colapsarFormulario() {
    const f = document.getElementById('formContainer');
    f.style.maxHeight = f.offsetHeight + 'px';
    void f.offsetHeight;
    f.classList.add('collapsed');
    f.style.maxHeight = '0px';
}

function expandirFormulario() {
    const f = document.getElementById('formContainer');
    f.classList.remove('collapsed');
    f.style.maxHeight = f.scrollHeight + 'px';
    setTimeout(() => { f.style.maxHeight = ''; }, 450);
}

function mostrarLoaderGuardando(titulo, subtitulo) {
    guardandoUI = true;
    setEstadoGuardado('yellow', titulo, subtitulo);
    colapsarFormulario();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function mostrarExito(mensaje, titulo = "¡REGISTRO EXITOSO!") {
    guardandoUI = true;
    setEstadoGuardado('green', titulo, mensaje);
}

function mostrarError(mensaje, titulo = "ERROR AL GUARDAR") {
    guardandoUI = true;
    setEstadoGuardado('red', titulo, mensaje);
}

window.cerrarLoaderError = function() {
    guardandoUI = false;
    document.getElementById('saveStatus').classList.remove('show');
    expandirFormulario();
    actualizarTotales();
};

async function init() {
    try {
        updateLoader("VERIFICANDO SESIÓN", "Comprobando credenciales...");
        document.body.style.opacity = 1;

        if (navigator.onLine) {
            const tokenData = await VM.validarToken(k);
            if (!tokenData) {
                showToast("Token inválido o expirado", "error");
                setTimeout(() => VM.expulsar(), 1500);
                return;
            }
            window.idUsuarioFirebase = tokenData.usuario;
            window.nombreUsuarioMostrar = tokenData.nombre_mostrar || window.idUsuarioFirebase;
            localStorage.setItem('vm_usuario_id', window.idUsuarioFirebase);
            localStorage.setItem('vm_usuario_nombre', window.nombreUsuarioMostrar);

            const segSnap = await getDoc(doc(db, "seguridad", "pin"));
            if (segSnap.exists()) {
                window.pinDinamicoFirebase = segSnap.data().dinamico?.toString();
            }
        } else {
            window.idUsuarioFirebase = localStorage.getItem('vm_usuario_id') || 'OFFLINE';
            window.nombreUsuarioMostrar = localStorage.getItem('vm_usuario_nombre') || 'MODO OFFLINE';
        }

        VM.iniciarSesion(k);
        document.getElementById('welcomeMessage').textContent = `Usuario: ${window.nombreUsuarioMostrar.toUpperCase()}`;
        startTimer();
        actualizarIndicadorOffline();
        iniciarSyncAutomatico();

        calentarGPS();
        await cargarDatos();
        if (AUDIO_HABILITADO) iniciarManejadorAudio();
        else { const bx = document.querySelector('.audio-recorder-box'); if (bx) bx.style.display = 'none'; }
        aplicarAutoFoco();

        sugerirClientesCercanos();

    } catch (e) { 
        console.error("Init Error", e);
        VM.expulsar();
    }
}

async function cargarDatos() {
    try {
        let descargoOk = false;

        if (navigator.onLine) {
            try {
                updateLoader("SINCRONIZANDO DB", "Verificando versión de datos...");
                
                // version_datos (seguridad/pin): si coincide con la copia local,
                // clientes se toma de memoria y no se descarga la colección.
                const snapPin = await getDoc(doc(db, "seguridad", "pin"));
                const verServidor = snapPin.exists() ? Number(snapPin.data().version_datos || 0) : 0;

                let copia = null;
                try { copia = JSON.parse(localStorage.getItem('vm_paquete_offline') || 'null'); } catch (e) { copia = null; }
                const cacheValido = !!copia && Array.isArray(copia.clientes) && copia.clientes.length > 0
                    && Number(copia.version_datos) === verServidor;

                if (cacheValido) {
                    updateLoader("SINCRONIZANDO DB", "Lista de clientes al día (memoria)...");
                    clientesData = copia.clientes;
                } else {
                    updateLoader("SINCRONIZANDO DB", "Descargando clientes de Firebase...");
                    const snapCli = await getDocs(collection(db, "clientes"));
                    clientesData = snapCli.docs.map(d => ({ id_cliente: d.id, ...d.data() }));
                }

                const snapPrecios = await getDocs(collection(db, "precios"));
                preciosData = snapPrecios.docs.map(d => d.data());

                const snapParam = await getDoc(doc(db, "configuracion", "parametros"));
                if (snapParam.exists()) {
                    comisionesData = normalizarComisiones(snapParam.data());
                }

                deudasData = {};
                clientesData.forEach(c => {
                    deudasData[c.id_cliente] = {
                        env10: c.env10 || 0, env15: c.env15 || 0, env45: c.env45 || 0,
                        plata: c.plata || 0,
                        flotante10: c.flotante10 || 0, flotante15: c.flotante15 || 0, flotante45: c.flotante45 || 0
                    };
                });

                zonasActivas = [...new Set(clientesData.map(c => c.zona).filter(Boolean))];

                const paqueteOffline = {
                    zonas: zonasActivas,
                    clientes: clientesData,
                    precios: preciosData,
                    deudas: deudasData,
                    comisiones: comisionesData,
                    version_datos: verServidor
                };

                localStorage.setItem('vm_paquete_offline', JSON.stringify(paqueteOffline));
                descargoOk = true;
            } catch (fetchError) {
                console.warn("⚠️ Falló descarga de Firebase. Pasando a offline.", fetchError);
                descargoOk = false; 
            }
        }

        if (!navigator.onLine || !descargoOk) {
            const cache = localStorage.getItem('vm_paquete_offline');
            if (cache) {
                const paquete = JSON.parse(cache);
                zonasActivas = paquete.zonas || [];
                clientesData = paquete.clientes || [];
                preciosData = paquete.precios || [];
                deudasData = paquete.deudas || {};
                comisionesData = normalizarComisiones(paquete.comisiones);
                showToast('Modo Offline: Usando datos en memoria', 'warning');
            } else {
                throw new Error("El paquete offline no existe o está corrupto");
            }
        }

        const selZona = document.getElementById('zona');
        selZona.innerHTML = '<option value="">Zona...</option>';
        zonasActivas.forEach(z => {
            const opt = document.createElement('option'); opt.value = z; opt.textContent = z; selZona.appendChild(opt);
        });

        const selNuevaZona = document.getElementById('nuevaZona');
        selNuevaZona.innerHTML = '<option value="">Seleccione Zona (Obligatorio)...</option>';
        zonasActivas.forEach(z => {
            const opt = document.createElement('option'); opt.value = z; opt.textContent = z; selNuevaZona.appendChild(opt);
        });

        const selCat = document.getElementById('categoria');
        selCat.innerHTML = '<option value="">Seleccione Categoría (Obligatorio)...</option>';
        const categoriasUnicas = [...new Set(preciosData.map(p => p.categoria ? p.categoria.trim().toUpperCase() : ''))].filter(c => c !== '');
        categoriasUnicas.forEach(c => {
            const opt = document.createElement('option'); opt.value = c; opt.textContent = c; selCat.appendChild(opt);
        });

        cerrarLoader();
    } catch (e) {
        cerrarLoader();
        console.error("Fallo crítico en cargarDatos:", e);
        showToast('Error cargando datos. Verifica tu conexión inicial.', 'error');
    }
}

function cerrarLoader() {
    const overlay = document.getElementById('loadingOverlay'); overlay.style.opacity = '0';
    setTimeout(() => { overlay.style.visibility = 'hidden'; overlay.style.display = 'none'; document.getElementById('formContainer').classList.remove('is-loading'); }, 150);
}

function aplicarAutoFoco() {
    document.querySelectorAll('input').forEach(input => {
        input.addEventListener('focus', function () {
            setTimeout(() => {
                try {
                    this.select();
                    this.setSelectionRange(0, 9999);
                } catch (e) { }
            }, 50);
        });
    });
}

function iniciarManejadorAudio() {
    const btnMic = document.getElementById('btnMic');
    const audioStatus = document.getElementById('audioStatus');
    const audioPlaybackContainer = document.getElementById('audioPlaybackContainer');
    const audioPlayback = document.getElementById('audioPlayback');
    const btnDeleteAudio = document.getElementById('btnDeleteAudio');

    btnMic.addEventListener('click', async () => {
        if (!mediaRecorder || mediaRecorder.state === 'inactive') {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                mediaRecorder = new MediaRecorder(stream);
                audioChunks = [];
                audioBase64 = null;

                mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
                mediaRecorder.onstop = () => {
                    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                    const reader = new FileReader();
                    reader.readAsDataURL(audioBlob);
                    reader.onloadend = () => {
                        audioBase64 = reader.result;
                        audioPlayback.src = URL.createObjectURL(audioBlob);
                        audioPlaybackContainer.style.display = 'flex';
                        btnMic.style.display = 'none';
                    };
                    stream.getTracks().forEach(track => track.stop());
                };

                mediaRecorder.start();
                btnMic.style.background = 'var(--error)';
                btnMic.style.borderColor = 'var(--error)';
                btnMic.innerHTML = '⏹️';
                btnMic.classList.add('recording-pulse');

                recSeconds = 120;
                audioStatus.innerHTML = `<span style="color:var(--error); font-weight:bold;">Grabando... 02:00</span>`;
                recordingTimer = setInterval(() => {
                    recSeconds--;
                    let m = Math.floor(recSeconds / 60).toString().padStart(2, '0');
                    let s = (recSeconds % 60).toString().padStart(2, '0');
                    audioStatus.innerHTML = `<span style="color:var(--error); font-weight:bold;">Grabando... ${m}:${s}</span>`;
                    if (recSeconds <= 0) btnMic.click();
                }, 1000);

            } catch (err) {
                showToast("⚠️ No se pudo acceder al micrófono.", "error");
            }
        } else if (mediaRecorder.state === 'recording') {
            mediaRecorder.stop();
            clearInterval(recordingTimer);
            btnMic.style.background = 'var(--input-bg)';
            btnMic.style.borderColor = 'var(--accent)';
            btnMic.innerHTML = '🎙️';
            btnMic.classList.remove('recording-pulse');
            audioStatus.innerHTML = `<span style="color:var(--success); font-weight:bold;">Audio capturado</span>`;
        }
    });

    btnDeleteAudio.addEventListener('click', () => {
        audioBase64 = null;
        audioChunks = [];
        audioPlayback.src = "";
        audioPlaybackContainer.style.display = 'none';
        btnMic.style.display = 'flex';
        audioStatus.innerHTML = `Listo para grabar<br><small>(Máx 2 minutos)</small>`;
    });
}

function checkVisibilidadCascada() {
    const hasClient = document.getElementById('cliente').value !== "";
    const isNew = document.getElementById('nuevoCliente').checked;
    const isGasto = document.getElementById('declaracionGastos').checked;
    document.getElementById('seccionesOperativas').style.display = (hasClient || isNew || isGasto) ? 'block' : 'none';
}

document.getElementById('nombreCliente').addEventListener('blur', function () {
    const val = this.value.trim().toLowerCase(); if (!val) return;
    if (clientesData.some(c => c.nombre.toLowerCase() === val)) showToast('⚠️ ATENCIÓN: Ya existe un cliente con este nombre en la base.', 'warning');
});

function pedirPinSiCorresponde(checkbox, inputId) {
    const input = document.getElementById(inputId);
    verificarSiNecesitaPin();
    if (checkbox.checked) {
        input.removeAttribute('readonly');
        setTimeout(() => {
            input.focus();
            input.select();
        }, 150);
    }
    else {
        input.setAttribute('readonly', true);
        actualizarPreciosAutomaticos();
    }
}

function togglePreciosEnvasesManuales(checkbox) {
    const inputs = ['precioVentaEnv10', 'precioVentaEnv15', 'precioVentaEnv45'];
    verificarSiNecesitaPin();
    inputs.forEach(id => {
        const input = document.getElementById(id);
        if (checkbox.checked) { input.removeAttribute('readonly'); }
        else { input.setAttribute('readonly', true); }
    });
    if (checkbox.checked) {
        setTimeout(() => { document.getElementById('precioVentaEnv10').focus(); }, 150);
    } else {
        actualizarPreciosAutomaticos();
    }
}

function verificarSiNecesitaPin() {
    const necesita = document.getElementById('manualPriceCheck1').checked || document.getElementById('manualPriceCheck2').checked || document.getElementById('manualPriceCheck3').checked || document.getElementById('precioAutorizadoCheck').checked || document.getElementById('ventaEnvases').checked || document.getElementById('declaracionGastos').checked;
    const container = document.getElementById('globalPinContainer'); const pinInput = document.getElementById('globalPinInput');
    if (necesita) { container.style.display = 'block'; pinInput.setAttribute('required', 'true'); }
    else { container.style.display = 'none'; pinInput.value = ''; pinInput.removeAttribute('required'); }
}

function normalizarTexto(texto) {
    return texto ? texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim() : '';
}

function coincidenciaFlexible(nombre, busqueda) {
    const nomNorm = normalizarTexto(nombre);
    const busqNorm = normalizarTexto(busqueda);
    if (nomNorm.includes(busqNorm)) return true;

    const terminos = busqNorm.split(' ').filter(t => t.length > 0);
    return terminos.every(t => nomNorm.includes(t));
}

function calcularDistancia(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

async function sugerirClientesCercanos() {
    let contChips = document.getElementById('sugerenciasGPSContainer');
    if (!contChips) return; 

    contChips.innerHTML = ''; 

    const ubiActual = await obtenerUbicacionFantasma();
    if (ubiActual.includes("SIN_GPS")) {
        contChips.style.display = 'none';
        return;
    }

    const [latAct, lonAct] = ubiActual.split(',').map(Number);

    let clientesConDistancia = clientesData.filter(c => {
        let ubi = c.ubicacion || c.coordenadas || c.UBICACION;
        return ubi && ubi.includes(',');
    }).map(c => {
        let ubi = c.ubicacion || c.coordenadas || c.UBICACION;
        const [lat, lon] = ubi.split(',').map(Number);
        const dist = calcularDistancia(latAct, lonAct, lat, lon);
        return { ...c, distancia: dist };
    });

    clientesConDistancia.sort((a, b) => a.distancia - b.distancia);
    const top3 = clientesConDistancia.slice(0, 3);

    if (top3.length > 0) {
        contChips.innerHTML = '<div style="width:100%; text-align:center; color:var(--text-muted); font-size:11px; margin-bottom:5px; font-weight:bold;">📍 CLIENTES CERCA TUYO</div>';
        top3.forEach(c => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'gps-chip';
            btn.innerHTML = `📍 ${c.nombre.slice(0, 18)}${c.nombre.length > 18 ? '...' : ''} (${(c.distancia * 1000).toFixed(0)}m)`;
            btn.onclick = () => seleccionarClienteDesdeBusqueda(c);
            contChips.appendChild(btn);
        });
        contChips.style.display = 'flex';
    } else {
        contChips.style.display = 'none';
    }
}

const buscador = document.getElementById('buscadorGlobal');
const resultadosBox = document.getElementById('resultadosBusqueda');

buscador.addEventListener('input', function () {
    const txt = this.value.trim();
    resultadosBox.innerHTML = '';
    if (txt.length < 2) { resultadosBox.style.display = 'none'; return; }

    const match = clientesData.filter(c => coincidenciaFlexible(c.nombre, txt)).slice(0, 8);

    if (match.length > 0) {
        resultadosBox.style.display = 'block';
        match.forEach(c => {
            const div = document.createElement('div'); div.className = 'result-item';
            div.innerHTML = `<span class="r-name">${c.nombre}</span><span class="r-detail">${c.zona} - ${c.categoria}</span>`;
            div.onclick = () => seleccionarClienteDesdeBusqueda(c); resultadosBox.appendChild(div);
        });
    } else { resultadosBox.style.display = 'none'; }
});

function seleccionarClienteDesdeBusqueda(c) {
    const selZona = document.getElementById('zona'); selZona.value = c.zona; selZona.dispatchEvent(new Event('change'));
    const selCliente = document.getElementById('cliente');
    for (let i = 0; i < selCliente.options.length; i++) { try { const optObj = JSON.parse(selCliente.options[i].value); if (optObj.nombre === c.nombre) { selCliente.selectedIndex = i; break; } } catch (e) { } }

    idClienteSeleccionado = c.id_cliente || '';
    selCliente.dispatchEvent(new Event('change')); buscador.value = ''; resultadosBox.style.display = 'none';
}
document.addEventListener('click', (e) => { if (!buscador.contains(e.target)) resultadosBox.style.display = 'none'; });

function normalizarCategoriaUI(c) {
    if (!c) return 'USUARIO (PUBLICO)';
    const u = c.trim().toUpperCase();
    if (u === 'PLANTA SIN COMISION') return 'PLANTA SIN COMISION';
    if (u.includes('ROT') || u.includes('PAN')) return 'ROT. Y PAN.';
    if (u.includes('SUB')) return 'SUBDISTRIBUIDOR';
    if (u.includes('COMERCIO') || u === 'COM') return 'COMERCIO';
    return 'USUARIO (PUBLICO)';
}

function obtenerCat() { return normalizarCategoriaUI(document.getElementById('nuevoCliente').checked ? document.getElementById('categoria').value : (clienteSeleccionado ? clienteSeleccionado.categoria : '')); }
function obtenerPrecioEnvase(cat, tipo) { const p = preciosData.find(x => normalizarCategoriaUI(x.categoria) === cat && x.tipo === tipo); return p ? p.precio : 0; }

function actualizarPreciosAutomaticos() {
    const cat = obtenerCat();
    const tieneAcuerdo = clienteSeleccionado && esAcuerdoVigente(clienteSeleccionado.vencimiento);
    const isRetiroPlanta = document.getElementById('esRetiroEnPlanta') ? document.getElementById('esRetiroEnPlanta').checked : false;

    let recargoFlotante = 0;
    if (isRetiroPlanta) {
        const pRecargo = preciosData.find(x => x.categoria === 'SISTEMA' && x.tipo === 'RECARGO_FLOTANTE');
        recargoFlotante = pRecargo ? pRecargo.precio : 0;
    }

    [10, 15, 45].forEach((t, i) => {
        if (!document.getElementById(`manualPriceCheck${i + 1}`).checked) {
            let precioFinal = 0;

            if (tieneAcuerdo && clienteSeleccionado[`p_esp_${t}`]) {
                precioFinal = parseM(clienteSeleccionado[`p_esp_${t}`].toString());
            }

            if (precioFinal === 0) {
                const p = preciosData.find(x => normalizarCategoriaUI(x.categoria) === cat && x.tipo === t.toString());
                precioFinal = p ? p.precio : 0;
            }

            if (precioFinal > 0 && isRetiroPlanta) {
                precioFinal = Math.max(0, precioFinal - recargoFlotante);
            }

            document.getElementById(`precioGarrafa${i + 1}`).value = precioFinal.toLocaleString('es-AR');
        }
    });

    if (!document.getElementById('precioAutorizadoCheck').checked) {
        [10, 15, 45].forEach(t => {
            let precioEnv = 0;

            if (tieneAcuerdo && clienteSeleccionado[`p_esp_env_${t}`]) {
                precioEnv = parseM(clienteSeleccionado[`p_esp_env_${t}`].toString());
            }

            if (precioEnv === 0) {
                precioEnv = obtenerPrecioEnvase(cat, `ENV${t}`);
            }

            document.getElementById(`precioVentaEnv${t}`).value = precioEnv.toLocaleString('es-AR');
        });
    }
    actualizarTotales();
}

function parseM(idOrValue) {
    let v;
    if (typeof idOrValue === 'string' && document.getElementById(idOrValue)) {
        const el = document.getElementById(idOrValue);
        v = el.value !== undefined ? el.value : el.textContent;
    } else {
        v = idOrValue;
    }

    if (!v) return 0;
    const clean = v.toString().replace(/[\$\s\.]/g, '').replace(',', '.').replace(/[^\d.-]/g, '');
    return parseFloat(clean) || 0;
}

document.getElementById('modoEnvase').addEventListener('change', function () {
    const modo = this.value; const isVentaNormal = (modo === 'venta');
    document.getElementById('uiVentaEnvase').style.display = isVentaNormal ? 'block' : 'none';
    document.getElementById('uiComodatoEnvase').style.display = !isVentaNormal ? 'block' : 'none';

    const lblAlerta = document.getElementById('lblAlertaEnvase');
    if (modo === 'comodato') {
        lblAlerta.textContent = "⚠️ COMODATO: Registra activo prestado (Sin cobro)."; lblAlerta.style.color = "var(--error)"; document.getElementById('uiComodatoEnvase').style.borderColor = "var(--error)";
    } else if (modo === 'consignacion') {
        lblAlerta.textContent = "💳 CONSIGNACIÓN: Genera deuda a cobrar en Cuenta Corriente."; lblAlerta.style.color = "var(--accent)"; document.getElementById('uiComodatoEnvase').style.borderColor = "var(--accent)";
    }
    verificarSiNecesitaPin(); actualizarTotales();
});

document.querySelectorAll('.money-input, .garrafa-cantidad').forEach(el => {
    el.setAttribute('inputmode', 'numeric');
    el.setAttribute('pattern', '[0-9]*');
});

document.querySelectorAll('input, select').forEach(el => {
    if (el.classList.contains('money-input')) {
        el.addEventListener('blur', function () {
            let v = this.value.replace(/\D/g, "");
            this.value = v ? parseInt(v).toLocaleString('es-AR') : "";
            if (this.id === 'montoEfectivo' || this.id === 'montoTransferencia') limitarPagoAlTotal(this.id);
            actualizarTotales();
        });

        el.oninput = () => {
            let clean = el.value.replace(/[^\d.,]/g, "");
            if (el.value !== clean) el.value = clean;
            actualizarTotales();
        };
    } else {
        el.oninput = () => actualizarTotales();
    }
});

function actualizarTotales() {
    let c10 = 0, c15 = 0, c45 = 0;
    const isModoFlotante = document.getElementById('ventaPlanta').checked;

    if (isModoFlotante) {
        c10 += Math.max(0, parseInt(document.getElementById('plantaLlenos10').value) || 0);
        c15 += Math.max(0, parseInt(document.getElementById('plantaLlenos15').value) || 0);
        c45 += Math.max(0, parseInt(document.getElementById('plantaLlenos45').value) || 0);
    } else if (document.getElementById('entregaGas').checked) {
        c10 += Math.max(0, parseInt(document.getElementById('cantidadGarrafa1').value) || 0);
        c15 += Math.max(0, parseInt(document.getElementById('cantidadGarrafa2').value) || 0);
        c45 += Math.max(0, parseInt(document.getElementById('cantidadGarrafa3').value) || 0);
    }

    const operandoEnvase = document.getElementById('ventaEnvases').checked;
    const modo = document.getElementById('modoEnvase').value;

    if (!isModoFlotante && operandoEnvase && (modo === 'comodato' || modo === 'consignacion')) {
        c10 += Math.max(0, parseInt(document.getElementById('comodato10').value) || 0);
        c15 += Math.max(0, parseInt(document.getElementById('comodato15').value) || 0);
        c45 += Math.max(0, parseInt(document.getElementById('comodato45').value) || 0);
    }

    let v_gas = (c10 * parseM('precioGarrafa1')) + (c15 * parseM('precioGarrafa2')) + (c45 * parseM('precioGarrafa3'));

    let v_env = 0;
    const rowEnv = document.getElementById('rowSubEnvase');

    if (!isModoFlotante && operandoEnvase) {
        if (modo === 'venta') {
            v_env = (parseM('precioVentaEnv10') * (parseInt(document.getElementById('cantVentaEnv10').value) || 0)) +
                (parseM('precioVentaEnv15') * (parseInt(document.getElementById('cantVentaEnv15').value) || 0)) +
                (parseM('precioVentaEnv45') * (parseInt(document.getElementById('cantVentaEnv45').value) || 0));
            rowEnv.style.display = 'flex'; rowEnv.querySelector('span:first-child').textContent = "Subtotal Envases:";
        } else if (modo === 'consignacion') {
            const cat = obtenerCat();
            v_env = ((parseInt(document.getElementById('comodato10').value) || 0) * obtenerPrecioEnvase(cat, 'ENV10')) +
                ((parseInt(document.getElementById('comodato15').value) || 0) * obtenerPrecioEnvase(cat, 'ENV15')) +
                ((parseInt(document.getElementById('comodato45').value) || 0) * obtenerPrecioEnvase(cat, 'ENV45'));
            rowEnv.style.display = 'flex'; rowEnv.querySelector('span:first-child').textContent = "Total Consignación:";
        } else if (modo === 'comodato') { v_env = 0; rowEnv.style.display = 'none'; }
    } else { rowEnv.style.display = 'none'; }

    let objetivoCaja = v_gas;
    if (!isModoFlotante && operandoEnvase && (modo === 'venta' || modo === 'consignacion')) {
        objetivoCaja += v_env;
    }

    let cobroDeuda = 0;
    const rowCobro = document.getElementById('rowCobroDeuda');
    if (!isModoFlotante && document.getElementById('pagoDeuda').checked) {
        cobroDeuda = parseM('pagoDeudaDinero');
        objetivoCaja += cobroDeuda;
        rowCobro.style.display = cobroDeuda > 0 ? 'flex' : 'none';
        document.getElementById('txtCobroDeuda').textContent = `$${cobroDeuda.toLocaleString('es-AR')}`;
    } else {
        rowCobro.style.display = 'none';
    }

    document.getElementById('txtSubVenta').textContent = `$${v_gas.toLocaleString('es-AR')}`;
    document.getElementById('txtSubEnvase').textContent = `$${v_env.toLocaleString('es-AR')}`;

    let msjDeuda = (!isModoFlotante && operandoEnvase && modo === 'comodato') ? " (+ Prestados)" : "";
    document.getElementById('totalFinal').textContent = `$${objetivoCaja.toLocaleString('es-AR')}${msjDeuda}`;

    window.__objetivoCaja = objetivoCaja;
    validarPagos(objetivoCaja, (!isModoFlotante && operandoEnvase && modo === 'consignacion'));
}

function validarPagos(objetivo, esConsignacion) {
    const btn = document.getElementById('btnGuardar');
    const el = document.getElementById('pagoEstado');
    const isModoFlotante = document.getElementById('ventaPlanta').checked;
    const esPagoDeuda = document.getElementById('pagoDeuda') ? document.getElementById('pagoDeuda').checked : false;

    const hayVenta = objetivo > 0 || document.getElementById('entregaGas').checked || document.getElementById('ventaEnvases').checked || document.getElementById('pagoDeuda').checked || isModoFlotante;
    const selectClienteValue = document.getElementById('cliente').value;
    const esNuevo = document.getElementById('nuevoCliente').checked;

    if (hayVenta && !selectClienteValue && !esNuevo) {
        el.textContent = "FALTA CLIENTE";
        el.className = "payment-counter pending";
        el.classList.remove('clickable');
        btn.disabled = true;
        return;
    }

    if (esNuevo) {
        const nom = document.getElementById('nombreCliente').value.trim();
        const dir = document.getElementById('nuevaDireccion').value.trim();
        const tel = document.getElementById('nuevoTelefono').value.trim();
        const nZona = document.getElementById('nuevaZona').value;
        const nCat = document.getElementById('categoria').value;

        document.getElementById('nombreCliente').classList.toggle('input-error', !nom);
        document.getElementById('nuevaDireccion').classList.toggle('input-error', !dir);
        document.getElementById('nuevoTelefono').classList.toggle('input-error', !tel);
        document.getElementById('nuevaZona').classList.toggle('input-error', !nZona);
        document.getElementById('categoria').classList.toggle('input-error', !nCat);

        if (!nom || !dir || !tel || !nZona || !nCat) {
            el.textContent = "FALTAN DATOS DEL CLIENTE";
            el.className = "payment-counter pending";
            el.classList.remove('clickable');
            btn.disabled = true;
            return;
        }
    }

    const hayGasto = document.getElementById('declaracionGastos').checked;
    const montoGasto = parseM('montoGastos');
    const descGasto = document.getElementById('descripcionGastos').value.trim();
    if (hayGasto) {
        const inputDesc = document.getElementById('descripcionGastos');
        if (!descGasto) {
            el.textContent = "FALTA MOTIVO GASTO";
            el.className = "payment-counter pending";
            el.classList.remove('clickable');
            inputDesc.classList.add('input-error');
            btn.disabled = true;
            return;
        } else {
            inputDesc.classList.remove('input-error');
        }
        if (montoGasto <= 0) {
            el.textContent = "INGRESE MONTO GASTO";
            el.className = "payment-counter pending";
            el.classList.remove('clickable');
            btn.disabled = true;
            return;
        }
    }

    let pagado = 0;
    if (document.getElementById('pagoEfectivo').checked) pagado += parseM('montoEfectivo');
    if (document.getElementById('pagoTransferencia').checked) pagado += parseM('montoTransferencia');

    const dif = objetivo - pagado;

    const operacionValida = (hayVenta && Math.abs(dif) < 1) ||
        (!hayVenta && hayGasto) ||
        (esConsignacion && dif >= 0) ||
        (hayVenta && isModoFlotante && dif >= 0) ||
        (esPagoDeuda && dif <= 0);

    if (operacionValida) {
        if (isModoFlotante && dif > 0) {
            el.textContent = `✓ A DEUDA (FLOTANTE): $${dif.toLocaleString('es-AR')}`;
            el.className = "payment-counter warning";
        } else if (esConsignacion && dif > 0) {
            el.textContent = `✓ A DEUDA (CONSIGNACIÓN): $${dif.toLocaleString('es-AR')}`;
            el.className = "payment-counter warning";
        } else if ((esPagoDeuda || esConsignacion) && dif < 0) {
            el.textContent = `✓ SALDO A FAVOR CREADO: $${Math.abs(dif).toLocaleString('es-AR')}`;
            el.className = "payment-counter complete";
            el.style.color = "var(--success)"; 
        } else {
            el.textContent = "✓ LISTO PARA GUARDAR";
            el.className = "payment-counter complete";
            el.style.color = "";
        }
        el.classList.remove('clickable');
        btn.disabled = false;
    } else if (!hayVenta && !hayGasto) {
        el.textContent = "INGRESE DATOS";
        el.className = "payment-counter pending";
        el.classList.remove('clickable');
        btn.disabled = true;
    } else {
        if (dif > 0) {
            el.textContent = `FALTAN: $${dif.toLocaleString('es-AR')}`;
            el.className = "payment-counter pending clickable";
            el.dataset.faltante = dif;
        } else {
            el.textContent = `SOBRAN: $${Math.abs(dif).toLocaleString('es-AR')}`;
            el.className = "payment-counter pending";
            el.classList.remove('clickable');
        }
        btn.disabled = true;
    }
}

document.getElementById('zona').onchange = function () {
    const z = this.value; const sel = document.getElementById('cliente'); sel.innerHTML = '<option value="">Seleccione...</option>';
    clientesData.filter(c => c.zona === z).forEach(c => { const opt = document.createElement('option'); opt.value = JSON.stringify(c); opt.textContent = c.nombre; sel.appendChild(opt); });

    document.getElementById('clientInfoBox').style.display = 'none';
    document.getElementById('acuerdoDisplay').style.display = 'none';
    document.getElementById('pagoDeudaContainer').style.display = 'none';
    document.getElementById('pagoDeuda').checked = false;
    document.getElementById('sectionPagoDeuda').style.display = 'none';
    idClienteSeleccionado = '';
    checkVisibilidadCascada(); actualizarTotales();
};

document.getElementById('cliente').onchange = function () {
    if (!this.value) {
        document.getElementById('clientInfoBox').style.display = 'none';
        document.getElementById('acuerdoDisplay').style.display = 'none';
        document.getElementById('pagoDeudaContainer').style.display = 'none';
        document.getElementById('pagoDeuda').checked = false;
        document.getElementById('sectionPagoDeuda').style.display = 'none';
        checkVisibilidadCascada(); actualizarTotales(); idClienteSeleccionado = ''; return;
    }

    clienteSeleccionado = JSON.parse(this.value);
    idClienteSeleccionado = clienteSeleccionado.id_cliente || '';

    const box = document.getElementById('clientInfoBox');
    let html = '';

    if (clienteSeleccionado.direccion) html += `<div class="client-info-tag">📍 ${clienteSeleccionado.direccion}</div>`;
    if (clienteSeleccionado.telefono) html += `<div class="client-info-tag">📞 ${clienteSeleccionado.telefono}</div>`;
    if (clienteSeleccionado.cuit_dni) html += `<div class="client-info-tag">🪪 ${clienteSeleccionado.cuit_dni}</div>`;

    const deudaCliente = deudasData[idClienteSeleccionado] || deudasData[clienteSeleccionado.nombre] || {};

    let dEnv10 = parseInt(deudaCliente.env10) || 0;
    let dEnv15 = parseInt(deudaCliente.env15) || 0;
    let dEnv45 = parseInt(deudaCliente.env45) || 0;
    let dPlata = parseFloat(deudaCliente.plata?.toString().replace(/\D/g, '')) || 0;

    let fEnv10 = parseInt(deudaCliente.flotante10) || 0;
    let fEnv15 = parseInt(deudaCliente.flotante15) || 0;
    let fEnv45 = parseInt(deudaCliente.flotante45) || 0;
    if (document.getElementById('flotanteCliente10')) {
        document.getElementById('flotanteCliente10').textContent = fEnv10;
        document.getElementById('flotanteCliente15').textContent = fEnv15;
        document.getElementById('flotanteCliente45').textContent = fEnv45;
    }

    let tieneComodato = (dEnv10 > 0 || dEnv15 > 0 || dEnv45 > 0);
    let tieneConsignacion = (dPlata > 0);
    let tieneFlotante = (fEnv10 > 0 || fEnv15 > 0 || fEnv45 > 0);

    if (tieneComodato) {
        let detalleComodato = [];
        if (dEnv10 > 0) detalleComodato.push(`${dEnv10}x10kg`);
        if (dEnv15 > 0) detalleComodato.push(`${dEnv15}x15kg`);
        if (dEnv45 > 0) detalleComodato.push(`${dEnv45}x45kg`);
        html += `<div class="client-info-tag tag-comodato" style="box-shadow: 0 0 10px #ff9800; border: 2px solid #ff9800; background: rgba(255, 152, 0, 0.1); color: #ffb74d; font-weight: bold;">📦 Comodato: ${detalleComodato.join(' | ')}</div>`;
    }

    if (tieneConsignacion) {
        html += `<div class="client-info-tag tag-consignacion" style="position: sticky; top: 10px; z-index: 100; box-shadow: 0 0 12px red; border: 2px solid red; background: rgba(255,0,0,0.15); color: #ff4d4d; font-weight: 900; padding: 12px; text-align: center; font-size: 16px; width: 100%; box-sizing: border-box;">💸 DEUDA A COBRAR: $${dPlata.toLocaleString('es-AR')}</div>`;
    }

    if (tieneFlotante) {
        let detalleFlot = [];
        if (fEnv10 > 0) detalleFlot.push(`${fEnv10}x10kg`);
        if (fEnv15 > 0) detalleFlot.push(`${fEnv15}x15kg`);
        if (fEnv45 > 0) detalleFlot.push(`${fEnv45}x45kg`);
        html += `<div class="client-info-tag tag-flotante" style="box-shadow: 0 0 10px #00bcd4; border: 2px solid #00bcd4; background: rgba(0, 188, 212, 0.1); color: #4dd0e1; font-weight: bold;">🔄 Flotante a favor: ${detalleFlot.join(' | ')}</div>`;
    }

    box.innerHTML = html;
    box.style.display = html ? 'flex' : 'none';

    document.getElementById('tipoClienteSpan').textContent = clienteSeleccionado.categoria;
    document.getElementById('tipoClienteDisplay').style.display = 'block';

    if (esAcuerdoVigente(clienteSeleccionado.vencimiento)) {
        document.getElementById('acuerdoDisplay').style.display = 'block';
    } else {
        document.getElementById('acuerdoDisplay').style.display = 'none';
    }

    const containerPago = document.getElementById('pagoDeudaContainer');
    const inputDinero = document.getElementById('pagoDeudaDinero');
    const row10 = document.getElementById('rowDev10');
    const row15 = document.getElementById('rowDev15');
    const row45 = document.getElementById('rowDev45');

    document.getElementById('pagoDeuda').checked = false;
    document.getElementById('sectionPagoDeuda').style.display = 'none';

    if (tieneComodato || tieneConsignacion) {
        containerPago.style.display = 'flex';
        if (tieneConsignacion) {
            inputDinero.style.display = 'block';
            inputDinero.value = dPlata.toLocaleString('es-AR');
        } else {
            inputDinero.style.display = 'none';
            inputDinero.value = '';
        }
        row10.style.display = dEnv10 > 0 ? 'flex' : 'none';
        document.getElementById('dev10').value = dEnv10;
        row15.style.display = dEnv15 > 0 ? 'flex' : 'none';
        document.getElementById('dev15').value = dEnv15;
        row45.style.display = dEnv45 > 0 ? 'flex' : 'none';
        document.getElementById('dev45').value = dEnv45;
    } else {
        containerPago.style.display = 'none';
    }

    checkVisibilidadCascada(); actualizarPreciosAutomaticos();
};

document.getElementById('nuevoCliente').onchange = function () {
    const isChecked = this.checked;
    document.getElementById('nuevoClienteSection').style.display = isChecked ? 'block' : 'none';
    document.getElementById('selectoresPrincipales').style.display = isChecked ? 'none' : 'flex';

    if (isChecked) {
        document.getElementById('cliente').value = "";
        document.getElementById('clientInfoBox').style.display = 'none';
        document.getElementById('tipoClienteDisplay').style.display = 'none';
        document.getElementById('acuerdoDisplay').style.display = 'none';
        document.getElementById('pagoDeudaContainer').style.display = 'none';
        document.getElementById('pagoDeuda').checked = false;
        document.getElementById('sectionPagoDeuda').style.display = 'none';
        idClienteSeleccionado = '';

        document.getElementById('nombreCliente').classList.remove('input-error');
        document.getElementById('nuevaDireccion').classList.remove('input-error');
        document.getElementById('nuevoTelefono').classList.remove('input-error');
        document.getElementById('nuevaZona').classList.remove('input-error');
        document.getElementById('categoria').classList.remove('input-error');
    } else {
        document.getElementById('nombreCliente').classList.remove('input-error');
        document.getElementById('nuevaDireccion').classList.remove('input-error');
        document.getElementById('nuevoTelefono').classList.remove('input-error');
        document.getElementById('nuevaZona').classList.remove('input-error');
        document.getElementById('categoria').classList.remove('input-error');
    }
    checkVisibilidadCascada(); actualizarPreciosAutomaticos();
};

document.getElementById('categoria').onchange = () => actualizarPreciosAutomaticos();

function toggleMutuallyExclusive(clickedId) {
    const ids = ['entregaGas', 'ventaEnvases', 'declaracionGastos', 'ventaPlanta'];
    const isChecked = document.getElementById(clickedId) ? document.getElementById(clickedId).checked : false;

    ids.forEach(id => {
        if (id !== clickedId) {
            const el = document.getElementById(id);
            if (el) {
                const container = el.closest('.checkbox-item');
                if (container) {
                    container.style.display = isChecked ? 'none' : '';
                }
            }
        }
    });
}

if (document.getElementById('esRetiroEnPlanta')) {
    document.getElementById('esRetiroEnPlanta').onchange = () => {
        actualizarPreciosAutomaticos();
        actualizarTotales();
    };
}

document.getElementById('ventaPlanta').onclick = () => {
    const isChecked = document.getElementById('ventaPlanta').checked;
    document.getElementById('sectionPlanta').style.display = isChecked ? 'block' : 'none';

    if (isChecked) {
        document.getElementById('pagoTransferencia').checked = false;
        document.getElementById('transferenciaInput').style.display = 'none';
        document.getElementById('montoTransferencia').value = '';

        document.getElementById('pagoEfectivo').checked = false;
        document.getElementById('efectivoInput').style.display = 'none';
        document.getElementById('montoEfectivo').value = '';

        const chkDeuda = document.getElementById('pagoDeuda');
        if (chkDeuda) {
            chkDeuda.checked = false;
            document.getElementById('sectionPagoDeuda').style.display = 'none';
        }
    }

    actualizarPreciosAutomaticos();
    actualizarTotales();
    toggleMutuallyExclusive('ventaPlanta');
};

document.getElementById('entregaGas').onclick = () => { document.getElementById('sectionGas').style.display = document.getElementById('entregaGas').checked ? 'block' : 'none'; actualizarTotales(); toggleMutuallyExclusive('entregaGas'); };
document.getElementById('ventaEnvases').onclick = () => { document.getElementById('sectionEnvases').style.display = document.getElementById('ventaEnvases').checked ? 'block' : 'none'; verificarSiNecesitaPin(); actualizarTotales(); toggleMutuallyExclusive('ventaEnvases'); };
document.getElementById('declaracionGastos').onclick = () => { document.getElementById('sectionGastos').style.display = document.getElementById('declaracionGastos').checked ? 'block' : 'none'; checkVisibilidadCascada(); verificarSiNecesitaPin(); actualizarTotales(); toggleMutuallyExclusive('declaracionGastos'); };
document.getElementById('pagoDeuda').onclick = () => { document.getElementById('sectionPagoDeuda').style.display = document.getElementById('pagoDeuda').checked ? 'block' : 'none'; checkVisibilidadCascada(); actualizarTotales(); };
document.getElementById('pagoEfectivo').onclick = () => { const on = document.getElementById('pagoEfectivo').checked; document.getElementById('efectivoInput').style.display = on ? 'block' : 'none'; if (!on) document.getElementById('montoEfectivo').value = ''; actualizarTotales(); };
document.getElementById('pagoTransferencia').onclick = () => { const on = document.getElementById('pagoTransferencia').checked; document.getElementById('transferenciaInput').style.display = on ? 'block' : 'none'; if (!on) document.getElementById('montoTransferencia').value = ''; actualizarTotales(); };

function conTimeout(promesa, ms) {
    return Promise.race([promesa, new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), ms))]);
}

function esErrorDeRed(e) {
    const code = String((e && e.code) || '').replace('firestore/', '');
    const msg = String((e && e.message) || e || '');
    return !navigator.onLine || msg === 'TIMEOUT' ||
        ['unavailable', 'deadline-exceeded', 'cancelled', 'aborted', 'resource-exhausted', 'internal', 'unknown'].includes(code) ||
        /offline|network|fetch|Failed to get document/i.test(msg);
}

function leerCola() {
    try { return JSON.parse(localStorage.getItem('cola_ventas') || '[]'); } catch (e) { return []; }
}
function escribirCola(c) { localStorage.setItem('cola_ventas', JSON.stringify(c)); }

function numeroSeguro(valor) {
    const n = Number(valor);
    return Number.isFinite(n) ? n : 0;
}

function normalizarClaveUsuario(valor) {
    return String(valor || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[^a-z0-9]/g, '');
}

function esUbicacionValida(valor) {
    const s = String(valor || '').trim();
    return /^-?\d{1,3}(?:\.\d+)?\s*,\s*-?\d{1,3}(?:\.\d+)?$/.test(s);
}

function ubicacionUtil(valor) {
    const s = String(valor || '').trim();
    if (!s || /^SIN_GPS/i.test(s)) return '';
    return s;
}

function tipoMovimientoFlotante(data) {
    if (data.esPagoDeuda) return 'PAGO_DEUDA';
    if (String(data.esFlotante).toLowerCase() === 'true') return 'FLOTANTE';
    if (data.operacionEnvase === 'comodato') return 'COMODATO';
    if (data.operacionEnvase === 'consignacion') return 'CONSIGNACION';
    if (data.operacionEnvase === 'venta') return 'VENTA_ENVASE';
    if (String(data.TIPO || '').toUpperCase().includes('GASTO')) return 'GASTO';
    return 'VENTA';
}

function calcularDeltasCliente(data) {
    return {
        d10: numeroSeguro(data.MOV_NETO_10),
        d15: numeroSeguro(data.MOV_NETO_15),
        d45: numeroSeguro(data.MOV_NETO_45),
        dinero: numeroSeguro(data.MOV_NETO_DINERO)
    };
}

// El saldo se maneja como un único número con signo:
// positivo = el cliente debe; negativo = el cliente tiene a favor.
// En el documento se guarda separado en env* (deuda) y flotante* (a favor).
function calcularSaldosCliente(base, deltas) {
    const b = base || {};
    const saldo10 = numeroSeguro(b.env10) - numeroSeguro(b.flotante10) + numeroSeguro(deltas.d10);
    const saldo15 = numeroSeguro(b.env15) - numeroSeguro(b.flotante15) + numeroSeguro(deltas.d15);
    const saldo45 = numeroSeguro(b.env45) - numeroSeguro(b.flotante45) + numeroSeguro(deltas.d45);
    const saldoDinero = numeroSeguro(b.plata) + numeroSeguro(deltas.dinero);

    return {
        saldo10, saldo15, saldo45, saldoDinero,
        env10: Math.max(0, saldo10),
        env15: Math.max(0, saldo15),
        env45: Math.max(0, saldo45),
        flotante10: Math.max(0, -saldo10),
        flotante15: Math.max(0, -saldo15),
        flotante45: Math.max(0, -saldo45),
        plata: saldoDinero
    };
}

function crearHistorialFlotante(data, deltas, saldos) {
    return {
        idTransaccion: data.N,
        movimientoId: data.N,
        fecha: data.FECHA || '',
        hora: data.HORA || '',
        usuario: data.USUARIO || '',
        usuarioId: data.USUARIO_ID || '',
        idCliente: data.ID_CLIENTE || '',
        clienteNombre: data.C || data.clienteNombre || '',
        tipoMov: tipoMovimientoFlotante(data),
        operacionEnvase: data.operacionEnvase || '',
        movEnv10: deltas.d10,
        movEnv15: deltas.d15,
        movEnv45: deltas.d45,
        movDinero: deltas.dinero,
        saldo10: saldos.saldo10,
        saldo15: saldos.saldo15,
        saldo45: saldos.saldo45,
        saldoDinero: saldos.saldoDinero,
        notas: data.G || '',
        idViaje: data.ID_VIAJE || data.idViaje || '',
        idTurno: data.ID_TURNO || data.idTurno || '',
        timestampMs: data.TIMESTAMP_MS || Date.now(),
        creado: serverTimestamp()
    };
}

// Devuelve la ubicación existente del cliente o, si no tiene, la nueva GPS.
function resolverUbicacionCliente(data, cliData) {
    const existente = ubicacionUtil(cliData && (cliData.ubicacion || cliData.coordenadas));
    if (existente) return existente;
    const nueva = String((data && data.clienteUbicacion) || '').trim();
    if (esUbicacionValida(nueva)) return nueva;
    const movimiento = String((data && data.UBICACION) || '').trim();
    return esUbicacionValida(movimiento) ? movimiento : '';
}

// Viaje activo del chofer y turno abierto. Si no hay, quedan los valores
// pedidos: ID_VIAJE = "Sin_Camion" e ID_TURNO = "SIN_TURNO".
async function obtenerContextoOperacion() {
    const CACHE_KEY = 'vm_contexto_operacion';
    const fallback = { idViaje: 'Sin_Camion', idTurno: 'SIN_TURNO' };
    let cache = null;
    try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (e) { cache = null; }

    const usuarioCache = String(window.idUsuarioFirebase || '').trim();
    if (!navigator.onLine) {
        if (cache && cache.usuario === usuarioCache && cache.idTurno &&
            (Date.now() - Number(cache.ts || 0)) < 12 * 60 * 60 * 1000) return cache;
        return fallback;
    }

    const ctx = { ...fallback };

    try {
        const snapTurnos = await getDocs(query(collection(db, 'turnos'), where('estado', '==', 'ABIERTO')));
        let mejor = null;
        snapTurnos.forEach(d => {
            const t = d.data();
            const ms = Number(t.timestampAperturaMs) || 0;
            if (!mejor || ms > mejor.ms) mejor = { ms, id: String(t.idTurno || d.id).trim() };
        });
        if (mejor && mejor.id) ctx.idTurno = mejor.id;
    } catch (e) {
        console.warn('No se pudo leer el turno abierto:', e);
    }

    const userId = String(window.idUsuarioFirebase || '').trim();
    const userNombre = String(window.nombreUsuarioMostrar || '').trim();
    if (userId || userNombre) {
        try {
            const snapViajes = await getDocs(query(collection(db, 'ccarga'), where('estado', 'in', ['EN_RUTA', 'COMPRA_EN_RUTA'])));
            let mejor = null;
            snapViajes.forEach(d => {
                const v = d.data();
                const chofer = String(v.chofer || '').trim();
                const coincide = normalizarClaveUsuario(chofer) === normalizarClaveUsuario(userId) ||
                    normalizarClaveUsuario(chofer) === normalizarClaveUsuario(userNombre);
                if (!coincide) return;
                const ms = Number(v.timestampMs) || 0;
                if (!mejor || ms > mejor.ms) mejor = { ms, id: String(v.idViaje || d.id).trim() };
            });
            if (mejor && mejor.id) ctx.idViaje = mejor.id;
        } catch (e) {
            console.warn('No se pudo leer el viaje activo:', e);
        }
    }

    const out = { ...ctx, usuario: usuarioCache, ts: Date.now() };
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(out)); } catch (e) {}
    return out;
}

// Escribe la venta y sus efectos sobre el cliente UNA sola vez (si ya existe, no hace nada).
async function enviarVentaFirestore(payload) {
    const data = { ...payload };
    delete data._offline_ts;

    const ubicacionCliente = String(data.clienteUbicacion || '').trim();
    delete data.clienteUbicacion;

    if (data.esClienteNuevo && !data.ID_CLIENTE) data.ID_CLIENTE = doc(collection(db, "clientes")).id;
    const movRef = doc(db, "movimientos", data.N);
    const deltas = calcularDeltasCliente(data);
    const huboMovimientoSaldos = !!(deltas.d10 || deltas.d15 || deltas.d45 || deltas.dinero);

    return runTransaction(db, async (tx) => {
        const ya = await tx.get(movRef);
        if (ya.exists()) return 'DUPLICADA';

        // Todas las lecturas van antes de la primera escritura (regla de transacciones).
        let cliRef = null;
        let cliSnap = null;
        if (!data.esClienteNuevo && data.ID_CLIENTE) {
            cliRef = doc(db, "clientes", data.ID_CLIENTE);
            cliSnap = await tx.get(cliRef);
        }

        tx.set(movRef, data);

        // Una comisión pendiente por cada venta que generó comisión.
        // El pago se registra desde controlcomisiones.html.
        const comisionMonto = round2(data.COMISION_TOTAL);
        if (comisionMonto > 0) {
            tx.set(doc(db, "comisiones", data.N), {
                movimientoId: data.N,
                choferId: data.USUARIO_ID || "",
                chofer: data.USUARIO || "",
                choferKey: claveChofer(data.USUARIO),
                clienteId: data.ID_CLIENTE || "",
                cliente: data.C || data.clienteNombre || "",
                fecha: data.FECHA || "",
                fechaISO: data.FECHA_ISO || "",
                hora: data.HORA || "",
                tipo: data.TIPO || "",
                ventaTotal: totalVentaDeMovimiento(data),
                comision: comisionMonto,
                detalle: Array.isArray(data.COMISION_DETALLE) ? data.COMISION_DETALLE : [],
                estado: "PENDIENTE",
                pagoId: null,
                creado: serverTimestamp(),
                timestampMs: data.TIMESTAMP_MS || Date.now()
            });
        }

        if (data.esClienteNuevo) {
            const saldos = calcularSaldosCliente({}, deltas);
            const coords = esUbicacionValida(ubicacionCliente) ? ubicacionCliente
                : (esUbicacionValida(data.UBICACION) ? String(data.UBICACION).trim() : '');

            tx.set(doc(db, "clientes", data.ID_CLIENTE), {
                id_cliente: data.ID_CLIENTE,
                nombre: data.clienteNombre,
                zona: data.clienteZona,
                categoria: data.clienteCategoria,
                direccion: data.clienteDireccion,
                telefono: data.clienteTelefono,
                mail: data.clienteMail || '',
                cuit_dni: data.cuit_dni,
                ubicacion: coords,
                plata: saldos.plata,
                env10: saldos.env10, env15: saldos.env15, env45: saldos.env45,
                flotante10: saldos.flotante10, flotante15: saldos.flotante15, flotante45: saldos.flotante45,
                ultimaActualizacion: data.FECHA || '',
                ultimaActualizacionMs: data.TIMESTAMP_MS || Date.now(),
                ultimoMovimientoTipo: tipoMovimientoFlotante(data),
                ultimoMovimientoId: data.N
            });

            if (huboMovimientoSaldos) {
                tx.set(doc(collection(db, "historial_flotantes")), crearHistorialFlotante(data, deltas, saldos));
            }
            tx.update(doc(db, "seguridad", "pin"), { version_datos: increment(1) });
        } else if (data.ID_CLIENTE) {
            const cliData = cliSnap && cliSnap.exists() ? cliSnap.data() : null;
            const updates = {};

            let saldos = null;
            if (huboMovimientoSaldos) {
                saldos = calcularSaldosCliente(cliData || {}, deltas);
                Object.assign(updates, {
                    plata: saldos.plata,
                    env10: saldos.env10, env15: saldos.env15, env45: saldos.env45,
                    flotante10: saldos.flotante10, flotante15: saldos.flotante15, flotante45: saldos.flotante45,
                    ultimaActualizacion: data.FECHA || '',
                    ultimaActualizacionMs: data.TIMESTAMP_MS || Date.now(),
                    ultimoMovimientoTipo: tipoMovimientoFlotante(data),
                    ultimoMovimientoId: data.N
                });
                tx.set(doc(collection(db, "historial_flotantes")), crearHistorialFlotante(data, deltas, saldos));
            }

            const coords = resolverUbicacionCliente({ clienteUbicacion: ubicacionCliente, UBICACION: data.UBICACION }, cliData);
            if (coords && !ubicacionUtil(cliData && cliData.ubicacion)) {
                updates.ubicacion = coords;
            }

            if (!cliData) {
                // Venta a un ID de cliente que ya no existe: recreamos la ficha mínima.
                tx.set(doc(db, "clientes", data.ID_CLIENTE), {
                    id_cliente: data.ID_CLIENTE,
                    nombre: data.C || data.clienteNombre || '',
                    zona: data.clienteZona || '',
                    categoria: data.clienteCategoria || '',
                    direccion: data.clienteDireccion || '',
                    telefono: data.clienteTelefono || '',
                    cuit_dni: data.cuit_dni || '',
                    ubicacion: updates.ubicacion || '',
                    plata: updates.plata || 0,
                    env10: updates.env10 || 0, env15: updates.env15 || 0, env45: updates.env45 || 0,
                    flotante10: updates.flotante10 || 0, flotante15: updates.flotante15 || 0, flotante45: updates.flotante45 || 0
                });
            } else if (Object.keys(updates).length > 0) {
                tx.update(cliRef, updates);
            }
        }
        return 'OK';
    });
}

function guardarEnCola(payload) {
    const cola = leerCola().filter(x => x.N !== payload.N);
    payload._offline_ts = Date.now();
    cola.push(payload);
    escribirCola(cola);
    mostrarExito("Se enviará sola apenas haya conexión.", "GUARDADO EN EL TELÉFONO");
    setTimeout(() => window.location.reload(), 1800);
}

// Sin botón: la cola se envía sola. Se mantiene la función por compatibilidad.
function actualizarIndicadorOffline() {
    const btnSync = document.getElementById('btn-sync');
    if (btnSync) btnSync.style.display = 'none';
}

const syncAvisados = new Set();

async function sincronizarCola() {
    if (!navigator.onLine || isSyncing) return;
    if (leerCola().length === 0) return;

    const lock = Number(localStorage.getItem('sync_lock') || 0);
    if (Date.now() - lock < 45000) return; // otra pestaña ya está enviando

    isSyncing = true;
    localStorage.setItem('sync_lock', String(Date.now()));
    let enviados = 0;

    try {
        for (const item of leerCola()) {
            try {
                localStorage.setItem('sync_lock', String(Date.now()));
                await conTimeout(enviarVentaFirestore(item), 20000);
                escribirCola(leerCola().filter(x => x.N !== item.N)); // se saca de la cola en el momento
                enviados++;
            } catch (e) {
                console.warn("Sync falló:", item.N, e);
                if (esErrorDeRed(e)) break; // sin conexión real: se reintenta solo más tarde
                if (!syncAvisados.has(item.N)) {
                    syncAvisados.add(item.N);
                    showToast(`No se pudo enviar la venta ${item.N}: ${e.code || e.message}`, "error");
                }
            }
        }
    } finally {
        isSyncing = false;
        localStorage.removeItem('sync_lock');
    }

    if (enviados > 0) showToast(`✅ ${enviados} venta${enviados > 1 ? 's' : ''} pendiente${enviados > 1 ? 's' : ''} enviada${enviados > 1 ? 's' : ''}.`, "success");
}

function iniciarSyncAutomatico() {
    sincronizarCola();
    setInterval(() => { if (navigator.onLine && leerCola().length > 0) sincronizarCola(); }, 20000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sincronizarCola(); });
}

async function guardar() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        showToast("⚠️ Debes detener la grabación antes de guardar.", "warning");
        return;
    }

    const btn = document.getElementById('btnGuardar');
    const pinContainer = document.getElementById('globalPinContainer');
    const pinInput = document.getElementById('globalPinInput');
    let pinParaEnviar = "";

    if (pinContainer.style.display !== 'none') {
        const val = pinInput.value.trim();
        if (val.length < 4) {
            showToast("⚠️ FALTA AUTORIZACIÓN: Ingrese el PIN de 4 dígitos.", "error");
            pinInput.focus();
            return;
        }
        pinParaEnviar = val;
    }

    {
        const ef = document.getElementById('pagoEfectivo').checked ? parseM('montoEfectivo') : 0;
        const tr = document.getElementById('pagoTransferencia').checked ? parseM('montoTransferencia') : 0;
        const obj = Number(window.__objetivoCaja) || 0;
        const esDeuda = document.getElementById('pagoDeuda').checked;
        const esFlot = document.getElementById('ventaPlanta').checked;
        if (!esDeuda && !esFlot && (ef + tr) > obj + 0.5) {
            showToast(`⚠️ Los pagos ($${(ef + tr).toLocaleString('es-AR')}) superan el total ($${obj.toLocaleString('es-AR')}). Corrija los montos.`, "error");
            return;
        }
    }

    btn.disabled = true;
    mostrarLoaderGuardando("OBTENIENDO GPS...", "Buscando satélites");

    const ubicacionActual = await obtenerUbicacionFantasma();

    if (ubicacionActual.includes("SIN_GPS")) {
        showToast("⚠️ Sin señal GPS. Guardando registro sin ubicación.", "warning");
    }

    let validacionGPS = "SIN_DATOS";
    if (!ubicacionActual.includes("SIN_GPS") && clienteSeleccionado && (clienteSeleccionado.ubicacion || clienteSeleccionado.coordenadas || clienteSeleccionado.UBICACION)) {
        let ubiCli = clienteSeleccionado.ubicacion || clienteSeleccionado.coordenadas || clienteSeleccionado.UBICACION;

        if (ubiCli.includes("?q=")) {
            ubiCli = ubiCli.split("?q=")[1];
        }

        if (ubiCli && ubiCli.includes(',')) {
            const [latAct, lonAct] = ubicacionActual.split(',').map(Number);
            const [latCli, lonCli] = ubiCli.split(',').map(Number);

            if (!isNaN(latCli) && !isNaN(lonCli)) {
                const distKm = calcularDistancia(latAct, lonAct, latCli, lonCli);
                validacionGPS = distKm <= 0.060 ? "SI" : "NO";
            }
        }
    }

    updateLoader("PROCESANDO OPERACIÓN...", "Armando paquete de datos");

    // Viaje activo del chofer y turno abierto. Si no hay, se guardan
    // "Sin_Camion" y "SIN_TURNO" para que el movimiento quede trazable.
    const contextoOperacion = await obtenerContextoOperacion();
    const ubicacionCliente = (!ubicacionActual.includes('SIN_GPS') && esUbicacionValida(ubicacionActual))
        ? ubicacionActual.trim() : '';

    const cat = obtenerCat();
    const esNuevo = document.getElementById('nuevoCliente').checked;
    const esGasto = document.getElementById('declaracionGastos').checked;
    const pfx = { 'SUBDISTRIBUIDOR': 'VS', 'COMERCIO': 'VC', 'ROT. Y PAN.': 'VRP', 'USUARIO (PUBLICO)': 'VU' }[cat] || 'VU';

    let nombreC = esNuevo ? document.getElementById('nombreCliente').value : (clienteSeleccionado ? clienteSeleccionado.nombre : '');
    if (!nombreC && esGasto) nombreC = 'GASTO';

    const operandoEnvase = document.getElementById('ventaEnvases').checked;
    const isModoFlotante = document.getElementById('ventaPlanta').checked;
    const isRetiroPlanta = document.getElementById('esRetiroEnPlanta') ? document.getElementById('esRetiroEnPlanta').checked : false;
    const modoEnv = operandoEnvase ? document.getElementById('modoEnvase').value : 'ninguna';

    let q10 = 0, q15 = 0, q45 = 0;
    let ret10 = 0, ret15 = 0, ret45 = 0;

    if (isModoFlotante) {
        q10 = parseInt(document.getElementById('plantaLlenos10').value) || 0;
        q15 = parseInt(document.getElementById('plantaLlenos15').value) || 0;
        q45 = parseInt(document.getElementById('plantaLlenos45').value) || 0;
        ret10 = parseInt(document.getElementById('plantaVacios10').value) || 0;
        ret15 = parseInt(document.getElementById('plantaVacios15').value) || 0;
        ret45 = parseInt(document.getElementById('plantaVacios45').value) || 0;
    } else if (document.getElementById('entregaGas').checked) {
        ret10 = Math.max(0, parseInt(document.getElementById('cantidadGarrafa1').value) || 0);
        ret15 = Math.max(0, parseInt(document.getElementById('cantidadGarrafa2').value) || 0);
        ret45 = Math.max(0, parseInt(document.getElementById('cantidadGarrafa3').value) || 0);
        q10 += ret10; q15 += ret15; q45 += ret45;
    }

    if (!isModoFlotante && operandoEnvase && (modoEnv === 'comodato' || modoEnv === 'consignacion')) {
        q10 += parseInt(document.getElementById('comodato10').value) || 0;
        q15 += parseInt(document.getElementById('comodato15').value) || 0;
        q45 += parseInt(document.getElementById('comodato45').value) || 0;
    }

    let tipoOp = 'VENTA';
    if (operandoEnvase) {
        if (modoEnv === 'venta') tipoOp = 'VENTA_ENVASE';
        if (modoEnv === 'comodato') tipoOp = 'COMODATO';
        if (modoEnv === 'consignacion') tipoOp = 'CONSIGNACION';
    }
    if (document.getElementById('pagoDeuda').checked) tipoOp = 'COBRO DEUDA';
    if (isModoFlotante) tipoOp = 'FLOTANTE';
    if (esGasto) tipoOp = 'GASTO';

    const garrafasArray = [];
    if (q10 > 0) garrafasArray.push({ tipo: '10', cantidad: q10, precio: parseM('precioGarrafa1') });
    if (q15 > 0) garrafasArray.push({ tipo: '15', cantidad: q15, precio: parseM('precioGarrafa2') });
    if (q45 > 0) garrafasArray.push({ tipo: '45', cantidad: q45, precio: parseM('precioGarrafa3') });

    const now = new Date();
    const hora24 = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    let ce10 = 0, ce15 = 0, ce45 = 0;
    let ce10$ = 0, ce15$= 0, ce45$ = 0;

    if (!isModoFlotante && operandoEnvase) {
        if (modoEnv === 'venta') {
            ce10 = parseInt(document.getElementById('cantVentaEnv10').value) || 0;
            ce10$ = ce10 * parseM('precioVentaEnv10');
            ce15 = parseInt(document.getElementById('cantVentaEnv15').value) || 0;
            ce15$ = ce15 * parseM('precioVentaEnv15');
            ce45 = parseInt(document.getElementById('cantVentaEnv45').value) || 0;
            ce45$ = ce45 * parseM('precioVentaEnv45');
        } else if (modoEnv === 'consignacion') {
            const c = obtenerCat();
            ce10 = parseInt(document.getElementById('comodato10').value) || 0;
            ce10$ = ce10 * obtenerPrecioEnvase(c, 'ENV10');
            ce15 = parseInt(document.getElementById('comodato15').value) || 0;
            ce15$ = ce15 * obtenerPrecioEnvase(c, 'ENV15');
            ce45 = parseInt(document.getElementById('comodato45').value) || 0;
            ce45$ = ce45 * obtenerPrecioEnvase(c, 'ENV45');
        }
    }

    // Solo cuenta lo de los medios de pago tildados (un monto oculto nunca suma)
    const efectivoOK = document.getElementById('pagoEfectivo').checked ? parseM('montoEfectivo') : 0;
    const transfOK = document.getElementById('pagoTransferencia').checked ? parseM('montoTransferencia') : 0;
    let pagado = efectivoOK + transfOK;
    let objetivoGas = (q10 * parseM('precioGarrafa1')) + (q15 * parseM('precioGarrafa2')) + (q45 * parseM('precioGarrafa3'));
    let totalOperacion = objetivoGas + ce10$ + ce15$+ ce45$;

    let deudaGeneradaPlanta = (isModoFlotante && objetivoGas > pagado) ? (objetivoGas - pagado) : 0;

    const comision = calcularComision(garrafasArray, isRetiroPlanta);
    const comisionTotal = comision.total;
    const comisionDetalle = comision.detalle;

    let neto10 = 0, neto15 = 0, neto45 = 0, netoDinero = 0;

    if (isModoFlotante) {
        neto10 = q10 - ret10;
        neto15 = q15 - ret15;
        neto45 = q45 - ret45;
        netoDinero = objetivoGas - pagado;
    } else {
        netoDinero = totalOperacion - pagado;

        if (operandoEnvase && (modoEnv === 'comodato' || modoEnv === 'consignacion')) {
            neto10 += parseInt(document.getElementById('comodato10').value) || 0;
            neto15 += parseInt(document.getElementById('comodato15').value) || 0;
            neto45 += parseInt(document.getElementById('comodato45').value) || 0;
        }
        if (document.getElementById('pagoDeuda').checked) {
            netoDinero -= parseM('pagoDeudaDinero');
            neto10 -= parseInt(document.getElementById('dev10').value) || 0;
            neto15 -= parseInt(document.getElementById('dev15').value) || 0;
            neto45 -= parseInt(document.getElementById('dev45').value) || 0;
        }
    }

    const payload = {
        USUARIO: document.getElementById('welcomeMessage').textContent.replace('Usuario: ', '').toLowerCase().trim(),
        TIPO: tipoOp, FECHA: now.toLocaleDateString('es-AR'), HORA: hora24, C: nombreC, N: `V-${generarID()}`,
        'E$': efectivoOK, 'T$': transfOK, TOTAL: pagado,
        FECHA_ISO: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
        TIMESTAMP_MS: now.getTime(),
        USUARIO_ID: window.idUsuarioFirebase || '',
        G: esGasto ? document.getElementById('descripcionGastos').value : '', GASTO_TOTAL: esGasto ? parseM('montoGastos') : 0,
        declaracionGastos: esGasto, garrafas: JSON.stringify(garrafasArray), pin: pinParaEnviar, esClienteNuevo: esNuevo, clienteNombre: esNuevo ? document.getElementById('nombreCliente').value : '',
        clienteZona: esNuevo ? document.getElementById('nuevaZona').value : document.getElementById('zona').value, clienteCategoria: cat, clienteDireccion: document.getElementById('nuevaDireccion').value, clienteTelefono: document.getElementById('nuevoTelefono').value, clienteMail: document.getElementById('nuevoMail').value,
        operacionEnvase: modoEnv,
        ventaDesdePlanta: isRetiroPlanta,
        esFlotante: isModoFlotante,
        deudaGeneradaPlanta: deudaGeneradaPlanta,
        ALL10: q10 + (modoEnv === 'venta' ? ce10 : 0), ALL15: q15 + (modoEnv === 'venta' ? ce15 : 0), ALL45: q45 + (modoEnv === 'venta' ? ce45 : 0),
        AV10: ret10, AV15: ret15, AV45: ret45,
        [`${pfx}10`]: q10, [`${pfx}10$`]: parseM('precioGarrafa1') * q10,
        [`${pfx}15`]: q15, [`${pfx}15$`]: parseM('precioGarrafa2') * q15,
        [`${pfx}45`]: q45, [`${pfx}45$`]: parseM('precioGarrafa3') * q45,
        CE10: ce10, 'CE10$': ce10$, CE15: ce15, 'CE15$': ce15$, CE45: ce45, 'CE45$': ce45$,
        precioEnvaseAutorizado: document.getElementById('precioAutorizadoCheck') ? document.getElementById('precioAutorizadoCheck').checked : false,
        ID_CLIENTE: idClienteSeleccionado,
        cuit_dni: esNuevo ? document.getElementById('nuevoCuit').value : '',
        clienteUbicacion: ubicacionCliente,
        UBICACION: ubicacionActual,
        PUNTO_GPS: validacionGPS,
        ID_VIAJE: contextoOperacion.idViaje,
        idViaje: contextoOperacion.idViaje,
        ID_TURNO: contextoOperacion.idTurno,
        idTurno: contextoOperacion.idTurno,
        COMISION_TOTAL: comisionTotal,
        COMISION_DETALLE: comisionDetalle,
        COMISION_PAGADA: false,
        MOV_NETO_10: neto10, MOV_NETO_15: neto15, MOV_NETO_45: neto45, MOV_NETO_DINERO: netoDinero
    };

    if (payload.esClienteNuevo) payload.ID_CLIENTE = doc(collection(db, "clientes")).id; // id fijo: sirve igual si se guarda sin conexión

    if (!isModoFlotante && document.getElementById('pagoDeuda').checked) {
        payload.esPagoDeuda = true;
        payload.pagoDeudaDinero = parseM('pagoDeudaDinero');
        payload.dev10 = parseInt(document.getElementById('dev10').value) || 0;
        payload.dev15 = parseInt(document.getElementById('dev15').value) || 0;
        payload.dev45 = parseInt(document.getElementById('dev45').value) || 0;
    }

    if (AUDIO_HABILITADO && audioBase64) {
        if (!navigator.onLine) {
            showToast("⚠️ Estás sin conexión. No se subirá el audio, pero se guardará el registro.", "warning");
        } else {
            updateLoader("SUBIENDO AUDIO...", "Procesando nota de voz");
            const audioName = `${payload.N}-${idClienteSeleccionado || 'SC'}`;
            const fdAudio = new FormData();
            fdAudio.append('action', 'upload_audio');
            fdAudio.append('k', k);
            fdAudio.append('audioBase64', audioBase64);
            fdAudio.append('fileName', audioName);

            try {
                const rAudio = await fetch(SCRIPT_URL, { method: 'POST', body: fdAudio });
                const jAudio = await rAudio.json();
                if (jAudio.status === 'success') {
                    const notaActual = payload.G || '';
                    payload.G = notaActual ? `${notaActual} | Audio: ${jAudio.url}` : `Audio: ${jAudio.url}`;
                    payload.AUDIO_URL = jAudio.url;
                } else {
                    showToast("⚠️ Falló la subida de audio: " + jAudio.message, "warning");
                }
            } catch (e) {
                showToast("⚠️ Falló la subida del audio, pero se guardará el registro.", "warning");
            }
        }
    }

    if (!navigator.onLine) { guardarEnCola(payload); return; }

    updateLoader("GUARDANDO REGISTRO...", "Impactando en Firebase");

    try {
        await conTimeout(enviarVentaFirestore(payload), 20000);
        mostrarExito("La operación se registró correctamente.");
        setTimeout(() => window.location.reload(), 1200);
    } catch (e) {
        console.warn("Fallo al guardar:", e);
        if (esErrorDeRed(e)) {
            guardarEnCola(payload);
        } else {
            mostrarError("No se pudo guardar: " + (e.code || e.message || "error desconocido"));
        }
    }
}

function mostrarModalDeudas(deuda) {
    const overlay = document.getElementById('modalDeudas');
    const box = document.getElementById('modalDeudasBox');
    const content = document.getElementById('modalDeudasContent');

    let html = "";
    let tieneEnvases = deuda.env10 > 0 || deuda.env15 > 0 || deuda.env45 > 0;

    if (tieneEnvases) {
        html += `<div style="color: #aaa; font-size: 12px; margin-bottom: 5px; text-transform: uppercase;">📦 Envases en Comodato:</div>`;
        if (deuda.env10 > 0) html += `<div class="deuda-item"><span>Garrafa 10kg:</span> <span>${deuda.env10} u.</span></div>`;
        if (deuda.env15 > 0) html += `<div class="deuda-item"><span>Garrafa 15kg:</span> <span>${deuda.env15} u.</span></div>`;
        if (deuda.env45 > 0) html += `<div class="deuda-item"><span>Cilindro 45kg:</span> <span>${deuda.env45} u.</span></div>`;
    }

    if (deuda.plata > 0) {
        html += `<div class="deuda-item urgente"><span>💰 Deuda Consignacion:</span> <span>$${deuda.plata.toLocaleString('es-AR')}</span></div>`;
    }

    content.innerHTML = html;
    overlay.style.display = 'flex';
    setTimeout(() => { overlay.style.opacity = '1'; box.style.transform = 'scale(1)'; }, 10);

    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
}

function cerrarModalDeudas() {
    const overlay = document.getElementById('modalDeudas');
    const box = document.getElementById('modalDeudasBox');
    overlay.style.opacity = '0';
    box.style.transform = 'scale(0.9)';
    setTimeout(() => { overlay.style.display = 'none'; }, 300);
}

document.getElementById('btnGuardar').onclick = guardar; 
document.getElementById('btnVolver').onclick = () => VM.irInicio(k);
init();

function toggleTema() {
    if (window.VM) VM.alternarTema();
}

window.toggleTema = toggleTema;
window.sincronizarCola = sincronizarCola;
window.pedirPinSiCorresponde = pedirPinSiCorresponde;
window.togglePreciosEnvasesManuales = togglePreciosEnvasesManuales;
window.autocompletarFaltante = autocompletarFaltante;
window.cerrarModalDeudas = cerrarModalDeudas;