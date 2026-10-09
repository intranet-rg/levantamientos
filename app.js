'use strict';
/* =========================================================
   LEVANTAMIENTOS EN TERRENO — App (funciona sin conexión)
   Sitio → Área → Sistema → Equipo (+ fotos)
   ========================================================= */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
const ahoraISO = () => new Date().toISOString();
const vivo = (r) => r && !r.eliminado;

const TIPOS = {
  motor: { nombre: 'Motor eléctrico', pref: 'M', color: '#2563eb' },
  reductor: { nombre: 'Reductor', pref: 'R', color: '#7c3aed' },
  motorreductor: { nombre: 'Motorreductor', pref: 'MR', color: '#0d9488' },
  acople: { nombre: 'Acoplamiento', pref: 'A', color: '#ca8a04' },
  freno: { nombre: 'Freno', pref: 'F', color: '#dc2626' },
  variador: { nombre: 'Variador de frecuencia', pref: 'VDF', color: '#059669' },
  tablero: { nombre: 'Tablero eléctrico', pref: 'TAB', color: '#475569' },
  otro: { nombre: 'Otro equipo', pref: 'EQ', color: '#64748b' },
};
const infoTipo = (t) => TIPOS[t] || { nombre: t.charAt(0).toUpperCase() + t.slice(1), pref: t.slice(0, 3).toUpperCase(), color: '#64748b' };
const ESTADOS = ['Operativo', 'Operativo con observaciones', 'Con falla', 'Fuera de servicio'];
const COLOR_ESTADO = { 'Operativo': '#16a34a', 'Operativo con observaciones': '#ca8a04', 'Con falla': '#dc2626', 'Fuera de servicio': '#6b7280' };
const ETIQUETAS_FOTO = ['Placa', 'General', 'Montaje', 'Eje / Medida', 'Entorno', 'Falla', 'Otro'];
const ENTIDADES = ['sitios', 'areas', 'sistemas', 'equipos', 'fotos'];

const S = { usuario: null, apiUrl: '', plantillas: [], ultimaSync: 0, sincronizando: false, etiquetaFoto: 'Placa' };

/* ===================== Utilidades ===================== */

function toast(msg, ms = 2500) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function fecha(iso) {
  if (!iso) return '—';
  const d = new Date(typeof iso === 'number' ? iso : iso);
  return d.toLocaleDateString('es-CL', { day: '2-digit', month: 'short' }) + ' ' + d.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
}

async function guardar(ent, rec) {
  const ahora = ahoraISO();
  if (!rec.creadoEn) { rec.creadoEn = ahora; rec.creadoPor = S.usuario.nombre; }
  rec.actualizadoEn = ahora;
  rec.actualizadoPor = S.usuario.nombre;
  rec._dirty = true;
  await DB.put(ent, rec);
  actualizarBadge();
  return rec;
}

async function hijos(ent, campoPadre, idPadre) {
  return (await DB.all(ent)).filter((r) => vivo(r) && r[campoPadre] === idPadre);
}

function plantilla(tipo) { return S.plantillas.filter((p) => p.tipo === tipo); }
function tiposDisponibles() {
  const t = [...new Set(S.plantillas.map((p) => p.tipo).filter((x) => !x.startsWith('_')))];
  const orden = Object.keys(TIPOS);
  return t.sort((a, b) => (orden.indexOf(a) + 1 || 99) - (orden.indexOf(b) + 1 || 99));
}

function avance(tipo, datos) {
  const req = plantilla(tipo).filter((p) => p.obligatorio);
  const ok = req.filter((p) => String((datos || {})[p.campo] ?? '').trim() !== '').length;
  return { ok, total: req.length };
}

/* ===================== Comunicación con el servidor ===================== */

async function api(accion, datos = {}, timeout = 60000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(S.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ accion, sesion: S.usuario?.sesion, ...datos }),
      signal: ctrl.signal,
      redirect: 'follow',
    });
    const j = await r.json();
    if (!j.ok) {
      const msg = j.error || 'Error del servidor';
      if (msg.startsWith('SESION:')) { S.sesionVencida = true; avisoSesion(); throw new Error(msg.slice(7).trim()); }
      throw new Error(msg);
    }
    return j;
  } finally {
    clearTimeout(t);
  }
}

function avisoSesion() { $('#avisoSesion').hidden = !(S.usuario && S.sesionVencida); }

const sinDirty = ({ _dirty, _pending, ...r }) => r;

async function contarPendientes() {
  let n = 0;
  for (const e of ENTIDADES) n += (await DB.all(e)).filter((r) => r._dirty || r._pending).length;
  return n;
}

async function actualizarBadge() {
  const n = await contarPendientes();
  const b = $('#badge');
  b.textContent = n;
  b.hidden = n === 0;
}

async function sincronizar({ silencioso = false, completa = false } = {}) {
  if (S.sincronizando || !S.usuario) return;
  if (S.sesionVencida && silencioso) return;
  if (!navigator.onLine) { if (!silencioso) toast('Sin conexión. Se sincronizará al volver la señal.'); return; }
  S.sincronizando = true;
  $('#btnSync').classList.add('girando');
  try {
    // 1) Enviar cambios locales (registros)
    const cambios = {};
    const enviados = [];
    for (const e of ENTIDADES) {
      const sucios = (await DB.all(e)).filter((r) => r._dirty && !r._pending);
      if (sucios.length) {
        cambios[e] = sucios.map(sinDirty);
        sucios.forEach((r) => enviados.push([e, r.id, r.actualizadoEn]));
      }
    }
    const desde = completa ? 0 : S.ultimaSync;
    const res = await api('sync', { cambios, desde });

    // 2) Marcar enviados como sincronizados (si no se editaron mientras tanto)
    for (const [e, id, act] of enviados) {
      const r = await DB.get(e, id);
      if (r && r.actualizadoEn === act) { r._dirty = false; await DB.put(e, r); }
    }

    // 3) Recibir cambios de otros técnicos
    for (const e of ENTIDADES) {
      for (const rec of res.datos[e] || []) {
        const local = await DB.get(e, rec.id);
        if (local && (local._dirty || local._pending) && String(local.actualizadoEn) > String(rec.actualizadoEn)) continue;
        await DB.put(e, { ...rec, _dirty: false, _pending: false });
      }
    }
    S.plantillas = res.plantillas || S.plantillas;
    await DB.setMeta('plantillas', S.plantillas);
    S.ultimaSync = res.ahora;
    await DB.setMeta('ultimaSync', S.ultimaSync);

    // 4) Subir fotos pendientes
    const pendientes = (await DB.all('fotos')).filter((f) => f._pending && !f.eliminado);
    let subidas = 0;
    for (const f of pendientes) {
      const blob = await DB.get('blobs', f.id);
      if (!blob) continue;
      const r = await api('foto', { foto: sinDirty(f), base64: blob.data }, 120000);
      const actual = await DB.get('fotos', f.id);
      await DB.put('fotos', { ...actual, driveId: r.foto.driveId, url: r.foto.url, archivo: r.foto.archivo, _pending: false,
        _dirty: actual.actualizadoEn !== f.actualizadoEn });
      subidas++;
    }

    if (res.rechazados && res.rechazados.length && !completa) {
      S.sincronizando = false;
      await sincronizar({ silencioso: true, completa: true });
      return;
    }
    if (!silencioso) toast('Sincronizado ✓' + (subidas ? ` · ${subidas} foto(s) subidas` : ''));
    const ruta = location.hash.split('/')[1] || '';
    if (!['equipo', 'form', 'nuevo', 'foto'].includes(ruta)) render();
  } catch (err) {
    if (!silencioso) toast('No se pudo sincronizar: ' + err.message, 4000);
  } finally {
    S.sincronizando = false;
    $('#btnSync').classList.remove('girando');
    actualizarBadge();
  }
}

/* ===================== Fotos ===================== */

function comprimir(file, max = 1600, calidad = 0.75) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      res(c.toDataURL('image/jpeg', calidad));
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('No se pudo leer la imagen')); };
    img.src = url;
  });
}

async function agregarFotos(equipoId, archivos) {
  for (const file of archivos) {
    try {
      const data = await comprimir(file);
      const foto = { id: uid(), equipoId, etiqueta: S.etiquetaFoto, nota: '', archivo: '', driveId: '', url: '', eliminado: false, _pending: true };
      await DB.put('blobs', { id: foto.id, data });
      await guardar('fotos', foto);
    } catch (e) { toast(e.message); }
  }
  await pintarFotos(equipoId);
}

// Descarga desde el servidor una foto que no está en este equipo y la deja guardada
const descargando = {};
async function traerFoto(f) {
  const ya = await DB.get('blobs', f.id);
  if (ya) return ya.data;
  if (!f.driveId || !navigator.onLine || !S.usuario) return null;
  if (!descargando[f.id]) {
    descargando[f.id] = api('verFoto', { id: f.id }, 90000)
      .then(async (r) => { await DB.put('blobs', { id: f.id, data: r.data, remota: true }); return r.data; })
      .catch(() => null)
      .finally(() => { delete descargando[f.id]; });
  }
  return descargando[f.id];
}

async function pintarFotos(equipoId) {
  const cont = $('#gridFotos');
  if (!cont) return;
  const fotos = (await hijos('fotos', 'equipoId', equipoId)).sort((a, b) => String(a.creadoEn).localeCompare(String(b.creadoEn)));
  $('#nFotos').textContent = fotos.length;
  if (!fotos.length) { cont.innerHTML = '<p class="vacio">Sin fotos. Empieza por la placa.</p>'; return; }
  const html = [];
  for (const f of fotos) {
    const b = await DB.get('blobs', f.id);
    html.push(`<a class="foto" href="#/foto/${f.id}">
      ${b ? `<img src="${b.data}" alt="">` : `<div class="sin-local" data-remota="${f.id}">${f.driveId ? (navigator.onLine ? 'Cargando…' : 'Sin señal') : 'Subiendo…'}</div>`}
      <span class="etq">${esc(f.etiqueta)}</span>
      ${f._pending ? '<span class="pend" title="Pendiente de subir"></span>' : ''}
    </a>`);
  }
  cont.innerHTML = html.join('');
  // Fotos que están en Drive pero no en este equipo: se descargan de a una
  for (const f of fotos) {
    const caja = cont.querySelector(`[data-remota="${f.id}"]`);
    if (!caja || !f.driveId) continue;
    const data = await traerFoto(f);
    if (data && caja.isConnected) caja.outerHTML = `<img src="${data}" alt="">`;
    else if (caja.isConnected) caja.textContent = 'Sin señal';
  }
}

/* ===================== Formularios ===================== */

function campoHTML(p, valor) {
  const id = 'f_' + p.campo;
  const req = p.obligatorio ? '<b class="req">*</b>' : '';
  const unidad = p.unidad ? `<span class="unidad">${esc(p.unidad)}</span>` : '';
  const ayuda = p.ayuda ? `<small>${esc(p.ayuda)}</small>` : '';
  const v = valor ?? '';
  let input;
  switch (p.tipoDato) {
    case 'lista':
      input = `<select id="${id}" data-k="${esc(p.campo)}"><option value="">—</option>${p.opciones
        .map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}${v && !p.opciones.includes(v) ? `<option selected>${esc(v)}</option>` : ''}</select>`;
      break;
    case 'sino':
      input = `<select id="${id}" data-k="${esc(p.campo)}"><option value="">—</option>${['Sí', 'No']
        .map((o) => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
      break;
    case 'textarea':
      input = `<textarea id="${id}" data-k="${esc(p.campo)}" rows="3">${esc(v)}</textarea>`;
      break;
    case 'numero':
      input = `<input id="${id}" data-k="${esc(p.campo)}" inputmode="decimal" autocomplete="off" value="${esc(v)}">`;
      break;
    default:
      input = `<input id="${id}" data-k="${esc(p.campo)}" autocomplete="off" value="${esc(v)}">`;
  }
  return `<label class="campo ${p.obligatorio && !String(v).trim() ? 'falta' : ''}" for="${id}">
    <span class="lbl">${esc(p.etiqueta)} ${req}</span>
    <div class="ctrl">${input}${unidad}</div>${ayuda}</label>`;
}

function gruposHTML(tipo, datos, abiertos = true) {
  const campos = plantilla(tipo);
  if (!campos.length) return '';
  const grupos = [];
  campos.forEach((p) => {
    let g = grupos.find((x) => x.nombre === p.grupo);
    if (!g) { g = { nombre: p.grupo, campos: [] }; grupos.push(g); }
    g.campos.push(p);
  });
  return grupos.map((g) => `<details class="grupo" ${abiertos ? 'open' : ''}>
      <summary>${esc(g.nombre)}</summary>
      <div class="campos" data-scope="datos">${g.campos.map((p) => campoHTML(p, datos[p.campo])).join('')}</div>
    </details>`).join('');
}

function leerDatos(contenedor) {
  const datos = {};
  $$('[data-scope="datos"] [data-k]', contenedor).forEach((el) => { datos[el.dataset.k] = el.value.trim(); });
  return datos;
}

const FORM_BASE = {
  sitios: {
    titulo: 'Sitio', padre: null,
    campos: [
      { k: 'cliente', l: 'Cliente / empresa', req: true },
      { k: 'nombre', l: 'Nombre del sitio / faena / planta', req: true },
      { k: 'ubicacion', l: 'Ubicación / dirección' },
      { k: 'contacto', l: 'Contacto en sitio (nombre, teléfono)' },
      { k: 'notas', l: 'Notas', t: 'textarea' },
    ],
  },
  areas: {
    titulo: 'Área', padre: 'sitioId',
    campos: [
      { k: 'nombre', l: 'Nombre del área / zona / planta', req: true, ayuda: 'Ej: Chancado secundario, Sala de bombas' },
      { k: 'notas', l: 'Notas', t: 'textarea' },
    ],
  },
  sistemas: {
    titulo: 'Sistema', padre: 'areaId', plantilla: '_sistema',
    campos: [
      { k: 'nombre', l: 'Nombre del sistema / accionamiento', req: true, ayuda: 'Ej: Correa CV-03, Bomba B-101, Agitador TK-2' },
    ],
  },
};
const RUTA_DE = { sitios: 'sitio', areas: 'area', sistemas: 'sistema', equipos: 'equipo' };

/* ===================== Vistas ===================== */

function cabecera(titulo, subtitulo = '', volver = null) {
  $('#titulo').textContent = titulo;
  $('#subtitulo').textContent = subtitulo;
  const b = $('#btnVolver');
  b.hidden = !volver;
  b.onclick = () => { location.hash = volver; };
}

async function ruta(ent, id) {
  // Devuelve [sitio, area, sistema] según corresponda
  const out = {};
  if (ent === 'equipos') { out.equipo = await DB.get('equipos', id); id = out.equipo?.sistemaId; ent = 'sistemas'; }
  if (ent === 'sistemas') { out.sistema = await DB.get('sistemas', id); id = out.sistema?.areaId; ent = 'areas'; }
  if (ent === 'areas') { out.area = await DB.get('areas', id); id = out.area?.sitioId; ent = 'sitios'; }
  if (ent === 'sitios') out.sitio = await DB.get('sitios', id);
  return out;
}

function tarjeta(href, titulo, sub, derecha = '', extra = '') {
  return `<a class="tarjeta" href="${href}">${extra}<div class="tx"><div class="t1">${titulo}</div><div class="t2">${sub}</div></div>
    <div class="der">${derecha}<svg viewBox="0 0 24 24" class="flecha"><path d="M9 5l7 7-7 7"/></svg></div></a>`;
}

function esperarGoogle(ms = 10000) {
  return new Promise((res) => {
    const t0 = Date.now();
    (function mirar() {
      if (window.google && google.accounts && google.accounts.id) return res(true);
      if (Date.now() - t0 > ms) return res(false);
      setTimeout(mirar, 200);
    })();
  });
}

function urlDeConfig() {
  return CONFIG.API_URL && !CONFIG.API_URL.startsWith('PEGAR') ? CONFIG.API_URL.trim() : '';
}

async function vistaLogin() {
  const reingreso = !!S.usuario;
  cabecera(CONFIG.NOMBRE_APP, reingreso ? (S.usuario.email || '') : '', reingreso ? '#/' : null);
  if (!reingreso) ['#btnSync', '#btnAjustes'].forEach((x) => { $(x).hidden = true; });
  const urlConfig = urlDeConfig();
  const urlGuardada = urlConfig || (await DB.meta('apiUrl')) || '';
  $('#app').innerHTML = `<div class="panel login">
    <h2>${reingreso ? 'Volver a iniciar sesión' : 'Ingreso'}</h2>
    <p class="nota">${reingreso
      ? 'Tu sesión venció. Lo que tienes en este teléfono está a salvo; inicia sesión para seguir sincronizando.'
      : 'Entra con tu cuenta de Google de la empresa. La primera vez necesitas señal; después la app funciona sin conexión.'}</p>
    <div id="gBtn" class="g-btn"><p class="nota">Cargando…</p></div>
    <p class="nota centro">Solo cuentas @${esc(CONFIG.DOMINIO)}</p>
    ${urlConfig ? '' : `<details open><summary>Servidor</summary>
      <label class="campo"><span class="lbl">URL de Apps Script (/exec)</span><div class="ctrl"><input id="inUrl" value="${esc(urlGuardada)}"></div></label>
    </details>`}
  </div>`;
  const caja = $('#gBtn');
  if (!navigator.onLine) { caja.innerHTML = '<p class="vacio">Necesitas señal para iniciar sesión.</p>'; return; }
  if (!CONFIG.GOOGLE_CLIENT_ID || CONFIG.GOOGLE_CLIENT_ID.startsWith('PEGAR')) {
    caja.innerHTML = '<p class="vacio">Falta configurar GOOGLE_CLIENT_ID en config.js.</p>'; return;
  }
  if (!(await esperarGoogle())) {
    caja.innerHTML = '<p class="vacio">No se pudo cargar el inicio de sesión de Google. Revisa la señal y vuelve a abrir la app.</p>'; return;
  }
  google.accounts.id.initialize({
    client_id: CONFIG.GOOGLE_CLIENT_ID,
    hd: CONFIG.DOMINIO,
    auto_select: false,
    ux_mode: 'popup',
    callback: async (resp) => {
      S.apiUrl = urlConfig || ($('#inUrl') ? $('#inUrl').value.trim() : '');
      if (!S.apiUrl) { toast('Falta la URL del servidor'); return; }
      caja.innerHTML = '<p class="nota">Conectando…</p>';
      try {
        const r = await api('login', { idToken: resp.credential });
        if (reingreso && S.usuario.email && S.usuario.email !== r.email && (await contarPendientes())) {
          throw new Error(`Hay cambios sin subir de ${S.usuario.email}. Inicia sesión con esa cuenta.`);
        }
        S.usuario = { nombre: r.usuario, email: r.email, sesion: r.sesion };
        S.sesionVencida = false;
        avisoSesion();
        await DB.setMeta('apiUrl', S.apiUrl);
        await DB.setMeta('usuario', S.usuario);
        iniciarSesion();
        await sincronizar({ completa: !reingreso });
        location.hash = '#/';
        render();
      } catch (e) {
        toast(e.message === 'Failed to fetch' ? 'Sin conexión con el servidor. Revisa la URL y la señal.' : e.message, 5000);
        vistaLogin();
      }
    },
  });
  caja.innerHTML = '';
  google.accounts.id.renderButton(caja, { theme: 'filled_blue', size: 'large', shape: 'pill', text: 'signin_with', locale: 'es', width: 280 });
}

async function vistaInicio() {
  cabecera(CONFIG.NOMBRE_APP, S.usuario.nombre);
  const [sitios, areas, sistemas, equipos] = await Promise.all(['sitios', 'areas', 'sistemas', 'equipos'].map((e) => DB.all(e)));
  const area = Object.fromEntries(areas.map((a) => [a.id, a]));
  const sis = Object.fromEntries(sistemas.map((s) => [s.id, s]));
  const nEq = {};
  equipos.filter(vivo).forEach((e) => {
    const s = sis[e.sistemaId]; const a = s && area[s.areaId];
    if (a) nEq[a.sitioId] = (nEq[a.sitioId] || 0) + 1;
  });
  const lista = sitios.filter(vivo).sort((a, b) => (a.cliente + a.nombre).localeCompare(b.cliente + b.nombre));
  $('#app').innerHTML = `
    <div class="buscar"><input id="q" type="search" placeholder="Buscar equipo por tag, marca, modelo o serie…"></div>
    <div id="resultados"></div>
    <div id="listaSitios">
      <h3 class="seccion">Sitios <span>${lista.length}</span></h3>
      ${lista.length ? lista.map((s) => tarjeta(`#/sitio/${s.id}`, esc(s.nombre), esc(s.cliente) + (s.ubicacion ? ' · ' + esc(s.ubicacion) : ''),
        `<span class="cnt">${nEq[s.id] || 0} eq.</span>`)).join('') : '<p class="vacio">Aún no hay sitios. Crea el primero.</p>'}
    </div>
    <button class="fab" onclick="location.hash='#/nuevo/sitios/-'">+ Nuevo sitio</button>`;
  $('#q').oninput = debounce(async (ev) => {
    const q = ev.target.value.trim().toLowerCase();
    $('#listaSitios').hidden = !!q;
    if (!q) { $('#resultados').innerHTML = ''; return; }
    const sitio = Object.fromEntries(sitios.map((s) => [s.id, s]));
    const r = equipos.filter(vivo).filter((e) => [e.tag, e.marca, e.modelo, e.serie, infoTipo(e.tipo).nombre].join(' ').toLowerCase().includes(q)).slice(0, 50);
    $('#resultados').innerHTML = r.length ? r.map((e) => {
      const s = sis[e.sistemaId] || {}; const a = area[s.areaId] || {}; const si = sitio[a.sitioId] || {};
      return tarjeta(`#/equipo/${e.id}`, `${esc(e.tag)} · ${esc(infoTipo(e.tipo).nombre)}`, [si.nombre, a.nombre, s.nombre].map(esc).join(' › '), '', chipTipo(e.tipo));
    }).join('') : '<p class="vacio">Sin resultados.</p>';
  }, 200);
}

async function vistaSitio(id) {
  const sitio = await DB.get('sitios', id);
  if (!vivo(sitio)) { location.hash = '#/'; return; }
  cabecera(sitio.nombre, sitio.cliente, '#/');
  const areas = (await hijos('areas', 'sitioId', id)).sort((a, b) => a.nombre.localeCompare(b.nombre));
  const sistemas = (await DB.all('sistemas')).filter(vivo);
  $('#app').innerHTML = `
    <div class="panel info">
      ${sitio.ubicacion ? `<div><b>Ubicación:</b> ${esc(sitio.ubicacion)}</div>` : ''}
      ${sitio.contacto ? `<div><b>Contacto:</b> ${esc(sitio.contacto)}</div>` : ''}
      ${sitio.notas ? `<div class="notas">${esc(sitio.notas)}</div>` : ''}
      <a class="btn chico" href="#/form/sitios/${id}">Editar sitio</a>
    </div>
    <h3 class="seccion">Áreas <span>${areas.length}</span></h3>
    ${areas.length ? areas.map((a) => tarjeta(`#/area/${a.id}`, esc(a.nombre), esc(a.notas || ''),
      `<span class="cnt">${sistemas.filter((s) => s.areaId === a.id).length} sist.</span>`)).join('') : '<p class="vacio">Agrega las áreas o zonas que vas a recorrer.</p>'}
    <button class="fab" onclick="location.hash='#/nuevo/areas/${id}'">+ Nueva área</button>`;
}

async function vistaArea(id) {
  const { area, sitio } = await ruta('areas', id);
  if (!vivo(area)) { location.hash = '#/'; return; }
  cabecera(area.nombre, sitio?.nombre || '', `#/sitio/${area.sitioId}`);
  const sistemas = (await hijos('sistemas', 'areaId', id)).sort((a, b) => a.nombre.localeCompare(b.nombre));
  const equipos = (await DB.all('equipos')).filter(vivo);
  $('#app').innerHTML = `
    <div class="panel info">${area.notas ? `<div class="notas">${esc(area.notas)}</div>` : ''}
      <a class="btn chico" href="#/form/areas/${id}">Editar área</a></div>
    <h3 class="seccion">Sistemas <span>${sistemas.length}</span></h3>
    ${sistemas.length ? sistemas.map((s) => {
      const eqs = equipos.filter((e) => e.sistemaId === s.id).sort((a, b) => a.orden - b.orden);
      return tarjeta(`#/sistema/${s.id}`, esc(s.nombre), eqs.map((e) => esc(e.tag)).join(' → ') || esc(s.datos?.aplicacion || 'Sin equipos'),
        `<span class="cnt">${eqs.length} eq.</span>`);
    }).join('') : '<p class="vacio">Un sistema es un accionamiento completo: ej. motor → acople → reductor.</p>'}
    <button class="fab" onclick="location.hash='#/nuevo/sistemas/${id}'">+ Nuevo sistema</button>`;
}

function chipTipo(tipo) {
  const t = infoTipo(tipo);
  return `<span class="chip-tipo" style="background:${t.color}">${esc(t.pref)}</span>`;
}

async function vistaSistema(id) {
  const { sistema, area, sitio } = await ruta('sistemas', id);
  if (!vivo(sistema)) { location.hash = '#/'; return; }
  cabecera(sistema.nombre, [sitio?.nombre, area?.nombre].filter(Boolean).join(' › '), `#/area/${sistema.areaId}`);
  const equipos = (await hijos('equipos', 'sistemaId', id)).sort((a, b) => a.orden - b.orden);
  const fotos = (await DB.all('fotos')).filter(vivo);
  const d = sistema.datos || {};
  const resumen = plantilla('_sistema').filter((p) => d[p.campo]).slice(0, 4)
    .map((p) => `<div><b>${esc(p.etiqueta)}:</b> ${esc(d[p.campo])} ${esc(p.unidad)}</div>`).join('');
  $('#app').innerHTML = `
    <div class="panel info">${resumen || '<div class="nota">Sin datos de aplicación todavía.</div>'}
      <a class="btn chico" href="#/form/sistemas/${id}">Editar sistema / aplicación</a></div>
    <h3 class="seccion">Equipos en orden de transmisión <span>${equipos.length}</span></h3>
    <div class="cadena">
    ${equipos.length ? equipos.map((e, i) => {
      const av = avance(e.tipo, e.datos);
      const nf = fotos.filter((f) => f.equipoId === e.id).length;
      return `<div class="eslabon">
        ${tarjeta(`#/equipo/${e.id}`, `${esc(e.tag)} <small>${esc(infoTipo(e.tipo).nombre)}</small>`,
          `${esc([e.marca, e.modelo].filter(Boolean).join(' ') || 'Sin marca/modelo')}`,
          `<span class="estado" style="background:${COLOR_ESTADO[e.estado] || '#999'}" title="${esc(e.estado)}"></span>
           <span class="cnt">${nf} foto${nf === 1 ? '' : 's'} · ${av.ok}/${av.total} oblig.</span>`, chipTipo(e.tipo))}
        <div class="mover">
          <button ${i === 0 ? 'disabled' : ''} onclick="moverEquipo('${e.id}',-1)" aria-label="Subir">▲</button>
          <button ${i === equipos.length - 1 ? 'disabled' : ''} onclick="moverEquipo('${e.id}',1)" aria-label="Bajar">▼</button>
        </div>
      </div>${i < equipos.length - 1 ? '<div class="conector">↓</div>' : ''}`;
    }).join('') : '<p class="vacio">Agrega los equipos en el orden de la transmisión: motor → acople → reductor → carga. El variador o tablero también van aquí aunque estén en otra sala.</p>'}
    </div>
    <button class="fab" onclick="elegirTipo('${id}')">+ Agregar equipo</button>`;
}

async function moverEquipo(id, delta) {
  const e = await DB.get('equipos', id);
  const lista = (await hijos('equipos', 'sistemaId', e.sistemaId)).sort((a, b) => a.orden - b.orden);
  lista.forEach((x, i) => { x.orden = i + 1; });
  const i = lista.findIndex((x) => x.id === id);
  const j = i + delta;
  if (j < 0 || j >= lista.length) return;
  [lista[i].orden, lista[j].orden] = [lista[j].orden, lista[i].orden];
  for (const x of lista) await guardar('equipos', x);
  render();
}

function elegirTipo(sistemaId) {
  const tipos = tiposDisponibles();
  const fondo = document.createElement('div');
  fondo.className = 'modal';
  fondo.innerHTML = `<div class="hoja"><h3>¿Qué equipo vas a levantar?</h3>
    ${tipos.length ? tipos.map((t) => `<button class="opcion" data-t="${esc(t)}">${chipTipo(t)} ${esc(infoTipo(t).nombre)}</button>`).join('')
      : '<p class="vacio">No hay plantillas. Sincroniza con señal para descargarlas.</p>'}
    <button class="btn" data-cerrar>Cancelar</button></div>`;
  document.body.appendChild(fondo);
  fondo.onclick = async (ev) => {
    const b = ev.target.closest('[data-t]');
    if (b) {
      fondo.remove();
      const id = await crearEquipo(sistemaId, b.dataset.t);
      location.hash = `#/equipo/${id}`;
    } else if (ev.target === fondo || ev.target.hasAttribute('data-cerrar')) fondo.remove();
  };
}

async function sugerirTag(sistemaId, tipo) {
  const eqs = await hijos('equipos', 'sistemaId', sistemaId);
  const pref = infoTipo(tipo).pref;
  const n = eqs.filter((e) => e.tipo === tipo).length + 1;
  return `${pref}-${String(n).padStart(2, '0')}`;
}

async function crearEquipo(sistemaId, tipo, base = null) {
  const eqs = await hijos('equipos', 'sistemaId', sistemaId);
  const e = {
    id: uid(), sistemaId, tipo,
    tag: await sugerirTag(sistemaId, tipo),
    orden: Math.max(0, ...eqs.map((x) => x.orden || 0)) + 1,
    marca: base?.marca || '', modelo: base?.modelo || '', serie: '', estado: base?.estado || 'Operativo',
    datos: base ? { ...base.datos } : {}, observaciones: '', eliminado: false,
  };
  await guardar('equipos', e);
  return e.id;
}

async function vistaEquipo(id) {
  const { equipo: e, sistema, area } = await ruta('equipos', id);
  if (!vivo(e)) { location.hash = '#/'; return; }
  const t = infoTipo(e.tipo);
  cabecera(`${e.tag} · ${t.nombre}`, [area?.nombre, sistema?.nombre].filter(Boolean).join(' › '), `#/sistema/${e.sistemaId}`);
  e.datos = e.datos || {};
  $('#app').innerHTML = `
    <form id="fEq" class="formulario" autocomplete="off" onsubmit="return false">
      <div class="guardado" id="guardado">Guardado en el equipo ✓</div>
      <section class="panel fotos-panel">
        <div class="fila-tit"><h3>Fotos <span id="nFotos">0</span></h3></div>
        <div class="etiquetas">${ETIQUETAS_FOTO.map((x) => `<button type="button" class="etq-btn ${x === S.etiquetaFoto ? 'activa' : ''}" data-etq="${esc(x)}">${esc(x)}</button>`).join('')}</div>
        <div class="botones-foto">
          <label class="btn primario">📷 Tomar foto<input id="inCam" type="file" accept="image/*" capture="environment" hidden></label>
          <label class="btn">Galería<input id="inGal" type="file" accept="image/*" multiple hidden></label>
        </div>
        <div id="gridFotos" class="grid-fotos"></div>
      </section>

      <details class="grupo" open><summary>Identificación</summary><div class="campos" data-scope="base">
        <label class="campo"><span class="lbl">Tag / código <b class="req">*</b></span><div class="ctrl"><input data-b="tag" value="${esc(e.tag)}"></div><small>Como está marcado en planta, o el sugerido</small></label>
        <label class="campo"><span class="lbl">Marca</span><div class="ctrl"><input data-b="marca" value="${esc(e.marca)}" list="marcas"></div></label>
        <label class="campo"><span class="lbl">Modelo</span><div class="ctrl"><input data-b="modelo" value="${esc(e.modelo)}"></div></label>
        <label class="campo"><span class="lbl">N° de serie</span><div class="ctrl"><input data-b="serie" value="${esc(e.serie)}"></div></label>
        <label class="campo"><span class="lbl">Estado</span><div class="ctrl"><select data-b="estado">${ESTADOS.map((x) => `<option ${x === e.estado ? 'selected' : ''}>${x}</option>`).join('')}</select></div></label>
      </div></details>
      <datalist id="marcas">${['Siemens', 'WEG', 'ABB', 'Schneider Electric', 'TECO Westinghouse', 'Rossi', 'NORD', 'SEW-Eurodrive', 'Flender', 'Falk', 'Bonfiglioli', 'Sumitomo', 'Veikong', 'Newman', 'Rexnord', 'KTR', 'Danfoss', 'Allen-Bradley', 'Baldor', 'Toshiba'].map((m) => `<option>${m}</option>`).join('')}</datalist>

      ${gruposHTML(e.tipo, e.datos)}

      <details class="grupo" open><summary>Observaciones</summary><div class="campos" data-scope="base">
        <label class="campo"><span class="lbl">Observaciones / hallazgos</span><div class="ctrl"><textarea data-b="observaciones" rows="4">${esc(e.observaciones)}</textarea></div></label>
      </div></details>

      <div class="acciones">
        <button type="button" class="btn" id="btnDuplicar">Duplicar equipo</button>
        <button type="button" class="btn peligro" id="btnEliminar">Eliminar</button>
      </div>
    </form>`;

  const form = $('#fEq');
  const guardarEq = async () => {
    const actual = await DB.get('equipos', id);
    $$('[data-b]', form).forEach((el) => { actual[el.dataset.b] = el.value.trim(); });
    actual.datos = { ...(actual.datos || {}), ...leerDatos(form) };
    await guardar('equipos', actual);
    $$('.campo', form).forEach((c) => {
      const el = $('[data-k]', c);
      if (el && $('.req', c)) c.classList.toggle('falta', !el.value.trim());
    });
    $('#titulo').textContent = `${actual.tag} · ${t.nombre}`;
    const g = $('#guardado'); g.classList.add('visible'); clearTimeout(g._t); g._t = setTimeout(() => g.classList.remove('visible'), 1200);
  };
  form.addEventListener('input', debounce(guardarEq, 600));
  form.addEventListener('change', guardarEq);

  $$('.etq-btn', form).forEach((b) => {
    b.onclick = () => { S.etiquetaFoto = b.dataset.etq; $$('.etq-btn', form).forEach((x) => x.classList.toggle('activa', x === b)); };
  });
  ['#inCam', '#inGal'].forEach((s) => {
    $(s).onchange = async (ev) => { const files = [...ev.target.files]; ev.target.value = ''; await agregarFotos(id, files); };
  });
  $('#btnEliminar').onclick = async () => {
    if (!confirm(`¿Eliminar ${e.tag}? Se ocultará para todos los técnicos.`)) return;
    const actual = await DB.get('equipos', id);
    actual.eliminado = true;
    await guardar('equipos', actual);
    location.hash = `#/sistema/${e.sistemaId}`;
  };
  $('#btnDuplicar').onclick = async () => {
    const actual = await DB.get('equipos', id);
    const nuevo = await crearEquipo(actual.sistemaId, actual.tipo, actual);
    toast('Equipo duplicado (sin fotos ni N° de serie)');
    location.hash = `#/equipo/${nuevo}`;
  };
  pintarFotos(id);
}

async function vistaFoto(id) {
  const f = await DB.get('fotos', id);
  if (!vivo(f)) { history.back(); return; }
  const eq = await DB.get('equipos', f.equipoId);
  cabecera(`Foto · ${f.etiqueta}`, eq ? eq.tag : '', `#/equipo/${f.equipoId}`);
  const b = await DB.get('blobs', id);
  $('#app').innerHTML = `
    <div class="visor" id="visor">${b ? `<img src="${b.data}" alt="">` : `<div class="sin-local grande">${f.driveId ? (navigator.onLine ? 'Cargando foto…' : 'Esta foto está en Drive. Conéctate a internet para verla.') : 'Esta foto se tomó en otro equipo y aún no se sube a Drive.'}</div>`}</div>
    <div class="panel">
      <label class="campo"><span class="lbl">Etiqueta</span><div class="ctrl"><select id="fEtq">${ETIQUETAS_FOTO.map((x) => `<option ${x === f.etiqueta ? 'selected' : ''}>${x}</option>`).join('')}</select></div></label>
      <label class="campo"><span class="lbl">Nota</span><div class="ctrl"><input id="fNota" value="${esc(f.nota)}" placeholder="Ej: medida de eje con pie de metro"></div></label>
      <div class="nota">${f._pending ? 'Pendiente de subir a Drive' : (f.driveId ? 'Guardada en Drive' : '')} · ${esc(f.creadoPor || '')} · ${fecha(f.creadoEn)}</div>
      <div class="acciones">
        <a class="btn primario" href="#/equipo/${f.equipoId}">Listo</a>
        <button class="btn peligro" id="btnBorrarFoto">Eliminar foto</button>
      </div>
    </div>`;
  if (!b && f.driveId) {
    traerFoto(f).then((data) => {
      const v = $('#visor');
      if (!v) return;
      if (data) v.innerHTML = `<img src="${data}" alt="">`;
      else v.innerHTML = '<div class="sin-local grande">No se pudo cargar la foto. Revisa la señal.</div>';
    });
  }
  const guardarF = async () => {
    const a = await DB.get('fotos', id);
    a.etiqueta = $('#fEtq').value; a.nota = $('#fNota').value.trim();
    await guardar('fotos', a);
  };
  $('#fEtq').onchange = guardarF;
  $('#fNota').oninput = debounce(guardarF, 500);
  $('#btnBorrarFoto').onclick = async () => {
    if (!confirm('¿Eliminar esta foto?')) return;
    const a = await DB.get('fotos', id);
    if (a._pending) { await DB.del('fotos', id); } else { a.eliminado = true; await guardar('fotos', a); }
    await DB.del('blobs', id);
    actualizarBadge();
    location.hash = `#/equipo/${a.equipoId}`;
  };
}

async function vistaForm(ent, id, padreId) {
  const def = FORM_BASE[ent];
  const nuevo = !id;
  const rec = nuevo ? { datos: {} } : await DB.get(ent, id);
  if (!rec) { location.hash = '#/'; return; }
  rec.datos = rec.datos || {};
  const volver = nuevo ? (def.padre ? `#/${RUTA_DE[{ sitioId: 'sitios', areaId: 'areas' }[def.padre]]}/${padreId}` : '#/') : `#/${RUTA_DE[ent]}/${id}`;
  cabecera(`${nuevo ? 'Nuevo' : 'Editar'} ${def.titulo.toLowerCase()}`, '', volver);
  $('#app').innerHTML = `<form id="fGen" class="formulario" autocomplete="off">
    <div class="panel"><div class="campos">
    ${def.campos.map((c) => `<label class="campo"><span class="lbl">${esc(c.l)} ${c.req ? '<b class="req">*</b>' : ''}</span>
      <div class="ctrl">${c.t === 'textarea' ? `<textarea name="${c.k}" rows="3">${esc(rec[c.k])}</textarea>` : `<input name="${c.k}" value="${esc(rec[c.k])}" ${c.req ? 'required' : ''}>`}</div>
      ${c.ayuda ? `<small>${esc(c.ayuda)}</small>` : ''}</label>`).join('')}
    </div></div>
    ${def.plantilla ? gruposHTML(def.plantilla, rec.datos) : ''}
    <div class="acciones">
      <button class="btn primario" type="submit">Guardar</button>
      ${nuevo ? '' : '<button type="button" class="btn peligro" id="btnEliminarGen">Eliminar</button>'}
    </div></form>`;
  $('#fGen').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const r = nuevo ? { id: uid(), eliminado: false, datos: {} } : await DB.get(ent, id);
    if (nuevo && def.padre) r[def.padre] = padreId;
    def.campos.forEach((c) => { r[c.k] = (f.get(c.k) || '').trim(); });
    if (def.plantilla) r.datos = { ...(r.datos || {}), ...leerDatos(ev.target) };
    await guardar(ent, r);
    toast('Guardado ✓');
    location.hash = `#/${RUTA_DE[ent]}/${r.id}`;
  };
  const del = $('#btnEliminarGen');
  if (del) {
    del.onclick = async () => {
      const ent2 = { sitios: 'areas', areas: 'sistemas', sistemas: 'equipos' }[ent];
      const campo = { sitios: 'sitioId', areas: 'areaId', sistemas: 'sistemaId' }[ent];
      if ((await hijos(ent2, campo, id)).length) { toast('Primero elimina o mueve lo que tiene adentro.', 3500); return; }
      if (!confirm('¿Eliminar?')) return;
      const r = await DB.get(ent, id);
      r.eliminado = true;
      await guardar(ent, r);
      location.hash = def.padre ? `#/${RUTA_DE[{ sitioId: 'sitios', areaId: 'areas' }[def.padre]]}/${r[def.padre]}` : '#/';
    };
  }
}

async function vistaAjustes() {
  cabecera('Ajustes', S.usuario.nombre, '#/');
  const pend = await contarPendientes();
  $('#app').innerHTML = `<div class="panel">
    <div><b>Técnico:</b> ${esc(S.usuario.nombre)}</div>
    <div><b>Cuenta:</b> ${esc(S.usuario.email || '')}</div>
    <div><b>Última sincronización:</b> ${S.ultimaSync ? fecha(S.ultimaSync) : 'nunca'}</div>
    <div><b>Cambios pendientes:</b> ${pend}</div>
    <div><b>Tipos de equipo cargados:</b> ${tiposDisponibles().length}</div>
    <div class="nota">Versión ${esc(CONFIG.VERSION)}</div>
    <div class="acciones col">
      <button class="btn primario" id="aSync">Sincronizar ahora</button>
      <button class="btn" id="aFull">Descargar todo de nuevo</button>
      <button class="btn peligro" id="aSalir">Cerrar sesión</button>
    </div></div>`;
  $('#aSync').onclick = () => sincronizar();
  $('#aFull').onclick = () => sincronizar({ completa: true });
  $('#aSalir').onclick = async () => {
    const n = await contarPendientes();
    if (n && !confirm(`Hay ${n} cambio(s) sin subir que se PERDERÁN. ¿Cerrar sesión igual?`)) return;
    if (!n && !confirm('¿Cerrar sesión? Se borrarán los datos guardados en este teléfono (en el servidor quedan).')) return;
    const url = S.apiUrl;
    if (navigator.onLine) await api('logout', {}, 8000).catch(() => {});
    await DB.borrarTodo();
    await DB.setMeta('apiUrl', url);
    location.hash = '#/';
    location.reload();
  };
}

/* ===================== Router ===================== */

async function render() {
  window.scrollTo(0, 0);
  const [, r, a, b] = (location.hash || '#/').split('/');
  if (!S.usuario || r === 'login') return vistaLogin();
  try {
    switch (r) {
      case 'sitio': return await vistaSitio(a);
      case 'area': return await vistaArea(a);
      case 'sistema': return await vistaSistema(a);
      case 'equipo': return await vistaEquipo(a);
      case 'foto': return await vistaFoto(a);
      case 'form': return await vistaForm(a, b);
      case 'nuevo': return await vistaForm(a, null, b);
      case 'ajustes': return await vistaAjustes();
      default: return await vistaInicio();
    }
  } catch (err) {
    console.error(err);
    $('#app').innerHTML = `<div class="panel"><p>Error: ${esc(err.message)}</p><a class="btn" href="#/">Volver al inicio</a></div>`;
  }
}

function estadoRed() { $('#estadoRed').hidden = navigator.onLine; }

function iniciarSesion() {
  $('#btnSync').hidden = false;
  $('#btnAjustes').hidden = false;
  actualizarBadge();
  if (!S.intervalo) S.intervalo = setInterval(() => { if (navigator.onLine) sincronizar({ silencioso: true }); }, 120000);
}

async function arrancar() {
  S.apiUrl = urlDeConfig() || (await DB.meta('apiUrl')) || '';
  S.usuario = await DB.meta('usuario');
  if (S.usuario && !S.usuario.sesion) S.usuario = null; // datos de una versión anterior
  S.plantillas = (await DB.meta('plantillas')) || [];
  S.ultimaSync = (await DB.meta('ultimaSync')) || 0;
  $('#btnSync').onclick = () => sincronizar();
  $('#btnAjustes').onclick = () => { location.hash = '#/ajustes'; };
  window.addEventListener('hashchange', render);
  window.addEventListener('online', () => { estadoRed(); sincronizar({ silencioso: true }); });
  window.addEventListener('offline', estadoRed);
  estadoRed();
  if (S.usuario) {
    iniciarSesion();
    sincronizar({ silencioso: true });
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  render();
}

arrancar();
