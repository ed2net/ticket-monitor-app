/* Ticket Monitor mobile (PWA) — the same Supabase database as the desktop program Ticket Monitor 10.x.
   No libraries: REST + auth over fetch, live updates and "who is online" over one WebSocket (Phoenix protocol). */
'use strict';
const APP_VERSION = 'mobile 1.42';
const CFG = window.TM_CONFIG || {};
const TOPIC = 'realtime:ticketmonitor';

// ───────────── schema (same order and names as the desktop program) ─────────────
const F = [['fdt', "מס' טיקט FDT"], ['entry_date', 'תאריך כניסה'], ['sent_by', 'נשלח ע"י'], ['sent_group', 'נשלח בקבוצה'],
  ['city', 'עיר'], ['site', 'מתחם'], ['street', 'רחוב'], ['house', 'בית'], ['entrance', 'כניסה'], ['cabinet', 'ארונית'],
  ['work_type', 'סוג העבודה'], ['contractor', 'קבלן מבצע'], ['escalation_date', 'תאריך הקפצה'], ['fault', 'זיהוי תקלה'],
  ['close_type', 'סוג סגירת התקלה'], ['status', 'סטטוס'], ['infrastructure', 'קוד תקלה'], ['inspector', 'מפקח'], ['close_date', 'תאריך סגירה'],
  ['solution', 'פתרון'], ['notes', 'הערות']];
const COLS = F.map(x => x[0]);
const LABEL = Object.fromEntries(F);
const DATE_COLS = new Set(['entry_date', 'escalation_date', 'close_date']);
const DATE_ONLY = new Set(['escalation_date']);      // date without time
const MULTI = new Set(['solution', 'notes']);
// 1.8: the column that was 'תשתית' (database column infrastructure, always empty) is now 'קוד תקלה', filled from זיהוי תקלה
const WORK_UNITS = 'לפי יח׳ עבודה';    // was 'יחידות עבודה'
const CODE_OPTIONS = ['HP 30', 'HP 31', 'HP 32', 'HP 33', WORK_UNITS];
// 1.36 / 10.58: these lists and rules are edited by the admin (רשימות / ⚙ «קודי תקלה» on the computer), in lookups.
// The values below are only the defaults while a list has no rows (11_more_lists.sql not run).
const LIST_DEFAULTS = {code: CODE_OPTIONS, fiber_reason: ['קרע סיב', 'נזק בארונית', 'נשלף מארונית'],
  fiber_cable: ['F12', 'F36', 'F72', 'F144', 'F288'], fiber_route: ['עילי', 'תת"ק'], fiber_fix: ['החלפה', 'משיכה']};
const RULE_DEFAULTS = {fault_code: [['HP 30', 'עוצמות אור בארון'], ['HP 31', 'הרחבת ארון ראשי'], ['HP 32', 'הנגשה'], ['HP 33', 'Optical issue'], ['HP 33', 'ONTs LOS']],
  fault_cable: [['Optical issue', ''], ['ONTs LOS', '']],
  cable_code: [['HP 33', 'F12'], [WORK_UNITS, 'F36'], [WORK_UNITS, 'F72'], [WORK_UNITS, 'F144'], [WORK_UNITS, 'F288']]};
const lookupKey = (a, b) => { const sa = +a.sort || 0, sb = +b.sort || 0;      // manual order (▲▼) first, then A–Z
  return (sa > 0 ? 0 : 1) - (sb > 0 ? 0 : 1) || sa - sb || String(a.value).localeCompare(String(b.value), 'he'); };
const cfgRows = kind => (S.lookups || []).filter(l => l.kind === kind && l.value);
function cfgList(kind) {
  const rows = cfgRows(kind);
  if (!rows.length) return [...(LIST_DEFAULTS[kind] || [])];
  return [...new Set(rows.filter(l => l.active !== false).sort(lookupKey).map(l => l.value))];
}
function cfgRules(kind) {
  const rows = cfgRows(kind);
  return rows.length ? rows.filter(l => l.active !== false).map(l => [l.value, l.parent || '']) : RULE_DEFAULTS[kind];
}
const fkey = f => String(f || '').replace(/_/g, ' ').toLowerCase().split(/\s+/).filter(Boolean).join(' ');
const faultCodes = f => { const k = fkey(f); if (!k) return []; const r = cfgRules('fault_code').find(([c, ff]) => c && fkey(ff) === k); return r ? [r[0]] : []; };
const faultByCable = f => { const k = fkey(f); return !!k && cfgRules('fault_cable').some(([ff]) => fkey(ff) === k); };
const cableCode = c => { const k = String(c || '').trim().toUpperCase(); const r = cfgRules('cable_code').find(([v, cc]) => v && String(cc).trim().toUpperCase() === k); return r ? r[0] : ''; };
function fiberCode(fault, solution) {   // the קרע סיב cable decides the code, for the faults where «הכבל קובע»
  return faultByCable(fault) ? cableCode((fiberParse(solution) || {}).cable) : '';
}
const LOOKUP = {sent_by: 'sender', sent_group: 'channel', city: 'city', site: 'site', work_type: 'work_type',
  contractor: 'contractor', fault: 'fault', close_type: 'close_type', status: 'status', inspector: 'inspector'};
const NEW_COLS = new Set(['inspector']);      // added later (SQL 06): the app still works on a database without them
const MISSING = new Set();
const META = ['id', 'version', 'created_at', 'created_by', 'updated_at', 'updated_by'];
const sel = () => META.concat(COLS.filter(c => !MISSING.has(c))).join(',');
const DONE_WORDS = ['finish', 'סגור', 'נסגר', 'בוצע', 'done', 'closed'];

// ───────────── helpers ─────────────
const pad = n => String(n).padStart(2, '0');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const norm = v => v == null ? '' : String(v).replace(/\r\n?/g, '\n').trim();
const normCity = v => norm(v).replace(/_/g, ' ').replace(/\s+/g, ' ');
const same = (a, b) => norm(a) === norm(b);
function fmtDate(d) {
  const s = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  return (d.getHours() || d.getMinutes()) ? `${s} ${pad(d.getHours())}:${pad(d.getMinutes())}` : s;
}
function serverDateText(v) {          // database timestamp (Israel local time, no zone)
  if (!v) return '';
  const m = String(v).match(/^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)/);
  return m ? fmtDate(new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5])) : String(v);
}
function parseDate(t) {
  t = norm(t);
  if (!t) return null;
  let m = t.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (m) {
    const d = new Date(+m[3], m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0));
    return (d.getDate() === +m[1] && d.getMonth() === m[2] - 1 && +(m[4] || 0) < 24) ? d : null;
  }
  m = t.match(/^(\d{4})-(\d\d)-(\d\d)(?:[ T](\d\d):(\d\d))?/);
  return m ? new Date(+m[1], m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) : null;
}
const toIso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
function parseTs(v) {                 // server time with zone -> Date (Safari needs exactly 3 fraction digits)
  if (!v) return null;
  let s = String(v).trim().replace(' ', 'T').replace(/\.(\d+)/, (_, d) => '.' + (d + '000').slice(0, 3));
  if (/[+-]\d\d$/.test(s)) s += ':00';
  if (!/[zZ]|[+-]\d\d:\d\d$/.test(s)) s += 'Z';
  const d = new Date(s);
  return isNaN(d) ? null : d;
}
const localTime = v => { const d = parseTs(v); return d ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}` : ''; };
const nowText = () => { const d = new Date(); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

function dbToRec(row) {
  const r = {};
  for (const c of COLS) r[c] = DATE_COLS.has(c) ? serverDateText(row[c]) : norm(row[c]);
  r.city = normCity(r.city);
  r.id = +row.id; r._v = +(row.version || 1); r._ua = row.updated_at || ''; r._ub = row.updated_by || '';
  r._s = COLS.map(c => r[c]).join(' ').toLowerCase();
  return r;
}
function recToDb(vals, cols) {
  const o = {};
  for (const c of cols) {
    const v = norm(vals[c]);
    if (DATE_COLS.has(c)) { const d = parseDate(v); o[c] = d ? toIso(d) : null; }
    else o[c] = c === 'city' ? normCity(v) : v;
  }
  return o;
}
// 1.14: status groups and filter buttons — same colours as the computer (10.20)
const CHIPS = [['all', 'הכל'], ['finish', 'FINISH'], ['wait', 'בהמתנה'], ['work', 'בעבודה'], ['cont', 'המשך טיפול'], ['today', 'נפתחו היום'], ['late', 'באיחור']];   // 1.34: «באיחור»
function savedChip() { try { const c = localStorage.getItem('tm_chip'); return CHIPS.some(x => x[0] === c) ? c : 'all'; } catch { return 'all'; } }
function stClass(r) {
  const s = (r.status || '').toLowerCase();
  if (DONE_WORDS.some(w => s.includes(w))) return 'finish';
  if (s.includes('המשך')) return 'cont';
  if (s.includes('המתנה') || s.includes('ממתין')) return 'wait';
  if (s.includes('עבודה') || s.includes('טיפול')) return 'work';
  return (!s && r.close_date) ? 'finish' : 'other';     // other = empty / unknown status (grey)
}
const stText = r => r.status || (stClass(r) === 'finish' ? 'FINISH' : '—');

// ───────────── errors + cloud ─────────────
class CloudError extends Error { constructor(m, status = 0, code = '') { super(m); this.status = status; this.code = code; } }
class OfflineError extends CloudError {}
class AuthError extends CloudError {}
class DupError extends CloudError {}
class PermError extends CloudError {}

class Cloud {
  constructor(url, key) { this.url = String(url || '').replace(/\/$/, ''); this.key = key; this.at = ''; this.rt = ''; this.exp = 0; this.user = {}; this.onSession = null; this._ref = null; }
  async raw(method, path, body, headers = {}, token) {
    const h = {apikey: this.key, 'Content-Type': 'application/json', Accept: 'application/json', ...headers};
    if (token) h.Authorization = 'Bearer ' + token;
    let r;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20000);
    try { r = await fetch(this.url + path, {method, headers: h, body: body == null ? undefined : JSON.stringify(body), signal: ctl.signal, cache: 'no-store'}); }
    catch (e) { throw new OfflineError('אין חיבור לשרת'); }
    finally { clearTimeout(t); }
    const txt = await r.text();
    let data = null;
    try { data = txt ? JSON.parse(txt) : null; } catch { data = {message: txt.slice(0, 300)}; }
    return {status: r.status, data};
  }
  err(status, info) {
    info = info && typeof info === 'object' && !Array.isArray(info) ? info : {};
    const msg = info.msg || info.message || info.error_description || info.error || ('HTTP ' + status);
    const code = String(info.code || info.error_code || '');
    if (status === 409 || code === '23505') return new DupError(msg, status, code);
    if (code === '42501' || (status === 403 && !['PGRST301', 'PGRST302'].includes(code))) return new PermError('אין לך הרשאה לפעולה הזו.', status, code);
    if (status === 401 || status === 403 || code === 'PGRST301') return new AuthError(msg, status, code);
    if ([502, 503, 504, 520, 521, 522, 523, 524, 540, 544].includes(status)) return new OfflineError(`השרת אינו זמין כרגע (HTTP ${status}). ייתכן שהפרויקט מושהה.`, status, code);
    return new CloudError(`${msg} (HTTP ${status})`, status, code);
  }
  setSession(d) {
    this.at = d.access_token; this.rt = d.refresh_token || this.rt;
    this.exp = Date.now() + 1000 * (+d.expires_in || 3600);
    if (d.user) this.user = {id: d.user.id, email: d.user.email};
    if (this.onSession) this.onSession();
  }
  async signIn(email, pw) {
    const r = await this.raw('POST', '/auth/v1/token?grant_type=password', {email: email.trim(), password: pw});
    if (r.status >= 400) { if ([400, 401, 422].includes(r.status)) throw new AuthError('דוא"ל או סיסמה שגויים.'); throw this.err(r.status, r.data); }
    this.setSession(r.data);
  }
  refresh() {
    if (this._ref) return this._ref;
    this._ref = (async () => {
      if (!this.rt) throw new AuthError('החיבור הסתיים. יש להתחבר מחדש.');
      const r = await this.raw('POST', '/auth/v1/token?grant_type=refresh_token', {refresh_token: this.rt});
      if (r.status >= 400) {
        if ([400, 401, 403, 422].includes(r.status)) { this.rt = ''; throw new AuthError('החיבור הסתיים. יש להתחבר מחדש.'); }
        throw this.err(r.status, r.data);
      }
      this.setSession(r.data);
    })().finally(() => { this._ref = null; });
    return this._ref;
  }
  async ensureFresh(margin = 120) { if (this.rt && Date.now() > this.exp - margin * 1000) await this.refresh(); }
  async req(method, path, body, headers) {
    await this.ensureFresh();
    let r = await this.raw(method, path, body, headers, this.at);
    if (r.status === 401 && this.rt) { await this.refresh(); r = await this.raw(method, path, body, headers, this.at); }
    if (r.status >= 400) throw this.err(r.status, r.data);
    return r.data;
  }
  async fetchAll(table, q) {
    let out = [], start = 0;
    for (;;) {
      const rows = await this.req('GET', `/rest/v1/${table}?${q}`, null, {'Range-Unit': 'items', Range: `${start}-${start + 999}`}) || [];
      out = out.concat(rows);
      if (rows.length < 1000) return out;
      start += 1000;
    }
  }
  async cols(fn) {               // a newer column missing in the database -> drop it and repeat
    try { return await fn(); }
    catch (e) {
      const gone = [...NEW_COLS].filter(c => !MISSING.has(c) && String(e.message).includes(c));
      if (e instanceof OfflineError || e instanceof AuthError || !gone.length) throw e;
      gone.forEach(c => MISSING.add(c));
      return this.cols(fn);
    }
  }
  loadTickets() { return this.cols(() => this.fetchAll('tickets', 'select=' + sel() + '&order=id')); }
  loadLookups() { return this.fetchAll('lookups', 'select=id,kind,value,parent,sort,active&order=kind,sort,value'); }
  async loadProfiles() {
    try { return await this.fetchAll('profiles', 'select=id,display_name,role,can_edit_lookups'); }
    catch (e) { if (e instanceof OfflineError || e instanceof AuthError) throw e; return this.fetchAll('profiles', 'select=id,display_name,role'); }
  }
  async loadSetting(key) {        // shared setting chosen by the admin (table app_settings, SQL 10.8); null = none
    try { const r = await this.req('GET', `/rest/v1/app_settings?select=value&key=eq.${encodeURIComponent(key)}`); return r && r[0] ? r[0].value : null; }
    catch (e) { if (e instanceof OfflineError || e instanceof AuthError) throw e; return null; }
  }
  async addrSearch(city, street, house, cabinet) {   // 1.20: address book (SQL 09); null = table missing
    const t = v => encodeURIComponent(String(v || '').replace(/[*,()]/g, ' ').trim().split(/\s+/).filter(Boolean).join(' '));
    const f = [];
    if (city) f.push(`city=ilike.*${t(city)}*`);
    if (cabinet) f.push(`cabinet=ilike.${t(cabinet)}*`);
    else { if (street) f.push(`street=ilike.*${t(street)}*`); if (house) f.push(`house=ilike.${t(house)}*`); }
    if (!cabinet && !street) return [];
    try { return await this.req('GET', '/rest/v1/addresses?select=city,site,cabinet,street,house,entrance,drop_status,signal&' + f.join('&') + '&order=street,house,cabinet&limit=60') || []; }
    catch (e) { if (e instanceof OfflineError || e instanceof AuthError) throw e; if (e.status === 404 || e.code === 'PGRST205') return null; throw e; }
  }
  async lastLogTime() { const r = await this.req('GET', '/rest/v1/ticket_log?select=at&order=at.desc&limit=1'); return r && r[0] ? r[0].at : ''; }
  changesSince(tm, lm) { return this.cols(() => this._changesSince(tm, lm)); }
  async _changesSince(tm, lm) {
    const back = s => { const d = parseTs(s); return d ? new Date(d.getTime() - 120000).toISOString() : ''; };
    let tq = 'select=' + sel() + '&order=id', lq = 'select=ticket_id,at&action=eq.delete&order=at';
    if (back(tm)) tq += '&updated_at=gte.' + encodeURIComponent(back(tm));
    if (back(lm)) lq += '&at=gte.' + encodeURIComponent(back(lm));
    return [await this.fetchAll('tickets', tq), await this.fetchAll('ticket_log', lq)];
  }
  getTicket(id) { return this.cols(() => this._getTicket(id)); }
  async _getTicket(id) { const r = await this.req('GET', `/rest/v1/tickets?select=${sel()}&id=eq.${+id}`); return r && r[0] ? r[0] : null; }
  insertTicket(row) { return this.cols(() => this._insertTicket(row)); }
  async _insertTicket(row) { row = Object.fromEntries(Object.entries(row).filter(([k]) => !MISSING.has(k)));
    const r = await this.req('POST', `/rest/v1/tickets?select=${sel()}`, row, {Prefer: 'return=representation'}); return r[0]; }
  updateTicket(id, version, body) { return this.cols(() => this._updateTicket(id, version, body)); }
  async _updateTicket(id, version, body) {
    body = Object.fromEntries(Object.entries(body).filter(([k]) => !MISSING.has(k)));
    const r = await this.req('PATCH', `/rest/v1/tickets?id=eq.${+id}&version=eq.${+version}&select=${sel()}`, body, {Prefer: 'return=representation'});
    return r && r[0] ? r[0] : null;
  }
  ticketHistory(id) { return this.fetchAll('ticket_log', `select=id,action,changed,old_row,new_row,by_user,at&ticket_id=eq.${+id}&order=at.desc`); }
  changePassword(pw) { return this.req('PUT', '/auth/v1/user', {password: pw}); }
  async signOut() { try { if (this.at) await this.raw('POST', '/auth/v1/logout', {}, {}, this.at); } catch {} this.at = this.rt = ''; this.exp = 0; }
  rtUrl() { return this.url.replace(/^http/, 'ws') + '/realtime/v1/websocket?apikey=' + encodeURIComponent(this.key) + '&vsn=1.0.0'; }
}

// ───────────── live updates + who is online ─────────────
class Realtime {
  constructor(cloud, h) { this.c = cloud; this.h = h; this.ws = null; this.ref = 0; this.joinRef = ''; this.meta = null; this.online = false; this.stopped = false; this.delay = 2000; this.pres = {}; this.hb = null; this.tok = ''; this.timer = null; }
  start() { this.stopped = false; this.connect(); }
  stop() { this.stopped = true; clearInterval(this.hb); clearTimeout(this.timer); try { this.ws && this.ws.close(); } catch {} }
  alive() { return this.ws && this.ws.readyState === 1; }
  send(topic, event, payload, jr) {
    if (!this.alive()) return;
    const m = {topic, event, payload, ref: String(++this.ref)};
    if (jr) m.join_ref = jr;
    this.ws.send(JSON.stringify(m));
  }
  async connect() {
    if (this.stopped || (this.ws && this.ws.readyState <= 1)) return;
    try { await this.c.ensureFresh(); }
    catch (e) { if (e instanceof AuthError) { this.setOnline(false); this.h.onAuth(); return; } }
    let ws;
    try { ws = new WebSocket(this.c.rtUrl()); } catch { return this.retry(); }
    this.ws = ws;
    ws.onopen = () => {
      this.pres = {};
      this.joinRef = String(++this.ref);
      this.tok = this.c.at;
      ws.send(JSON.stringify({topic: TOPIC, event: 'phx_join', ref: this.joinRef, join_ref: this.joinRef, payload: {
        config: {broadcast: {self: false, ack: false}, presence: {key: this.c.user.id || '', enabled: true},
          postgres_changes: [{event: '*', schema: 'public', table: 'tickets'}, {event: '*', schema: 'public', table: 'lookups'}], private: false},
        access_token: this.c.at}}));
      clearInterval(this.hb);
      this.hb = setInterval(() => {
        this.send('phoenix', 'heartbeat', {});
        if (this.c.at && this.c.at !== this.tok) { this.tok = this.c.at; this.send(TOPIC, 'access_token', {access_token: this.tok}, this.joinRef); }
      }, 25000);
    };
    ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch { return; } this.msg(m); };
    ws.onclose = () => { clearInterval(this.hb); if (this.ws === ws) this.ws = null; this.setOnline(false); this.retry(); };
    ws.onerror = () => {};
  }
  retry() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), this.delay);
    this.delay = Math.min(this.delay * 2, 60000);
  }
  reconnectNow() { this.delay = 2000; clearTimeout(this.timer); this.connect(); }
  setOnline(on) { if (on !== this.online) { this.online = on; this.h.onStatus(on); } }
  msg(m) {
    const ev = m.event, p = m.payload || {};
    if (ev === 'phx_reply' && m.ref === this.joinRef) {
      if (p.status === 'ok') { this.delay = 2000; this.setOnline(true); this.trackNow(); }
      else { try { this.ws.close(); } catch {} }
    } else if (ev === 'postgres_changes') {
      this.h.onChange((p.data || {}).table || '');
    } else if (ev === 'presence_state') {
      this.pres = {};
      for (const [k, v] of Object.entries(p)) this.pres[k] = [...((v || {}).metas || [])];
      this.h.onPresence(this.conns());
    } else if (ev === 'presence_diff') {
      for (const [k, v] of Object.entries(p.joins || {})) {
        const cur = this.pres[k] || (this.pres[k] = []);
        const refs = new Set(cur.map(x => x.phx_ref));
        for (const mm of (v || {}).metas || []) if (!refs.has(mm.phx_ref)) cur.push(mm);
      }
      for (const [k, v] of Object.entries(p.leaves || {})) {
        const gone = new Set(((v || {}).metas || []).map(x => x.phx_ref));
        if (this.pres[k]) { this.pres[k] = this.pres[k].filter(x => !gone.has(x.phx_ref)); if (!this.pres[k].length) delete this.pres[k]; }
      }
      this.h.onPresence(this.conns());
    } else if (ev === 'phx_error' || ev === 'phx_close') {
      try { this.ws.close(); } catch {}
    }
  }
  conns() { const out = []; for (const [k, ms] of Object.entries(this.pres)) for (const m of ms) out.push({...m, user_id: m.user_id || k}); return out; }
  track(meta) { this.meta = meta; if (this.online) this.trackNow(); }
  trackNow() { if (this.meta) this.send(TOPIC, 'presence', {type: 'presence', event: 'track', payload: this.meta}, this.joinRef); }
}

// ───────────── local storage (IndexedDB for data, localStorage for the sign-in) ─────────────
const kv = {
  db: null,
  open() {
    return this.db || (this.db = new Promise((res, rej) => {
      const r = indexedDB.open('ticketmonitor', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
  },
  async get(k) {
    try { const db = await this.open(); return await new Promise(res => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); }); }
    catch { return undefined; }
  },
  async set(k, v) {
    try { const db = await this.open(); await new Promise(res => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = res; tx.onerror = res; }); }
    catch {}
  },
};
const SESSION_KEY = 'tm_session';
function loadSession() { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || '{}'); } catch { return {}; } }
function saveSession(s) { try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch {} }

// ───────────── app state ─────────────
const S = {
  cloud: new Cloud(CFG.url, CFG.key), rt: null, session: loadSession(), conn: Math.random().toString(16).slice(2, 14),
  recs: new Map(), lookups: [], names: {}, role: 'user', tm: '', lm: '', loaded: false, readonly: false, cacheAt: '',
  restOk: true, rtOnline: false, connections: [], view: 'login', chip: savedChip(), query: '', limit: 60,
  card: null, syncing: false, syncAgain: false, pollTimer: null,
};
const $ = s => document.querySelector(s);
const app = () => $('#app');

function toast(t, ms = 2600) {
  const el = $('#toast');
  el.textContent = t; el.classList.remove('hidden');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.add('hidden'), ms);
}
function sheet(html) {
  $('#toast').classList.add('hidden');
  const m = $('#modal');
  m.innerHTML = `<div class="sheet"><div class="grip"></div>${html}</div>`;
  m.classList.remove('hidden');
  m.onclick = e => { if (e.target === m) closeSheet(); };
  guard();
  return m.firstElementChild;
}
function closeSheet() { const m = $('#modal'); m.classList.add('hidden'); m.innerHTML = ''; if (closeSheet.cb) { const cb = closeSheet.cb; closeSheet.cb = null; cb(false); } unguard(); }

// ───────────── phone "back" button (1.12): closes the editor / window / card instead of leaving the app ─────────────
const sheetOpen = () => !$('#modal').classList.contains('hidden');
const somethingOpen = () => !!$('#bigedit') || sheetOpen() || S.view === 'card' || S.view === 'people';
function guard() {                      // one extra history entry while a card / window / editor is open
  clearTimeout(unguard.t);
  if (!(history.state && history.state.tm)) { try { history.pushState({tm: 1}, ''); } catch {} }
}
function unguard() {                    // nothing open any more → drop that entry (later, in case something opens right away)
  clearTimeout(unguard.t);
  unguard.t = setTimeout(() => {
    if (!somethingOpen() && history.state && history.state.tm) { S.ignorePop = true; history.back(); }
  }, 350);
}
window.addEventListener('popstate', async () => {
  if (S.ignorePop) { S.ignorePop = false; return; }
  if ($('#bigedit')) { $('#bigcancel').click(); }
  else if (sheetOpen()) closeSheet();
  else if (S.view === 'card') await closeCard();
  else if (S.view === 'people') renderList();
  if (somethingOpen()) guard();
});
// ───────────── קרע סיב form (1.9): six fields → one sentence in פתרון ─────────────
const fiberLists = () => ({reason: cfgList('fiber_reason'), cable: cfgList('fiber_cable'), route: cfgList('fiber_route'), fix: cfgList('fiber_fix')});
function fiberText(d) {        // קרע סיב F12 בין 400-1 לבין 400-2 עילי 100 מטר. בוצע החלפה וחיבור.
  const g = k => String(d[k] || '').trim();
  const parts = [g('reason'), g('cable'), (g('a') || g('b')) ? `בין ${g('a') || '?'} לבין ${g('b') || '?'}` : '', g('route'), g('m') ? `${g('m')} מטר` : ''];
  const first = parts.filter(Boolean).join(' ');
  let t = first ? first + '.' : '';
  if (g('fix')) t = (t ? t + ' ' : '') + `בוצע ${g('fix')} וחיבור.`;
  return t;
}
const reEsc = v => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function fiberRe(F) {
  const byLen = a => [...a].filter(Boolean).sort((x, y) => y.length - x.length).map(reEsc).join('|');
  const cab = F.cable.length ? `(?:${byLen(F.cable)}|F\\d+)` : 'F\\d+', rt = byLen(F.route) || '(?!)';
  return new RegExp(`([^\\n.]*?)\\s*(${cab})?\\s*(?:בין (\\S+) לבין (\\S+))?\\s*(${rt})?\\s*(?:([\\d.,]+) מטר)?\\.(?:\\s*בוצע (\\S+) וחיבור\\.)?`);
}
function fiberParse(text) {
  const FIBER = fiberLists(), FIBER_RE = fiberRe(FIBER);
  for (const line of String(text || '').split('\n')) {
    if (!(line.includes('בין') || FIBER.reason.some(r => line.includes(r)) || FIBER.cable.some(c => line.includes(c)))) continue;
    const m = line.match(FIBER_RE);
    if (m && (m[2] || m[3] || m[6] || FIBER.reason.includes((m[1] || '').trim()))) return {reason: (m[1] || '').trim(), cable: m[2] || '', a: m[3] || '', b: m[4] || '', route: m[5] || '', m: m[6] || '', fix: m[7] || ''};
  }
  return null;
}
function fiberForm() {
  const ta = inputOf('solution'); if (!ta) return;
  const FIBER = fiberLists();
  const d = fiberParse(ta.value) || {reason: FIBER.reason[0] || ''};
  const sel = (k, opts) => `<select data-k="${k}"><option value=""></option>${(d[k] && !opts.includes(d[k]) ? [d[k], ...opts] : opts).map(o => `<option${o === d[k] ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  const s = sheet(`<h3>קרע סיב</h3><div class="fiber">
      <label>מה הסיבה${sel('reason', FIBER.reason)}</label>
      <label>סוג כבל${sel('cable', FIBER.cable)}</label>
      <label>בין<input data-k="a" value="${esc(d.a || '')}" placeholder="מספר"></label>
      <label>לבין<input data-k="b" value="${esc(d.b || '')}" placeholder="מספר"></label>
      <label>תוואי${sel('route', FIBER.route)}</label>
      <label>כמה מטרים<input data-k="m" value="${esc(d.m || '')}" inputmode="decimal" placeholder="מטרים"></label>
      <label>פתרון${sel('fix', FIBER.fix)}</label></div>
    <p class="fprev" id="fprev"></p>
    <div class="btns"><button class="btn save" id="fok">הכנס לפתרון</button><button class="btn" id="fno">ביטול</button></div>`);
  const vals = () => Object.fromEntries([...s.querySelectorAll('[data-k]')].map(e => [e.dataset.k, e.value]));
  const upd = () => { $('#fprev').textContent = fiberText(vals()) || '—'; };
  s.querySelectorAll('[data-k]').forEach(e => { e.addEventListener('input', upd); e.addEventListener('change', upd); });
  upd();
  s.querySelector('#fno').onclick = closeSheet;
  s.querySelector('#fok').onclick = () => {
    const t = fiberText(vals());
    closeSheet();
    if (!t) return;
    const lines = ta.value ? ta.value.split('\n') : [];
    ta.value = fiberParse(ta.value) ? lines.map(l => fiberParse(l) ? t : l).join('\n') : (ta.value.trim() ? ta.value.replace(/\s+$/, '') + '\n' + t : t);
    onEdit('solution');
    faultChanged();
    toast('נכנס לפתרון — לחץ "שמור" לשמירת הטיקט');
  };
}

function choose(title, text, options) {      // one button per option; resolves to the option or null
  return new Promise(res => {
    const s = sheet(`<h3>${esc(title)}</h3><p>${esc(text)}</p><div class="btns">${options.map((o, i) =>
      `<button class="btn dark" data-o="${i}">${esc(o)}</button>`).join('')}</div><div class="btns"><button class="btn" data-o="-1">ביטול</button></div>`);
    closeSheet.cb = () => res(null);
    s.querySelectorAll('[data-o]').forEach(b => b.onclick = () => { closeSheet.cb = null; closeSheet(); const i = +b.dataset.o; res(i >= 0 ? options[i] : null); });
  });
}
async function faultChanged() {   // עוצמות אור בארון → HP 30, הרחבת ארון ראשי → HP 31, הנגשה → HP 32, Optical issue / ONTs LOS → HP 33 or לפי יח׳ עבודה
  const c = S.card, fault = norm((inputOf('fault') || {}).value), opts = faultCodes(fault), code = inputOf('infrastructure');
  if (S.readonly || !c || !code) return;
  const byCable = fiberCode(fault, (inputOf('solution') || {}).value);
  if (byCable) { if (norm(code.value) !== byCable) { code.value = byCable; onEdit('infrastructure'); } return; }
  const allowed = opts.concat(faultByCable(fault) ? cfgRules('cable_code').map(r => r[0]) : []);   // 1.36
  if (!opts.length || allowed.includes(norm(code.value))) return;
  code.value = opts[0]; onEdit('infrastructure');   // Optical issue / ONTs LOS → HP 33 at once, no question
}
function ask(title, text, yes = 'כן', no = 'ביטול', danger = false) {
  return new Promise(res => {
    const s = sheet(`<h3>${esc(title)}</h3><p>${esc(text)}</p><div class="btns"><button class="btn ${danger ? 'red' : 'dark'}" data-a="y">${esc(yes)}</button><button class="btn" data-a="n">${esc(no)}</button></div>`);
    closeSheet.cb = res;
    s.querySelector('[data-a=y]').onclick = () => { closeSheet.cb = null; closeSheet(); res(true); };
    s.querySelector('[data-a=n]').onclick = () => { closeSheet.cb = null; closeSheet(); res(false); };
  });
}
function info(title, text) { return ask(title, text, 'סגור', '', false).then(() => {}); }
const errText = e => e instanceof OfflineError ? 'אין חיבור לשרת. בדוק את האינטרנט ונסה שוב.' :
  e instanceof AuthError ? 'החיבור הסתיים — יש להתחבר מחדש.' : (e && e.message) || String(e);
const userName = id => !id ? '—' : (S.names[id] || 'משתמש');
const myName = () => S.names[S.cloud.user.id] || (S.cloud.user.email || S.session.email || '').split('@')[0] || '—';
function lookupValues(kind, parent) {
  const rows = S.lookups.filter(l => l.kind === kind && (parent == null || (l.parent || '') === parent) && l.active !== false && l.value);
  return [...new Set(rows.sort(lookupKey).map(l => l.value))];      // 1.36: the admin's order (▲▼), then A–Z
}
const groupKey = v => String(v || '').replace(/_/g, ' ').toLowerCase().split(/\s+/).filter(Boolean).join(' ');
function inspectorValues(channel) {     // מפקח: names for every group + names of this group (נשלח בקבוצה)
  const key = groupKey(channel);
  const rows = S.lookups.filter(l => l.kind === 'inspector' && l.active !== false && l.value && (!l.parent || (key && groupKey(l.parent) === key)));
  return [...new Set(rows.sort(lookupKey).map(l => l.value))];
}

// ───────────── start ─────────────
async function start() {
  if ('serviceWorker' in navigator) { try { navigator.serviceWorker.register('sw.js', {updateViaCache: 'none'}).then(r => r.update()).catch(() => {}); } catch {} }
  S.cloud.onSession = () => { if (S.session.remember) { S.session.rt = S.cloud.rt; S.session.uid = S.cloud.user.id || S.session.uid; saveSession(S.session); } };
  if (S.session.remember && S.session.rt) {
    S.cloud.rt = S.session.rt;
    const cache = await kv.get('cache');
    if (usableCache(cache)) return quickStart(cache);    // instant: last data at once, connect + catch up in the background
    renderLoading('מתחבר...');
    try { await S.cloud.refresh(); return enterOnline(); }
    catch (e) {
      if (e instanceof OfflineError) { const c = await kv.get('cache'); if (c) return enterOffline(c); return renderLogin('אין חיבור לשרת.'); }
      S.session.rt = ''; saveSession(S.session);
      return renderLogin('הכניסה הקודמת הסתיימה — יש להתחבר מחדש.');
    }
  }
  renderLogin('');
}

function renderLoading(t) { app().innerHTML = `<div class="loading">${esc(t)}</div>`; }

async function renderLogin(msg) {
  S.view = 'login';
  const cache = await kv.get('cache');
  app().innerHTML = `<div class="screen"><div class="login">
    <div class="logo">Ticket Monitor</div><div class="lsub">כניסה עם הדוא"ל והסיסמה שלך</div>
    <input id="email" class="inp" type="email" autocomplete="username" placeholder="דוא&quot;ל" value="${esc(S.session.email || '')}">
    <input id="pw" class="inp" type="password" autocomplete="current-password" placeholder="סיסמה">
    <label class="chk"><input id="rem" type="checkbox" ${S.session.remember !== false ? 'checked' : ''}> זכור אותי בטלפון הזה</label>
    <button id="go" class="big">כניסה</button>
    <div id="err" class="err">${esc(msg || '')}</div>
    ${cache ? `<button id="off" class="ghost">אין חיבור? פתח עותק אחרון (<bdi dir="ltr">${esc(cache.saved_text || '')}</bdi>, קריאה בלבד)</button>` : ''}
    <div class="note">הוספה למסך הבית: iPhone — שיתוף ← "הוסף למסך הבית" · Android — תפריט ⋮ ← "הוסף למסך הבית"</div>
  </div></div>`;
  const go = async () => {
    const email = $('#email').value.trim(), pw = $('#pw').value;
    if (!email || !pw) { $('#err').textContent = 'יש להזין דוא"ל וסיסמה.'; return; }
    $('#go').disabled = true; $('#err').textContent = 'מתחבר...';
    try { await S.cloud.signIn(email, pw); }
    catch (e) { $('#go').disabled = false; $('#err').textContent = e instanceof AuthError ? e.message : errText(e); return; }
    S.session = {email, uid: S.cloud.user.id || '', remember: $('#rem').checked, rt: $('#rem').checked ? S.cloud.rt : ''};
    saveSession(S.session);
    enterOnline();
  };
  $('#go').onclick = go;
  $('#pw').onkeydown = e => { if (e.key === 'Enter') go(); };
  if (cache) $('#off').onclick = () => enterOffline(cache);
}

// ───────────── online / offline ─────────────
// ───────────── fast start: show the saved copy at once, then only the changes are downloaded ─────────────
function usableCache(c) { return !!(c && c.uid && c.uid === S.session.uid && c.tm && c.lm && Array.isArray(c.rows)); }
function loadFromCache(cache) {
  S.names = cache.names || {}; S.lookups = cache.lookups || []; S.waOff = cache.waOff || []; S.req = cache.req || null; S.maps = cache.maps || null; S.people = cache.people || []; S.peopleFields = cache.peopleFields || []; S.role = cache.role || 'user';
  S.raw = new Map((cache.rows || []).map(r => [+r.id, r]));
  S.recs = new Map([...S.raw.values()].map(r => { const rec = dbToRec(r); return [rec.id, rec]; }));
  S.tm = cache.tm || ''; S.lm = cache.lm || ''; S.cacheAt = cache.saved_text || '';
  S.cloud.user = {id: cache.uid, email: S.session.email || ''};
  S.loaded = true;
}
function quickStart(cache) {
  loadFromCache(cache);
  S.readonly = false; S.connecting = true; S.restOk = true; S.view = 'list';
  renderList();
  connectInBackground(cache);
}
async function connectInBackground(cache) {
  try { await S.cloud.refresh(); }
  catch (e) {
    S.connecting = false;
    if (e instanceof OfflineError) { enterOffline(cache); return; }
    S.session.rt = ''; saveSession(S.session);
    return renderLogin('הכניסה הקודמת הסתיימה — יש להתחבר מחדש.');
  }
  S.connecting = false;
  startLive();
  await sync();                                       // only what changed since the saved copy
  try { setProfiles(await S.cloud.loadProfiles()); await loadWaSetting(); await reloadLookups(); await loadPeople(); saveCache(); } catch {}
  if (S.view === 'list') renderListBody();
  if (Date.now() - (cache.at || 0) > 24 * 3600 * 1000) {   // old copy: full reload in the background (safety net)
    try { await fullLoad(); onDataChanged([], []); } catch {}
  }
}

async function enterOnline() {
  S.readonly = false; S.view = 'list';
  renderLoading('טוען טיקטים...');
  try { await fullLoad(); }
  catch (e) {
    if (e instanceof AuthError) return sessionEnded();
    const c = await kv.get('cache');
    if (c) return enterOffline(c);
    return renderLogin(errText(e));
  }
  startLive();
  renderList();
}
function enterOffline(cache) {
  S.readonly = true; S.view = 'list'; S.cacheAt = cache.saved_text || '';
  S.names = cache.names || {}; S.lookups = cache.lookups || []; S.waOff = cache.waOff || []; S.req = cache.req || null; S.maps = cache.maps || null; S.people = cache.people || []; S.peopleFields = cache.peopleFields || [];
  S.recs = new Map((cache.rows || []).map(r => { const rec = dbToRec(r); return [rec.id, rec]; }));
  S.loaded = true;
  renderList();
}
async function fullLoad() {
  const c = S.cloud;
  const [tickets, lookups, profiles, logtime] = await Promise.all([c.loadTickets(), c.loadLookups(), c.loadProfiles(), c.lastLogTime()]);
  try { await loadWaSetting(); } catch {}
  await loadPeople();
  setProfiles(profiles);
  S.recs = new Map();
  S.raw = new Map();
  let mark = null;
  for (const row of tickets) { const r = dbToRec(row); S.recs.set(r.id, r); S.raw.set(r.id, row); const d = parseTs(row.updated_at); if (d && (!mark || d > mark)) mark = d; }
  S.tm = mark ? mark.toISOString() : '';
  S.lm = logtime || new Date().toISOString();
  S.lookups = lookups;
  S.loaded = true; S.restOk = true;
  saveCache();
}
function setProfiles(ps) {
  S.names = Object.fromEntries(ps.map(p => [p.id, (p.display_name || '').trim()]));
  const me = ps.find(p => p.id === S.cloud.user.id) || {};
  S.role = me.role || 'user';
}
async function loadWaSetting() {  // WhatsApp fields without V — chosen by the admin in the desktop card, same for everybody
  const v = await S.cloud.loadSetting('wa_unchecked');
  if (Array.isArray(v)) S.waOff = v;
  try { const r = await S.cloud.loadSetting('req_fields'); if (Array.isArray(r)) S.req = r; } catch {}   // 1.29
  try { const m = await S.cloud.loadSetting('maps_index'); if (Array.isArray(m)) S.maps = m; } catch {}   // 1.39
}
// 1.29 / 10.49: required fields — empty ones are coloured: green = needed when opening, orange = needed to close
const REQ_OPEN_DEFAULT = ["מס' טיקט FDT", 'עיר', 'מתחם', 'רחוב', 'בית', 'ארונית', 'סוג העבודה', 'זיהוי תקלה'];
const REQ_CLOSE_DEFAULT = ['קבלן מבצע', 'סוג סגירת התקלה', 'קוד תקלה', 'תאריך סגירה', 'פתרון'];
function reqFields() {
  if (!Array.isArray(S.req)) return {open: new Set(REQ_OPEN_DEFAULT), close: new Set(REQ_CLOSE_DEFAULT)};
  const out = {open: new Set(), close: new Set()};
  for (const x of S.req) { const i = String(x).indexOf(':'); const k = String(x).slice(0, i); if (out[k]) out[k].add(String(x).slice(i + 1)); }
  return out;
}
function markClosing() {            // the closing fields count once the ticket is saved (or is being closed right away)
  const form = document.querySelector('.form'); if (!form || !S.card) return;
  const cd = inputOf('close_date'), st = inputOf('status');
  form.classList.toggle('closing', S.card.id != null || !!(cd && norm(cd.value)) || !!(st && stClass({status: st.value, close_date: ''}) === 'finish'));   // 1.35: Finish / סגור too
}
let cacheTimer = null;
function saveCache() {
  clearTimeout(cacheTimer);
  cacheTimer = setTimeout(() => {
    if (S.readonly || !S.loaded) return;
    kv.set('cache', {saved_text: nowText(), at: Date.now(), uid: S.cloud.user.id || '', role: S.role, tm: S.tm, lm: S.lm,
      names: S.names, waOff: S.waOff || [], req: S.req || null, maps: S.maps || null, people: S.people || [], peopleFields: S.peopleFields || [], lookups: S.lookups, rows: [...(S.raw || new Map()).values()]});
  }, 3000);
}
function startLive() {
  if (S.rt) S.rt.stop();
  S.rt = new Realtime(S.cloud, {
    onChange: t => { if (t === 'lookups') reloadLookups(); else { clearTimeout(S.syncT); S.syncT = setTimeout(sync, 400); } },
    onPresence: c => { S.connections = c; refreshLive(); },
    onStatus: on => { const was = S.rtOnline; S.rtOnline = on; if (!on) S.connections = []; if (on && !was) { sync(); reloadLookups(); } refreshLive(); setPoll(); },
    onAuth: () => sessionEnded(),
  });
  S.rt.track(presenceMeta());
  S.rt.start();
  setPoll();
  clearInterval(S.tokTimer);
  S.tokTimer = setInterval(() => S.cloud.ensureFresh(600).catch(e => { if (e instanceof AuthError) sessionEnded(); }), 300000);
}
function setPoll() { clearInterval(S.pollTimer); S.pollTimer = setInterval(sync, S.rtOnline ? 120000 : 30000); }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !S.readonly && S.loaded) { sync(); if (S.rt) S.rt.reconnectNow(); }
});

async function sync() {
  if (S.readonly || !S.loaded) return;
  if (S.syncing) { S.syncAgain = true; return; }
  S.syncing = true;
  try {
    const [rows, deleted] = await S.cloud.changesSince(S.tm, S.lm);
    S.restOk = true;
    const changed = [], removed = [];
    for (const row of rows) {
      const r = dbToRec(row), old = S.recs.get(r.id);
      if (old && old._v > r._v) continue;
      if (!old || old._v !== r._v || old._s !== r._s) { S.recs.set(r.id, r); S.raw.set(r.id, row); changed.push(r.id); }
      const d = parseTs(row.updated_at); if (d && (!parseTs(S.tm) || d > parseTs(S.tm))) S.tm = d.toISOString();
    }
    for (const d of deleted) {
      const id = +d.ticket_id;
      if (S.recs.has(id)) { S.recs.delete(id); S.raw.delete(id); removed.push(id); }
      const t = parseTs(d.at); if (t && (!parseTs(S.lm) || t > parseTs(S.lm))) S.lm = t.toISOString();
    }
    if (changed.length || removed.length) { saveCache(); onDataChanged(changed, removed); }
  } catch (e) {
    if (e instanceof AuthError) return sessionEnded();
    S.restOk = false;
  } finally {
    S.syncing = false;
    refreshLive();
    if (S.syncAgain) { S.syncAgain = false; setTimeout(sync, 0); }
  }
}
async function reloadLookups() { try { S.lookups = await S.cloud.loadLookups(); saveCache(); } catch {} }
function onDataChanged(changed, removed) {
  if (S.view === 'list') renderListBody();
  if (S.view === 'card' && S.card && S.card.id != null) {
    if (removed.includes(S.card.id)) remoteDeleted();
    else if (changed.includes(S.card.id)) remoteUpdate(S.recs.get(S.card.id));
  }
}
async function sessionEnded() {
  if (S.ending) return;
  S.ending = true;
  if (S.rt) S.rt.stop();
  clearInterval(S.pollTimer); clearInterval(S.tokTimer);
  S.session.rt = ''; saveSession(S.session);
  S.ending = false;
  renderLogin('החיבור לשרת הסתיים. יש להתחבר מחדש.');
}

// ───────────── presence ─────────────
function presenceMeta() {
  const c = S.card;
  return {user_id: S.cloud.user.id || '', name: myName(), conn: S.conn, ticket_id: c && c.id != null ? c.id : null,
    fdt: c && c.rec ? c.rec.fdt : '', editing: !!(c && c.dirty), new_ticket: !!(c && c.id == null), app: APP_VERSION,
    since: new Date().toISOString()};
}
function track() { if (S.rt) S.rt.track(presenceMeta()); }
function others() { const me = S.cloud.user.id; return S.connections.filter(c => c.conn !== S.conn && c.user_id !== me); }
function othersOn(id) {
  const out = {};
  for (const c of S.connections) if (c.conn !== S.conn && c.ticket_id === id) { const n = c.name || userName(c.user_id); out[n] = out[n] || !!c.editing; }
  return Object.entries(out);
}
function pillHtml() {
  if (S.readonly) return `<div class="pill ro"><i></i><span>לא מקוון — קריאה בלבד</span></div>`;
  if (S.connecting) return `<div class="pill ro"><i></i><span>מתחבר…</span></div>`;
  if (!S.restOk) return `<div class="pill off"><i></i><span>אין חיבור לשרת</span></div>`;
  if (!S.rtOnline) return `<div class="pill poll"><i></i><span>מחובר · עדכון חי לא פעיל</span></div>`;
  const users = {};
  for (const c of others()) {
    const u = users[c.user_id] || (users[c.user_id] = {name: c.name || userName(c.user_id), acts: []});
    if (c.ticket_id != null) u.acts.push(`טיקט ${esc(c.fdt || c.ticket_id)}${c.editing ? ' ✎' : ''}`);
    else if (c.new_ticket) u.acts.push('טיקט חדש' + (c.editing ? ' ✎' : ''));
  }
  const parts = Object.values(users).map(u => `<b>${esc(u.name)}</b>${u.acts.length ? ` (${u.acts.join(', ')})` : ''}`);
  return `<div class="pill live"><i></i><span>${parts.length ? 'מחוברים: ' + parts.join(' · ') : 'מחובר'}</span></div>`;
}
function refreshLive() {
  const p = $('#pill'); if (p) p.innerHTML = pillHtml();
  if (S.view === 'list') renderListBody();
  if (S.view === 'card') renderOthersBar();
}

// ───────────── list ─────────────
function renderList() {
  S.view = 'list'; S.card = null; track(); unguard();
  if ($('#pickbar') && !S.pick) $('#pickbar').remove();
  app().innerHTML = `<div class="screen">
    <div class="top"><div class="toprow"><div class="title"><span>Ticket Monitor</span></div><div class="topbtns"><button class="icon" id="ppl" title="עובדים">👥</button><button class="icon" id="set">⚙</button></div></div><div id="pill">${pillHtml()}</div></div>
    ${S.readonly ? `<div class="banner grey">הנתונים מ-<bdi dir="ltr">${esc(S.cacheAt)}</bdi>. אפשר לחפש, לפתוח טיקט, להעתיק ולשלוח ב-WhatsApp. שמירה — כשתחזור הרשת.<br><button id="retry">התחבר שוב</button></div>` : ''}
    <input id="q" class="search" type="search" placeholder="🔍  חיפוש: מספר, עיר, רחוב, ארונית…" value="${esc(S.query)}">
    <div class="chips">${CHIPS.map(([k, t]) =>
      `<button class="chip c-${k} ${S.chip === k ? 'on' : ''}" data-chip="${k}">${t} <b data-n="${k}"></b></button>`).join('')}</div>
    <div class="count" id="count"></div><div class="list" id="list"></div>
    ${S.readonly ? '' : '<button class="fab" id="new">+</button>'}</div>`;
  $('#set').onclick = settings;
  $('#ppl').onclick = () => renderPeople();
  $('#q').oninput = e => { S.query = e.target.value; S.limit = 60; clearTimeout(S.qT); S.qT = setTimeout(renderListBody, 150); };
  document.querySelectorAll('[data-chip]').forEach(b => b.onclick = () => { S.chip = b.dataset.chip; S.limit = 60; try { localStorage.setItem('tm_chip', S.chip); } catch {} renderList(); });
  if ($('#new')) $('#new').onclick = () => openCard(null);
  if ($('#retry')) $('#retry').onclick = () => { if (S.cloud.rt || S.session.rt) { S.cloud.rt = S.cloud.rt || S.session.rt; renderLoading('מתחבר...'); S.cloud.refresh().then(() => kv.get('cache')).then(c => usableCache(c) ? quickStart(c) : enterOnline()).catch(e => e instanceof OfflineError ? (toast('עדיין אין חיבור'), renderList()) : renderLogin('')); } else renderLogin(''); };
  renderListBody();
}
// 1.34 / 10.55: בהמתנה / בעבודה longer than N hours (admin's choice, default 48) since תאריך כניסה
function lateHours() {
  const x = (Array.isArray(S.req) ? S.req : []).find(v => String(v).startsWith('late:'));
  const h = x ? parseInt(String(x).slice(5), 10) : NaN;
  return h > 0 ? h : 48;
}
function isLate(r) {
  const st = stClass(r);
  if (st !== 'wait' && st !== 'work') return false;
  const d = parseDate(r.entry_date);
  return !!d && Date.now() - d.getTime() > lateHours() * 3600e3;
}
function filtered() {
  const today = nowText().slice(0, 10);
  let rows = [...S.recs.values()];
  const words = S.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length) rows = rows.filter(r => words.every(w => r._s.includes(w)));
  const isToday = r => stClass(r) !== 'finish' && (r.entry_date || '').startsWith(today);   // 1.33: a closed ticket leaves «נפתחו היום»
  const n = {all: rows.length, finish: 0, wait: 0, work: 0, cont: 0, other: 0, today: 0, late: 0};      // numbers on the buttons
  for (const r of rows) { n[stClass(r)]++; if (isToday(r)) n.today++; if (isLate(r)) n.late++; }
  S.chipCounts = n;
  if (S.chip === 'today') rows = rows.filter(isToday);
  else if (S.chip === 'late') rows = rows.filter(isLate);
  else if (S.chip !== 'all') rows = rows.filter(r => stClass(r) === S.chip);
  return rows.sort((a, b) => b.id - a.id);
}
function renderListBody() {
  const list = $('#list'); if (!list) return;
  const rows = filtered(), today = nowText().slice(0, 10);      // 1.27: opened today → orange card
  $('#count').textContent = `${rows.length} טיקטים`;
  document.querySelectorAll('[data-n]').forEach(b => { b.textContent = (S.chipCounts || {})[b.dataset.n] ?? ''; });
  const open = {};
  for (const c of S.connections) if (c.conn !== S.conn && c.ticket_id != null) { const o = open[c.ticket_id] || (open[c.ticket_id] = {names: [], edit: false}); o.names.push(c.name || userName(c.user_id)); o.edit = o.edit || !!c.editing; }
  list.innerHTML = rows.slice(0, S.limit).map(r => {
    const st = stClass(r), o = open[r.id];
    const addr = [r.city, [r.street, r.house].filter(Boolean).join(' '), r.cabinet ? 'ארונית ' + r.cabinet : ''].filter(Boolean).join(' · ');
    const left = [r.fault, r.contractor].filter(Boolean).join(' · ');
    return `<button class="card st-${st}${!['finish', 'work', 'cont'].includes(st) && (r.entry_date || '').startsWith(today) ? ' today' : ''}${isLate(r) ? ' late' : ''} ${o ? (o.edit ? 'edit' : 'view') : ''}" data-id="${r.id}">
      <div class="row1"><span class="fdt f-${st}">${isLate(r) ? '<span class="latemark">⏱</span>' : ''}${esc(r.fdt)}</span><span class="badge b-${st}">${esc(stText(r))}</span></div>
      <div class="addr">${esc(addr) || '—'}</div>
      <div class="meta"><span>${esc(left)}</span><span dir="ltr">${esc(r.entry_date.slice(0, 5) + (r.entry_date.length > 10 ? r.entry_date.slice(10) : ''))}</span></div>
      ${o ? `<div class="who">${o.edit ? '✎ ' + esc(o.names.join(', ')) + ' עורך/ת את הטיקט כרגע' : '👁 ' + esc(o.names.join(', ')) + ' צופה בטיקט'}</div>` : ''}
    </button>`;
  }).join('') + (rows.length > S.limit ? `<button class="more" id="more">הצג עוד (${rows.length - S.limit})</button>` : '') +
    (!rows.length ? '<div class="loading">אין טיקטים להצגה</div>' : '');
  list.querySelectorAll('.card').forEach(b => {
    const id = +b.dataset.id;
    if (S.pick && S.pick.has(id)) b.classList.add('picked');
    b.onclick = () => { if (b._lp) { b._lp = false; return; } if (S.pick) togglePick(id); else openCard(id); };
    longPress(b, () => { if (S.pick) togglePick(id); else rowMenu(id); });
  });
  renderPickBar();
  if ($('#more')) $('#more').onclick = () => { S.limit += 100; renderListBody(); };
}

// ───────────── card ─────────────
function openCard(id, prefill) {
  const rec = id == null ? null : S.recs.get(id);
  const vals = rec ? Object.fromEntries(COLS.map(c => [c, rec[c]])) : Object.fromEntries(COLS.map(c => [c, c === 'status' ? 'בהמתנה' : '']));   // 1.25: new = בהמתנה
  if (!rec && prefill) for (const c of COLS) if (!DUP_SKIP.has(c) && norm(prefill[c])) vals[c] = prefill[c];      // 1.40: «שכפל»
  S.card = {id, rec: rec ? {...rec} : null, before: vals, remote: null, deleted: false, dirty: false, extra: id == null};
  S.view = 'card';
  if ($('#pickbar')) $('#pickbar').remove();
  renderCard();
  track();
  guard();
}
function fieldHtml(c) {
  const v = S.card.before[c] ?? '';
  const ro = S.readonly || MISSING.has(c) ? 'readonly' : '';
  const list = LOOKUP[c] || c === 'infrastructure' ? `list="dl-${c}"` : '';
  const ltr = DATE_COLS.has(c) || c === 'fdt' || c === 'house' || c === 'cabinet' ? 'ltr' : '';
  const input = MULTI.has(c) ? `<textarea data-c="${c}" data-big="${c}" readonly rows="2" placeholder="${S.readonly ? ' ' : 'לחץ לכתיבה…'}">${esc(v)}</textarea>`
    : `<input data-c="${c}" class="${ltr}" ${list} ${ro} value="${esc(v)}" ${DATE_COLS.has(c) ? `inputmode="numeric" placeholder="${DATE_ONLY.has(c) ? 'dd/mm/yyyy' : 'dd/mm/yyyy HH:MM'}"` : 'placeholder=" "'} autocomplete="off">`;
  const now = DATE_COLS.has(c) && !S.readonly ? `<label class="cal" title="בחר תאריך">📅<input type="${DATE_ONLY.has(c) ? 'date' : 'datetime-local'}" data-pick="${c}" aria-label="${esc(LABEL[c])}"></label><button class="now" data-now="${c}">${DATE_ONLY.has(c) ? 'היום' : 'עכשיו'}</button>` : '';
  const fiber = c === 'solution' && !S.readonly ? '<button class="fiberbtn" id="fiberbtn">✂ קרע סיב</button>'
    : c === 'site' ? '<button class="folderbtn" id="folderbtn" type="button">📁 תיקיית מתחם</button>'      // 1.39
    : c === 'contractor' || c === 'inspector' ? `<button class="contactbtn" data-contact="${c}" type="button">📞 פרטי קשר</button>`      // 1.41 / 1.42
    : c === 'street' ? '<span class="navbtns"><button class="wazebtn" id="wazebtn" type="button">Waze</button><button class="gmapsbtn" id="gmapsbtn" type="button">Maps</button></span>' : '';     // 1.22 Waze, 1.26 Google Maps
  const req = reqFields(), vm = req.open.has(LABEL[c]) ? ' rq-open' : req.close.has(LABEL[c]) ? ' rq-close' : '';   // 1.29: required fields
  return `<div class="f${DATE_COLS.has(c) ? ' dt' : ''}${vm}" id="f-${c}"><label>${esc(LABEL[c])}${fiber}</label>${input}${now}</div>`;
}
function datalists() {
  const out = [];
  for (const [c, kind] of Object.entries(LOOKUP)) {
    let vals;
    if (kind === 'site') vals = lookupValues('site', normCity(S.card.before.city));
    else if (kind === 'channel') vals = lookupValues('channel', norm(S.card.before.sent_by));
    else if (kind === 'inspector') vals = inspectorValues(S.card.before.sent_group);
    else vals = lookupValues(kind);
    out.push(`<datalist id="dl-${c}">${vals.map(v => `<option value="${esc(v)}">`).join('')}</datalist>`);
  }
  out.push(`<datalist id="dl-infrastructure">${cfgList('code').map(v => `<option value="${esc(v)}">`).join('')}</datalist>`);
  return out.join('');
}
// ───────────── 1.20: hints from the address book (1.21: also in an existing ticket + «חפש במאגר») ─────────────
function addrHook() {
  const box = document.createElement('div');
  box.id = 'addrbox'; box.className = 'addrbox hidden';
  const after = $('#f-cabinet'); if (!after) return;
  const find = document.createElement('button');
  find.id = 'addrfind'; find.className = 'btn addrfind'; find.type = 'button'; find.textContent = 'חפש במאגר הכתובות';
  after.after(find); find.after(box);
  let timer = null, seq = 0, mode = '', manual = false;
  const kick = m => { mode = m; manual = false; clearTimeout(timer); timer = setTimeout(run, 350); };
  find.onclick = e => {           // search with what the card holds now: ארונית first, otherwise רחוב + בית
    e.preventDefault(); const v = values();
    if (norm(v.cabinet).length >= 2) mode = 'cabinet';
    else if (norm(v.street).length >= 2) mode = 'address';
    else { toast('כדי לחפש במאגר מלא «ארונית» או «רחוב»'); return; }
    clearTimeout(timer); manual = true; run();
  };
  ['street', 'house'].forEach(c => inputOf(c) && inputOf(c).addEventListener('input', () => kick('address')));
  if (inputOf('cabinet')) inputOf('cabinet').addEventListener('input', () => kick('cabinet'));
  async function run() {
    if (!S.card || !document.body.contains(box)) return;      // the card was closed meanwhile
    const my = ++seq, v = values(), city = normCity(v.city);
    let args = null;
    if (mode === 'cabinet') { if (norm(v.cabinet).length >= 2) args = [city, '', '', norm(v.cabinet)]; }
    else if (norm(v.street).length >= 2) args = [city, norm(v.street), norm(v.house), ''];
    let rows = [];
    if (args) { try { rows = await S.cloud.addrSearch(...args); } catch { rows = []; } }
    if (my !== seq || !document.body.contains(box)) return;
    if (rows === null) { S.addrOff = true; box.remove(); find.remove(); return; }
    const seen = new Set(), items = [];
    for (const r of rows) { const k = [r.city, r.site, r.cabinet, r.street, r.house, r.entrance].join('|'); if (!seen.has(k)) { seen.add(k); items.push(r); } if (items.length >= 20) break; }
    const iso = x => `<bdi dir="ltr">${esc(x)}</bdi>`;
    const x = '<button class="addrx" id="addrx" type="button" aria-label="סגור">✕</button>';     // 1.23: close the hints
    box.innerHTML = items.length ? `<div class="addrhead">${x}מאגר הכתובות — ${items.length} התאמות · הקש למילוי</div>` + items.map((r, i) => {
      const addr = [r.street, r.house].filter(Boolean).join(' ') + (r.entrance ? ' כניסה ' + r.entrance : '');
      const low = [esc(r.city), r.site ? iso(r.site) : '', r.signal ? iso('Signal ' + r.signal) : '', r.drop_status ? 'דרופ: ' + esc(r.drop_status) : ''].filter(Boolean).join(' · ');
      return `<button class="addritem" data-i="${i}"><b>ארונית ${iso(r.cabinet || '—')} · ${esc(addr || '—')}</b><span>${low}</span></button>`;
    }).join('') : (manual ? `<div class="addrhead">${x}מאגר הכתובות — לא נמצאו התאמות</div>` : '');
    box.classList.toggle('hidden', !items.length && !manual);
    box.querySelectorAll('[data-i]').forEach(b => b.onclick = e => { e.preventDefault(); pick(items[+b.dataset.i]); });
    const xb = box.querySelector('#addrx');
    if (xb) xb.onclick = e => { e.preventDefault(); clearTimeout(timer); seq++; manual = false; box.classList.add('hidden'); box.innerHTML = ''; };
  }
  function pick(r) {          // עיר (only if empty), מתחם, רחוב, בית, כניסה, ארונית — Signal / דרופ are not written
    const set = (c, val) => { const el = inputOf(c); if (el && val) { el.value = val; onEdit(c); } };
    if (!norm(inputOf('city') && inputOf('city').value)) set('city', r.city);
    set('site', r.site); set('street', r.street); set('house', r.house); set('entrance', r.entrance); set('cabinet', r.cabinet);
    seq++; manual = false; box.classList.add('hidden'); box.innerHTML = '';
    toast('הכתובת מולאה מהמאגר');
  }
}
function renderCard() {
  const c = S.card, rec = c.rec, isNew = c.id == null;
  const title = isNew ? 'טיקט חדש' : 'טיקט ' + (rec.fdt || '');
  const sub = !isNew && rec._v > 1 && rec._ua ? `עדכון אחרון: <bdi dir="ltr">${esc(localTime(rec._ua))}</bdi> · ${esc(userName(rec._ub))}` : '';

  app().innerHTML = `<div class="screen">
    <div class="top"><div class="toprow"><div class="title"><button class="back" id="back">→</button><span>${esc(title)}</span></div>${isNew ? '' : '<button class="icon" id="hist">🕘</button>'}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>
    <div id="others"></div><div id="remote"></div>
    ${S.readonly ? '<div class="banner grey">מצב לא מקוון — קריאה בלבד. אפשר להעתיק ולשלוח ב-WhatsApp.</div>' : ''}
    <div class="form">
      <div class="box first">${COLS.map(fieldHtml).join('')}</div>   <!-- all 20 fields, same order as the table / desktop card -->
      ${datalists()}
    </div>
    <div class="bottom"><button class="btn goback" id="back2" aria-label="חזרה">→ חזרה</button><button class="btn wa" id="wa">WhatsApp</button><button class="btn save" id="save" ${S.readonly ? 'disabled' : ''}>שמור</button></div></div>`;
  $('#back').onclick = closeCard;
  $('#back2').onclick = closeCard;
  if (!S.readonly && !S.addrOff) addrHook();          // 1.21: new and existing tickets
  if ($('#hist')) $('#hist').onclick = () => showHistory(c.id);
  $('#wa').onclick = whatsapp;
  $('#save').onclick = save;
  document.querySelectorAll('[data-c]').forEach(el => el.addEventListener('input', () => onEdit(el.dataset.c)));
  document.querySelectorAll('[data-big]').forEach(el => el.addEventListener('click', () => openTextEditor(el.dataset.big)));
  if (inputOf('fault')) inputOf('fault').addEventListener('change', faultChanged);
  if ($('#fiberbtn')) $('#fiberbtn').onclick = e => { e.preventDefault(); e.stopPropagation(); fiberForm(); };
  document.querySelectorAll('[data-contact]').forEach(b => b.onclick = e => { e.preventDefault(); e.stopPropagation();
    contactSheet(((inputOf(b.dataset.contact) || {}).value || '').trim(), LABEL[b.dataset.contact]); });
  if ($('#folderbtn')) $('#folderbtn').onclick = e => { e.preventDefault(); e.stopPropagation(); openSiteFolder(); };
  if ($('#wazebtn')) $('#wazebtn').onclick = e => { e.preventDefault(); e.stopPropagation(); openWaze(); };
  if ($('#gmapsbtn')) $('#gmapsbtn').onclick = e => { e.preventDefault(); e.stopPropagation(); openGmaps(); };
  document.querySelectorAll('[data-pick]').forEach(p => {
    const col = p.dataset.pick;
    const prime = () => { const d = parseDate(inputOf(col).value) || new Date(); p.value = toIso(d).slice(0, DATE_ONLY.has(col) ? 10 : 16); };
    p.addEventListener('pointerdown', prime);
    p.addEventListener('focus', prime);
    p.addEventListener('change', () => {          // native calendar + clock of the phone
      const m = p.value.match(/^(\d{4})-(\d\d)-(\d\d)(?:T(\d\d):(\d\d))?/);
      if (!m) return;
      inputOf(col).value = `${m[3]}/${m[2]}/${m[1]}` + (m[4] && !DATE_ONLY.has(col) ? ` ${m[4]}:${m[5]}` : '');
      onEdit(col);
    });
  });
  document.querySelectorAll('[data-now]').forEach(b => b.onclick = () => { const el = inputOf(b.dataset.now); el.value = DATE_ONLY.has(b.dataset.now) ? nowText().slice(0, 10) : nowText(); onEdit(b.dataset.now); });
  updateSave();
  renderOthersBar();
  window.scrollTo(0, 0);
}
const inputOf = c => document.querySelector(`[data-c="${c}"]`);
function values() { const v = {}; for (const c of COLS) { const el = inputOf(c); v[c] = el ? norm(el.value) : S.card.before[c]; } return v; }
function changedCols(v) { return COLS.filter(c => norm(v[c]) !== norm(S.card.before[c])); }
// 1.25 / 10.39: תאריך סגירה → FINISH; otherwise קבלן מבצע + תאריך הקפצה → בעבודה, without them → בהמתנה.
// Only empty / בהמתנה / בעבודה switch; FINISH goes back only when תאריך סגירה is cleared; המשך טיפול stays. null = leave.
function autoStatus(status, contractor, bump, close, closing) {
  const st = norm(status), cat = st ? stClass({status: st, close_date: ''}) : '';
  if (parseDate(close)) return cat !== 'finish' ? 'FINISH' : null;
  if (cat === 'finish' && !(closing && !norm(close))) return null;
  if (!['', 'wait', 'work', 'finish'].includes(cat)) return null;
  const want = norm(contractor) && parseDate(bump) ? 'בעבודה' : 'בהמתנה';
  if ((cat === 'work' && want === 'בעבודה') || (cat === 'wait' && want === 'בהמתנה')) return null;
  return want;
}
function onEdit(col) {
  const c = S.card;
  if (col === 'city') { const dl = $('#dl-site'); if (dl) dl.innerHTML = lookupValues('site', normCity(inputOf('city').value)).map(v => `<option value="${esc(v)}">`).join(''); }
  if (col === 'sent_by') { const dl = $('#dl-sent_group'); if (dl) dl.innerHTML = lookupValues('channel', norm(inputOf('sent_by').value)).map(v => `<option value="${esc(v)}">`).join(''); }
  if (col === 'sent_by' || col === 'sent_group') { const dl = $('#dl-inspector'); if (dl && inputOf('sent_group')) dl.innerHTML = inspectorValues(inputOf('sent_group').value).map(v => `<option value="${esc(v)}">`).join(''); }
  if (col === 'status') {                 // a closed status fills the close date (if empty)
    const st = stClass({status: inputOf('status').value, close_date: ''});
    const cd = inputOf('close_date');
    if (st === 'finish' && cd && !norm(cd.value)) { cd.value = nowText(); toast('תאריך סגירה מולא: ' + cd.value); }
  }
  if (DATE_COLS.has(col)) { const el = inputOf(col); el.classList.toggle('bad', !!norm(el.value) && !parseDate(el.value)); }
  if ((col === 'contractor' || col === 'escalation_date' || col === 'close_date') && !S.readonly) {   // 1.24–1.25 / 10.38–10.39
    const st = inputOf('status'), v = values();
    const want = st && autoStatus(v.status, v.contractor, v.escalation_date, v.close_date, col === 'close_date');
    if (want && want !== norm(st.value)) { st.value = want; toast('סטטוס: ' + want); }
  }
  if (col === 'fdt') { const el = inputOf('fdt'); el.classList.toggle('bad', isDupFdt(el.value)); }
  updateSave();
  const dirty = changedCols(values()).length > 0;
  if (dirty !== c.dirty) { c.dirty = dirty; track(); renderOthersBar(); }
}
function updateSave() {
  markClosing();
  const v = values(), ch = new Set(changedCols(v));
  for (const c of COLS) { const f = $('#f-' + c); if (f) f.classList.toggle('changed', ch.has(c)); }
  const b = $('#save');
  if (b) { b.disabled = S.readonly || S.card.deleted || ch.size === 0; b.textContent = ch.size ? `שמור (${ch.size})` : 'שמור'; }
}
function isDupFdt(v) {
  const k = norm(v).toLowerCase(), own = S.card.rec ? S.card.rec.fdt.toLowerCase() : null;
  if (!k || k === own) return false;
  for (const r of S.recs.values()) if (r.fdt.toLowerCase() === k) return true;
  return false;
}
function setBanner(el, html) {      // a message above the fields must not move the field being typed in
  if (!el || el.innerHTML === html) return;
  const f = document.activeElement, keep = f && f !== document.body && el.parentNode && !el.contains(f);
  const y0 = keep ? f.getBoundingClientRect().top : 0;
  el.innerHTML = html;
  if (keep) { const d = f.getBoundingClientRect().top - y0; if (Math.abs(d) > 1) window.scrollBy(0, d); }
}
function renderOthersBar() {
  const el = $('#others'); if (!el || !S.card || S.card.id == null) return;
  const o = othersOn(S.card.id);
  if (!o.length) { setBanner(el, ''); return; }
  const editing = o.filter(x => x[1]).map(x => x[0]), viewing = o.filter(x => !x[1]).map(x => x[0]);
  let t = [];
  if (editing.length) t.push('⚠ ' + editing.join(', ') + ' עורך/ת את הטיקט הזה כרגע');
  if (viewing.length) t.push(viewing.join(', ') + ' צופה בטיקט הזה');
  setBanner(el, `<div class="banner ${editing.length ? 'warn' : 'info'}">${esc(t.join(' · '))}${editing.length && S.card.dirty ? '<br>בשמירה תתבקש לאשר אם אותם שדות השתנו.' : ''}</div>`);
}
function remoteUpdate(rec) {
  const c = S.card;
  if (!rec || !c.rec || rec._v <= c.rec._v) return;
  const diff = COLS.filter(x => !same(rec[x], c.rec[x]));
  const who = userName(rec._ub);
  if (!diff.length) { c.rec = {...rec}; return; }
  if (!c.dirty) {
    c.rec = {...rec}; c.before = Object.fromEntries(COLS.map(x => [x, rec[x]]));
    renderCard();
    setBanner($('#remote'), `<div class="banner info">ℹ ${esc(who)} עדכן/ה את הטיקט. הכרטיס רוענן: ${esc(diff.map(x => LABEL[x]).join(', '))}</div>`);
  } else {
    c.remote = rec;
    setBanner($('#remote'), `<div class="banner orange">⚠ ${esc(who)} שמר/ה שינויים בזמן שערכת: ${esc(diff.map(x => LABEL[x]).join(', '))}<br><button id="loadr">טען ערכים חדשים</button></div>`);
    $('#loadr').onclick = async () => {
      if (!await ask('טעינת ערכים', 'השינויים שלך בכרטיס יימחקו ויוצגו הערכים מהשרת. להמשיך?')) return;
      c.rec = {...c.remote}; c.before = Object.fromEntries(COLS.map(x => [x, c.remote[x]])); c.dirty = false; renderCard(); track();
    };
  }
}
function remoteDeleted() {
  S.card.deleted = true;
  setBanner($('#remote'), '<div class="banner warn">⚠ הטיקט נמחק על ידי משתמש אחר. אי אפשר לשמור בו שינויים.</div>');
  updateSave();
}
async function closeCard() {
  if (S.card && S.card.dirty && !S.readonly && !await ask('שינויים לא נשמרו', 'לסגור את הכרטיס בלי לשמור?', 'סגור בלי לשמור', 'המשך לערוך', true)) return;
  renderList();
}

// ───────────── big editor for תשתית / פתרון / הערות: half a screen to type, one tap to save ─────────────
function openTextEditor(col) {
  const el = inputOf(col);
  if (!el || $('#bigedit')) return;
  const ro = S.readonly || (S.card && S.card.deleted);
  const isNew = S.card && S.card.id == null;
  const ov = document.createElement('div');
  ov.id = 'bigedit';
  ov.className = 'bigedit';
  ov.innerHTML = `<div class="bigpanel">
      <div class="bighead"><b>${esc(LABEL[col])}</b><span>${esc(S.card && S.card.rec ? 'טיקט ' + S.card.rec.fdt : 'טיקט חדש')}</span></div>
      <textarea id="bigtext" dir="rtl" ${ro ? 'readonly' : ''}>${esc(el.value)}</textarea>
      <div class="bigbtns">${ro ? '' : `<button class="btn save" id="bigsave">${isNew ? 'אישור' : 'שמור'}</button>`}<button class="btn" id="bigcancel">${ro ? 'סגור' : 'ביטול'}</button></div>
    </div>`;
  document.body.appendChild(ov);
  document.body.classList.add('noscroll');
  guard();
  const ta = $('#bigtext');
  const close = () => { ov.remove(); document.body.classList.remove('noscroll'); unguard(); };
  $('#bigcancel').onclick = close;
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
  if (!ro) {
    setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 30);
    $('#bigsave').onclick = () => {
      el.value = ta.value.replace(/\s+$/, '');
      close();
      onEdit(col);
      if (isNew) { toast('נוסף לכרטיס — לחץ "שמור" לשמירת הטיקט'); return; }
      if (changedCols(values()).length) save();           // existing ticket: saved at once
    };
  }
}

async function save() {
  const c = S.card, v = values(), changed = changedCols(v);
  if (!changed.length || S.readonly) return;
  if (!norm(v.fdt)) return info('חסר נתון', "יש להזין מס' טיקט FDT.");
  if (isDupFdt(v.fdt)) return info('טיקט קיים', "מס' טיקט FDT כבר קיים בטיקט אחר.");
  const bad = COLS.filter(x => DATE_COLS.has(x) && norm(v[x]) && !parseDate(v[x]));
  if (bad.length) return info('תאריך שגוי', 'תאריך לא תקין: ' + bad.map(x => LABEL[x]).join(', ') + '\nהפורמט: dd/mm/yyyy או dd/mm/yyyy HH:MM');
  const btn = $('#save'); btn.disabled = true; btn.textContent = 'שומר...';
  try {
    if (c.id == null) {
      const row = await S.cloud.insertTicket(recToDb(v, COLS));
      applyRow(row);
      toast('הטיקט החדש נשמר');
      c.dirty = false; renderList(); return;
    }
    const res = await saveChanges(c, v, changed);
    if (!res) { updateSave(); return; }
    toast(res.merged.length ? `נשמר. בינתיים ${res.merged.join(', ')} שינה/תה שדות אחרים — שני השינויים נשמרו.` : 'נשמר', 3500);
    c.dirty = false; renderList();
  } catch (e) {
    updateSave();
    if (e instanceof DupError) return info('טיקט קיים', "מס' טיקט FDT כבר קיים בשרת.");
    if (e && e.deleted) { remoteDeleted(); return info('שמירה', 'הטיקט נמחק על ידי משתמש אחר — השינויים לא נשמרו.'); }
    if (e instanceof AuthError) return sessionEnded();
    return info('השמירה נכשלה', errText(e) + '\nהכרטיס נשאר פתוח — אפשר לנסות שוב.');
  }
}
async function saveChanges(c, after, changed) {
  const body = recToDb(after, changed), before = c.before, merged = [];
  let version = c.rec._v, forced = false;
  for (let i = 0; i < 5; i++) {
    const row = await S.cloud.updateTicket(c.id, version, body);
    if (row) { applyRow(row); return {merged}; }
    const curRow = await S.cloud.getTicket(c.id);
    if (!curRow) { const e = new Error('deleted'); e.deleted = true; throw e; }
    const cur = dbToRec(curRow);
    const conflicts = changed.filter(x => !same(cur[x], before[x]) && !same(cur[x], after[x]));
    if (conflicts.length && !forced) {
      const det = conflicts.map(x => `• ${LABEL[x]}: עכשיו בשרת «${cur[x] || '—'}»`).join('\n');
      if (!await ask('שינוי מקביל', `${userName(cur._ub)} שינה/תה את אותם שדות:\n${det}\n\nלדרוס עם הערכים שלך?`, 'דרוס', 'ביטול', true)) { applyRow(curRow); return null; }
      forced = true;
    } else if (!conflicts.length) { const n = userName(cur._ub); if (!merged.includes(n)) merged.push(n); }
    version = cur._v;
  }
  throw new CloudError('השרת עסוק — נסה שוב.');
}
function applyRow(row) {
  const r = dbToRec(row), cur = S.recs.get(r.id);
  if (!cur || cur._v <= r._v) { S.recs.set(r.id, r); S.raw.set(r.id, row); }
  saveCache();
}

// ───────────── WhatsApp / history / settings ─────────────
function wazeUrl(v) {            // 1.22 / 10.36: רחוב + בית + עיר → Waze navigation; '' without a street
  const street = norm(v.street); if (!street) return '';
  const addr = [street, norm(v.house)].filter(Boolean).join(' '), city = normCity(v.city);
  return 'https://waze.com/ul?q=' + encodeURIComponent(city ? `${addr}, ${city}` : addr) + '&navigate=yes';
}
function gmapsUrl(v) {           // 1.26 / 10.43: Google Maps search; '' without a street
  const street = norm(v.street); if (!street) return '';
  const addr = [street, norm(v.house)].filter(Boolean).join(' '), city = normCity(v.city);
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(city ? `${addr}, ${city}` : addr);
}
function openGmaps() {
  const url = gmapsUrl(values());
  if (!url) { toast('אין כתובת: מלא «רחוב»'); return; }
  window.open(url, '_blank');
}
// ───────────── 1.39 / 10.64: folder of the מתחם in SharePoint ─────────────
// The admin's computer sends the list of folders under …\++מפות++\אופטיקה\HOT (app_settings 'maps_index':
// [library web address, path of HOT inside it, 'city/site', …]); the phone finds the folder like the desktop (tm_maps.py)
// and opens it on the web (OneDrive app or browser).
const MAP_SEP = [' ', '_', '(', '.', ' -', '-'];
const MAP_VER = /[\s_-]*v\d+$/i;
const mapName = s => String(s || '').replace(/_/g, ' ').split(/\s+/).filter(Boolean).join(' ').toLowerCase();
function mapsIndex() {
  const v = S.maps;
  if (!Array.isArray(v) || v.length < 2 || !v[0]) return null;
  if (mapsIndex.src !== v) {
    const idx = new Map(), rels = v.slice(2).filter(Boolean);
    for (const rel of rels) { const n = rel.split('/').pop().trim().toLowerCase(); if (!idx.has(n)) idx.set(n, []); idx.get(n).push(rel); }
    mapsIndex.c = {lib: v[0], sub: v[1] || '', idx, all: new Set(rels)}; mapsIndex.src = v;
  }
  return mapsIndex.c;
}
function siteFolders(site, city) {
  const m = mapsIndex();
  site = String(site || '').trim(); city = String(city || '').trim();
  if (!m || !site) return [];
  if (city && m.all.has(`${city}/${site}`)) return [`${city}/${site}`];
  const key = site.toLowerCase(), c = mapName(city);
  const exact = new Set(m.idx.get(key) || []), loose = new Set();
  if (!exact.size || c)                         // «GB-HDRA2409 ישן» — the code and then anything
    for (const [name, ps] of m.idx)
      if (name.startsWith(key) && MAP_SEP.some(s => name.slice(key.length, key.length + 2).startsWith(s))) ps.forEach(p => loose.add(p));
  const parent = p => { const a = p.split('/'); return a.length > 1 ? a[a.length - 2] : ''; };
  const inCity = p => !!c && mapName(parent(p)) === c;
  let hits = new Set([...exact, ...loose]);
  if (exact.size && ![...loose].some(inCity)) hits = exact;   // a «code + text» folder counts only in the own city
  const out = [...hits].sort((a, b) => (inCity(a) ? 0 : 1) - (inCity(b) ? 0 : 1) || (exact.has(a) ? 0 : 1) - (exact.has(b) ? 0 : 1)
                                    || (a < b ? -1 : a > b ? 1 : 0));
  const base = site.replace(MAP_VER, '');
  if (!out.length && base && base !== site) return siteFolders(base, city);   // «GB-NATN016-V2» → «GB-NATN016»
  return out;
}
function folderUrl(rel) {
  const m = mapsIndex(), u = new URL(m.lib), lib = u.pathname.replace(/\/+$/, '');
  const id = [decodeURIComponent(lib), m.sub, rel].filter(Boolean).join('/');
  return `${u.origin}${lib}/Forms/AllItems.aspx?id=${encodeURIComponent(id)}`;
}
function openSiteFolder() {
  const site = ((inputOf('site') || {}).value || '').trim(), city = ((inputOf('city') || {}).value || '').trim();
  if (!site) { toast('השדה «מתחם» ריק — בחר מתחם קודם.'); return; }
  if (!mapsIndex()) { toast('רשימת התיקיות עוד לא נשלחה מהמחשב של המנהל.', 4000); return; }
  const hits = siteFolders(site, city);
  if (!hits.length) { toast(`לא נמצאה תיקייה בשם ${site}`, 4000); return; }
  if (hits.length === 1) { window.open(folderUrl(hits[0]), '_blank'); return; }
  const s = sheet(`<h3>תיקיית מתחם</h3><p>נמצאו כמה תיקיות בשם ${esc(site)}:</p><div class="folders">${hits.map(h =>
    `<a class="btn dark" target="_blank" rel="noopener" href="${esc(folderUrl(h))}" dir="auto">${esc(h)}</a>`).join('')}</div>
    <div class="btns"><button class="btn" id="fclose">ביטול</button></div>`);
  s.querySelectorAll('a').forEach(a => a.addEventListener('click', () => setTimeout(closeSheet, 300)));
  s.querySelector('#fclose').onclick = closeSheet;
}
// ───────────── 1.41 / 10.70: «עובדים» — contacts (read only on the phone; the admin edits on the computer) ─────────────
const PERSON_SEL = 'id,kind,first_name,last_name,email,phone,contractor,user_id,extra,active';
async function loadPeople() {
  if (S.readonly) return;
  try {
    S.people = await S.cloud.fetchAll('people', `select=${PERSON_SEL}&order=first_name,last_name,id`);
    const f = await S.cloud.loadSetting('people_fields');
    S.peopleFields = (Array.isArray(f) ? f : []).map(x => { const [key, label, type] = String(x).split('|'); return {key, label, type: type || 'text'}; })
      .filter(x => x.key && x.label);
    S.peopleOk = true;
  } catch (e) { if (e instanceof AuthError) throw e; S.peopleOk = !(e && /people|PGRST205/.test(String(e.message || e))); }
}
const personName = p => [p.first_name, p.last_name].map(x => norm(x)).filter(Boolean).join(' ') || '—';
function waPhone(phone) {                   // 050-123 4567 → 972501234567
  let d = String(phone || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = '972' + d.slice(1);
  return d;
}
const telPhone = phone => String(phone || '').replace(/[^\d+]/g, '');
function personFor(name) {
  const n = norm(name); if (!n) return null;
  const act = (S.people || []).filter(p => p.active !== false);
  return act.find(p => same(p.contractor, n)) || act.find(p => same(personName(p), n)) || null;
}
function contactLinks(p) {
  const tel = telPhone(p.phone), wa = waPhone(p.phone), em = norm(p.email);
  return `${tel ? `<a class="cl call" href="tel:${esc(tel)}">📞 התקשר</a>` : ''}${wa ? `<a class="cl wa" target="_blank" rel="noopener" href="https://wa.me/${wa}">WhatsApp</a>` : ''}${em ? `<a class="cl mail" href="mailto:${esc(em)}">✉ אימייל</a>` : ''}`;
}
function personSheet(p) {
  const rows = [['תפקיד', p.kind], ['טלפון', p.phone], ['אימייל', p.email], ['קבלן מבצע', p.contractor]]
    .concat((S.peopleFields || []).map(f => [f.label, (p.extra || {})[f.key]])).filter(([, v]) => norm(v));
  const s = sheet(`<h3>${esc(personName(p))}</h3><div class="pinfo">${rows.map(([k, v]) => `<div><span>${esc(k)}</span><b dir="auto">${esc(v)}</b></div>`).join('')}</div>
    <div class="clinks">${contactLinks(p)}</div><div class="btns"><button class="btn" id="pclose">סגור</button></div>`);
  s.querySelector('#pclose').onclick = closeSheet;
  s.querySelectorAll('a.cl').forEach(a => a.addEventListener('click', () => setTimeout(closeSheet, 300)));
}
function contactSheet(name, label = 'קבלן מבצע') {
  if (!name) { toast(`השדה «${label}» ריק`); return; }
  const p = personFor(name);
  if (!p) { toast(`אין פרטי קשר ל-«${name}». המנהל מוסיף אותם ב«עובדים» בתוכנית במחשב.`, 4500); return; }
  personSheet(p);
}
function renderPeople() {
  S.view = 'people'; S.card = null; S.pick = null; track(); guard();
  if ($('#pickbar')) $('#pickbar').remove();
  S.pq = S.pq || ''; S.pkind = S.pkind || 'all';
  app().innerHTML = `<div class="screen">
    <div class="top"><div class="toprow"><div class="title"><button class="back" id="pback">→</button><span>עובדים</span></div></div></div>
    ${S.peopleOk === false ? '<div class="banner grey">הטבלה «עובדים» עוד לא קיימת בשרת (16_people.sql).</div>' : ''}
    <input id="pq" class="search" type="search" placeholder="🔍  חיפוש: שם, טלפון, קבלן…" value="${esc(S.pq)}">
    <div class="chips" id="pkinds"></div><div class="count" id="pcount"></div><div class="list" id="plist"></div></div>`;
  $('#pback').onclick = () => history.back();
  $('#pq').oninput = e => { S.pq = e.target.value; renderPeopleBody(); };
  renderPeopleBody();
  if (!S.readonly) loadPeople().then(() => { if (S.view === 'people') renderPeopleBody(); saveCache(); }).catch(() => {});
}
function renderPeopleBody() {
  const all = (S.people || []).filter(p => p.active !== false);
  const kinds = ['all', ...new Set(['קבלן', 'משתמש', 'מפקח', 'אחר', ...all.map(p => norm(p.kind)).filter(Boolean)])];
  $('#pkinds').innerHTML = kinds.map(k => `<button class="chip ${S.pkind === k ? 'on' : ''}" data-k="${esc(k)}">${k === 'all' ? 'הכל' : esc(k)} <b>${k === 'all' ? all.length : all.filter(p => norm(p.kind) === k).length}</b></button>`).join('');
  $('#pkinds').querySelectorAll('[data-k]').forEach(b => b.onclick = () => { S.pkind = b.dataset.k; renderPeopleBody(); });
  const words = norm(S.pq).toLowerCase().split(/\s+/).filter(Boolean);
  const text = p => [personName(p), p.kind, p.phone, p.email, p.contractor, ...Object.values(p.extra || {})].join(' ').toLowerCase();
  const rows = all.filter(p => (S.pkind === 'all' || norm(p.kind) === S.pkind) && words.every(w => text(p).includes(w)))
    .sort((a, b) => personName(a).localeCompare(personName(b), 'he'));
  $('#pcount').textContent = `${rows.length} עובדים`;
  $('#plist').innerHTML = rows.map(p => `<div class="person" data-id="${p.id}"><div class="pmain"><b>${esc(personName(p))}</b>
      <span>${esc([p.kind, p.contractor && !same(p.contractor, personName(p)) ? 'קבלן: ' + p.contractor : ''].filter(Boolean).join(' · '))}</span>
      <span dir="ltr" class="ph">${esc(p.phone || '')}</span></div><div class="clinks">${contactLinks(p)}</div></div>`).join('') ||
    `<div class="loading">${S.readonly ? 'אין נתונים במצב לא מקוון' : 'אין עובדים להצגה'}</div>`;
  $('#plist').querySelectorAll('.person').forEach(el => el.querySelector('.pmain').onclick = () => {
    const p = (S.people || []).find(x => x.id === +el.dataset.id); if (p) personSheet(p); });
}
// ───────────── 1.40 / 10.67: long press on a ticket — the same actions as the right click on the computer ─────────────
const DUP_SKIP = new Set(['fdt', 'entry_date', 'status', 'contractor', 'escalation_date', 'close_type', 'infrastructure',
                          'close_date', 'solution', 'notes']);
const WA_MULTI_SEP = '\n\n\u200f= = = = = = = = = = = = = = =\n\n';     // several tickets in one message
const STATUS_MENU = ['בהמתנה', 'בעבודה', 'המשך טיפול', 'FINISH'];
function longPress(el, fn, ms = 550) {
  let t = null, x = 0, y = 0;
  const stop = () => { clearTimeout(t); t = null; };
  el.addEventListener('pointerdown', e => { x = e.clientX; y = e.clientY; stop(); el._lp = false; t = setTimeout(() => { t = null; el._lp = true; fn(); }, ms); });
  el.addEventListener('pointermove', e => { if (t && Math.hypot(e.clientX - x, e.clientY - y) > 10) stop(); });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(k => el.addEventListener(k, stop));
  el.addEventListener('contextmenu', e => { e.preventDefault(); if (!el._lp) { stop(); el._lp = true; fn(); } });
}
function statusValues() {
  return STATUS_MENU.concat(lookupValues('status').filter(v => stClass({status: v, close_date: ''}) === 'other' && !STATUS_MENU.includes(v)));
}
const recsMessage = rs => rs.map(r => message(r)).join(WA_MULTI_SEP);
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; }
  catch { const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select();
          const ok = document.execCommand('copy'); ta.remove(); return ok; }
}
async function copyRecs(rs) {
  if (!S.readonly) { try { await loadWaSetting(); } catch {} }
  S.copied = rs.map(r => ({...r}));
  await copyText(recsMessage(rs));
  toast(rs.length > 1 ? `הועתקו ${rs.length} טיקטים` : `הועתק טיקט ${rs[0].fdt}`);
}
async function sendRecs(rs) {
  if (!S.readonly) { try { await loadWaSetting(); } catch {} }
  const t = recsMessage(rs);
  if (t) window.open('https://wa.me/?text=' + encodeURIComponent(t), '_blank');
}
function rowMenu(id) {
  const r = S.recs.get(id); if (!r) return;
  const ro = S.readonly;
  const s = sheet(`<h3>טיקט ${esc(r.fdt)}</h3><p class="sub">${esc([r.city, r.street, r.house].filter(Boolean).join(' '))}</p>
    <div class="menu">
      <button class="mi" data-m="open">פתח</button>
      <button class="mi" data-m="copy">העתק</button>
      <button class="mi wa" data-m="send">שלח ב-WhatsApp</button>
      ${ro ? '' : '<button class="mi" data-m="dup">שכפל לטיקט חדש</button><button class="mi" data-m="status">סטטוס ‹</button><button class="mi" data-m="contr">קבלן מבצע ‹</button>'}
      <button class="mi" data-m="pick">☑ בחר כמה טיקטים</button>
    </div><div class="btns"><button class="btn" data-m="close">ביטול</button></div>`);
  s.querySelectorAll('[data-m]').forEach(b => b.onclick = () => {
    const m = b.dataset.m; closeSheet();
    if (m === 'open') openCard(id);
    else if (m === 'copy') copyRecs([r]);
    else if (m === 'send') sendRecs([r]);
    else if (m === 'dup') { openCard(null, r); faultChanged(); }
    else if (m === 'status') statusMenu([r]);
    else if (m === 'contr') contractorMenu([r]);
    else if (m === 'pick') { S.pick = new Set([id]); renderListBody(); }
  });
}
function pickSheet(title, values, current) {
  return new Promise(res => {
    const s = sheet(`<h3>${esc(title)}</h3><div class="menu">${values.map((v, i) =>
      `<button class="mi${same(v, current) ? ' cur' : ''}" data-i="${i}">${same(v, current) ? '✓ ' : ''}${esc(v)}</button>`).join('')}</div>
      <div class="btns"><button class="btn" data-i="-1">ביטול</button></div>`);
    closeSheet.cb = () => res(null);
    s.querySelectorAll('[data-i]').forEach(b => b.onclick = () => { closeSheet.cb = null; closeSheet(); const i = +b.dataset.i; res(i >= 0 ? values[i] : null); });
  });
}
async function statusMenu(rs) {
  const v = await pickSheet(rs.length > 1 ? `סטטוס — ${rs.length} טיקטים` : 'סטטוס', statusValues(), rs.length === 1 ? rs[0].status : null);
  if (v) await setStatusRecs(rs, v);
}
async function contractorMenu(rs) {
  const vals = lookupValues('contractor');
  if (!vals.length) return info('קבלן מבצע', 'רשימת הקבלנים ריקה.');
  const v = await pickSheet(rs.length > 1 ? `קבלן מבצע — ${rs.length} טיקטים` : 'קבלן מבצע', vals, rs.length === 1 ? rs[0].contractor : null);
  if (v) await setContractorRecs(rs, v);
}
async function changeRecs(rs, change, title) {
  // change(rec) → {col: value}; saved one by one like a card save (history, parallel changes). Returns the saved count.
  if (S.readonly || !rs.length) return 0;
  const busy = [...new Set(rs.flatMap(r => othersOn(r.id).filter(([, ed]) => ed).map(([n]) => n)))];
  if (busy.length && !await ask(title, `${busy.join(', ')} עורך/ת כרגע ${rs.length > 1 ? 'חלק מהטיקטים האלה' : 'את הטיקט הזה'}.\nלשנות בכל זאת?`, 'שנה', 'ביטול', true)) return 0;
  let n = 0;
  for (const r0 of rs) {
    const r = S.recs.get(r0.id) || r0, upd = change(r);
    const before = Object.fromEntries(COLS.map(c => [c, r[c]])), after = {...before, ...upd};
    const changed = COLS.filter(c => norm(after[c]) !== norm(before[c]));
    if (!changed.length) continue;
    try {
      const res = await saveChanges({id: r.id, rec: r, before}, after, changed);
      if (res) n++;
    } catch (e) {
      if (e instanceof AuthError) { sessionEnded(); return n; }
      if (e && e.deleted) continue;
      await info(title, errText(e)); break;
    }
  }
  return n;
}
async function setStatusRecs(rs, status) {
  const fin = stClass({status, close_date: ''}) === 'finish', now = nowText();
  const n = await changeRecs(rs, r => fin ? {status, close_date: norm(r.close_date) ? r.close_date : now} : {status, close_date: ''}, 'שינוי סטטוס');
  if (!n) return renderListBody();
  toast(`סטטוס ${status}: ${n} טיקטים`);
  if (fin) {
    const need = COLS.filter(c => reqFields().close.has(LABEL[c]));
    const miss = rs.map(r => S.recs.get(r.id) || r).map(r => [r.fdt, need.filter(c => !norm(r[c])).map(c => LABEL[c])]).filter(x => x[1].length);
    if (miss.length) await info('FINISH', 'נסגר, אבל חסרים שדות לסגירה:\n\n' + miss.slice(0, 10).map(([f, l]) => `טיקט ${f}: ${l.join(', ')}`).join('\n'));
  }
  renderListBody();
}
async function setContractorRecs(rs, name) {
  const today = nowText().slice(0, 10);
  const n = await changeRecs(rs, r => {
    const bump = norm(r.escalation_date) ? r.escalation_date : today;
    const upd = {contractor: name, escalation_date: bump};
    const st = autoStatus(r.status, name, bump, r.close_date, false);
    if (st) upd.status = st;
    return upd;
  }, 'קבלן מבצע');
  if (n) toast(`קבלן מבצע ${name}: ${n} טיקטים`);
  renderListBody();
}
// selection of several tickets
function togglePick(id) {
  if (!S.pick) return;
  if (S.pick.has(id)) S.pick.delete(id); else S.pick.add(id);
  renderListBody();
}
function pickedRecs() { return [...(S.pick || [])].map(id => S.recs.get(id)).filter(Boolean); }
function renderPickBar() {
  let bar = $('#pickbar');
  if (!S.pick || S.view !== 'list') { if (bar) bar.remove(); if ($('#new')) $('#new').classList.remove('hidden'); return; }
  if (!bar) { bar = document.createElement('div'); bar.id = 'pickbar'; bar.className = 'pickbar'; document.body.appendChild(bar); }
  if ($('#new')) $('#new').classList.add('hidden');
  const n = S.pick.size, ro = S.readonly, dis = n ? '' : 'disabled';
  bar.innerHTML = `<div class="pk-top"><b>${n} נבחרו</b><button class="pk-x" data-p="x">✕ סיום</button></div>
    <div class="pk-btns"><button data-p="copy" ${dis}>העתק</button><button class="wa" data-p="send" ${dis}>שלח</button>
    ${ro ? '' : `<button data-p="status" ${dis}>סטטוס</button><button data-p="contr" ${dis}>קבלן</button>`}</div>`;
  bar.querySelectorAll('[data-p]').forEach(b => b.onclick = async () => {
    const p = b.dataset.p, rs = pickedRecs();
    if (p === 'x') { S.pick = null; renderListBody(); return; }
    if (!rs.length) return;
    if (p === 'copy') copyRecs(rs);
    else if (p === 'send') sendRecs(rs);
    else if (p === 'status') statusMenu(rs);
    else if (p === 'contr') contractorMenu(rs);
  });
}
function openWaze() {
  const url = wazeUrl(values());
  if (!url) { toast('אין כתובת: מלא «רחוב»'); return; }
  window.open(url, '_blank');
}
function message(v) {             // same as the desktop (10.25): only fields with V (admin's choice), table order
  const off = new Set(S.waOff || []), lines = [];
  const cols = COLS.filter(c => !off.has(LABEL[c]));    // 1.21 / 10.33: a field with V goes also when empty
  // no icon: WhatsApp Web/Desktop turns emoji that come through wa.me into «�»; RLM keeps the line on the right
  if (cols.includes('fdt') && norm(v.fdt)) lines.push(`*מס' טיקט: ${norm(v.fdt)}*`, '\u200f━━━━━━━━━━━━');
  for (const c of cols) {
    if (c === 'fdt') continue;
    const parts = String(v[c]).split('\n').map(x => x.trim()).filter(Boolean);
    let first = parts[0] || '';
    if (first && !/[\u0590-\u05ff]/.test(first)) first = '\u2066' + first + '\u2069';     // date / code keeps its own order
    lines.push(first ? `*${LABEL[c]}:* ${first}` : `*${LABEL[c]}:*`, ...parts.slice(1).map(x => '\u200f' + x));   // *…* = bold in WhatsApp
  }
  return lines.join('\n'); }
async function whatsapp() {
  if (!S.readonly) { try { await loadWaSetting(); saveCache(); } catch {} }   // newest choice of the admin
  const msg = message(values());
  const s = sheet(`<h3>הודעה ל-WhatsApp</h3><p style="color:#6b7785;font-size:12.5px;margin-bottom:6px">השדות בהודעה נקבעים על ידי המנהל (סימוני V בתוכנית במחשב).</p><textarea id="wamsg" dir="rtl">${esc(msg)}</textarea>
    <div class="btns"><button class="btn wa" id="wasend">שלח</button><button class="btn" id="wacopy">העתק</button><button class="btn" id="waclose">סגור</button></div>`);
  s.querySelector('#wasend').onclick = () => { const t = $('#wamsg').value.trim(); if (t) window.open('https://wa.me/?text=' + encodeURIComponent(t), '_blank'); closeSheet(); };
  s.querySelector('#wacopy').onclick = async () => { try { await navigator.clipboard.writeText($('#wamsg').value.trim()); toast('הטקסט הועתק'); } catch { $('#wamsg').select(); document.execCommand('copy'); toast('הטקסט הועתק'); } };
  s.querySelector('#waclose').onclick = closeSheet;
}
async function showHistory(id) {
  if (S.readonly) return info('היסטוריה', 'לא זמין במצב לא מקוון.');
  let entries;
  try { entries = await S.cloud.ticketHistory(id); } catch (e) { return info('היסטוריה', errText(e)); }
  const act = {insert: 'נוצר', update: 'שונה', delete: 'נמחק'};
  const val = (row, c) => DATE_COLS.has(c) ? serverDateText((row || {})[c]) : norm((row || {})[c]);
  const html = entries.length ? entries.map(e => `<div class="hist"><b><bdi dir="ltr">${esc(localTime(e.at))}</bdi> · ${esc(userName(e.by_user))} · ${act[e.action] || e.action}</b>
    ${(e.action === 'update' ? (e.changed || []).filter(c => LABEL[c]).map(c => `<div>${esc(LABEL[c])}: ${esc(val(e.old_row, c) || '—')} ← ${esc(val(e.new_row, c) || '—')}</div>`).join('') : '')}</div>`).join('')
    : '<p>אין רישומים ביומן.</p>';
  const s = sheet(`<h3>היסטוריה</h3>${html}<div class="btns"><button class="btn" id="hclose">סגור</button></div>`);
  s.querySelector('#hclose').onclick = closeSheet;
}
function settings() {
  const email = S.cloud.user.email || S.session.email || '';
  const s = sheet(`<div class="set"><h3>הגדרות</h3>
    <p><b>${esc(myName())}</b> (${esc(email)})</p><p>תפקיד: ${S.role === 'admin' ? 'מנהל' : 'משתמש'}</p>
    <p>מצב: ${S.readonly ? 'לא מקוון — קריאה בלבד' : 'מחובר'}</p><p>גרסה: ${APP_VERSION}</p>
    <p style="color:#6b7785">הוספה למסך הבית: iPhone (Safari) — שיתוף ← "הוסף למסך הבית". Android (Chrome) — תפריט ⋮ ← "התקן אפליקציה" / "הוסף למסך הבית".<br>
    ניהול משתמשים והרשאות — בתוכנית במחשב (⚙ הגדרות ← משתמשים).</p>
    <div class="btns"><button class="btn" id="spw" ${S.readonly ? 'disabled' : ''}>שנה סיסמה</button><button class="btn red" id="sout">התנתק</button></div>
    <div class="btns"><button class="btn" id="sclose">סגור</button></div></div>`);
  s.querySelector('#sclose').onclick = closeSheet;
  s.querySelector('#sout').onclick = async () => {
    closeSheet();
    if (!await ask('התנתקות', 'להתנתק? בכניסה הבאה תצטרך להזין דוא"ל וסיסמה.', 'התנתק', 'ביטול', true)) return;
    if (S.rt) S.rt.stop();
    clearInterval(S.pollTimer); clearInterval(S.tokTimer);
    await S.cloud.signOut();
    S.session.rt = ''; saveSession(S.session);
    renderLogin('');
  };
  s.querySelector('#spw').onclick = () => {
    const p = sheet(`<h3>שינוי סיסמה</h3><input id="p1" class="inp" type="password" placeholder="סיסמה חדשה (לפחות 8 תווים)" autocomplete="new-password">
      <input id="p2" class="inp" type="password" placeholder="שוב את הסיסמה החדשה" style="margin-top:8px" autocomplete="new-password">
      <div class="err" id="perr"></div><div class="btns"><button class="btn dark" id="pok">שמור</button><button class="btn" id="pno">ביטול</button></div>`);
    p.querySelector('#pno').onclick = closeSheet;
    p.querySelector('#pok').onclick = async () => {
      const a = $('#p1').value, b = $('#p2').value;
      if (a.length < 8) { $('#perr').textContent = 'לפחות 8 תווים.'; return; }
      if (a !== b) { $('#perr').textContent = 'הסיסמאות אינן זהות.'; return; }
      try { await S.cloud.changePassword(a); closeSheet(); toast('הסיסמה שונתה'); } catch (e) { $('#perr').textContent = errText(e); }
    };
  };
}

start();
