// fit tree — app entry. Logic unchanged from the prototype; Phase 2 adds a login gate.
import './style.css';
import Chart from 'chart.js/auto';   // auto = same all-controllers registration as the old UMD CDN
import { supabase } from './supabase.js';
import { bootstrap, loadAll, profileFromRow, saveProfileRow } from './db.js';

/* ---------- members ---------- */
// Flat initial state: just me. Friends arrive in the backend/sharing phase (I/I2).
// Re-keyed to the logged-in user's id in bootstrap (see initApp) so members[CURRENT_USER] resolves.
let members = {
  boy:   { name:'ぼーい', ini:'ボ', c:'#14B87C' },
};
// First code point (not str[0]) so emoji / surrogate-pair nicknames don't get half-cut.
function firstCP(s){ return (Array.from((s || '').trim())[0]) || '?'; }
const tagDot = {
  '胸トレ':'#FF6A3D','背中':'#3E86C9','脚':'#7C6CD0',
  '肩・腕':'#E0A53A','有酸素':'#14B87C','ストレッチ':'#5FB6A8','休養':'#9AA09A'
};
function avatar(m,size=40){
  return `<div style="width:${size}px;height:${size}px;background:${m.c}" class="rounded-full flex items-center justify-center text-white font-bold shrink-0"><span style="font-size:${Math.round(size*0.4)}px">${m.ini}</span></div>`;
}
function chip(tag,status){
  const dot=tagDot[tag]||'#9AA09A';
  const d=`<span class="w-1.5 h-1.5 rounded-full" style="background:${dot}"></span>`;
  const base='inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-full';
  if(status==='done')    return `<span class="${base} text-ink bg-asoft border border-aline">${d}${tag}<span class="text-accent text-[12px] leading-none">✓</span></span>`;
  if(status==='changed') return `<span class="${base} text-ink bg-[#F3F2EE]">${d}${tag}<span class="text-[9px] font-extrabold text-[#E0A53A] bg-[#FBF3E0] px-1 py-0.5 rounded leading-none">変更</span></span>`;
  if(status==='todo')    return `<span class="${base} text-faint bg-card border border-dashed border-line">${d}${tag}</span>`;
  return `<span class="${base} text-ink bg-[#F3F2EE]">${d}${tag}</span>`;
}
function hudCell(label,val,color){
  return `<div class="py-2 px-1 text-center"><p class="text-[9px] text-faint font-bold mb-0.5">${label}</p><p class="text-[13px] font-extrabold leading-none" style="color:${color}">${val}</p></div>`;
}

/* ---------- FEED ---------- */
// Flat initial state: no sample posts. Posts are created via createPost (timer/resist/achieve).
const posts = [];
// every post carries who + scope (公開範囲) for future export/share; ids for reference
let postSeq=0;
posts.forEach(p=>{ p.id='p'+(postSeq++); if(!p.scope) p.scope='group'; });
// single source of truth for creating timeline posts (timer-stop / resist / future done-share all use this)
function createPost({kind='workout', who=CURRENT_USER, tags=[], dur=null, photo=null, text='', ruleLabel=null, scope='group'}){
  return { id:'p'+(postSeq++), kind, who, scope, time:'いま', tags:(tags||[]).slice(), dur, photo, text, ruleLabel, r:{fire:0,muscle:0,clap:0} };
}
function addPost(p){ posts.unshift(p); renderFeed(); }

/* ---------- workout timer (E2) + post flow (E) ---------- */
let timerRunning=false, timerSec=0, timerInterval=null, timerTags=[];
let timerFromPlan=false;    // true=今日の予定から開始（既存エントリを更新）／false=予定なし開始（新規追加）
let startTags=[];           // category-select (no-plan start)
let pendingPhoto=null, postCtx=null;
const START_CATS=['胸トレ','背中','脚','肩・腕','有酸素','ストレッチ'];
function fmtTimer(s){ return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`; }
function durFromSec(s){ const min=Math.max(1,Math.round(s/60)); if(min<60) return `${min}分`; const h=Math.floor(min/60), mm=min%60; return mm?`${h}時間${mm}分`:`${h}時間`; }
function renderStartBar(){
  const el=document.getElementById('startBarInner'); if(!el) return;
  el.innerHTML = timerRunning
    ? `<div class="bg-card border border-aline rounded-full shadow-lift pl-5 pr-2 py-2 flex items-center gap-3">
         <span class="flex items-center gap-2 text-[14px] font-extrabold text-ink"><span class="w-2 h-2 rounded-full bg-accent animate-pulse"></span><span id="timerDisp">${fmtTimer(timerSec)}</span></span>
         <span class="text-[11px] font-bold text-sub truncate max-w-[110px]">${timerTags.join('・')}</span>
         <button class="stop-workout pop bg-accent text-white text-[12px] font-extrabold rounded-full px-4 py-2">運動終了</button>
       </div>`
    : `<button class="start-workout pop bg-accent text-white text-[13px] font-extrabold rounded-full shadow-lift px-6 py-3 flex items-center gap-2"><span class="text-[12px]">▶</span>運動開始</button>`;
}
function startTimer(tags){
  timerTags=(tags||[]).slice(); timerSec=0; timerRunning=true;
  if(timerInterval) clearInterval(timerInterval);
  timerInterval=setInterval(()=>{ timerSec++; const d=document.getElementById('timerDisp'); if(d) d.textContent=fmtTimer(timerSec); },1000);
  renderStartBar();
}
function onStartWorkout(){
  const todays=logEntries.filter(e=>e.type==='workout'&&e.who===CURRENT_USER&&e.date===TODAY);
  const tags=[...new Set(todays.flatMap(e=>e.tags||[]))];
  if(tags.length){ timerFromPlan=true; startTimer(tags); }
  else { timerFromPlan=false; startTags=[]; renderStartTags(); document.getElementById('startScrim').classList.remove('hidden'); document.getElementById('startSheet').classList.add('open'); }
}
function closeStartSheet(){ document.getElementById('startSheet').classList.remove('open'); document.getElementById('startScrim').classList.add('hidden'); }
function renderStartTags(){
  document.getElementById('startTags').innerHTML=START_CATS.map(t=>
    `<button class="start-tag pop text-[12px] font-bold px-3 py-2 rounded-full border ${startTags.includes(t)?'sel':'border-line text-ink bg-card'}" data-tag="${t}"><span class="inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle" style="background:${tagDot[t]||'#9AA09A'}"></span>${t}</button>`
  ).join('');
}
function onStartGo(){ if(!startTags.length) return; timerFromPlan=false; closeStartSheet(); startTimer(startTags); }
function onStopWorkout(){
  if(timerInterval) clearInterval(timerInterval);
  timerRunning=false;
  const dur=durFromSec(timerSec);
  renderStartBar();
  // (1) record the workout so it counts. 予定から開始なら今日の自分の予定を実施済みに更新（重複追加しない）。
  //     予定なし開始の時だけ新規エントリを追加する。
  const todays=logEntries.filter(e=>e.type==='workout'&&e.who===CURRENT_USER&&e.date===TODAY);
  if(timerFromPlan && todays.length){
    todays.forEach(e=>{ e.status='done'; e.dur=dur; });
  }else{
    logEntries.push({id:newId(), date:TODAY, type:'workout', who:CURRENT_USER, tags:timerTags.slice(), time:'いま', dur, status:'done'});
  }
  rerenderAfterChange();
  // (2) open the share (post) flow with the same tags + measured time
  openPostSheet(timerTags, dur);
}
function openPostSheet(tags, dur){
  pendingPhoto=null; postCtx={tags:(tags||[]).slice(), dur};
  document.getElementById('psTags').innerHTML=(tags||[]).map(t=>chip(t)).join('');
  document.getElementById('psDur').textContent='実施 '+dur;
  document.getElementById('psPhotoPreview').innerHTML='';
  document.getElementById('psText').value='';
  document.getElementById('psPhoto').value='';
  document.getElementById('postScrim').classList.remove('hidden');
  document.getElementById('postSheet').classList.add('open');
}
function closePostSheet(){ document.getElementById('postSheet').classList.remove('open'); document.getElementById('postScrim').classList.add('hidden'); }
function handlePhoto(file){
  if(!file) return;
  const reader=new FileReader();
  reader.onload=ev=>{ pendingPhoto=ev.target.result; document.getElementById('psPhotoPreview').innerHTML=`<img src="${pendingPhoto}" class="w-full h-40 object-cover rounded-xl mt-2">`; };
  reader.readAsDataURL(file);
}
function submitPost(){
  if(!postCtx) return;
  const text=document.getElementById('psText').value.trim();
  addPost(createPost({kind:'workout', who:CURRENT_USER, tags:postCtx.tags, dur:postCtx.dur, photo:pendingPhoto, text, scope:'group'}));
  postCtx=null; pendingPhoto=null;
  closePostSheet();
  showPage('feed');
}
// 記録ヒーローを丸ごと再計算（renderProgressHero に統合。下位互換のため名前は残す）
function renderStats(){ if(typeof renderProgressHero==='function') renderProgressHero(); }
function renderFeedAvatars(){
  // unique posters (up to 3), derived from current posts
  const whos=[...new Set(posts.map(p=>p.who))].filter(k=>members[k]).slice(0,3);
  document.getElementById('feedAvatars').innerHTML =
    whos.map(k=>`<div class="ring-2 ring-bg rounded-full">${avatar(members[k],24)}</div>`).join('');
  const cnt=document.getElementById('feedCount'); if(cnt) cnt.textContent=`きょう ${posts.length}件`;
}
function renderFeed(){
  renderFeedAvatars();
  const list=document.getElementById('feedList');
  if(!posts.length){
    list.innerHTML=`<div class="text-center py-14 rounded-2xl bg-card border border-dashed border-line">
      <p class="text-[28px]">🌱</p>
      <p class="text-[13px] text-faint font-bold mt-2">まだ投稿はありません</p>
      <p class="text-[11px] text-faint mt-1">運動を記録したり、自分ルールを達成すると、ここに届きます</p>
    </div>`;
    return;
  }
  list.innerHTML = posts.map((p,i)=>{
    const m=members[p.who];
    if(p.kind==='resist') return `
    <article class="rounded-2xl bg-asoft border border-aline shadow-card overflow-hidden">
      <div class="flex items-center gap-3 px-4 pt-3.5">
        ${avatar(m,38)}
        <div class="flex-1">
          <p class="text-[14px] font-extrabold text-ink leading-none">${m.name}</p>
          <p class="text-[11px] text-faint mt-1">きょう ${p.time}</p>
        </div>
        <span class="inline-flex items-center gap-1 text-[11px] font-bold text-accent bg-card border border-aline px-2.5 py-1 rounded-full">🛡 踏みとどまった</span>
      </div>
      <div class="px-4 pt-3 pb-1">
        <p class="text-[14px] text-ink leading-snug">${p.text}</p>
        ${p.ruleLabel?`<div class="mt-2.5 flex items-center gap-1.5 text-[12px] font-bold text-accent"><span class="w-1.5 h-1.5 rounded-full bg-accent"></span>自分ルール「${p.ruleLabel}」を守った</div>`:''}
      </div>
      <div class="flex gap-2 px-4 py-3">
        ${reactBtn(i,'fire','🔥',p.r.fire)}${reactBtn(i,'muscle','💪',p.r.muscle)}${reactBtn(i,'clap','👏',p.r.clap)}
      </div>
    </article>`;
    if(p.kind==='achieve') return `
    <article class="rounded-2xl bg-asoft border border-aline shadow-card overflow-hidden">
      <div class="flex items-center gap-3 px-4 pt-3.5">
        ${avatar(m,38)}
        <div class="flex-1">
          <p class="text-[14px] font-extrabold text-ink leading-none">${m.name}</p>
          <p class="text-[11px] text-faint mt-1">きょう ${p.time}</p>
        </div>
        <span class="inline-flex items-center gap-1 text-[11px] font-bold text-accent bg-card border border-aline px-2.5 py-1 rounded-full">🎯 ルール達成</span>
      </div>
      <div class="px-4 pt-3 pb-1">
        <p class="text-[14px] text-ink leading-snug">${p.text}</p>
        ${p.ruleLabel?`<div class="mt-2.5 flex items-center gap-1.5 text-[12px] font-bold text-accent"><span class="w-1.5 h-1.5 rounded-full bg-accent"></span>自分ルール「${p.ruleLabel}」を達成</div>`:''}
      </div>
      <div class="flex gap-2 px-4 py-3">
        ${reactBtn(i,'fire','🔥',p.r.fire)}${reactBtn(i,'muscle','💪',p.r.muscle)}${reactBtn(i,'clap','👏',p.r.clap)}
      </div>
    </article>`;
    // post = 実施部位 + 実施時間 + 写真 + コメント (no calories — those live on 記録)
    const imgBlock = p.photo
      ? `<div class="px-4 pt-3"><img src="${p.photo}" class="rounded-xl w-full h-44 object-cover"></div>`
      : (p.ph ? `<div class="px-4 pt-3"><div class="rounded-xl h-44 flex items-center justify-center" style="background:${p.ph}"><span style="font-size:42px;opacity:.32">${p.phIco}</span></div></div>` : '');
    const textLine = p.text ? `<p class="text-[14px] text-ink leading-snug">${p.text}</p>` : '';
    const durLine = p.dur ? `<div class="${p.text?'mt-2.5 ':''}flex items-center gap-1.5 text-[12px] font-bold text-sub"><span class="w-1.5 h-1.5 rounded-full bg-accent"></span>実施 ${p.dur}</div>` : '';
    const body = (textLine||durLine) ? `<div class="px-4 pt-3 pb-1">${textLine}${durLine}</div>` : '';
    return `
    <article class="rounded-2xl bg-card border border-line shadow-card overflow-hidden">
      <div class="flex items-center gap-3 px-4 pt-3.5">
        ${avatar(m,38)}
        <div class="flex-1">
          <p class="text-[14px] font-extrabold text-ink leading-none">${m.name}</p>
          <p class="text-[11px] text-faint mt-1">きょう ${p.time}</p>
        </div>
        <div class="flex flex-wrap justify-end gap-1.5">${(p.tags||[]).map(t=>chip(t)).join('')}</div>
      </div>
      ${imgBlock}
      ${body}
      <div class="flex gap-2 px-4 py-3">
        ${reactBtn(i,'fire','🔥',p.r.fire)}
        ${reactBtn(i,'muscle','💪',p.r.muscle)}
        ${reactBtn(i,'clap','👏',p.r.clap)}
      </div>
    </article>`;
  }).join('');
}
function reactBtn(i,key,emo,n){
  return `<button class="react pop flex items-center gap-1.5 border border-line bg-card px-3 py-1.5 rounded-full text-[13px] font-bold text-sub" data-i="${i}" data-k="${key}"><span>${emo}</span><span class="cnt">${n}</span></button>`;
}

/* ---------- SCHEDULE (type-tagged log · week/month · bottom sheet) ---------- */
let CURRENT_USER='boy';   // replaced with session.user.id in bootstrap (initApp)
let SPACE_ID=null;        // the personal space id resolved in bootstrap
const TODAY='2026-06-20';
let selectedDate=TODAY;
let schedView='week';
let calCursor={y:2026, m:5};            // 0-based month (5 = June)
const WD=['月','火','水','木','金','土','日'];   // Monday-first

// pure 'YYYY-MM-DD' helpers (built from parts to avoid timezone drift)
function ymd(y,m,d){ return `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`; }
function parseYmd(s){ const [y,m,d]=s.split('-').map(Number); return {y,m:m-1,d}; }
function wdIndex(s){ const {y,m,d}=parseYmd(s); return (new Date(y,m,d).getDay()+6)%7; } // Mon=0
function fmtLabel(s){
  if(s===TODAY) return 'きょうの予定';
  const {m,d}=parseYmd(s);
  const txt=`${m+1}月${d}日(${WD[wdIndex(s)]})`;
  return s<TODAY ? `${txt} の記録` : `${txt} の予定`;
}

// real Monday-first week containing TODAY (2026-06-20 = Sat) → Mon 15 … Sun 21
const week = [
  {d:'月',date:'2026-06-15'},{d:'火',date:'2026-06-16'},{d:'水',date:'2026-06-17'},
  {d:'木',date:'2026-06-18'},{d:'金',date:'2026-06-19'},{d:'土',date:'2026-06-20'},{d:'日',date:'2026-06-21'}
];
function renderWeek(){
  document.getElementById('weekStrip').innerHTML = week.map(w=>{
    const sel=w.date===selectedDate, isToday=w.date===TODAY;
    const {d:dd}=parseYmd(w.date);
    const has=logEntries.some(e=>e.type==='workout'&&e.date===w.date);
    // teal language: selected=teal fill, today=teal ring + "今日" mark (both distinguishable)
    const cardCls = sel?'bg-accent border-accent':(isToday?'bg-card border-accent':'bg-card border-line');
    const labelCls = sel?'text-white/80':(isToday?'text-accent':'text-faint');
    const numCls = sel?'text-white':(isToday?'text-accent':'text-ink');
    const marker = isToday
      ? `<span class="text-[8px] font-extrabold leading-none ${sel?'text-white/90':'text-accent'}">今日</span>`
      : `<span class="w-1 h-1 rounded-full ${has?(sel?'bg-white/70':'bg-accent'):(sel?'bg-white/40':'bg-line')}"></span>`;
    return `<button class="day-pill pop w-full py-3 rounded-2xl flex flex-col items-center gap-1.5 border ${cardCls}" data-date="${w.date}">
      <span class="text-[11px] font-bold ${labelCls}">${w.d}</span>
      <span class="text-[16px] font-extrabold ${numCls}">${dd}</span>
      <span class="h-2.5 flex items-center">${marker}</span>
    </button>`;
  }).join('');
}
// shared weight is 前週比 only — never raw kg. Shown in the selected-day list rows (workoutCard).
// Flat initial state: no friends yet → empty. (Friends + 相手ごと公開範囲 = backend phase I/I2.)
const memberShare = {};
// Structured, export-ready log: each row is {date:'YYYY-MM-DD', type, ...value}.
// type-tagged (CLAUDE.md「Schedule拡張仕様」). workout / weight / meal live here.
// Flat initial state: empty. Structure stays so we can wire it to Supabase later.
const logEntries = [];
// stable ids so any entry (workout/weight/meal) can be edited or deleted by reference
let entrySeq=0;
logEntries.forEach(e=>{ e.id='e'+(entrySeq++); });
function newId(){ return 'e'+(entrySeq++); }
const planStat = {
  done:   {label:'実施済み', cls:'text-accent',    dot:'#14B87C', dim:false, check:true},
  planned:{label:'これから', cls:'text-ink',       dot:'#E0A53A', dim:false, check:false},
  changed:{label:'予定変更', cls:'text-[#E0A53A]', dot:'#E0A53A', dim:false, check:false},
  todo:   {label:'未実施',   cls:'text-faint',     dot:'#D2D5CF', dim:true,  check:false},
};
function workoutCard(p){
  const m=members[p.who]; const s=planStat[p.status]||planStat.planned;
  const sh=memberShare[p.who]||{};
  const wtLine = sh.wt ? `<span class="text-[11px] font-bold ${sh.wt.startsWith('▼')?'text-accent':'text-sub'}">${sh.wt}</span>` : '';
  return `<div class="entry-edit pop cursor-pointer flex items-center gap-3 rounded-2xl bg-card border border-line shadow-card p-3.5 ${s.dim?'opacity-60':''}" data-id="${p.id}">
    ${avatar(m,40)}
    <div class="flex-1">
      <div class="flex flex-wrap items-center gap-1.5">
        <span class="text-[14px] font-extrabold text-ink">${m.name}</span>${(p.tags||[]).map(t=>chip(t)).join('')}
      </div>
      <p class="text-[11px] text-faint mt-1">予定 ${p.time}${p.note?` ・ <span class="font-bold text-[#E0A53A]">${p.note}</span>`:''}</p>
    </div>
    <div class="flex flex-col items-end gap-1">
      <span class="flex items-center gap-1.5 text-[12px] font-bold ${s.cls}"><span class="w-1.5 h-1.5 rounded-full" style="background:${s.dot}"></span>${s.check?'✓ ':''}${s.label}</span>
      ${wtLine}
    </div>
  </div>`;
}
function renderDayList(){
  document.getElementById('dayListLabel').textContent = fmtLabel(selectedDate);
  const items = logEntries.filter(e=>e.type==='workout'&&e.date===selectedDate);
  document.getElementById('planList').innerHTML = items.length
    ? items.map(workoutCard).join('')
    : `<div class="text-center py-7 rounded-2xl bg-card border border-dashed border-line">
         <p class="text-[12px] text-faint font-bold">まだ予定がありません</p>
         <p class="text-[11px] text-faint mt-1">「＋追記」で宣言できます</p>
       </div>`;
  if(typeof renderMeal==='function') renderMeal();
  if(typeof renderDayWeight==='function') renderDayWeight();
}
function renderMonth(){
  const {y,m}=calCursor;
  document.getElementById('monthLabel').textContent=`${y}年${m+1}月`;
  const first=(new Date(y,m,1).getDay()+6)%7;     // Monday-first lead blanks
  const days=new Date(y,m+1,0).getDate();
  let cells='';
  for(let i=0;i<first;i++) cells+='<div></div>';
  for(let d=1;d<=days;d++){
    const ds=ymd(y,m,d);
    const isToday=ds===TODAY, sel=ds===selectedDate;
    const dayTags=logEntries.filter(e=>e.type==='workout'&&e.date===ds).flatMap(e=>e.tags||[]);
    const dots=dayTags.slice(0,3).map(t=>`<span class="w-1.5 h-1.5 rounded-full" style="background:${tagDot[t]||'#9AA09A'}"></span>`).join('');
    const more=dayTags.length>3?`<span class="text-[8px] font-bold text-faint leading-none">+${dayTags.length-3}</span>`:'';
    const numCls = sel
      ? (isToday?'bg-accent text-white ring-2 ring-aline':'bg-accent text-white')
      : (isToday?'text-accent ring-1 ring-accent':'text-ink');
    cells+=`<button class="mcell pop flex flex-col items-center gap-1 py-1" data-date="${ds}">
      <span class="w-7 h-7 flex items-center justify-center rounded-full text-[12px] font-bold ${numCls}">${d}</span>
      <span class="flex items-center gap-0.5 h-2">${dots}${more}</span>
    </button>`;
  }
  document.getElementById('monthGrid').innerHTML=cells;
}
// inline popup under the grid (no navigation).
// 過去日 = その日の「記録(実績)」: 運動・体重・食事を拾って表示。当日/未来 = 「予定」。
function renderMonthDetail(){
  const el=document.getElementById('monthDetail'); if(!el) return;
  const {m,d}=parseYmd(selectedDate);
  const dateLabel=`${m+1}月${d}日(${WD[wdIndex(selectedDate)]})`;
  const workouts=logEntries.filter(e=>e.type==='workout'&&e.date===selectedDate);
  const isPast=selectedDate<TODAY;
  let head, body;
  if(isPast){
    // actuals as of that day: workout 実績 + 体重 + 食事
    head=`<p class="text-[12px] font-bold text-sub mb-2.5">${dateLabel} の記録</p>`;
    const weight=logEntries.find(e=>e.type==='weight'&&e.who===CURRENT_USER&&e.date===selectedDate);
    const meal=logEntries.find(e=>e.type==='meal'&&e.who===CURRENT_USER&&e.date===selectedDate);
    const rows=[];
    workouts.forEach(e=>{
      const mem=members[e.who]; const s=planStat[e.status]||planStat.done;
      const durTxt=e.dur?`<span class="text-[11px] font-bold text-sub shrink-0">${e.dur}</span>`:`<span class="flex items-center gap-1 text-[11px] font-bold ${s.cls} shrink-0"><span class="w-1.5 h-1.5 rounded-full" style="background:${s.dot}"></span>${s.check?'✓':''}${s.label}</span>`;
      rows.push(`<div class="entry-edit pop cursor-pointer flex items-center gap-2.5" data-id="${e.id}">
        ${avatar(mem,28)}
        <span class="text-[12px] font-bold text-ink w-12 shrink-0">${mem.name}</span>
        <div class="flex flex-wrap items-center gap-1.5">${(e.tags||[]).map(t=>chip(t)).join('')}</div>
        <span class="ml-auto">${durTxt}</span>
      </div>`);
    });
    if(weight) rows.push(`<div class="entry-edit pop cursor-pointer flex items-center gap-2.5" data-id="${weight.id}">
      <span class="text-[13px] shrink-0">⚖</span><span class="text-[12px] font-bold text-sub">体重</span>
      <span class="ml-auto text-[13px] font-extrabold text-ink">${weight.kg}<span class="text-[10px] text-faint font-bold ml-0.5">kg</span></span></div>`);
    if(meal) rows.push(`<div class="entry-edit pop cursor-pointer flex items-center gap-2.5" data-id="${meal.id}">
      <span class="text-[13px] shrink-0">🍽</span><span class="text-[12px] font-bold text-sub">摂取</span>
      <span class="ml-auto text-[13px] font-extrabold text-ink">${meal.kcal}<span class="text-[10px] text-faint font-bold ml-0.5">kcal</span>${meal.protein!=null?` <span class="text-[11px] text-faint font-bold">P${meal.protein}g</span>`:''}</span></div>`);
    body = rows.length ? `<div class="space-y-2.5">${rows.join('')}</div>` : `<p class="text-[11px] text-faint">この日の記録はありません</p>`;
  }else{
    // today / future = plan ("誰が何をする")
    head=`<p class="text-[12px] font-bold text-sub mb-2.5">${dateLabel}・誰が何をする</p>`;
    body = workouts.length
      ? `<div class="space-y-2.5">`+workouts.map(e=>{
          const mem=members[e.who]; const s=planStat[e.status]||planStat.planned;
          return `<div class="entry-edit pop cursor-pointer flex items-center gap-2.5" data-id="${e.id}">
            ${avatar(mem,28)}
            <span class="text-[12px] font-bold text-ink w-12 shrink-0">${mem.name}</span>
            <div class="flex flex-wrap items-center gap-1.5">${(e.tags||[]).map(t=>chip(t)).join('')}</div>
            <span class="ml-auto flex items-center gap-1 text-[11px] font-bold ${s.cls} shrink-0"><span class="w-1.5 h-1.5 rounded-full" style="background:${s.dot}"></span>${s.check?'✓':''}${s.label}</span>
          </div>`;
        }).join('')+`</div>`
      : `<p class="text-[11px] text-faint">この日の予定はまだありません</p>`;
  }
  el.innerHTML=`<div class="rounded-2xl bg-card border border-line shadow-card p-3.5">${head}${body}</div>`;
  el.classList.remove('hidden');
}

/* ---------- bottom sheet (declare / log) ---------- */
const SHEET_TAGS=['胸トレ','背中','脚','肩・腕','有酸素','ストレッチ','休養'];
let sfType='workout', sfTags=['背中'], sfEditId=null;
function sheetTitle(){
  const ed=sfEditId!=null;
  if(sfType==='workout') return ed?'運動を編集':'予定を宣言';
  if(sfType==='weight')  return ed?'体重を編集':'体重を記録';
  return ed?'食事を編集':'食事を記録';
}
function setSheetType(t){
  sfType=t;
  document.querySelectorAll('.sf-type').forEach(b=>{
    const on=b.dataset.sftype===t; b.classList.toggle('active',on); b.classList.toggle('text-sub',!on);
  });
  document.getElementById('sfWorkout').classList.toggle('hidden',t!=='workout');
  document.getElementById('sfWeight').classList.toggle('hidden',t!=='weight');
  document.getElementById('sfMeal').classList.toggle('hidden',t!=='meal');
  document.getElementById('sheetTitle').textContent=sheetTitle();
}
function renderSheetTags(){
  document.getElementById('sfTags').innerHTML=SHEET_TAGS.map(t=>
    `<button class="sf-tag pop text-[11px] font-bold px-3 py-1.5 rounded-full border ${sfTags.includes(t)?'sel':'border-line text-ink bg-card'}" data-tag="${t}"><span class="inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle" style="background:${tagDot[t]||'#9AA09A'}"></span>${t}</button>`
  ).join('');
}
function showSheet(){
  document.getElementById('sheetScrim').classList.remove('hidden');
  document.getElementById('sheet').classList.add('open');
}
function openSheet(type){
  sfEditId=null; sfTags=['背中'];
  ['sfTime','sfKg','sfKcal','sfProtein','sfFat','sfCarbs'].forEach(id=>{const el=document.getElementById(id); if(el) el.value='';});
  document.getElementById('sfTypeToggle').classList.remove('hidden');
  document.getElementById('sheetDelete').classList.add('hidden');
  setSheetType(type||'workout');
  document.getElementById('sfDate').value=selectedDate;
  renderSheetTags();
  showSheet();
}
function openSheetEdit(id){
  const en=logEntries.find(x=>x.id===id); if(!en) return;
  sfEditId=id;
  document.getElementById('sfTypeToggle').classList.add('hidden');   // lock type while editing
  document.getElementById('sheetDelete').classList.remove('hidden');
  setSheetType(en.type);
  document.getElementById('sfDate').value=en.date;
  if(en.type==='workout'){ sfTags=(en.tags||[]).slice(); renderSheetTags(); document.getElementById('sfTime').value=(en.time&&en.time!=='—')?en.time:''; }
  else if(en.type==='weight'){ document.getElementById('sfKg').value=en.kg; }
  else { document.getElementById('sfKcal').value=en.kcal; document.getElementById('sfProtein').value=en.protein??''; document.getElementById('sfFat').value=en.fat??''; document.getElementById('sfCarbs').value=en.carbs??''; }
  showSheet();
}
function closeSheet(){
  document.getElementById('sheet').classList.remove('open');
  document.getElementById('sheetScrim').classList.add('hidden');
  sfEditId=null;
}
function rerenderAfterChange(){
  renderWeek(); if(schedView==='month'){ renderMonth(); renderMonthDetail(); } renderDayList();
  if(typeof renderStats==='function') renderStats();
  if(chartsReady) updateWeight(chartMode);
}
function confirmSheet(){
  const date=document.getElementById('sfDate').value||selectedDate;
  const editing=sfEditId!=null;
  const target=editing?logEntries.find(e=>e.id===sfEditId):null;
  if(sfType==='workout'){
    if(!sfTags.length){ closeSheet(); return; }
    const status=editing&&target?target.status:(date<TODAY?'done':'planned');
    const fields={date, tags:sfTags.slice(), time:document.getElementById('sfTime').value||'—', status};
    if(editing&&target) Object.assign(target,fields);
    else logEntries.push({id:newId(), type:'workout', who:CURRENT_USER, ...fields});
  }else if(sfType==='weight'){
    const kg=parseFloat(document.getElementById('sfKg').value);
    if(!isNaN(kg)){
      if(editing&&target) Object.assign(target,{date,kg});
      else{
        const ex=logEntries.find(e=>e.type==='weight'&&e.who===CURRENT_USER&&e.date===date);
        if(ex) ex.kg=kg; else logEntries.push({id:newId(),date,type:'weight',who:CURRENT_USER,kg});
      }
    }
  }else{ // meal
    const kcal=parseInt(document.getElementById('sfKcal').value);
    if(!isNaN(kcal)){
      const num=id=>{const v=parseFloat(document.getElementById(id).value); return isNaN(v)?null:v;};
      const fields={date,kcal,protein:num('sfProtein'),fat:num('sfFat'),carbs:num('sfCarbs')};
      if(editing&&target) Object.assign(target,fields);
      else{
        const ex=logEntries.find(e=>e.type==='meal'&&e.who===CURRENT_USER&&e.date===date);
        if(ex) Object.assign(ex,fields); else logEntries.push({id:newId(),type:'meal',who:CURRENT_USER,...fields});
      }
    }
  }
  selectedDate=date;
  closeSheet();
  rerenderAfterChange();
}
function deleteEntry(){
  if(sfEditId==null) return;
  const i=logEntries.findIndex(e=>e.id===sfEditId);
  if(i>=0) logEntries.splice(i,1);
  closeSheet();
  rerenderAfterChange();
}

/* ---------- SCHEDULE: 本日の食事 / limits (type-tagged items) ---------- */
// meal input lives in 予定; intake feeds the 記録 calorie-balance graph (週). 食品DB検索なし
function renderMeal(){
  const el=document.getElementById('mealSummary'); if(!el) return;
  const {m,d}=parseYmd(selectedDate);
  const lbl=document.getElementById('mealLabel');
  if(lbl) lbl.textContent = selectedDate===TODAY ? '本日の食事' : `${m+1}月${d}日の食事`;
  const meal=logEntries.find(e=>e.type==='meal'&&e.who===CURRENT_USER&&e.date===selectedDate);
  if(!meal){
    el.innerHTML=`<button class="meal-add pop w-full flex items-center justify-center gap-1.5 text-[12px] font-bold text-accent bg-card border border-dashed border-aline rounded-2xl py-3">＋ 食事を入力（摂取kcal・タンパク質 など）</button>`;
    return;
  }
  const cell=(label,val,unit)=>{ const has=val!=null&&val!==''; return `<div class="text-center px-1"><p class="text-[10px] text-faint font-bold mb-1">${label}</p><p class="text-[14px] font-extrabold ${has?'text-ink':'text-faint'} leading-none">${has?val:'—'}${has?`<span class="text-[9px] text-faint font-bold">${unit}</span>`:''}</p></div>`; };
  el.innerHTML=`<button class="entry-edit pop w-full text-left" data-id="${meal.id}"><div class="grid grid-cols-4 divide-x divide-line">
    ${cell('摂取',meal.kcal,'kcal')}${cell('P',meal.protein,'g')}${cell('F',meal.fat,'g')}${cell('C',meal.carbs,'g')}
  </div></button>`;
}
// compact tappable 本日の体重 handle in 予定 (edit/add). Weight lives on 記録; this is just the edit handle.
function renderDayWeight(){
  const el=document.getElementById('dayWeightRow'); if(!el) return;
  const {m,d}=parseYmd(selectedDate);
  const lbl = selectedDate===TODAY ? '本日の体重' : `${m+1}月${d}日の体重`;
  const w=logEntries.find(e=>e.type==='weight'&&e.who===CURRENT_USER&&e.date===selectedDate);
  el.innerHTML = w
    ? `<button class="entry-edit pop w-full flex items-center justify-between rounded-2xl bg-card border border-line shadow-card px-4 py-2.5" data-id="${w.id}">
         <span class="text-[12px] font-bold text-sub">⚖ ${lbl}</span>
         <span class="text-[13px] font-extrabold text-ink">${w.kg}<span class="text-[10px] text-faint font-bold ml-0.5">kg</span> <span class="text-faint text-[11px] ml-0.5">✎</span></span>
       </button>`
    : `<button class="weight-add pop w-full flex items-center justify-center gap-1.5 text-[12px] font-bold text-accent bg-card border border-dashed border-aline rounded-2xl py-2.5">⚖ ＋ ${lbl}を記録</button>`;
}

// self-rules: each picks 公開(みんなが見れる) or 自分だけ(非公開). No 4-step scope, no warnings. Max 3.
// Flat initial state: no rules yet. User adds up to 3 via 「＋ルール追加」.
const limits = [];
function renderLimits(){
  const list=document.getElementById('limitList');
  if(!list) return;
  list.innerHTML = limits.length ? limits.map((l,i)=>{
    const count = l.total ? `<span class="text-[10px] font-bold text-faint ml-2">今週 ${l.done}/${l.total}</span>` : '';
    return `<div class="limit flex items-center gap-2 rounded-2xl border bg-card border-line px-3 py-2.5" data-i="${i}">
      <span class="text-[15px] shrink-0">${l.emoji}</span>
      <div class="flex-1 min-w-0"><p class="text-[13px] font-bold text-ink truncate">${l.label}${count}</p></div>
      <button class="rule-pub pop flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-full border shrink-0 ${l.pub?'bg-asoft border-aline text-accent':'bg-card border-line text-faint'}">${l.pub?'🌐 公開':'🔒 自分だけ'}</button>
      <button class="rule-done pop text-[11px] font-extrabold text-white bg-accent px-2.5 py-1.5 rounded-full shrink-0">達成</button>
      <button class="rule-del pop text-faint text-[13px] leading-none shrink-0 pl-0.5">✕</button>
    </div>`;
  }).join('') : `<p class="text-[12px] text-faint text-center py-3">まだ自分ルールはありません。「＋ルール追加」でそっと決められます</p>`;
  const addBtn=document.getElementById('ruleAddBtn');
  if(addBtn) addBtn.classList.toggle('hidden', limits.length>=3);
}
// no-shame: 達成した時だけ祝う(公開ならタイムラインへ)。未達は何も晒さない・通知しない・×を残さない。
function recordRuleAchieve(i){
  const l=limits[i]; if(!l) return;
  if(l.total) l.done=Math.min((l.done||0)+1, l.total);
  streak++;
  renderStreak(); renderLimits();
  if(typeof renderProgressHero==='function') renderProgressHero();
  if(l.pub){
    addPost(createPost({kind:'achieve', who:CURRENT_USER, ruleLabel:l.label, text:`自分ルール「${l.label}」を達成。続いてる自分をほめる`, scope:'all'}));
    showPage('feed');
  }
}

/* ---------- self-rule add + resist record (record-only; timeline post = batch2) ---------- */
let resistWeek=0;
let streak=0;   // 🔥有言実行の連続。自分ルール達成/継続で育つ（F項目はここに吸収）
function renderStreak(){ const el=document.getElementById('streakCount'); if(el) el.textContent=streak; }
function recordResist(){
  resistWeek++;
  const el=document.getElementById('resistCount');
  if(el) el.textContent=`今週 ${resistWeek}回 踏みとどまった`;
}
function openRule(){
  document.getElementById('rfLabel').value='';
  document.getElementById('rfTotal').value='';
  document.getElementById('ruleScrim').classList.remove('hidden');
  document.getElementById('ruleSheet').classList.add('open');
}
function closeRule(){
  document.getElementById('ruleSheet').classList.remove('open');
  document.getElementById('ruleScrim').classList.add('hidden');
}
function saveRule(){
  const label=(document.getElementById('rfLabel').value||'').trim();
  if(!label){ closeRule(); return; }
  if(limits.length>=3){ closeRule(); return; }   // 最大3つ（静かに止めるだけ・警告は出さない）
  const total=parseInt(document.getElementById('rfTotal').value)||0;
  limits.push({type:'limit', emoji:'🎯', label, done:0, total, pub:true});
  closeRule(); renderLimits();
}

/* ---------- PROGRESS group ---------- */
// Flat initial state: no friends yet (sharing = backend phase I/I2).
const groupWeek = [];
function renderGroup(){
  const row=document.getElementById('groupRow');
  if(!groupWeek.length){
    row.innerHTML=`<p class="text-[12px] text-faint text-center py-2">仲間はまだいません。今後、友達を追加できるようになります</p>`;
    return;
  }
  row.innerHTML = groupWeek.map(g=>{
    const m=members[g.who]; const pct=Math.round(g.d/7*100);
    return `<div class="flex items-center gap-3">
      ${avatar(m,26)}
      <span class="text-[12px] font-bold text-ink w-11">${m.name}</span>
      <div class="flex-1 h-1.5 rounded-full bg-[#F0EFEB] overflow-hidden"><div class="h-full rounded-full" style="width:${pct}%;background:${m.c}"></div></div>
      <span class="text-[12px] font-extrabold text-sub w-8 text-right">${g.d}日</span>
    </div>`;
  }).join('');
}

/* ---------- charts ---------- */
let charts={}; let chartsReady=false; let chartMode='week';
const chartLabels={ week:['月','火','水','木','金','土','日'], month:['7週前','6','5','4','3','2','先週','今週'] };
// All series derive from logEntries (flat初期状態=空). No mock history; month has no history yet → null.
function weekWeightSeries(){
  return week.map(w=>{ const e=logEntries.find(x=>x.type==='weight'&&x.who===CURRENT_USER&&x.date===w.date); return e?e.kg:null; });
}
function weightSeries(mode){ return mode==='week'?weekWeightSeries():new Array(8).fill(null); }
// week calorie balance = intake − maintenance where a meal was logged; null where none.
function weekBalSeries(){
  const maint=maintenanceValue();
  return week.map(w=>{ const meal=logEntries.find(e=>e.type==='meal'&&e.who===CURRENT_USER&&e.date===w.date); return meal?Math.round(meal.kcal-maint):null; });
}
function balSeries(mode){ return mode==='week'?weekBalSeries():new Array(8).fill(null); }
function weekWorkoutDays(){ return new Set(logEntries.filter(e=>e.type==='workout'&&e.who===CURRENT_USER&&week.some(w=>w.date===e.date)).map(e=>e.date)).size; }
function daysSeries(){ return [0,0,0,0,0,0,0, weekWorkoutDays()]; }   // only current week known after reset
function seriesDelta(arr){ const v=arr.filter(x=>x!=null); if(v.length<2) return ''; const diff=+(v[v.length-1]-v[0]).toFixed(1); return (diff<=0?'▼':'▲')+Math.abs(diff)+'kg'; }
function initCharts(){
  if(chartsReady) return; chartsReady=true;
  Chart.defaults.font.family="'Plus Jakarta Sans','Noto Sans JP'";
  Chart.defaults.color='#A2A69F';

  // top panel: weight line (x ticks hidden — shared with balance panel below)
  charts.weight = new Chart(document.getElementById('weightChart'), {
    type:'line',
    data:{ labels:chartLabels.week, datasets:[{ data:[], spanGaps:true,
      borderColor:'#14B87C', borderWidth:2.5, tension:.4,
      pointBackgroundColor:'#14B87C', pointRadius:3, pointHoverRadius:5, fill:true,
      backgroundColor:(c)=>{const g=c.chart.ctx.createLinearGradient(0,0,0,120);g.addColorStop(0,'rgba(20,184,124,.12)');g.addColorStop(1,'rgba(20,184,124,0)');return g;} }]},
    options:{ plugins:{legend:{display:false},tooltip:{enabled:false}}, scales:{
      y:{grid:{color:'#F2F1ED'},border:{display:false},ticks:{stepSize:0.5,font:{size:10}},afterFit:(s)=>{s.width=36;}},
      x:{grid:{display:false},border:{display:false},ticks:{display:false}} }, maintainAspectRatio:false }
  });

  // bottom panel: calorie balance bars (deficit=teal, surplus=neutral grey — no shame)
  charts.balance = new Chart(document.getElementById('balanceChart'), {
    type:'bar',
    data:{ labels:chartLabels.week, datasets:[{ data:[],
      backgroundColor:(c)=> (c.raw<=0 ? '#14B87C' : '#C9CEC6'),
      borderRadius:4, barThickness:14 }]},
    options:{ plugins:{legend:{display:false},tooltip:{enabled:false}}, scales:{
      y:{ min:-600, max:600,
          // fixed gridlines at -500/-250/0/250/500 (no auto-scaling); deficit side labeled, surplus hidden
          afterBuildTicks:(s)=>{ s.ticks=[-500,-250,0,250,500].map(value=>({value})); },
          grid:{ color:(ctx)=> ctx.tick.value>0 ? 'rgba(0,0,0,0)' : (ctx.tick.value===0 ? '#CDCFC9' : '#EDECE8') }, border:{display:false},
          ticks:{ font:{size:9}, color:'#A2A69F', callback:(v)=> v<0 ? String(-v) : '' },
          afterFit:(s)=>{s.width=36;} },
      x:{grid:{display:false},border:{display:false},ticks:{font:{size:11}}} }, maintainAspectRatio:false }
  });

  charts.days = new Chart(document.getElementById('daysChart'), {
    type:'bar',
    data:{ labels:chartLabels.month,
      datasets:[{ data:[],
        backgroundColor:(c)=> c.dataIndex===c.dataset.data.length-1 ? '#14B87C' : '#DDE3DF',
        borderRadius:6, barThickness:15 }]},
    options:{ plugins:{legend:{display:false}}, scales:{
      y:{grid:{color:'#F2F1ED'},border:{display:false},ticks:{stepSize:1,font:{size:10}},suggestedMax:7},
      x:{grid:{display:false},border:{display:false},ticks:{font:{size:11}}} }, maintainAspectRatio:false }
  });
  updateWeight(chartMode);
}
// refresh charts + their no-shame empty states from current data
function updateWeight(mode){
  if(!charts.weight) return;
  const wser=weightSeries(mode), bser=balSeries(mode);
  const hasWB = wser.some(x=>x!=null) || bser.some(x=>x!=null);
  document.getElementById('weightBody').classList.toggle('hidden', !hasWB);
  document.getElementById('weightEmpty').classList.toggle('hidden', hasWB);
  if(hasWB){
    charts.weight.data.labels=chartLabels[mode];   charts.weight.data.datasets[0].data=wser;   charts.weight.update();
    charts.balance.data.labels=chartLabels[mode];  charts.balance.data.datasets[0].data=bser;  charts.balance.update();
  }
  document.getElementById('weightDelta').textContent = seriesDelta(wser)||'—';

  const hasWorkout=logEntries.some(e=>e.type==='workout'&&e.who===CURRENT_USER);
  document.getElementById('daysBody').classList.toggle('hidden', !hasWorkout);
  document.getElementById('daysEmpty').classList.toggle('hidden', hasWorkout);
  if(hasWorkout){ charts.days.data.datasets[0].data=daysSeries(); charts.days.update(); }

  renderProgressHero();
}
// 記録ヒーローの数値を logEntries から算出（空ならゼロ/—で自然に）
function durToMin(s){
  if(!s) return 0; let m=0;
  const h=s.match(/(\d+)\s*時間/), mi=s.match(/(\d+)\s*分/);
  if(h) m+=parseInt(h[1])*60;
  if(mi) m+=parseInt(mi[1]);
  if(!h&&!mi){ const n=parseInt(s); if(!isNaN(n)) m+=n; }
  return m;
}
function fmtMinHtml(m){
  if(!m) return '—';
  const h=Math.floor(m/60), mm=m%60;
  return (h?`${h}<span class="text-[10px] text-faint font-bold">時間</span>`:'')+((mm||!h)?`${mm}<span class="text-[10px] text-faint font-bold">分</span>`:'');
}
function renderProgressHero(){
  const wk=logEntries.filter(e=>e.type==='workout'&&e.who===CURRENT_USER&&week.some(w=>w.date===e.date));
  const set=(id,v)=>{const el=document.getElementById(id); if(el) el.textContent=v;};
  set('statDays', new Set(wk.map(e=>e.date)).size);
  set('heroStreak', streak);
  const total=wk.length, done=wk.filter(e=>e.status==='done').length;
  const pct = total ? Math.round(done/total*100) : 0;
  const ring=document.getElementById('heroRing'); if(ring) ring.setAttribute('stroke-dashoffset', (94.2*(1-pct/100)).toFixed(1));
  set('heroPct', pct); set('heroCount', `${done}/${total}回`);
  const weights=logEntries.filter(e=>e.type==='weight'&&e.who===CURRENT_USER).slice().sort((a,b)=> a.date<b.date?-1:1);
  set('heroWeight', weights.length?weights[weights.length-1].kg:'—');
  set('heroWeightDelta', weights.length?seriesDelta(weights.map(w=>w.kg)):'');
  const ht=document.getElementById('heroTime'); if(ht) ht.innerHTML=fmtMinHtml(wk.reduce((s,e)=>s+durToMin(e.dur),0));
  const bser=weekBalSeries().filter(x=>x!=null);
  if(bser.length){ const sum=bser.reduce((a,b)=>a+b,0); set('heroMaint', (sum<=0?'-':'+')+Math.abs(sum/1000).toFixed(1)+'k'); }
  else set('heroMaint','—');
}

/* ---------- profile + maintenance (Katch-McArdle, mock — no auth/persistence) ---------- */
const profile = { nick:'ぼーい', height:175, weight:71.0, bodyfat:18, activity:1.45, maintenanceOverride:null };
// LBM=体重×(1-体脂肪/100), BMR=370+21.6×LBM, メンテ=BMR×活動係数。これは「初期の目安」
// （式は個人で±200〜400kcalずれ得る）。将来は体重×カロリー実データで補正(学習)する構造を見据える（今回は未実装、初期値＋手動補正のみ）。
function computeMaintenance(p){
  const lbm = p.weight * (1 - p.bodyfat/100);
  const bmr = 370 + 21.6 * lbm;
  return Math.round(bmr * p.activity);
}
function maintenanceValue(){ return profile.maintenanceOverride!=null ? profile.maintenanceOverride : computeMaintenance(profile); }
function renderMaintCaption(){
  const el=document.getElementById('maintCaption'); if(!el) return;
  const note=profile.maintenanceOverride!=null ? '手動補正' : '初期の目安';
  el.textContent=`0ライン＝メンテ ${maintenanceValue().toLocaleString()}kcal（${note}）`;
}
function readProfileForm(){
  const ov=parseFloat(document.getElementById('pfOverride').value);
  return {
    nick:(document.getElementById('pfNick').value||'').trim()||profile.nick,
    height:parseFloat(document.getElementById('pfHeight').value)||profile.height,
    weight:parseFloat(document.getElementById('pfWeight').value)||profile.weight,
    bodyfat:parseFloat(document.getElementById('pfFat').value)||profile.bodyfat,
    activity:parseFloat(document.getElementById('pfAct').value)||profile.activity,
    maintenanceOverride: isNaN(ov)?null:ov,
  };
}
function updateProfilePreview(){
  const f=readProfileForm();
  const v=f.maintenanceOverride!=null ? f.maintenanceOverride : computeMaintenance(f);
  document.getElementById('pfMaint').textContent=Math.round(v).toLocaleString();
}
function openProfile(){
  document.getElementById('pfNick').value=profile.nick;
  document.getElementById('pfHeight').value=profile.height;
  document.getElementById('pfWeight').value=profile.weight;
  document.getElementById('pfFat').value=profile.bodyfat;
  document.getElementById('pfAct').value=profile.activity;
  document.getElementById('pfOverride').value=profile.maintenanceOverride??'';
  updateProfilePreview();
  document.getElementById('profileScrim').classList.remove('hidden');
  document.getElementById('profileSheet').classList.add('open');
}
function closeProfile(){
  document.getElementById('profileSheet').classList.remove('open');
  document.getElementById('profileScrim').classList.add('hidden');
}
// nick is the single source of truth for display name + avatar initial (header + 記録 hero).
function renderIdentity(){
  const m = members[CURRENT_USER]; if(!m) return;
  const btn = document.getElementById('profileBtn'); if(btn) btn.textContent = m.ini;
  const ha  = document.getElementById('heroAvatar'); if(ha) ha.textContent = m.ini;
  const hn  = document.getElementById('heroName');   if(hn) hn.textContent = `${m.name}の今週`;
}
function saveProfile(){
  Object.assign(profile, readProfileForm());
  closeProfile();
  renderMaintCaption();
  // reflect nick into identity + persist to cloud (fire-and-forget; log on failure)
  const m = members[CURRENT_USER];
  if(m){ m.name = profile.nick; m.ini = firstCP(profile.nick); }
  renderIdentity();
  saveProfileRow(CURRENT_USER, profile, maintenanceValue())
    .catch(err => console.error('profile save failed:', err.message || err));
}

/* ---------- nav + interactions ---------- */
function showPage(id){
  document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active',p.id===id));
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.toggle('active',b.dataset.page===id));
  document.querySelector('main').scrollTop=0;
  document.getElementById('startBar').classList.toggle('hidden', id!=='schedule');
  if(id==='progress') setTimeout(initCharts,60);
}
document.querySelectorAll('.nav-btn').forEach(b=> b.addEventListener('click',()=>showPage(b.dataset.page)));

document.addEventListener('click',e=>{
  const r=e.target.closest('.react');
  if(r){
    const cnt=r.querySelector('.cnt');
    if(!r.classList.contains('reacted')){ r.classList.add('reacted'); cnt.textContent=(+cnt.textContent)+1; }
    else{ r.classList.remove('reacted'); cnt.textContent=(+cnt.textContent)-1; }
  }
  const seg=e.target.closest('.seg-btn');
  if(seg){
    document.querySelectorAll('.seg-btn').forEach(s=>{s.classList.remove('active');s.classList.add('text-sub');});
    seg.classList.add('active'); seg.classList.remove('text-sub');
    chartMode=seg.dataset.seg;
    updateWeight(seg.dataset.seg);
  }
  const rdel=e.target.closest('.rule-del');
  if(rdel){ const li=rdel.closest('.limit'); if(li){ limits.splice(+li.dataset.i,1); renderLimits(); } }
  const rpub=e.target.closest('.rule-pub');
  if(rpub){ const li=rpub.closest('.limit'); if(li){ limits[+li.dataset.i].pub=!limits[+li.dataset.i].pub; renderLimits(); } }
  const rdone=e.target.closest('.rule-done');
  if(rdone){ const li=rdone.closest('.limit'); if(li) recordRuleAchieve(+li.dataset.i); }
  if(e.target.closest('.meal-add')) openSheet('meal');
  const eedit=e.target.closest('.entry-edit'); if(eedit) openSheetEdit(eedit.dataset.id);
  if(e.target.closest('#sheetDelete')) deleteEntry();
  if(e.target.closest('.rule-add')) openRule();
  if(e.target.closest('#ruleSave')) saveRule();
  if(e.target.closest('#ruleCancel')||e.target.closest('#ruleScrim')) closeRule();
  if(e.target.closest('.resist-add')){
    recordResist();
    const rule = limits[0] ? limits[0].label : null;
    addPost(createPost({kind:'resist', who:CURRENT_USER, ruleLabel:rule, text:'今日は誘惑に勝った。踏みとどまった自分をほめる', scope:'group'}));
    showPage('feed');
  }
  if(e.target.closest('.start-workout')) onStartWorkout();
  if(e.target.closest('.stop-workout')) onStopWorkout();
  const sct=e.target.closest('.start-tag');
  if(sct){ const t=sct.dataset.tag; const i=startTags.indexOf(t); if(i>=0) startTags.splice(i,1); else startTags.push(t); renderStartTags(); }
  if(e.target.closest('#startGo')) onStartGo();
  if(e.target.closest('#startCancel')||e.target.closest('#startScrim')) closeStartSheet();
  if(e.target.closest('#postSubmit')) submitPost();
  if(e.target.closest('#postCancel')||e.target.closest('#postScrim')) closePostSheet();
  const day=e.target.closest('.day-pill');
  if(day){ selectedDate=day.dataset.date; renderWeek(); renderDayList(); }

  const vseg=e.target.closest('.vseg');
  if(vseg){
    schedView=vseg.dataset.vview;
    document.querySelectorAll('.vseg').forEach(b=>{const on=b.dataset.vview===schedView;b.classList.toggle('active',on);b.classList.toggle('text-sub',!on);});
    document.getElementById('weekStrip').classList.toggle('hidden',schedView!=='week');
    document.getElementById('monthCal').classList.toggle('hidden',schedView!=='month');
    if(schedView==='month'){ renderMonth(); renderMonthDetail(); }
  }
  const mnav=e.target.closest('[data-mnav]');
  if(mnav){
    calCursor.m+=(mnav.dataset.mnav==='next'?1:-1);
    if(calCursor.m<0){calCursor.m=11;calCursor.y--;}
    if(calCursor.m>11){calCursor.m=0;calCursor.y++;}
    renderMonth();
  }
  const mcell=e.target.closest('.mcell');
  if(mcell){ selectedDate=mcell.dataset.date; renderMonth(); renderMonthDetail(); renderDayList(); }

  if(e.target.closest('.declare-btn')||e.target.closest('.day-add')) openSheet('workout');
  if(e.target.closest('.weight-add')) openSheet('weight');
  const sft=e.target.closest('.sf-type'); if(sft) setSheetType(sft.dataset.sftype);
  const stag=e.target.closest('.sf-tag');
  if(stag){ const t=stag.dataset.tag; const i=sfTags.indexOf(t); if(i>=0) sfTags.splice(i,1); else sfTags.push(t); renderSheetTags(); }
  if(e.target.closest('#sheetConfirm')) confirmSheet();
  if(e.target.closest('#sheetCancel')||e.target.closest('#sheetScrim')) closeSheet();

  if(e.target.closest('#profileBtn')) openProfile();
  if(e.target.closest('#profileSave')) saveProfile();
  if(e.target.closest('#profileCancel')||e.target.closest('#profileScrim')) closeProfile();
});
// live maintenance preview while editing the profile sheet
document.addEventListener('input', e=>{ if(e.target.closest('#profileSheet')) updateProfilePreview(); });
document.addEventListener('change', e=>{ if(e.target.id==='psPhoto') handlePhoto(e.target.files && e.target.files[0]); });

/* ---------- init (runs once, after login) ---------- */
let appStarted=false;
async function initApp(session){
  if(appStarted) return; appStarted=true;
  try{
    // users row + personal space, then load cloud data into the in-memory stores.
    const { userId, spaceId, urow } = await bootstrap(session);
    CURRENT_USER=userId; SPACE_ID=spaceId;
    Object.assign(profile, profileFromRow(urow));
    members = { [CURRENT_USER]: { name:profile.nick, ini:firstCP(profile.nick), c:'#14B87C' } };
    const data = await loadAll(spaceId);
    logEntries.push(...data.entries);
    posts.push(...data.posts);
    limits.push(...data.rules);
  }catch(err){
    console.error('bootstrap/load failed:', err.message || err);
  }
  renderFeedAvatars(); renderFeed(); renderWeek(); renderDayList(); renderGroup();
  renderMeal(); renderLimits(); renderMonth(); renderMaintCaption(); renderStartBar(); renderStats(); renderStreak();
  renderIdentity();
  showPage('schedule');   // app opens on 予定 (also reveals the 運動開始 bar)
}

/* ---------- auth gate (Phase 2): Google login wraps the app, no data yet ---------- */
function showApp(session){
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  initApp(session);
}
function showLogin(){
  document.getElementById('app').classList.add('hidden');
  document.getElementById('loginScreen').classList.remove('hidden');
}
// resolve current session on load, then react to every login/logout
supabase.auth.getSession().then(({data})=>{ data.session ? showApp(data.session) : showLogin(); });
supabase.auth.onAuthStateChange((_event, session)=>{ session ? showApp(session) : showLogin(); });

document.getElementById('googleLogin').addEventListener('click', async ()=>{
  // redirectTo = current origin → works on both localhost and the Vercel URL
  const { error } = await supabase.auth.signInWithOAuth({
    provider:'google',
    options:{ redirectTo: window.location.origin },
  });
  if(error) console.error('Google login failed:', error.message);
});
document.getElementById('logoutBtn').addEventListener('click', async ()=>{
  closeProfile();
  await supabase.auth.signOut();   // onAuthStateChange → showLogin()
});
