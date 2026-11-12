/* Local lists only. Nothing here calls an outside service. */
let NIGHT_STATE=null, NIGHT_CUSTOM=[], NIGHT_THEME='decade-1990', NIGHT_MAKER='', NIGHT_BUSY=false;
const NIGHT_THEMES=[
  ...[1960,1970,1980,1990,2000,2010,2020].map(y=>['decade-'+y,(y>=2000?y:String(y).slice(2))+'s night']),
  ['old-school','Old school'],['random','Random night'],['originals','Originals night'],['score-chase','Score chase'],
  ['overlooked','Overlooked gems'],['favorites','Favorites night'],['fresh','Fresh arrivals'],
  ['no-score','No score yet'],['color','Color night'],['top100','Top-100 night'],
  ['game-shows','Game shows'],['movie','Movie night'],['tv','TV night'],['sci-fi','Sci-fi night'],
  ['sports','Sports night'],['music','Music night'],['horror','Horror night']
];
const NIGHT_PLAYLISTS={
  'game-shows':['game shows','game show'],movie:['movie','movies','movie night'],tv:['tv','television','tv night'],
  'sci-fi':['sci fi','science fiction','sci fi night'],sports:['sports','sports night'],music:['music','music night'],horror:['horror','horror night']
};
const NIGHT_RULES={
  'old-school':'Dated before 1990. Unknown years stay out.',random:'A random draw up to your cap, with equal chances and no repeats.',
  originals:'Tables explicitly marked Original by the cabinet. Unknown makers stay out.','score-chase':'Tables with a saved score. Your saved best is the target, not a new-score tracker.',
  overlooked:'Random from the least-played pool: twice your cap, plus any tied play counts. Unknown counts stay out.',favorites:'Your personal saved favorites.',
  fresh:'Random from the newest dated tables: a pool up to twice your cap. Unknown dates stay out.','no-score':'No score recorded here, not necessarily never played.',
  color:'Tables with the cabinet Color badge.',top100:'Random from your owned matches in the built-in Top-100 list.'
};
const NIGHT_MAKER_ALIASES={'bally midway':'bally',midway:'bally','williams electronics':'williams','stern pinball':'stern','data east pinball':'data east','sega pinball':'sega','jersey jack pinball':'jersey jack','spooky pinball':'spooky','capcom pinball':'capcom'};
function nightMakerKey(value){const n=nightNormalize(value);return NIGHT_MAKER_ALIASES[n]||n;}
function nightMakers(){
  const map=new Map();
  for(const t of DATA.tables){if(HIDDEN.has(t.gameId))continue;const key=nightMakerKey(t.maker);if(!key||['original','originals','unknown','none','n a'].includes(key))continue;
    if(!map.has(key))map.set(key,{key:'maker-'+key.replace(/ /g,'-'),maker:key,name:key.replace(/\b[a-z]/g,c=>c.toUpperCase()),count:0});map.get(key).count++;
  }
  return [...map.values()].sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name)).slice(0,6);
}
function nightThemes(){return [...NIGHT_THEMES.slice(0,10),...nightMakers().map(m=>[m.key,m.name+' night']),...NIGHT_THEMES.slice(10),...NIGHT_CUSTOM.map(t=>[t.id,t.name])];}
function nightName(key){return nightThemes().find(t=>t[0]===key)?.[1]||'Saved night';}
function nightNormalize(value){return String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();}
function nightPool(key,maker=NIGHT_MAKER){
  let rows=DATA.tables.filter(t=>!HIDDEN.has(t.gameId));
  if(key.startsWith('decade-')){const y=Number(key.slice(7));return rows.filter(t=>Number.isInteger(t.year)&&t.year>=y&&t.year<y+10);}
  if(key==='originals')return rows.filter(t=>['original','originals'].includes(nightMakerKey(t.maker)));
  if(key==='old-school')return rows.filter(t=>Number.isInteger(t.year)&&t.year<1990);
  if(key.startsWith('maker-'))return rows.filter(t=>nightMakerKey(t.maker).replace(/ /g,'-')===key.slice(6));
  if(key==='favorites')return rows.filter(t=>FAVOURITES.has(t.gameId));
  if(key==='overlooked'){
    const ranked=rows.filter(t=>Number.isInteger(t.playCount)&&t.playCount>=0).sort((a,b)=>a.playCount-b.playCount);
    const boundary=ranked[Math.min(ranked.length,(NIGHT_STATE?.cap||10)*2)-1]?.playCount;
    return ranked.filter(t=>t.playCount<=boundary);
  }
  if(key==='fresh')return rows.filter(t=>t.addedAt&&Number.isFinite(Date.parse(t.addedAt))).sort((a,b)=>Date.parse(b.addedAt)-Date.parse(a.addedAt)).slice(0,(NIGHT_STATE?.cap||10)*2);
  if(key==='color')return rows.filter(t=>(t.badges||[]).includes('Color'));
  if(key==='score-chase'||key==='no-score'){const scored=new Set(DATA.scores.map(s=>s.gameId));return rows.filter(t=>scored.has(t.gameId)===(key==='score-chase'));}
  if(key==='top100'){const ids=new Set(DATA.topTables.map(t=>t.gameId));return rows.filter(t=>ids.has(t.gameId));}
  if(key.startsWith('custom-')){const ids=new Set(NIGHT_CUSTOM.find(t=>t.id===key)?.gameIds||[]);return rows.filter(t=>ids.has(t.gameId));}
  if(NIGHT_PLAYLISTS[key]){const ids=new Set(DATA.playlists.filter(p=>NIGHT_PLAYLISTS[key].includes(nightNormalize(p.name))).flatMap(p=>p.gameIds||[]));return rows.filter(t=>ids.has(t.gameId));}
  return key==='random'?rows:[];
}
function nightShuffle(rows){const a=[...rows];for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
function nightChoose(key,maker){
  let rows=nightShuffle(nightPool(key,maker));
  return rows.slice(0,NIGHT_STATE?.cap||10).map(t=>t.gameId);
}
function nightError(error){const n=$('night-error');n.hidden=!error;n.title=error?.message||'';n.setAttribute('aria-label',error?.message||'Game night error');}
async function loadNight(){
  const r=await fetch('/api/game-night');if(!r.ok)throw new Error('Game night could not be loaded.');NIGHT_STATE=await r.json();
  const themes=await fetch('/api/night-themes');if(!themes.ok)throw new Error('Imported themes could not be loaded.');NIGHT_CUSTOM=(await themes.json()).themes;
  if(NIGHT_STATE.night){NIGHT_THEME=NIGHT_STATE.night.theme;NIGHT_MAKER=NIGHT_STATE.night.maker;}
  renderGameNight();
}
async function nightWrite(body){
  if(NIGHT_BUSY||!NIGHT_STATE)return false;NIGHT_BUSY=true;renderGameNight();
  try{NIGHT_STATE=await apiPost('/api/game-night',{revision:NIGHT_STATE.revision,...body});nightError(null);return true;}
  catch(e){try{await loadNight();}catch{}nightError(e);return false;}
  finally{NIGHT_BUSY=false;renderGameNight();}
}
async function nightSetting(){
  const hidden=[...$('night-theme-settings').querySelectorAll('input')].filter(c=>!c.checked).map(c=>c.dataset.theme);
  await nightWrite({action:'settings',enabled:$('night-enabled').checked,showImports:$('night-import-enabled').checked,hiddenThemes:hidden});
}
function renderGameNight(){
  if(!NIGHT_STATE)return;
  $('tab-night').hidden=!NIGHT_STATE.enabled;
  if(!NIGHT_STATE.enabled&&$('tab-night').getAttribute('aria-pressed')==='true')switchTab('library');
  const makers=[...new Set(DATA.tables.filter(t=>!HIDDEN.has(t.gameId)).map(t=>t.maker).filter(Boolean))].sort();
  if(!makers.includes(NIGHT_MAKER))NIGHT_MAKER=makers[0]||'';
  let visible=nightThemes().filter(t=>!NIGHT_STATE.hiddenThemes.includes(t[0]));
  if(HIDE_EMPTY_THEMES){const nonEmpty=visible.filter(t=>nightPool(t[0]).length);if(nonEmpty.length)visible=nonEmpty;}
  if(!visible.some(t=>t[0]===NIGHT_THEME))NIGHT_THEME=visible.find(t=>nightPool(t[0]).length)?.[0]||visible[0]?.[0]||'';
  const menu=visible.map(([key,label])=>{const count=nightPool(key).length;return `<button type="button" class="night-theme" data-night-theme="${esc(key)}" aria-pressed="${key===NIGHT_THEME}" ${!count||NIGHT_BUSY?'disabled':''}><strong>${esc(label)}</strong><span>${count} tables</span></button>`;}).join('');
  $('night-themes').innerHTML=menu||'<p class="muted">Choose themes in Settings.</p>';
  $('night-theme-select').innerHTML=visible.map(([key,label])=>`<option value="${esc(key)}" ${key===NIGHT_THEME?'selected':''} ${!nightPool(key).length?'disabled':''}>${esc(label)} (${nightPool(key).length})</option>`).join('');
  document.querySelectorAll('[data-night-theme]').forEach(b=>b.addEventListener('click',()=>{NIGHT_THEME=b.dataset.nightTheme;renderGameNight();}));
  $('night-maker').innerHTML=makers.map(m=>`<option ${m===NIGHT_MAKER?'selected':''}>${esc(m)}</option>`).join('');
  $('night-maker').hidden=true;
  $('night-preview-name').textContent=nightName(NIGHT_THEME);
  $('night-rule').textContent=NIGHT_THEME.startsWith('maker-')?'A random draw from this manufacturer, up to your cap. Known maker aliases are combined.':NIGHT_THEME.startsWith('decade-')?'Tables dated '+NIGHT_THEME.slice(7)+' through '+(Number(NIGHT_THEME.slice(7))+9)+'.':NIGHT_PLAYLISTS[NIGHT_THEME]?'Uses a cabinet playlist named '+NIGHT_PLAYLISTS[NIGHT_THEME].map(n=>'"'+n+'"').join(' or ')+'. Case and punctuation do not matter.':NIGHT_THEME.startsWith('custom-')?'Matches from an imported theme. Hidden and missing tables stay out.':NIGHT_RULES[NIGHT_THEME]||'';
  const art=$('night-art'),artPool=nightPool(NIGHT_THEME).slice(0,3);
  art.innerHTML=artPool.length?artPool.map(t=>`<div class="night-art-tile">${DATA.thumbsEnabled?`<img src="/api/thumb/${t.gameId}?v=2&r=${encodeURIComponent(t.mediaRevision||'')}" alt="" loading="lazy">`:''}<span>${esc(t.name)}</span></div>`).join(''):'<div class="night-art-icon"><svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><line x1="6" y1="11" x2="10" y2="11"/><line x1="8" y1="9" x2="8" y2="13"/><line x1="15" y1="12" x2="15.01" y2="12"/><line x1="18" y1="10" x2="18.01" y2="10"/><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"/></svg></div>';
  art.querySelectorAll('img').forEach(img=>img.addEventListener('error',()=>img.remove()));
  const count=nightPool(NIGHT_THEME).length;
  $('night-cap').value=String(NIGHT_STATE.cap||10);$('night-cap').disabled=NIGHT_BUSY;
  $('night-start').disabled=NIGHT_BUSY||!count;
  $('night-start').textContent=NIGHT_STATE.night?'Start new night':'Start night';
  const saved=NIGHT_STATE.night, ids=saved?.ids||[], checked=new Set(saved?.checked||[]);
  $('night-saved-title').textContent=saved?nightName(saved.theme)+(saved.theme==='maker'?' · '+saved.maker:''):'Tonight';
  $('night-complete').textContent=saved?'✓ '+checked.size+' / '+ids.length:'';
  const best=bestByTable();
  $('night-list').innerHTML=ids.length?ids.map(id=>{
    const t=DATA.tables.find(t=>t.gameId===id),available=t&&!HIDDEN.has(id),done=checked.has(id);
    const target=saved.theme==='score-chase'&&best.get(id)?.best!=null?' · Best '+fmt(best.get(id).best):'';
    return `<div class="night-row ${done?'night-done':''}"><label class="night-check"><input type="checkbox" data-night-check="${id}" ${done?'checked':''} ${NIGHT_BUSY?'disabled':''}><span class="sr-only">Mark ${esc(available?t.name:'unavailable table')} played tonight</span></label><div class="night-table"><strong>${esc(available?t.name:'Table unavailable or hidden')}</strong><span class="muted">${available?esc([t.maker,t.year].filter(Boolean).join(' · ')+target):'Saved place kept. Start a new night to replace it.'}</span></div>${available&&canLaunch(t)?`<button class="play night-play" type="button" data-night-play="${id}" aria-label="Play ${esc(t.name)}" ${STATUS.state==='online'&&!STATUS.gamePlaying?'':'disabled'}>▶</button>`:''}</div>`;
  }).join(''):'<p class="muted night-empty">Choose a theme, then Start night. Your list stays here until you start another.</p>';
  document.querySelectorAll('[data-night-check]').forEach(c=>c.addEventListener('change',()=>nightWrite({action:'check',id:Number(c.dataset.nightCheck),checked:c.checked})));
  document.querySelectorAll('[data-night-play]').forEach(b=>b.addEventListener('click',()=>play(Number(b.dataset.nightPlay))));
  $('night-enabled').checked=NIGHT_STATE.enabled;$('night-import-enabled').checked=NIGHT_STATE.showImports;
  $('night-enabled').disabled=NIGHT_BUSY;$('night-import-enabled').disabled=NIGHT_BUSY;
  $('night-theme-settings').innerHTML=nightThemes().map(([key,label])=>`<label class="setting-toggle"><input type="checkbox" data-theme="${esc(key)}" ${NIGHT_STATE.hiddenThemes.includes(key)?'':'checked'} ${NIGHT_BUSY?'disabled':''}>${esc(label)}</label>`).join('');
  $('night-theme-settings').querySelectorAll('input').forEach(c=>c.addEventListener('change',nightSetting));
  $('night-import-panel').hidden=CURRENT_USER?.role!=='admin'||!NIGHT_STATE.showImports;
  $('night-imports').innerHTML=NIGHT_CUSTOM.map(t=>`<div class="night-import-row"><strong>${esc(t.name)}</strong><span>${t.gameIds.length} matched</span><button class="accountbtn" data-night-edit="${esc(t.id)}">Edit</button><button class="accountbtn" data-night-delete="${esc(t.id)}">Delete</button></div>`).join('');
  document.querySelectorAll('[data-night-edit]').forEach(b=>b.addEventListener('click',()=>nightOpenImport(NIGHT_CUSTOM.find(t=>t.id===b.dataset.nightEdit))));
  document.querySelectorAll('[data-night-delete]').forEach(b=>b.addEventListener('click',async()=>{const t=NIGHT_CUSTOM.find(t=>t.id===b.dataset.nightDelete);if(!confirm('Delete '+t.name+' for everyone on this server? Saved nights keep their table lists.'))return;try{await apiPost('/api/night-themes',{action:'delete',id:t.id,revision:t.revision});await loadNight();}catch(e){nightImportError(e);}}));
}
$('tab-night').addEventListener('click',async()=>{switchTab('night');try{await loadNight();nightError(null);}catch(e){nightError(e);}});
$('night-theme-select').addEventListener('change',e=>{NIGHT_THEME=e.target.value;renderGameNight();});
$('night-maker').addEventListener('change',e=>{NIGHT_MAKER=e.target.value;renderGameNight();});
$('night-cap').addEventListener('change',e=>nightWrite({action:'cap',cap:Number(e.target.value)}));
$('night-start').addEventListener('click',async()=>{
  if(NIGHT_STATE?.night&&!confirm('Start a new '+nightName(NIGHT_THEME)+'? This replaces your current list and clears its checks.'))return;
  const ids=nightChoose(NIGHT_THEME,NIGHT_MAKER);if(ids.length)await nightWrite({action:'new',theme:NIGHT_THEME,maker:NIGHT_THEME==='maker'?NIGHT_MAKER:'',ids});
});
$('night-enabled').addEventListener('change',nightSetting);$('night-import-enabled').addEventListener('change',nightSetting);
let NIGHT_EDIT=null,NIGHT_PREVIEW=null;
function nightImportError(e){$('night-import-error').textContent=e?.message||'';const icon=$('night-settings-error');icon.hidden=!e;icon.title=e?.message||'';icon.setAttribute('aria-label',e?.message||'Theme import error');}
function nightOpenImport(theme=null){NIGHT_EDIT=theme;NIGHT_PREVIEW=null;$('night-import-source').value=theme?.source||'';$('night-import-report').replaceChildren();$('night-import-save').disabled=true;nightImportError(null);$('night-import-dialog').showModal();}
$('night-import-open').addEventListener('click',()=>nightOpenImport());
$('night-import-close').addEventListener('click',()=>$('night-import-dialog').close());
$('night-import-source').addEventListener('input',()=>{NIGHT_PREVIEW=null;$('night-import-save').disabled=true;});
$('night-import-file').addEventListener('change',async e=>{const f=e.target.files[0];if(!f)return;if(f.size>32768){nightImportError(new Error('Choose a text or JSON file under 32 KB.'));return;}$('night-import-source').value=await f.text();NIGHT_PREVIEW=null;$('night-import-save').disabled=true;e.target.value='';});
$('night-import-preview').addEventListener('click',async()=>{
  const button=$('night-import-preview');button.disabled=true;nightImportError(null);
  try{const source=$('night-import-source').value;const result=await apiPost('/api/night-themes',{action:'preview',id:NIGHT_EDIT?.id||null,revision:NIGHT_EDIT?.revision||0,source});NIGHT_PREVIEW=source;
    $('night-import-report').innerHTML=`<h3>${esc(result.name)}: ${result.gameIds.length} matched</h3>`+result.report.map(r=>`<div class="night-match"><strong>${esc(r.title)}</strong><span>${esc(r.status)}${r.matchedTitle?' · '+esc(r.matchedTitle):''}</span></div>`).join('');
    $('night-import-save').disabled=false;
  }catch(e){NIGHT_PREVIEW=null;$('night-import-save').disabled=true;nightImportError(e);}finally{button.disabled=false;}
});
$('night-import-save').addEventListener('click',async()=>{
  if(NIGHT_PREVIEW!==$('night-import-source').value)return;
  const b=$('night-import-save');b.disabled=true;
  try{await apiPost('/api/night-themes',{action:'save',id:NIGHT_EDIT?.id||null,revision:NIGHT_EDIT?.revision||0,source:NIGHT_PREVIEW});$('night-import-dialog').close();await loadNight();}catch(e){nightImportError(e);b.disabled=false;}
});
