const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzi1x000HsPSQsWgz65jYWDWZI3cNQoKhoU5XCKagYcqs4en-d1YzO2sbnmzWlLIa9Vvw/exec";
const params = new URLSearchParams(window.location.search);
const k = params.get('k') || params.get('token');

if (!k) window.location.replace('index.html');
if (window.history.replaceState) window.history.replaceState({}, document.title, window.location.pathname);

// MODIFICACIÓN CRÍTICA: Escucha de red y auto-sync
window.addEventListener('online', function () {
    actualizarIndicadorOffline();
    sincronizarCola();
});
window.addEventListener('pageshow', function (event) {
    if (event.persisted) window.location.reload();
    actualizarIndicadorOffline();
    if (navigator.onLine) sincronizarCola();
});

let clientesData = []; let preciosData = []; let zonasActivas = []; let clienteSeleccionado = null;
let comisionesData = [];
let sessionTimeout = 180;
let idClienteSeleccionado = '';
let deudasData = {};
let mediaRecorder = null;
let audioChunks = [];
let audioBase64 = null;
let recordingTimer = null;
let recSeconds = 0;
let isSyncing = false; // CANDADO ANTI-SPAM

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

function getComisionPorRango(precioUnitario, tipoStr) {
    if (!comisionesData || comisionesData.length === 0) return 0;
    const p = Number(precioUnitario) || 0;
    const rango = comisionesData.find(r => p >= Number(r.RANGO_MENOR) && p <= Number(r.RANGO_MAYOR));
    if (rango) {
        return Number(rango[`COMISION_${tipoStr}`]) || 0;
    }
    return 0;
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

let expireTime = Date.now() + 300000;
function startTimer() {
    const timerDisplay = document.getElementById('timerDisplay');

    const verificarTiempo = () => {
        const timeLeft = Math.floor((expireTime - Date.now()) / 1000);

        if (timeLeft <= 0) {
            window.location.replace('index.html');
        } else if (timerDisplay) {
            const m = Math.floor(timeLeft / 60).toString().padStart(2, '0');
            const s = (timeLeft % 60).toString().padStart(2, '0');
            timerDisplay.textContent = `${m}:${s}`;
        }
    };

    setInterval(verificarTiempo, 1000);

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

function refreshSession() { expireTime = Date.now() + 300000; }
['click', 'mousemove', 'keydown', 'touchstart'].forEach(evt => document.addEventListener(evt, refreshSession));

const pad = (n) => n.toString().padStart(2, '0');
function generarID() { const d = new Date(); return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + Math.floor(100 + Math.random() * 900); }

function showToast(msg, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div'); toast.className = `toast ${type}`; toast.textContent = msg; container.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 3500);
}

function updateLoader(title, sub) { document.getElementById('txtLoading').textContent = title; document.getElementById('txtSubLoading').textContent = sub; }

async function init() {
    try {
        updateLoader("VERIFICANDO SESIÓN", "Comprobando credenciales...");
        document.body.style.opacity = 1;

        const fd = new FormData(); fd.append('action', 'verificarsesion'); fd.append('k', k);
        let d;
        if (navigator.onLine) {
            try {
                const r = await fetch(SCRIPT_URL, { method: 'POST', body: fd });
                d = await r.json(); if (d.status !== 'success') throw new Error();
            } catch (e) { d = { nombre: 'MODO OFFLINE' }; }
        } else { d = { nombre: 'MODO OFFLINE' }; }

        document.getElementById('welcomeMessage').textContent = `Usuario: ${d.nombre ? d.nombre.toUpperCase() : 'USUARIO'}`;
        startTimer();
        actualizarIndicadorOffline();

        calentarGPS();
        await cargarDatos();
        iniciarManejadorAudio();
        aplicarAutoFoco();

        sugerirClientesCercanos();

        // Disparo automático al iniciar
        if (navigator.onLine) {
            setTimeout(sincronizarCola, 1500);
        }
    } catch (e) { window.location.replace('index.html'); }
}

async function cargarDatos() {
    try {
        let descargoOk = false;

        // Intento 1: Si el navegador jura que hay internet, tratamos de descargar
        if (navigator.onLine) {
            try {
                updateLoader("MAPEO DE ZONAS", "Descargando rutas activas...");
                const rZonas = await fetch(`${SCRIPT_URL}?action=getactivezones`);
                const dataZ = await rZonas.json();
                zonasActivas = dataZ.zonas ? dataZ.zonas : (Array.isArray(dataZ) ? dataZ : []);

                updateLoader("SINCRONIZANDO DB", "Descargando clientes y cuadro tarifario...");
                const rDatos = await fetch(`${SCRIPT_URL}?action=getDatos&k=${k}`);
                const datos = await rDatos.json();

                const paqueteOffline = {
                    zonas: zonasActivas,
                    clientes: datos.clientes || [],
                    precios: datos.precios || [],
                    deudas: datos.deudas || {},
                    comisiones: datos.comisiones || []
                };

                localStorage.setItem('vm_paquete_offline', JSON.stringify(paqueteOffline));

                clientesData = paqueteOffline.clientes;
                preciosData = paqueteOffline.precios;
                deudasData = paqueteOffline.deudas;
                comisionesData = paqueteOffline.comisiones;

                descargoOk = true; // Todo salió perfecto
            } catch (fetchError) {
                console.warn("⚠️ Falló la red o bloqueado por CORS. Pasando a modo offline forzado.");
                descargoOk = false; // Falló en el medio del proceso
            }
        }

        // Intento 2: Si no hay internet real, o el Intento 1 rebotó, leemos la memoria local
        if (!navigator.onLine || !descargoOk) {
            const cache = localStorage.getItem('vm_paquete_offline');

            if (cache) {
                const paquete = JSON.parse(cache);

                zonasActivas = paquete.zonas || [];
                clientesData = paquete.clientes || [];
                preciosData = paquete.precios || [];
                deudasData = paquete.deudas || {};
                comisionesData = paquete.comisiones || [];

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

// ----------------------------------------------------
// LÓGICA FUZZY SEARCH Y HAVERSINE (CHIPS CERCANOS)
// ----------------------------------------------------

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
    if (!contChips) return; // Si por alguna razón no cargó el HTML nuevo, aborta limpio.

    contChips.innerHTML = ''; // Limpiamos lecturas previas

    const ubiActual = await obtenerUbicacionFantasma();
    if (ubiActual.includes("SIN_GPS")) {
        contChips.style.display = 'none';
        return;
    }

    const [latAct, lonAct] = ubiActual.split(',').map(Number);

    let clientesConDistancia = clientesData.filter(c => {
        let ubi = c.ubicacion || c.UBICACION;
        return ubi && ubi.includes(',');
    }).map(c => {
        let ubi = c.ubicacion || c.UBICACION;
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
            btn.className = 'gps-chip'; // Usamos la clase inyectada en el CSS
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

document.querySelectorAll('input, select').forEach(el => {
    if (el.classList.contains('money-input')) {
        el.addEventListener('blur', function () {
            let v = this.value.replace(/\D/g, "");
            this.value = v ? parseInt(v).toLocaleString('es-AR') : "";
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
    // CORRECCIÓN: Si es venta o consignación, el envase DEBE sumar a la caja a cobrar
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

    // CIRUGÍA DE SALDOS: Consignación permite dif positiva (Faltante = Deuda). PagoDeuda permite dif negativa (Sobrante = Saldo a favor).
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
            el.style.color = "var(--success)"; // Lo pintamos de verde éxito
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

    // --- EFECTO NEÓN Y STICKY PARA DEUDAS (SIN MODAL) ---
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

    // LÍNEA ELIMINADA: Ya no llamamos a mostrarModalDeudas() acá.
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

// Conectamos el nuevo checkbox modificador
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

        // Bloqueo de cruces: Desactiva el cobro de deudas si toca Flotantes
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
document.getElementById('pagoEfectivo').onclick = () => { document.getElementById('efectivoInput').style.display = document.getElementById('pagoEfectivo').checked ? 'block' : 'none'; actualizarTotales(); };
document.getElementById('pagoTransferencia').onclick = () => { document.getElementById('transferenciaInput').style.display = document.getElementById('pagoTransferencia').checked ? 'block' : 'none'; actualizarTotales(); };

function guardarEnCola(payload) {
    let cola = JSON.parse(localStorage.getItem('cola_ventas') || '[]');
    payload._offline_ts = new Date().getTime();
    cola.push(payload);
    localStorage.setItem('cola_ventas', JSON.stringify(cola));
    showToast("📡 SIN CONEXIÓN: Datos guardados localmente.", "warning");
    actualizarIndicadorOffline();
    setTimeout(() => window.location.reload(), 2000);
}

function actualizarIndicadorOffline() { let cola = JSON.parse(localStorage.getItem('cola_ventas') || '[]'); const btnSync = document.getElementById('btn-sync'); if (cola.length > 0) { btnSync.style.display = 'block'; btnSync.innerText = `🔄 SINCRONIZAR (${cola.length} PENDIENTES)`; } else { btnSync.style.display = 'none'; } }

async function sincronizarCola() {
    if (!navigator.onLine) { showToast("Todavía no tienes internet.", "error"); return; }
    if (isSyncing) return; // Evita que se dispare 20 veces a la vez

    let cola = JSON.parse(localStorage.getItem('cola_ventas') || '[]');
    if (cola.length === 0) return;

    isSyncing = true;
    const btnSync = document.getElementById('btn-sync');
    const origText = btnSync.innerText;
    btnSync.innerText = "Sincronizando...";
    btnSync.disabled = true;

    let errores = 0;
    let procesados = 0;
    let nuevaCola = [];

    for (let item of cola) {
        try {
            const paramsEncoded = new URLSearchParams();

            for (const key in item) {
                if (key !== '_offline_ts') {
                    if (key === 'k') {
                        paramsEncoded.append('k', k);
                    } else {
                        paramsEncoded.append(key, item[key]);
                    }
                }
            }

            const response = await fetch(SCRIPT_URL, {
                method: "POST",
                body: paramsEncoded,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });

            const json = await response.json();

            if (json.status === 'success') {
                procesados++;
            } else {
                showToast("⛔ RECHAZADO: " + (json.message || "Error desconocido en servidor"), "error");
                nuevaCola.push(item);
                errores++;
            }
        } catch (e) {
            showToast("🔌 FALLO DE RED: " + e.message, "error");
            nuevaCola.push(item);
            errores++;
        }
    }

    localStorage.setItem('cola_ventas', JSON.stringify(nuevaCola));
    showToast(`Sincronización: ${procesados} subidos, ${errores} errores.`, errores > 0 ? "warning" : "success");

    btnSync.disabled = false;
    btnSync.innerText = origText;
    actualizarIndicadorOffline();
    isSyncing = false;
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

    btn.disabled = true;
    btn.textContent = "OBTENIENDO GPS...";

    const ubicacionActual = await obtenerUbicacionFantasma();

    if (ubicacionActual.includes("SIN_GPS")) {
        showToast("⚠️ Sin señal GPS. Guardando registro sin ubicación.", "warning");
    }

    // --- RADAR DE PRECISIÓN (MÁX 60 METROS = 0.060 KM) CON TIJERA ---
    let validacionGPS = "SIN_DATOS";
    if (!ubicacionActual.includes("SIN_GPS") && clienteSeleccionado && (clienteSeleccionado.ubicacion || clienteSeleccionado.UBICACION)) {
        let ubiCli = clienteSeleccionado.ubicacion || clienteSeleccionado.UBICACION;

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

    btn.textContent = "PROCESANDO OPERACIÓN...";

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

    const hayVenta = (q10 + q15 + q45 > 0) || operandoEnvase || document.getElementById('pagoDeuda').checked || isModoFlotante;

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
    let ce10$ = 0, ce15$ = 0, ce45$ = 0;

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

    let pagado = parseM('montoEfectivo') + parseM('montoTransferencia');
    let objetivoGas = (q10 * parseM('precioGarrafa1')) + (q15 * parseM('precioGarrafa2')) + (q45 * parseM('precioGarrafa3'));
    let totalOperacion = objetivoGas + ce10$ + ce15$ + ce45$;

    let deudaGeneradaPlanta = (isModoFlotante && objetivoGas > pagado) ? (objetivoGas - pagado) : 0;

    const comisionTotal = isRetiroPlanta ? 0 : (
        (q10 * getComisionPorRango(parseM('precioGarrafa1'), '10')) +
        (q15 * getComisionPorRango(parseM('precioGarrafa2'), '15')) +
        (q45 * getComisionPorRango(parseM('precioGarrafa3'), '45'))
    );

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
        action: 'guardarregistro', k: k, USUARIO: document.getElementById('welcomeMessage').textContent.replace('Usuario: ', '').toLowerCase().trim(),
        TIPO: tipoOp, FECHA: now.toLocaleDateString('es-AR'), HORA: hora24, C: nombreC, N: generarID(),
        'E$': parseM('montoEfectivo'), 'T$': parseM('montoTransferencia'), TOTAL: pagado,
        G: esGasto ? document.getElementById('descripcionGastos').value : '', GASTO_TOTAL: esGasto ? parseM('montoGastos') : 0,
        declaracionGastos: esGasto, garrafas: JSON.stringify(garrafasArray), pin: pinParaEnviar, esClienteNuevo: esNuevo, clienteNombre: esNuevo ? document.getElementById('nombreCliente').value : '',
        clienteZona: esNuevo ? document.getElementById('nuevaZona').value : document.getElementById('zona').value, clienteCategoria: cat, clienteDireccion: document.getElementById('nuevaDireccion').value, clienteTelefono: document.getElementById('nuevoTelefono').value, clienteMail: document.getElementById('nuevoMail').value,
        operacionEnvase: modoEnv,
        ventaDesdePlanta: isRetiroPlanta,
        esFlotante: isModoFlotante,
        deudaGeneradaPlanta: deudaGeneradaPlanta,
        // --- CIRUGÍA: Evitamos el cobro/descuento doble sumando CE solo si es VENTA pura
        ALL10: q10 + (modoEnv === 'venta' ? ce10 : 0),
        ALL15: q15 + (modoEnv === 'venta' ? ce15 : 0),
        ALL45: q45 + (modoEnv === 'venta' ? ce45 : 0),
        AV10: ret10, AV15: ret15, AV45: ret45,
        [`${pfx}10`]: q10, [`${pfx}10$`]: parseM('precioGarrafa1') * q10,
        [`${pfx}15`]: q15, [`${pfx}15$`]: parseM('precioGarrafa2') * q15,
        [`${pfx}45`]: q45, [`${pfx}45$`]: parseM('precioGarrafa3') * q45,
        CE10: ce10, 'CE10$': ce10$, CE15: ce15, 'CE15$': ce15$, CE45: ce45, 'CE45$': ce45$,
        precioEnvaseAutorizado: document.getElementById('precioAutorizadoCheck') ? document.getElementById('precioAutorizadoCheck').checked : false,
        ID_CLIENTE: idClienteSeleccionado,
        cuit_dni: esNuevo ? document.getElementById('nuevoCuit').value : '',
        UBICACION: ubicacionActual,
        PUNTO_GPS: validacionGPS,
        COMISION_TOTAL: comisionTotal,
        MOV_NETO_10: neto10, MOV_NETO_15: neto15, MOV_NETO_45: neto45, MOV_NETO_DINERO: netoDinero
    };

    if (!isModoFlotante && document.getElementById('pagoDeuda').checked) {
        payload.esPagoDeuda = true;
        payload.pagoDeudaDinero = parseM('pagoDeudaDinero');
        payload.dev10 = parseInt(document.getElementById('dev10').value) || 0;
        payload.dev15 = parseInt(document.getElementById('dev15').value) || 0;
        payload.dev45 = parseInt(document.getElementById('dev45').value) || 0;
    }

    if (audioBase64) {
        if (!navigator.onLine) {
            showToast("⚠️ Estás sin conexión. No se subirá el audio, pero se guardará el registro.", "warning");
        } else {
            btn.textContent = "SUBIENDO AUDIO (ESPERE)...";
            const audioName = `${generarID()}-${idClienteSeleccionado || 'SC'}`;
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

    btn.textContent = "GUARDANDO REGISTRO...";
    const fd = new FormData();
    for (let key in payload) {
        fd.append(key, payload[key]);
    }

    try {
        const r = await fetch(SCRIPT_URL, { method: 'POST', body: fd });
        const j = await r.json();

        if (j.status === 'success') {
            showToast("✓ REGISTRO EXITOSO", "success");
            setTimeout(() => window.location.replace(`inicio.html?k=${k}`), 1500);
        } else {
            const msg = (j.message || "").toUpperCase();
            if (msg.includes("PIN")) {
                showToast("⛔ ERROR DE AUTORIZACIÓN: El PIN es incorrecto.", "error");
                btn.disabled = false;
                btn.textContent = "GUARDAR REGISTRO";
                document.getElementById('globalPinInput').value = '';
                document.getElementById('globalPinInput').focus();
            } else {
                throw new Error(j.message || "Error del servidor");
            }
        }
    } catch (e) {
        if (e.message && (e.message.includes("PIN") || e.message.includes("Autorización"))) return;
        console.warn("Fallo de red o servidor:", e);
        guardarEnCola(payload);
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

document.getElementById('btnGuardar').onclick = guardar; document.getElementById('btnVolver').onclick = () => window.location.replace(`inicio.html?k=${k}`); init();


function toggleTema() {
    var btn = document.getElementById('btnTema');
    if (document.body.classList.toggle('tema-claro')) {
        btn.textContent = '🌙 Oscuro';
        localStorage.setItem('tema_repartos', 'claro');
    } else {
        btn.textContent = '☀️ Claro';
        localStorage.setItem('tema_repartos', 'oscuro');
    }
}

function controlPatovica() {
    const ahora = new Date();
    const hora = ahora.getHours();
    const min = ahora.getMinutes();
    const capa = document.getElementById('capaMantenimiento');

    const estaEnBloqueo = (hora === 23 && min >= 45) || (hora === 0 && min <= 5);

    if (estaEnBloqueo) {
        capa.style.display = 'flex';
        document.onkeydown = function (e) { return false; };
    } else {
        capa.style.display = 'none';
        document.onkeydown = null;
    }
}

controlPatovica();
setInterval(controlPatovica, 30000);