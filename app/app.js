
const $ = (id) => document.getElementById(id);
let CURRENT_USER = null;
let CSRF = "";
const nativeFetch = window.fetch.bind(window);
function operationName(url){const p=new URL(url,location.href).pathname;if(p.startsWith('/api/details/'))return 'Table details';if(p.startsWith('/api/scorehistory/'))return 'Score history';if(p.startsWith('/api/admin/users'))return 'User management';return ({'/api/library':'Library refresh','/api/status':'Cabinet status','/api/favourites':'Personal favourites','/api/instructions':'Cabinet instructions','/api/preferences':'Display settings','/api/status/dismiss':'Session dismissal','/api/exit':'Exit table / frontend','/api/play':'Table launch','/api/cache-thumbs':'Image caching','/api/collection':'Background collection settings','/api/settings':'Branding','/api/auth/logout':'Sign out','/api/auth/status':'Sign in'})[p]||'Dashboard request';}
function requestFailure(url,write=false){return operationName(url)+(write?' could not be confirmed. Check its current state before trying again.':' could not be loaded. Keeping saved data and retrying when connected.');}
window.fetch = async (url, options={}) => {
  const headers = new Headers(options.headers || {});
  if (new URL(url,location.href).origin === location.origin && !["GET","HEAD"].includes((options.method || "GET").toUpperCase())) headers.set("X-CSRF-Token", CSRF);
  const write=!["GET","HEAD"].includes((options.method||"GET").toUpperCase());
  let response;const controller=new AbortController();const slow=new URL(url,location.href).searchParams.get('refresh')==='1'||['/api/cache-thumbs','/api/exit'].includes(new URL(url,location.href).pathname);const timeout=setTimeout(()=>controller.abort(),slow?150000:20000);
  try{response=await nativeFetch(url,{...options,headers,signal:options.signal||controller.signal});}catch{throw new Error(requestFailure(url,write));}finally{clearTimeout(timeout);}
  if (response.status === 401){location.replace("/login");throw new Error('Your session expired. Sign in again.');}
  const readJSON=response.json.bind(response);response.json=async()=>{try{return await readJSON();}catch{throw new Error(operationName(url)+' returned an unreadable response.'+(write?' Check its current state before trying again.':' Retrying when connected.'));}};
  return response;
};
let DATA = { tables: [], scores: [], playlists: [], thumbsEnabled: false };
let STATUS = { state: "unknown", gamePlaying: false, playingText: null };
let FILTER = "all";
let FAVOURITES=new Set();
let FAVOURITE_BUSY=false;
let SHOW_TIMER=true;
let STATUS_DETAILS=false;
let SHOW_PLAY_TIME=true;
let BROWSE = "maker";
const RECENT_MS = 30 * 24 * 60 * 60 * 1000;
const fmt = (n) => (n === null || n === undefined ? "—" : Number(n).toLocaleString("en-US"));
const playCountLabel = (t) => Number.isInteger(t.playCount) && t.playCount >= 0 ? `${fmt(t.playCount)} play${t.playCount === 1 ? "" : "s"}` : "Plays unknown";
const totalTimeLabel = t => Number.isInteger(t.timePlayedSecs) && t.timePlayedSecs>=0 ? (t.timePlayedSecs>0 && t.timePlayedSecs<60?"<1":fmt(Math.floor(t.timePlayedSecs/60)))+" min total" : "Time unavailable";
const tableMeta = (t) => [...[t.maker, t.year].filter(Boolean), playCountLabel(t)].join(" · ");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function heartButton(t){
  const saved=FAVOURITES.has(t.gameId),label=(saved?'Remove ':'Add ')+t.name+(saved?' from':' to')+' your favourites';
  return `<button type="button" class="heart${saved?' saved':''}" data-heart="${t.gameId}" aria-pressed="${saved}" aria-label="${esc(label)}" title="${esc(label)}" ${FAVOURITE_BUSY?'disabled':''}><svg width="22" height="22" viewBox="0 0 24 24" fill="${saved?'currentColor':'none'}" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/></svg></button>`;
}
function bindHearts(root){root.querySelectorAll('[data-heart]').forEach(b=>b.addEventListener('click',()=>toggleFavourite(Number(b.dataset.heart))));}
function applyPreferences(data){document.documentElement.dataset.colorblind=String(data.colorblind);$('colorblind-setting').checked=data.colorblind;SHOW_TIMER=data.showTimer!==false;$('timer-setting').checked=SHOW_TIMER;SHOW_PLAY_TIME=data.showPlayTime!==false;$('playtime-setting').checked=SHOW_PLAY_TIME;STATUS_DETAILS=data.statusDetails===true;$('status-details-setting').checked=STATUS_DETAILS;renderStatus();renderLibrary();}
async function loadPreferences(){const r=await fetch('/api/preferences');if(!r.ok)throw new Error('Settings could not be loaded.');applyPreferences(await r.json());}
$('tab-settings').addEventListener('click',()=>switchTab('settings'));
$('colorblind-setting').addEventListener('change',async e=>{const checkbox=e.target;checkbox.disabled=true;try{applyPreferences(await apiPost('/api/preferences',{colorblind:checkbox.checked}));$('preference-message').textContent='Saved to your account.';}catch(error){checkbox.checked=!checkbox.checked;$('preference-message').textContent=error.message;}finally{checkbox.disabled=false;}});
$('timer-setting').addEventListener('change',async e=>{const checkbox=e.target;checkbox.disabled=true;try{applyPreferences(await apiPost('/api/preferences',{showTimer:checkbox.checked}));$('preference-message').textContent='Saved to your account.';}catch(error){checkbox.checked=!checkbox.checked;$('preference-message').textContent=error.message;}finally{checkbox.disabled=false;}});
$('playtime-setting').addEventListener('change',async e=>{const checkbox=e.target;checkbox.disabled=true;try{applyPreferences(await apiPost('/api/preferences',{showPlayTime:checkbox.checked}));$('preference-message').textContent='Saved to your account.';}catch(error){checkbox.checked=!checkbox.checked;$('preference-message').textContent=error.message;}finally{checkbox.disabled=false;}});
$('status-details-setting').addEventListener('change',async e=>{const checkbox=e.target;checkbox.disabled=true;try{applyPreferences(await apiPost('/api/preferences',{statusDetails:checkbox.checked}));$('preference-message').textContent='Saved to your account.';}catch(error){checkbox.checked=!checkbox.checked;$('preference-message').textContent=error.message;}finally{checkbox.disabled=false;}});
function elapsedLabel(started,now=Date.now()){
  if(typeof started!=='string')return 'Time unavailable';
  const start=Date.parse(started);if(!Number.isFinite(start)||start>now)return 'Time unavailable';
  const total=Math.floor((now-start)/1000),hours=Math.floor(total/3600),minutes=Math.floor(total/60)%60,seconds=total%60;
  return 'Elapsed '+(hours?hours+':'+String(minutes).padStart(2,'0'):String(minutes))+':'+String(seconds).padStart(2,'0');
}
function statusAgeLabel(checkedAt,now=Date.now()) {if(!Number.isFinite(checkedAt)||checkedAt<=0)return 'Check time unavailable';const age=Math.max(0,Math.floor((now-checkedAt*1000)/1000));return age<60?'Checked '+age+'s ago':'Checked '+Math.floor(age/60)+'m ago';}
function updateElapsed(){const label=$('now-playing').querySelector('.elapsed');if(label)label.textContent=' · '+elapsedLabel(STATUS.started).replace(/^Elapsed /,'');const age=$('now-playing').querySelector('.status-age');if(age)age.textContent=statusAgeLabel(STATUS.checkedAt);const dismiss=$('now-playing').querySelector('.dismiss-session');if(dismiss)dismiss.title=statusAgeLabel(STATUS.checkedAt)+'. Studio may retain a session after a crash. Dismiss on this dashboard only; Play stays blocked.';}
setInterval(updateElapsed,1000);
async function loadFavourites(){const response=await fetch('/api/favourites');if(!response.ok)throw new Error('Your favourites could not be loaded.');const result=await response.json();FAVOURITES=new Set(result.gameIds);}
async function toggleFavourite(gameId){
  if(FAVOURITE_BUSY)return;FAVOURITE_BUSY=true;document.querySelectorAll('[data-heart]').forEach(b=>b.disabled=true);
  try{const result=await apiPost('/api/favourites',{gameId,saved:!FAVOURITES.has(gameId)});FAVOURITES=new Set(result.gameIds);}
  catch(e){showBanner(e.message);}
  finally{FAVOURITE_BUSY=false;renderLibrary();const button=$('detail').querySelector('[data-heart]');if(button){const t=DATA.tables.find(t=>t.gameId===Number(button.dataset.heart));if(t){button.outerHTML=heartButton(t);bindHearts($('detail'));}}}
}

function bestByTable() {
  const map = new Map();
  for (const s of DATA.scores) {
    const cur = map.get(s.gameId);
    if (!cur) map.set(s.gameId, { best: s.score, initials: s.initials, count: 1, scores: [s] });
    else { cur.count++; cur.scores.push(s); if (s.score > cur.best) { cur.best = s.score; cur.initials = s.initials; } }
  }
  for (const v of map.values()) v.scores.sort((a, b) => a.rank - b.rank || b.score - a.score);
  return map;
}

function memberships() {
  const map = new Map();
  for (const p of DATA.playlists) for (const id of p.gameIds || []) {
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(p.name);
  }
  return map;
}

function withinRecent(iso) {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return !Number.isNaN(t) && Date.now() - t <= RECENT_MS;
}

function tagHit(t, re) {
  return re.test(t.name) || re.test(t.maker || "") || (t.tags || []).some((x) => re.test(x));
}

// Smart playlists are computed from the cabinet data itself:
// author tags in the table names/tags, originals, and decades.
const SMART = [
  ["smart:vpw", "VPin Workshop's", (t) => tagHit(t, /vpw|vpin workshop/i)],
  ["smart:originals", "Originals", (t) => !t.maker || t.maker.trim().toLowerCase() === "original"],
  ...[1970, 1980, 1990, 2000, 2010, 2020].map((d) => ["smart:decade-" + d, "The " + d + "s", (t) => t.year !== null && t.year !== undefined && t.year >= d && t.year < d + 10]),
  ["smart:hybrid", "Hybrid", (t) => tagHit(t, /hybrid/i)],
  ["smart:nfozzy", "nFozzy", (t) => tagHit(t, /nfozzy/i)],
  ["smart:fleep", "Fleep", (t) => tagHit(t, /fleep/i)],
  ["smart:ssf", "SSF", (t) => tagHit(t, /\bssf\b/i)],
];
const BADGES = ["B2S", "ROM", "PUP", "Color"];

function buildMatcher() {
  const best = bestByTable();
  const member = memberships();
  const topRated = new Set(DATA.tables
    .filter((t) => (best.get(t.gameId)?.best ?? null) !== null)
    .sort((a, b) => (best.get(b.gameId)?.best ?? 0) - (best.get(a.gameId)?.best ?? 0))
    .slice(0, 10).map((t) => t.gameId));
  const match = (t, key) => {
    if (key === "all") return true;
    if (key === "with-scores") return (best.get(t.gameId)?.count ?? 0) > 0;
    if (key === "no-scores") return (best.get(t.gameId)?.count ?? 0) === 0;
    if (key === "cat:favourites") return FAVOURITES.has(t.gameId);
    if (key === "cat:cabinet-favourites") return (member.get(t.gameId) || []).some((n) => /favourites|favorites/i.test(n));
    if (key === "cat:top-rated") return topRated.has(t.gameId);
    if (key === "cat:recently-played") return withinRecent(t.lastPlayedAt);
    if (key === "cat:recently-added") return withinRecent(t.addedAt);
    if (key === "cat:needs-attention") return !!t.needsAttention;
    if (key.startsWith("maker:")) return t.maker === key.slice(6);
    if (key.startsWith("decade:")) { const d = Number(key.slice(7)); return t.year !== null && t.year !== undefined && t.year >= d && t.year < d + 10; }
    if (key.startsWith("playlist:")) return (member.get(t.gameId) || []).includes(key.slice(9));
    if (key.startsWith("badge:")) return (t.badges || []).includes(key.slice(6));
    if (key.startsWith("smart:")) { const s = SMART.find((x) => x[0] === key); return s ? s[2](t) : true; }
    return true;
  };
  const countFor = (key) => DATA.tables.filter((t) => match(t, key)).length;
  return { match, countFor };
}

function headingFor(key) {
  if (key === "all") return "All tables";
  if (key === "with-scores") return "Tables with scores";
  if (key === "no-scores") return "No scores yet";
  if (key === "cat:favourites") return "Favourites";
  if (key === "cat:cabinet-favourites") return "Cabinet favourites";
  if (key === "cat:top-rated") return "Top rated";
  if (key === "cat:recently-played") return "Recently played";
  if (key === "cat:recently-added") return "Recently added";
  if (key === "cat:needs-attention") return "Needs attention";
  if (key.startsWith("smart:")) return (SMART.find((x) => x[0] === key) || [])[1] || "Smart playlist";
  if (key.startsWith("badge:")) return "Has " + key.slice(6);
  if (key.startsWith("decade:")) return "The " + key.slice(7) + "s";
  return key.replace(/^(maker|playlist):/, "");
}

function renderSidebar(M) {
  const btn = (key, label, count, letter) => `
    <button type="button" class="side-btn" data-filter="${esc(key)}" aria-pressed="${FILTER === key}">
      <span class="lbl">${letter !== undefined ? `<span class="letter">${esc(letter)}</span>` : ""}<span>${esc(label)}</span></span>
      ${count !== undefined ? `<span class="cnt">${count}</span>` : ""}
    </button>`;
  let html = `<p class="side-title">Library</p>`;
  html += btn("all", "All tables", M.countFor("all"));
  html += btn("cat:favourites", "Favourites", M.countFor("cat:favourites"));
  html += btn("cat:cabinet-favourites", "Cabinet favourites", M.countFor("cat:cabinet-favourites"));
  html += btn("cat:top-rated", "Top rated", M.countFor("cat:top-rated"));
  html += btn("cat:recently-played", "Recently played", M.countFor("cat:recently-played"));
  html += btn("cat:recently-added", "Recently added", M.countFor("cat:recently-added"));
  html += btn("cat:needs-attention", "Needs attention", M.countFor("cat:needs-attention"));
  html += btn("with-scores", "With scores", M.countFor("with-scores"));
  html += btn("no-scores", "No scores yet", M.countFor("no-scores"));
  html += `<p class="side-title">Smart playlists</p>`;
  for (const [key, label] of SMART) html += btn(key, label, M.countFor(key));
  if (DATA.playlists.length) {
    html += `<p class="side-title">Your playlists</p>`;
    for (const p of DATA.playlists) html += btn("playlist:" + p.name, p.name, (p.gameIds || []).length);
  }
  const makers = new Map();
  const decades = new Map();
  for (const t of DATA.tables) {
    if (t.maker) makers.set(t.maker, (makers.get(t.maker) || 0) + 1);
    if (t.year) { const d = Math.floor(t.year / 10) * 10; decades.set(d, (decades.get(d) || 0) + 1); }
  }
  if (makers.size || decades.size) {
    html += `<div class="browse-head"><p class="side-title">Browse by</p>
      <select id="browse-by" aria-label="Browse tables by">
        <option value="maker" ${BROWSE === "maker" ? "selected" : ""}>Maker</option>
        <option value="decade" ${BROWSE === "decade" ? "selected" : ""}>Decade</option>
      </select></div>`;
    if (BROWSE === "maker") {
      for (const [m, c] of [...makers.entries()].sort((a, b) => b[1] - a[1])) html += btn("maker:" + m, m, c, m.charAt(0).toUpperCase());
    } else {
      for (const [d, c] of [...decades.entries()].sort((a, b) => a[0] - b[0])) html += btn("decade:" + d, "The " + d + "s", c, String(d).slice(2, 3));
    }
  }
  $("sidebar").innerHTML = html;
  $("sidebar").querySelectorAll("[data-filter]").forEach((b) => b.addEventListener("click", () => { selectFilter(b.dataset.filter); }));
  const sel = $("browse-by");
  if (sel) sel.addEventListener("change", () => { BROWSE = sel.value; renderLibrary(); });

  const chips = [["all", "All"], ["cat:favourites", "Favourites"], ["cat:cabinet-favourites", "Cabinet favourites"], ["cat:top-rated", "Top rated"], ["cat:recently-played", "Recently played"], ["cat:recently-added", "Recently added"], ["cat:needs-attention", "Needs attention"], ["with-scores", "With scores"], ["no-scores", "No scores"]];
  $("chiprow").innerHTML = chips.map(([k, l]) => `<button type="button" class="chip" data-filter="${k}" aria-pressed="${FILTER === k}">${l}</button>`).join("");
  $("chiprow").querySelectorAll("[data-filter]").forEach((b) => b.addEventListener("click", () => { selectFilter(b.dataset.filter); }));

  $("has-chips").innerHTML = BADGES.map((b) => `<button type="button" class="chip" data-badge="${b}" aria-pressed="${FILTER === "badge:" + b}">${b}</button>`).join(" ");
  $("has-chips").querySelectorAll("[data-badge]").forEach((b) => b.addEventListener("click", () => {
    FILTER = FILTER === "badge:" + b.dataset.badge ? "all" : "badge:" + b.dataset.badge;
    renderLibrary();
  }));
}

let EXIT_PENDING=false;
function renderStatus() {
  const dot = $("status-dot"), label = $("status-label");
  const stale=STATUS.checkedAt && Date.now()/1000-STATUS.checkedAt>125;
  const state=stale?'stale':STATUS.state==='offline'?'offline':STATUS.state!=='online'?'unknown':STATUS.gamePlaying?'busy':'idle';
  const labels={idle:'Cabinet idle',busy:'Cabinet busy - Studio reports an active table',offline:'Cabinet offline',unknown:'Cabinet status unknown',stale:'Cabinet status stale - refresh needed'};
  label.textContent=labels[state];
  for(const light of [dot,$('mobile-status')]){light.className='dot '+(light.id==='mobile-status'?'mobile-status ':'')+'light-'+state;light.style.background='';light.style.borderRadius='';light.title=labels[state]+'. See Status key in Settings.';light.setAttribute('aria-label',labels[state]);light.tabIndex=0;}
  const pill=dot.closest('.pill');pill.title=dot.title;pill.setAttribute('aria-label',labels[state]);
  const exit=$('exit-btn');exit.hidden=CURRENT_USER?.role!=='admin';exit.disabled=EXIT_PENDING||!STATUS.gamePlaying||!STATUS.started||!STATUS.gameId||STATUS.state!=='online'||!!stale;exit.title=exit.disabled?'Exit needs a fresh online active session. Refresh status if needed.':'Exit table / frontend - confirmation required';
  const np = $("now-playing");
  if (STATUS.gamePlaying) {
    np.style.display="flex";np.innerHTML="";
    const t=DATA.tables.find(t=>t.gameId===STATUS.gameId);
    const text=document.createElement(t && !STATUS.dismissed?'button':'span');
    text.textContent=STATUS.dismissed?'Session dismissed':(t?.name||STATUS.playingText||'Table reported active');
    text.title=statusAgeLabel(STATUS.checkedAt)+'. Reported by Studio, not a process check; it may remain active after a crash.';
    if(t && !STATUS.dismissed){text.type='button';text.setAttribute('aria-label','Go to '+t.name+' in Library');text.addEventListener('click',()=>{switchTab('library');$('search').value='';selectFilter('all');const card=$('grid').querySelector('[data-open="'+t.gameId+'"]');if(card){card.scrollIntoView({block:'center',behavior:'smooth'});card.focus({preventScroll:true});}});}
    if(SHOW_TIMER && !STATUS.dismissed){const timer=document.createElement('span');timer.className='elapsed';timer.textContent=' · '+elapsedLabel(STATUS.started).replace(/^Elapsed /,'');text.append(timer);}
    const main=document.createElement('div');main.className='reported-session';main.append(text);np.append(main);
    if(CURRENT_USER?.role==='admin' && !STATUS.dismissed && STATUS.started){const dismiss=document.createElement('button');dismiss.type='button';dismiss.className='dismiss-session';dismiss.textContent='×';dismiss.setAttribute('aria-label','Dismiss this reported session');dismiss.title=statusAgeLabel(STATUS.checkedAt)+'. Studio may retain a session after a crash. Dismiss on this dashboard only; Play stays blocked.';dismiss.addEventListener('click',async()=>{if(!confirm(statusAgeLabel(STATUS.checkedAt)+'. Studio may still report a crashed table. Hide this session on this dashboard only? This does not stop a table, reset Studio, or enable Play.'))return;dismiss.disabled=true;try{await apiPost('/api/status/dismiss',{gameId:STATUS.gameId,started:STATUS.started});await loadStatus();}catch(error){showBanner(error.message);dismiss.disabled=false;}});if(STATUS_DETAILS){dismiss.textContent='Dismiss this session';dismiss.classList.add('dismiss-detailed');}main.append(dismiss);}
    if(STATUS_DETAILS){const info=document.createElement('div');info.className='reported-info';const age=document.createElement('span');age.className='status-age';age.textContent=statusAgeLabel(STATUS.checkedAt);info.append(age);const caveat=document.createElement('span');caveat.textContent=STATUS.dismissed?'Hidden on this dashboard only. Studio still reports busy; Play stays blocked.':'Studio status, not a process check. It may remain active after a crash.';info.append(caveat);const detailedDismiss=main.querySelector('.dismiss-detailed');if(detailedDismiss)info.append(detailedDismiss);np.append(info);}


  }
  else np.style.display = "none";
}

function canLaunch(t) { return CURRENT_USER?.role === "admin" && STATUS.state === "online" && (!STATUS.checkedAt || Date.now()/1000-STATUS.checkedAt<=125) && !STATUS.gamePlaying && t.launchable === true && Number.isInteger(t.gameId) && t.gameId > 0; }

function selectFilter(key) {
  FILTER = key;
  $("sort").value = ({"cat:recently-played":"played","cat:recently-added":"added","cat:top-rated":"score"})[key] || "name";
  renderLibrary();
}
function dateSortValue(value) {
  const parsed=Date.parse(value);
  return Number.isFinite(parsed)?parsed:0;
}

function renderLibrary() {
  const M = buildMatcher();
  renderSidebar(M);
  const best = bestByTable();
  const q = $("search").value.trim().toLowerCase();
  const sort = $("sort").value;
  let rows = DATA.tables.filter((t) => M.match(t, FILTER))
    .map((t) => ({ ...t, bestScore: best.get(t.gameId)?.best ?? null, bestInitials: best.get(t.gameId)?.initials ?? null }));
  if (q) rows = rows.filter((t) => t.name.toLowerCase().includes(q) || (t.maker || "").toLowerCase().includes(q) || String(t.year || "").includes(q));
  if (sort === "name") rows.sort((a, b) => a.name.localeCompare(b.name));
  if (sort === "score") rows.sort((a, b) => (b.bestScore ?? -1) - (a.bestScore ?? -1));
  if (sort === "played") rows.sort((a, b) => dateSortValue(b.lastPlayedAt)-dateSortValue(a.lastPlayedAt)||a.name.localeCompare(b.name));
  if (sort === "added") rows.sort((a, b) => dateSortValue(b.addedAt)-dateSortValue(a.addedAt)||a.name.localeCompare(b.name));
  if (sort === "maker") rows.sort((a, b) => (a.maker || "~").localeCompare(b.maker || "~") || a.name.localeCompare(b.name));
  if (sort === "year-desc") rows.sort((a, b) => (b.year ?? -1) - (a.year ?? -1));
  if (sort === "year-asc") rows.sort((a, b) => (a.year ?? 99999) - (b.year ?? 99999));
  $("heading").textContent = headingFor(FILTER);
  $("count").textContent = rows.length + " of " + DATA.tables.length + " tables";
  const empty = $("empty");
  if (DATA.tables.length === 0) {
    empty.style.display = "block";
    $("empty-title").textContent = "No tables loaded";
    $("grid").innerHTML = "";
    return;
  }
  empty.style.display = rows.length === 0 ? "block" : "none";
  if (rows.length === 0) $("empty-title").textContent = "No tables match that search and filter";
  const canPlay = CURRENT_USER?.role === "admin" && STATUS.state === "online" && !STATUS.gamePlaying;
  $("grid").innerHTML = rows.map((t) => `
    <article class="card">
      <button class="art" data-open="${t.gameId}" aria-label="View details for ${esc(t.name)}">
        ${DATA.thumbsEnabled ? `<img class="artimg" src="/api/thumb/${t.gameId}?v=2&r=${encodeURIComponent(t.mediaRevision || "")}" alt="" loading="lazy">` : ""}
        ${(t.attentionReasons||[]).length ? `<span class="flag" title="${esc(t.attentionReasons.join('; '))}. Open table details for context.">${esc(t.attentionReasons[0])}${t.attentionReasons.length>1?' +'+(t.attentionReasons.length-1):''}</span>` : ""}

      </button>
      ${heartButton(t)}
      <div class="cardbody">
        <p class="tname">${esc(t.name)}</p>
        <p class="meta" title="${esc(tableMeta(t))}" aria-label="${esc(tableMeta(t))}">${t.maker ? `<span class="meta-maker">${esc(t.maker)}</span><span class="meta-fixed">·</span>` : ""}${t.year ? `<span class="meta-fixed">${esc(t.year)} ·</span>` : ""}<span class="meta-fixed">${esc(playCountLabel(t))}</span></p>
        ${SHOW_PLAY_TIME?`<p class="playtime" title="Cumulative play time reported by Studio's frontend analytics, not the duration of the last session">${esc(totalTimeLabel(t))}</p>`:''}
        <div class="cardfeatures">${(t.badges || []).length ? `<div class="badges">${t.badges.map((b) => `<span class="bdg">${esc(b)}</span>`).join("")}</div>` : ""}${canLaunch(t) ? `<button class="play" data-play="${t.gameId}" ${canPlay ? "" : "disabled"} aria-label="Play ${esc(t.name)} on the cabinet" title="Play ${esc(t.name)} on the cabinet"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4.5 2.5L14.5 8L4.5 13.5Z" fill="currentColor"/></svg></button>` : ""}</div>
      </div>
      <div class="cardfoot">
        <span class="top">${t.bestScore !== null ? `Top${t.bestInitials ? " · " + esc(t.bestInitials) : ""} · <b>${fmt(t.bestScore)}</b>` : "No scores yet"}</span>
      </div>
    </article>`).join("");
  bindHearts($("grid"));
  document.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => openDetail(Number(b.dataset.open))));
  document.querySelectorAll(".artimg").forEach(i=>i.addEventListener("error",()=>i.remove(),{once:true}));
  document.querySelectorAll("[data-play]").forEach((b) => b.addEventListener("click", () => play(Number(b.dataset.play))));
}

function renderStats() {
  const best = bestByTable();
  const withScores = [...best.keys()].length;
  const highest = Math.max(0, ...[...best.values()].map((v) => v.best));
  const makers = new Map();
  const decades = new Map();
  for (const t of DATA.tables) {
    if (t.maker) makers.set(t.maker, (makers.get(t.maker) || 0) + 1);
    if (t.year) { const d = Math.floor(t.year / 10) * 10 + "s"; decades.set(d, (decades.get(d) || 0) + 1); }
  }
  $("tiles").innerHTML = [
    ["Tables on cabinet", fmt(DATA.tables.length)],
    ["Recorded plays", fmt(DATA.tables.reduce((n, t) => n + (t.playCount ?? 0), 0))],
    ["Tables played", DATA.tables.filter((t) => t.playCount > 0).length],
    ["Tables with scores", withScores],
  ].map(([l, v]) => `<div class="tile"><div class="l">${l}</div><div class="v">${v}</div></div>`).join("");
  const counted = DATA.tables.filter((t) => Number.isInteger(t.playCount) && t.playCount >= 0);
  const nameOrder = (a, b) => a.name.localeCompare(b.name);
  const most = [...counted].filter((t) => t.playCount > 0).sort((a, b) => b.playCount - a.playCount || nameOrder(a, b)).slice(0, 10);
  const least = [...counted].sort((a, b) => a.playCount - b.playCount || nameOrder(a, b)).slice(0, 10);
  const playRows = (rows, bars) => rows.map((t, i) => `<div class="rank-row"><span class="rank-num">${i + 1}</span><div><button class="stats-table" data-open="${t.gameId}">${esc(t.name)}</button>${bars ? `<div class="bar rank-bar"><i style="width:${(t.playCount / (most[0]?.playCount || 1)) * 100}%"></i></div>` : ""}</div><span class="rank-value">${fmt(t.playCount)}<small>plays</small></span></div>`).join("");
  $("most-played").innerHTML = most.length ? playRows(most, true) : '<p class="muted">No positive play counts reported yet.</p>';
  $("least-played").innerHTML = least.length ? playRows(least, false) : '<p class="muted">Play counts are not available from the cabinet.</p>';
  const recent = DATA.tables.filter((t) => t.lastPlayedAt && Number.isFinite(Date.parse(t.lastPlayedAt)))
    .sort((a, b) => b.lastPlayedAt.localeCompare(a.lastPlayedAt) || nameOrder(a, b)).slice(0, 10);
  const playedDate = (value) => new Date(value).toLocaleString(undefined, {month:"short", day:"numeric", year:"numeric", hour:"numeric", minute:"2-digit"});
  $("recent-tables").innerHTML = recent.length ? recent.map((t, i) => `<div class="rank-row"><span class="rank-num">${i + 1}</span><button class="stats-table" data-open="${t.gameId}">${esc(t.name)}</button><time class="rank-time" datetime="${esc(t.lastPlayedAt)}">${esc(playedDate(t.lastPlayedAt))}</time></div>`).join("") : '<p class="muted">No last-played dates reported yet.</p>';
  $("view-stats").querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => openDetail(Number(b.dataset.open))));
  const tops = DATA.tables.map((t) => ({ ...t, best: best.get(t.gameId)?.best ?? null, initials: best.get(t.gameId)?.initials ?? null }))
    .filter((t) => t.best !== null).sort((a, b) => b.best - a.best).slice(0, 10);
  const max = tops[0]?.best || 1;
  $("top-tables").innerHTML = tops.length ? tops.map((t, i) => `
    <div class="row"><span>${i + 1}. ${esc(t.name)}${t.initials ? " · " + esc(t.initials) : ""}</span><strong style="color:var(--accent)">${fmt(t.best)}</strong></div>
    <div class="bar"><i style="width:${Math.max(4, (t.best / max) * 100)}%"></i></div>`).join("") : '<p class="muted">No scores pulled from the cabinet yet.</p>';
  const players = new Map();
  for (const v of best.values()) {
    if (!v.initials) continue;
    const p = players.get(v.initials) || { n: 0, best: 0 };
    p.n++; p.best = Math.max(p.best, v.best); players.set(v.initials, p);
  }
  $("players").innerHTML = players.size ? [...players.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 10)
    .map(([ini, p], i) => `<div class="row"><span>${i + 1}. ${esc(ini)}</span><span class="muted">${p.n} table${p.n === 1 ? "" : "s"} topped · best ${fmt(p.best)}</span></div>`).join("")
    : '<p class="muted">No player initials in the cabinet scores yet.</p>';
  $("makers").innerHTML = makers.size ? [...makers.entries()].sort((a, b) => b[1] - a[1])
    .map(([m, c]) => `<div class="row"><span>${esc(m)}</span><span class="muted">${c}</span></div>`).join("")
    : '<p class="muted">The cabinet did not report maker names.</p>';
  $("decades").innerHTML = decades.size ? [...decades.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([d, c]) => `<div class="row"><span>The ${d}</span><span class="muted">${c}</span></div>`).join("")
    : '<p class="muted">The cabinet did not report table years.</p>';
}

async function openDetail(gameId) {
  const t = DATA.tables.find((x) => x.gameId === gameId);
  if (!t) return;
  const entry = bestByTable().get(gameId);
  const d = $("detail");
  d.innerHTML = `
    ${DATA.thumbsEnabled ? `<button type="button" class="enlarge-playfield" aria-label="Enlarge playfield of ${esc(t.name)}" title="Tap to enlarge"><img class="dimg" src="/api/thumb/${t.gameId}?full=1&v=2" alt="Playfield of ${esc(t.name)}"><span>Tap to enlarge</span></button>` : ""}
    <h2 style="margin:0;text-transform:uppercase">${esc(t.name)}</h2>
    <div class="detail-meta"><p class="muted">${esc(tableMeta(t))}</p>${heartButton(t)}</div>
    ${(t.badges || []).length ? `<div class="badges">${t.badges.map((b) => `<span class="bdg">${esc(b)}</span>`).join("")}</div>` : ""}
    ${(t.attentionReasons||[]).length?`<section class="attention-note"><h3>Cabinet checks</h3><p>${esc(t.attentionReasons.join('; '))}</p><p class="muted">The cabinet export reports neither a directB2S backglass file nor a PUP pack. Some tables need neither. This is not a confirmed launch error.</p></section>`:''}
    <h3 style="text-transform:uppercase;font-size:13px;color:var(--dim)">Scores on this table</h3>
    ${entry ? entry.scores.map((s) => `<div class="row"><span>#${s.rank} ${esc(s.initials || "—")}</span><strong style="color:var(--accent)">${fmt(s.score)}</strong></div>`).join("") : '<p class="muted">No scores recorded on this table.</p>'}
    <section class="score-history"><h3>Recent score changes</h3><p class="panel-note">Latest saved highscore snapshots, not results from every play. Expand a date to see its scores.</p><div id="detail-history" class="muted">Loading score history…</div></section>
    <div id="detail-extra" class="muted">Loading cabinet details…</div>
    ${canLaunch(t) ? `<button class="play" id="detail-play" style="width:100%;margin-top:14px;padding:12px" ${STATUS.state === "online" && !STATUS.gamePlaying ? "" : "disabled"}>▶ Play on the cabinet</button>
    <p class="muted launch-note" style="text-align:center">Launches through VPin Studio on the cabinet.</p>` : ""}
    <button id="detail-close" style="width:100%;margin-top:6px;padding:10px;background:var(--surface2);color:var(--text);border:0;border-radius:6px;cursor:pointer">Close</button>`;
  d.dataset.gameId = String(gameId);
  d.showModal();bindHearts(d);
  d.querySelector(".dimg")?.addEventListener("error",e=>e.target.closest("button").remove(),{once:true});
  d.querySelector(".enlarge-playfield")?.addEventListener("click",()=>{const box=$('playfield-lightbox');box.innerHTML=`<button class="lightbox-close" type="button">Close enlarged playfield</button><button class="lightbox-image" type="button" aria-label="Close enlarged playfield of ${esc(t.name)}"><img src="/api/thumb/${t.gameId}?full=1&v=2" alt="Playfield of ${esc(t.name)}"></button>`;box.querySelectorAll('button').forEach(button=>button.addEventListener('click',()=>box.close()));box.showModal();});
  loadScoreHistory(gameId);
  $("detail-close").addEventListener("click", () => d.close());
  $("detail-play")?.addEventListener("click", () => { d.close(); play(gameId); });
  loadModalData('details',gameId);
}

const MODAL_CACHE=new Map();
function modalCacheNote(res){const c=res.cache;if(!c)return '';if(c.notSaved)return c.refreshing?'Not saved yet. Checking the cabinet...':'Not saved yet. Cabinet must be online and idle to save this data.';return 'Saved '+new Date(c.savedAt*1000).toLocaleString()+(c.refreshing?' · Checking for updates.':'.');}
function renderModalData(kind,gameId,res){
  if($('detail').dataset.gameId!==String(gameId)||!$('detail').open)return;
  const node=$(kind==='details'?'detail-extra':'detail-history');
  if(res.cache?.notSaved){node.textContent=modalCacheNote(res);return;}
  if(kind==='details'){
    const fields = res && res.details && typeof res.details === "object"
      ? Object.entries(res.details).filter(([, v]) => ["string", "number", "boolean"].includes(typeof v) && v !== "").slice(0, 20) : [];
    node.innerHTML = fields.length
      ? "<h3 style='text-transform:uppercase;font-size:13px;color:var(--dim)'>Cabinet details</h3>" + fields.map(([k, v]) => k.toLowerCase()==="extradetails"
        ? `<details class="extra-details"><summary>Extra details</summary><div class="extra-details-body">${esc(v)}</div></details>`
        : `<div class="detail-field"><span class="muted">${esc(k)}</span><span>${esc(v)}</span></div>`).join("")
      : "The cabinet reported no extra detail fields for this table.";
  }else{
    const seen = new Set();
    const snapshots = res.scores.filter((h) => h && h.createdAt && Number.isFinite(Date.parse(h.createdAt)) && Array.isArray(h.scores))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).filter((h) => {
        const signature = h.createdAt + JSON.stringify(h.scores.map((s) => [s.position, s.playerInitials, s.score, s.label, s.suffix]));
        if (seen.has(signature)) return false;
        seen.add(signature); return true;
      }).slice(0, 5);
    node.innerHTML = snapshots.length ? snapshots.map((h, i) => `<details class="history-entry" ${i === 0 ? "open" : ""}><summary>${esc(new Date(h.createdAt).toLocaleString(undefined, {month:"short", day:"numeric", year:"numeric", hour:"numeric", minute:"2-digit", hour12:true}))}</summary>${h.scores.filter((s) => Number.isFinite(Number(s.score)) && Number(s.score) > 0).map((s) => `<div class="row"><span>${esc(s.label || (s.position ? "#" + s.position : "Score"))} · ${esc(s.playerInitials || "Unknown")}</span><strong>${fmt(s.score)}${esc(s.suffix || "")}</strong></div>`).join("") || '<p class="muted">No numeric scores in this snapshot.</p>'}</details>`).join("") : "No saved score changes reported for this table.";
  }
  const note=document.createElement('p');note.className='panel-note';note.textContent=modalCacheNote(res);node.prepend(note);
}
async function loadModalData(kind,gameId){
  const key=kind+'/'+gameId,previous=MODAL_CACHE.get(key);
  if(previous)renderModalData(kind,gameId,previous);
  try{
    for(let attempt=0;attempt<8;attempt++){
      if($('detail').dataset.gameId!==String(gameId)||!$('detail').open)return;
      const response=await fetch('/api/'+key);
      if(!response.ok)throw new Error('Saved table data is unavailable.');
      const res=await response.json();
      if(!res.cache?.notSaved && (kind==='details'?!res.details:!Array.isArray(res.scores)))throw new Error('Saved table data is unavailable.');
      if(!res.cache?.notSaved){MODAL_CACHE.set(key,res);if(MODAL_CACHE.size>100)MODAL_CACHE.delete(MODAL_CACHE.keys().next().value);}
      renderModalData(kind,gameId,res);
      if(!res.cache?.refreshing)return;
      await new Promise(resolve=>setTimeout(resolve,1500));
    }
    if($('detail').dataset.gameId===String(gameId)){
      const node=$(kind==='details'?'detail-extra':'detail-history');
      if(!MODAL_CACHE.has(key))node.textContent='Not saved yet. The cabinet check is taking longer than expected. Reopen this table later.';
    }
  }catch{
    if($('detail').dataset.gameId!==String(gameId))return;
    const node=$(kind==='details'?'detail-extra':'detail-history');
    if(previous){renderModalData(kind,gameId,previous);const note=document.createElement('p');note.className='panel-note';note.textContent='Update unavailable. Showing last saved data.';node.prepend(note);}
    else node.textContent='Not saved yet. Data is unavailable; reopen this table when the cabinet is online and idle.';
  }
}
function loadScoreHistory(gameId){return loadModalData('scorehistory',gameId);}

async function exitTable(){
  if(CURRENT_USER?.role!=='admin'||EXIT_PENDING||$('exit-btn').disabled)return;
  const session={gameId:STATUS.gameId,started:STATUS.started};
  const name=DATA.tables.find(t=>t.gameId===session.gameId)?.name||'the reported table';
  if(!confirm('Exit '+name+' and close the cabinet frontend? This can force-close the table and lose an unsaved game. It does not launch another table.'))return;
  EXIT_PENDING=true;renderStatus();
  try{await apiPost('/api/exit',session);showBanner('Exit requested. Checking reported cabinet status; this is not proof that every process closed.');await loadStatus();}
  catch(error){showBanner(error.message);await loadStatus();}
  finally{EXIT_PENDING=false;renderStatus();}
}
$('exit-btn').addEventListener('click',exitTable);
$('account-toggle').addEventListener('click',()=>{const open=$('account-options').hidden;$('account-options').hidden=!open;$('account-toggle').setAttribute('aria-expanded',String(open));});
document.addEventListener('click',event=>{if(!event.target.closest('.account-menu')){$('account-options').hidden=true;$('account-toggle').setAttribute('aria-expanded','false');}});
async function play(gameId) {
  if (CURRENT_USER?.role !== "admin") return;
  const t = DATA.tables.find((x) => x.gameId === gameId);
  if (!t || !canLaunch(t)) return;
  showBanner("Asking VPin Studio to launch " + (t ? t.name : "the table") + " on the cabinet…");
  try {
    const res = await fetch("/api/play", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ gameId }) }).then((r) => r.json().then((j) => ({ status: r.status, body: j })));
    if (res.body && res.body.ok) showBanner((t ? t.name : "Table") + " is launching on the cabinet.");
    else if (res.status === 409) showBanner("A game is already running on the cabinet. Finish that game first.");
    else showBanner("The launch failed: " + ((res.body && res.body.error) || ("bridge HTTP " + res.status)));
  } catch (e) { showBanner("The launch failed: " + e.message); }
  loadStatus();
}

function showBanner(msg) { const b = $("banner"); b.textContent = msg; b.style.display = "block"; }

async function loadStatus() {
  try {
    const response = await fetch("/api/status");if(!response.ok)throw new Error("Cabinet status unavailable.");const res=await response.json();
    const reachable = res && res.health && res.health.cabinet_reachable;
    const playing = (res && res.health && res.health.game_playing) || (res && res.status && Number(res.status.gameId) > 0);
    STATUS = {
      state: reachable === undefined ? "unknown" : reachable ? "online" : "offline",
      gamePlaying: !!playing,
      gameId:Number(res?.status?.gameId)||null,
      started:res?.status?.started||null,
      checkedAt:res?.checkedAt||null,
      dismissed:res?.dismissed===true,
      playingText: DATA.tables.find(t=>t.gameId===Number(res?.status?.gameId))?.name || null,
    };
  } catch { STATUS = { state: "unknown", gamePlaying: false, playingText: null }; }
  renderStatus(); renderLibrary();
  const activePlay=$("detail-play");if(activePlay){const t=DATA.tables.find(t=>String(t.gameId)===$("detail").dataset.gameId);if(!t||!canLaunch(t)){activePlay.remove();$("detail").querySelector(".launch-note")?.remove();}}
}

let loadInFlight=null;
function load(manual,refresh=false){if(loadInFlight)return (manual||refresh)?loadInFlight.then(()=>load(manual,refresh)):loadInFlight;loadInFlight=performLoad(manual,refresh).finally(()=>{loadInFlight=null;});return loadInFlight;}
async function performLoad(manual,refresh=false) {
  if (manual && CURRENT_USER?.role !== "admin") return;
  const btn = $("sync-btn"), label = $("sync-label"), note = $("sync-note");
  if (manual) {
    btn.disabled = true; btn.classList.add("syncing"); label.textContent = "Syncing…";
    note.classList.remove("err"); note.textContent = "Syncing with the cabinet…";
  }
  let error = null;const readIssues=[];
  try {
    const response=await fetch("/api/library"+((manual||refresh)?"?refresh=1":""));if(!response.ok)throw new Error('Library refresh unavailable (HTTP '+response.status+').');const res=await response.json();
    if (res && res.ok){ DATA = res;
      if(res.collection){const age=(Date.now()/1000-res.collection.capturedAt)/60;const stamp=new Date(res.collection.capturedAt*1000).toLocaleString();$("sync-note").textContent='Saved cabinet data · '+stamp+(age>10?' · may be out of date':'');}
    }
    else error = (res && res.error) || "the bridge pull failed";
  } catch (e) { error = e.message; }
  try{await loadFavourites();}catch(e){readIssues.push('Personal favourites unavailable');}
  renderLibrary(); renderStats();
  await loadStatus();
  updateModalCache();
  if(!await loadInstructions())readIssues.push('Cabinet instructions unavailable');
  if(error)readIssues.unshift('Library refresh unavailable');
  if(STATUS.state==='unknown')readIssues.push('Cabinet status unavailable');
  if(readIssues.length){note.textContent=readIssues.join(' · ')+'. Keeping saved data; retrying when connected.';note.classList.remove('err');}else note.classList.remove('err');
  if (manual) {
    btn.disabled = false; btn.classList.remove("syncing"); label.textContent = "Sync";
    if (error || readIssues.length) {
      error=error||readIssues.join(' · ');
      note.classList.add("err");
      note.textContent = "Sync failed: " + error + ". Showing the last data loaded.";
      if (DATA.tables.length === 0) $("empty-text").textContent = "The bridge pull failed: " + error;
    } else {
      startImageCache();startModalCache();
      const when = new Date().toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      note.textContent = "Synced with the cabinet " + when + " · " + DATA.tables.length + " tables · " + DATA.scores.length + " scores.";
    }
  }
  return !error && !readIssues.length;
}

let modalCachePoll=null;
async function updateModalCache(){
  if(document.hidden||navigator.onLine===false)return;
  try{
    const response=await fetch('/api/modal-cache');if(!response.ok)return;
    const state=await response.json(),node=$('modal-cache-progress');node.style.display=state.total?'block':'none';
    node.textContent=state.running?`${state.paused?'Table data cache paused while cabinet is busy or offline':'Saving table details and history'} ${state.done}/${state.total}`:`Table data saved: ${state.done-state.failed}/${state.total}${state.failed?' · '+state.failed+' unavailable; retry on Sync':''}${state.incomplete?' · incomplete; tap Sync to continue':''}`;
    if(state.running&&!modalCachePoll)modalCachePoll=setInterval(updateModalCache,5000);
    if(!state.running&&modalCachePoll){clearInterval(modalCachePoll);modalCachePoll=null;}
  }catch{const node=$('modal-cache-progress');node.style.display='block';node.textContent='Table data cache progress unavailable.';}
}
async function startModalCache(){try{await apiPost('/api/modal-cache',{gameIds:DATA.tables.map(t=>t.gameId)});await updateModalCache();}catch(error){const node=$('modal-cache-progress');node.style.display='block';node.textContent=error.message;}}
let cachePoll = null;
async function updateImageCache() {
  if(document.hidden || navigator.onLine===false)return;
  try {
    const state = await fetch("/api/cache-thumbs").then((r) => r.json());
    const failures=Array.isArray(state.failedTables)?state.failedTables:[];
    $('cache-failures').textContent=failures.length?failures.map(f=>(DATA.tables.find(t=>t.gameId===f.gameId)?.name || 'Table '+f.gameId)+': '+f.reason).join(' • '):'No unavailable previews reported by the latest Sync.';
    const label = $("cache-progress");
    label.style.display = state.total ? "block" : "none";
    label.textContent = state.running ? `${state.paused ? "Caching paused while cabinet is busy or offline" : "Caching images"} ${state.done}/${state.total}` : `Images cached: ${state.done - state.failed}/${state.total}${state.failed ? ` · ${state.failed} unavailable (retry on Sync)` : ""}`;
    if (state.running && !cachePoll) cachePoll = setInterval(updateImageCache, 2000);
    if (!state.running && cachePoll) { clearInterval(cachePoll); cachePoll = null; }
  } catch { $("cache-progress").textContent = "Image cache progress unavailable"; }
}
async function startImageCache(full=false) {
  try {
    const r = await fetch("/api/cache-thumbs", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({full,tables:DATA.tables.map((t) => ({gameId:t.gameId,mediaRevision:t.mediaRevision}))})});
    if (!r.ok) {const result=await r.json();throw new Error(result.error||'Image caching could not start.');}
    updateImageCache();return true;
  } catch(e) { $("cache-progress").style.display="block"; $("cache-progress").textContent=e.message||"Image caching could not start. Tap Sync to retry.";return false; }
}
$("sync-btn").addEventListener("click", () => load(true));
$("tab-library").addEventListener("click", () => switchTab("library"));
$("tab-stats").addEventListener("click", () => switchTab("stats"));
function switchTab(which) {
  if(which==="instructions" && $("tab-instructions").hidden)return;
  setMenu(false);
  $("view-settings").hidden=which!=="settings";$("tab-settings").setAttribute("aria-pressed",String(which==="settings"));
  $("view-instructions").hidden=which!=="instructions";
  $("tab-instructions").setAttribute("aria-pressed",String(which==="instructions"));
  $("view-library").style.display = which === "library" ? "block" : "none";
  $("view-stats").style.display = which === "stats" ? "block" : "none";
  $("view-admin").hidden = which !== "admin" || CURRENT_USER?.role !== "admin";
  $("tab-admin").setAttribute("aria-pressed",String(which === "admin"));
  if (which === "admin" && CURRENT_USER?.role === "admin") { loadUsers(); updateImageCache(); loadCollection(); }
  $("tab-library").setAttribute("aria-pressed", String(which === "library"));
  $("tab-stats").setAttribute("aria-pressed", String(which === "stats"));
}
["search", "sort"].forEach((id) => $(id).addEventListener("input", renderLibrary));


async function apiPost(url,body) {
  const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  let result;try{result=await r.json();}catch{throw new Error(operationName(url)+' returned an unreadable response. Check its current state before trying again.');}if(!r.ok)throw new Error(operationName(url)+': '+(result.error||'Request failed (HTTP '+r.status+').'));return result;
}
function instructionsHTML(text) {
  let output=[],paragraph=[],list=null,code=null;
  const flush=()=>{if(paragraph.length){output.push('<p>'+esc(paragraph.join(' '))+'</p>');paragraph=[];}if(list){output.push('</'+list+'>');list=null;}};
  for(const line of text.split(/\r?\n/)){
    if(line.startsWith('```')){flush();if(code!==null){output.push('<pre><code>'+esc(code.join('\n'))+'</code></pre>');code=null;}else code=[];continue;}
    if(code!==null){code.push(line);continue;}
    const heading=line.match(/^(#{1,3})\s+(.+)$/),item=line.match(/^\s*(?:([-*])|\d+\.)\s+(.+)$/);
    if(!line.trim()){flush();continue;}
    if(heading){flush();const level=Math.min(heading[1].length+2,5);output.push('<h'+level+'>'+esc(heading[2])+'</h'+level+'>');continue;}
    if(item){if(paragraph.length)flush();const tag=item[1]?'ul':'ol';if(list!==tag){flush();list=tag;output.push('<'+tag+'>');}output.push('<li>'+esc(item[2])+'</li>');continue;}
    if(list)flush();paragraph.push(line);
  }
  flush();if(code!==null)output.push('<pre><code>'+esc(code.join('\n'))+'</code></pre>');return output.join('');
}
async function loadInstructions(){
  let available=false;
  try{const response=await fetch('/api/instructions');const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'Instructions could not be loaded.');
    available=!!data.text.trim();$('instructions-content').innerHTML=available?instructionsHTML(data.text):'';
  }catch(e){return false;}
  $('tab-instructions').hidden=!available;
  if(!available){const selected=$('tab-instructions').getAttribute('aria-pressed')==='true';$('view-instructions').hidden=true;if(selected)switchTab('library');}
  $('instructions-admin-note').hidden=CURRENT_USER?.role!=='admin';return true;
}
$('tab-instructions').addEventListener('click',()=>switchTab('instructions'));

async function loadCollection(){
  try{const r=await fetch('/api/collection');const data=await r.json();if(!r.ok||!data.ok)throw new Error(data.error||'Collection state unavailable.');
    $('collection-enabled').checked=data.enabled;$('collection-interval').value=data.interval;
    const date=v=>v?new Date(v*1000).toLocaleString():'Not yet';
    $('collection-status').textContent=(data.enabled?'Enabled':'Disabled')+' · '+data.pending+' · Last check: '+date(data.lastChecked)+' · Last complete pull: '+date(data.lastSuccess)+(data.lastError?' · '+data.lastError:'');
    $('collection-size').textContent=(data.historyCounts.library||0)+' changed library snapshots · '+(data.historyCounts.status||0)+' status transitions · '+(data.payloadBytes/1048576).toFixed(2)+' MB archived payload';
  }catch(e){$('collection-status').textContent=e.message;}
}
$('collection-form').addEventListener('submit',async e=>{e.preventDefault();const b=e.target.querySelector('button');b.disabled=true;try{await apiPost('/api/collection',{enabled:$('collection-enabled').checked,interval:Number($('collection-interval').value)});await loadCollection();}catch(error){$('collection-status').textContent=error.message;}finally{b.disabled=false;}});

async function loadBranding() {
  const data=await fetch('/api/settings').then(r=>r.json());
  $('site-name').textContent=data.name; $('brand-name').value=data.name; document.title=data.name;
  $('site-logo').src='/api/settings/logo?v='+Date.now();
  document.querySelector('link[rel=icon]').href='/favicon.png?v='+Date.now();
}
async function loadUsers() {
  try {
    const data=await fetch('/api/admin/users').then(r=>r.json());
    $('user-list').innerHTML=data.users.map(u=>`<div class="useritem"><strong>${esc(u.username)}</strong><span class="role">${esc(u.role)}${u.active?'':' · disabled'}${u.id===CURRENT_USER.id?' · you':''}</span><div class="useractions">${u.id!==CURRENT_USER.id?`<button class="accountbtn" data-active="${u.id}" data-value="${u.active?'0':'1'}">${u.active?'Disable':'Enable'}</button><button class="accountbtn" data-role="${u.id}" data-value="${u.role==='admin'?'viewer':'admin'}">Make ${u.role==='admin'?'viewer':'admin'}</button>`:''}<button class="accountbtn" data-reset="${u.id}" data-username="${esc(u.username)}">Reset password</button></div></div>`).join('');
    $('user-list').querySelectorAll('[data-active]').forEach(b=>b.addEventListener('click',()=>changeUser(b.dataset.active,{active:b.dataset.value==='1'})));
    $('user-list').querySelectorAll('[data-role]').forEach(b=>b.addEventListener('click',()=>{if(confirm('Change this user to '+b.dataset.value+'?'))changeUser(b.dataset.role,{role:b.dataset.value});}));
    $('user-list').querySelectorAll('[data-reset]').forEach(b=>b.addEventListener('click',()=>{$('reset-password').hidden=false;$('reset-password').dataset.userId=b.dataset.reset;$('reset-title').textContent='Reset password: '+b.dataset.username;$('reset-value').focus();}));
  } catch(e) { $('admin-message').textContent=e.message; }
}
async function changeUser(id,body) {
  try { await apiPost('/api/admin/users/'+id,body); $('admin-message').textContent='User updated. Existing sessions have been signed out.'; await loadUsers(); }
  catch(e) { $('admin-message').textContent=e.message; }
}
function setMenu(open) {
  document.querySelector('header').classList.toggle('menu-open',open);
  $('menu-toggle').setAttribute('aria-expanded',String(open));$('menu-toggle').setAttribute('aria-label',open?'Close menu':'Open menu');
}
$('menu-toggle').addEventListener('click',()=>setMenu($('menu-toggle').getAttribute('aria-expanded')!=='true'));
document.addEventListener('keydown',e=>{if(e.key==='Escape'){setMenu(false);}});
$('full-resync').addEventListener('click',async()=>{
  if(CURRENT_USER?.role!=='admin'||!confirm('Re-fetch all table images from the cabinet? This can take several minutes. Existing images stay available until replaced.'))return;
  const button=$('full-resync');button.disabled=true;
  try{const ok=await load(false);if(!ok)throw new Error('Library could not be refreshed. Full re-sync was not started.');if(!await startImageCache(true))throw new Error('Full image re-sync could not start.');$('admin-message').textContent='Image re-sync is running. Progress appears in the header menu.';}
  catch(e){$('admin-message').textContent=e.message;}finally{button.disabled=false;}
});
$('refresh-btn').addEventListener('click',async()=>{
  const button=$('refresh-btn');button.disabled=true;button.classList.add('syncing');
  try{const ok=await load(false,true);showBanner(ok?'Dashboard data refreshed.':'Refresh failed. Showing the last data loaded.');}catch{showBanner('Dashboard refresh failed.');}
  finally{button.disabled=false;button.classList.remove('syncing');}
});
$('tab-admin').addEventListener('click',()=>switchTab('admin'));
$('logout').addEventListener('click',async()=>{try{await apiPost('/api/auth/logout',{});location.replace('/login');}catch(e){showBanner(e.message);}});
$('create-user').addEventListener('submit',async e=>{
  e.preventDefault();const button=e.target.querySelector('button');button.disabled=true;
  try { await apiPost('/api/admin/users',{username:$('new-username').value,password:$('new-password').value,role:$('new-role').value});e.target.reset();$('admin-message').textContent='User added.';await loadUsers(); }
  catch(e) { $('admin-message').textContent=e.message; } finally {button.disabled=false;}
});
$('reset-cancel').addEventListener('click',()=>{$('reset-password').hidden=true;$('reset-value').value='';});
$('reset-password').addEventListener('submit',async e=>{
  e.preventDefault();await changeUser(e.target.dataset.userId,{password:$('reset-value').value});$('reset-value').value='';e.target.hidden=true;
});
$('branding-form').addEventListener('submit',async e=>{
  e.preventDefault();const button=e.target.querySelector('button');button.disabled=true;
  try {
    const body={name:$('brand-name').value}; const file=$('brand-logo').files[0];
    if(file) {
      if(!['image/png','image/jpeg'].includes(file.type)||file.size>2*1024*1024) throw new Error('Choose a PNG or JPEG under 2 MB.');
      const bitmap=await createImageBitmap(file);const canvas=document.createElement('canvas');const scale=Math.min(1,256/Math.max(bitmap.width,bitmap.height));canvas.width=Math.round(bitmap.width*scale);canvas.height=Math.round(bitmap.height*scale);canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();body.logo=canvas.toDataURL('image/png').split(',')[1];
    }
    await apiPost('/api/settings',body);$('brand-logo').value='';await loadBranding();$('admin-message').textContent='Branding saved.';
  } catch(e) {$('admin-message').textContent=e.message;} finally{button.disabled=false;}
});
(async()=>{
  const state=await fetch('/api/auth/status').then(r=>r.json());if(!state.user){location.replace('/login');return;}
  CURRENT_USER=state.user;CSRF=state.user.csrf;const admin=CURRENT_USER.role==='admin';
  $('tab-admin').hidden=!admin;$('sync-btn').hidden=!admin;$('account-name').textContent=CURRENT_USER.username+' · '+CURRENT_USER.role;
  await loadPreferences();await loadBranding();if(admin)updateImageCache();await load(false);setInterval(()=>{if(!document.hidden && navigator.onLine!==false)load(false);},30000);
})().catch(error=>showBanner(error.message||'Dashboard could not be loaded. Refresh to try again.'));

$('playfield-lightbox').addEventListener('click',e=>{if(e.target===$('playfield-lightbox'))e.target.close();});
$('playfield-lightbox').addEventListener('close',()=>{const box=$('playfield-lightbox');if(!box.open)box.innerHTML='';});

function resumeDashboardReads(){if(CURRENT_USER && !document.hidden && navigator.onLine!==false)load(false);}
document.addEventListener('visibilitychange',resumeDashboardReads);
window.addEventListener('online',resumeDashboardReads);
