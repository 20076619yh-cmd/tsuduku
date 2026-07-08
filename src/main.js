// fit tree — app entry. Logic unchanged from the prototype; Phase 2 adds a login gate.
import './style.css';
import Chart from 'chart.js/auto';   // auto = same all-controllers registration as the old UMD CDN
import { supabase } from './supabase.js';
import { bootstrap, loadAll, profileFromRow, saveProfileRow, upsertEntry, removeEntry, upsertPost, upsertRule, removeRule, setSaveErrorHandler, markTourDone, loadPublicProfiles, loadPublicRules, createInvite, joinWithCode } from './db.js';

/* ---------- members ---------- */
// Flat initial state: just me. Friends arrive in the backend/sharing phase (I/I2).
// Re-keyed to the logged-in user's id in bootstrap (see initApp) so members[CURRENT_USER] resolves.
let members = {
  boy:   { name:'ぼーい', ini:'ボ', c:'#14B87C' },
};
// First code point (not str[0]) so emoji / surrogate-pair nicknames don't get half-cut.
function firstCP(s){ return (Array.from((s || '').trim())[0]) || '?'; }
// 保存失敗の軽いトースト(自動で消える・ノーシェイム)。db.jsの保存系失敗時に共通発火。
let toastTimer=null;
function showToast(msg){
  const el=document.getElementById('toast'); if(!el) return;
  const inner=el.firstElementChild; if(inner) inner.textContent=msg;
  el.classList.remove('hidden');
  if(toastTimer) clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>el.classList.add('hidden'), 3500);
}
setSaveErrorHandler(()=>showToast('保存に失敗しました。通信を確認してください'));
// アバターが絵文字頭文字のとき、名前表示から先頭の絵文字を落として二重表示を防ぐ(アバター=頭文字/名前=残り)。
function isEmoji(ch){ return /\p{Extended_Pictographic}/u.test(ch || ''); }
function heroDisplayName(nick){
  const cp = Array.from((nick || '').trim());
  if(cp.length && isEmoji(cp[0])){ const rest = cp.slice(1).join('').trim(); return rest || nick; }
  return nick;
}
// 部位色: 肩腕を「肩(amber)」「腕(bronze)」に分割。近い暖色だが区別可。既存パレットと調和。
// 未登録タグ(＋その他の自由テキスト)は tagDot[t]||'#9AA09A' でニュートラル灰に自動フォールバック。
const tagDot = {
  '胸トレ':'#FF6A3D','背中':'#3E86C9','脚':'#7C6CD0',
  '肩':'#E0A53A','腕':'#B5836A','有酸素':'#14B87C','ストレッチ':'#5FB6A8','休養':'#9AA09A'
};
function avatar(m,size=40,who=''){
  const du = who ? ` data-user="${who}"` : '';   // タップ相手を特定するため
  if(m.photo) return `<div${du} style="width:${size}px;height:${size}px;background-image:url('${m.photo}');background-size:cover;background-position:center" class="avatar-btn cursor-pointer rounded-full shrink-0"></div>`;
  return `<div${du} style="width:${size}px;height:${size}px;background:${m.c}" class="avatar-btn cursor-pointer rounded-full flex items-center justify-center text-white font-bold shrink-0"><span style="font-size:${Math.round(size*0.4)}px">${m.ini}</span></div>`;
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
// Flat initial state: no sample posts. Posts are created via createPost (timer-stop / rule-kept).
const posts = [];
// single source of truth for creating timeline posts. id=crypto.randomUUID (same id in DB).
function createPost({kind='workout', who=CURRENT_USER, tags=[], dur=null, durSec=null, photo=null, text='', ruleLabel=null, scope='group'}){
  // 投稿時点の公開ルール(最大3・名前＋日数)を焼き込む=以後不変(日記・盛れない構造)
  const rulesSnapshot = limits.filter(l=>l.pub && l.streakStart).slice(0,3).map(l=>({label:l.label, day:ruleStreak(l)}));
  return { id:crypto.randomUUID(), kind, who, scope, createdAt:new Date().toISOString(), tags:(tags||[]).slice(), dur, durSec, photo, text, ruleLabel, rulesSnapshot, r:{fire:0,muscle:0,clap:0} };
}
// single funnel: local prepend + render, then persist in background (失敗はconsole.error)
function addPost(p){ posts.unshift(p); renderFeed(); upsertPost(p); }

/* ---------- workout timer (E2) + post flow (E) ---------- */
let timerRunning=false, timerSec=0, timerInterval=null, timerTags=[];
let timerFromPlan=false;    // true=今日の予定から開始（既存エントリを更新）／false=予定なし開始（新規追加）
let activeEntryIds=[];      // タイマー作動中に「実施中」表示する予定エントリのid(UI専用・非永続)
let startTags=[];           // category-select (no-plan start)
let pendingPhoto=null, postCtx=null, postTags=[];
const START_CATS=['胸トレ','背中','脚','肩','腕','有酸素','ストレッチ'];
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
  if(tags.length){ timerFromPlan=true; activeEntryIds=todays.map(e=>e.id); startTimer(tags); renderDayList(); }
  else { timerFromPlan=false; startTags=[]; renderStartTags(); document.getElementById('startScrim').classList.remove('hidden'); document.getElementById('startSheet').classList.add('open'); }
}
function closeStartSheet(){ document.getElementById('startSheet').classList.remove('open'); document.getElementById('startScrim').classList.add('hidden'); }
function renderStartTags(){
  // fixed cats + any user-added free-text tags (＋その他), then the add button
  const list=[...START_CATS, ...startTags.filter(t=>!START_CATS.includes(t))];
  document.getElementById('startTags').innerHTML=list.map(t=>
    `<button class="start-tag pop text-[12px] font-bold px-3 py-2 rounded-full border ${startTags.includes(t)?'sel':'border-line text-ink bg-card'}" data-tag="${t}"><span class="inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle" style="background:${tagDot[t]||'#9AA09A'}"></span>${t}</button>`
  ).join('')
    + `<button class="start-tag-other pop text-[12px] font-bold px-3 py-2 rounded-full border border-dashed border-line text-sub bg-card">＋その他</button>`;
}
function onStartGo(){ if(!startTags.length) return; timerFromPlan=false; closeStartSheet(); startTimer(startTags); }
function onStopWorkout(){
  if(timerInterval) clearInterval(timerInterval);
  timerRunning=false;
  activeEntryIds=[];   // 実施中→実施済みへ遷移
  const durSec=timerSec;
  const dur=durFromSec(timerSec);
  renderStartBar();
  // (1) record the workout so it counts. 予定から開始なら今日の自分の予定を実施済みに更新（重複追加しない）。
  //     予定なし開始の時だけ新規エントリを追加する。dur_sec を保存し表示は durFromSec 整形。
  const todays=logEntries.filter(e=>e.type==='workout'&&e.who===CURRENT_USER&&e.date===TODAY);
  if(timerFromPlan && todays.length){
    todays.forEach(e=>{ e.status='done'; e.dur=dur; e.durSec=durSec; upsertEntry(e); });
  }else{
    const en={id:newId(), date:TODAY, type:'workout', who:CURRENT_USER, tags:timerTags.slice(), time:'いま', dur, durSec, status:'done'};
    logEntries.push(en); upsertEntry(en);
  }
  rerenderAfterChange();
  // (2) open the share (post) flow with the same tags + measured time
  openPostSheet(timerTags, dur, durSec);
}
function renderPostTags(){
  const el=document.getElementById('psTags'); if(!el) return;
  // 予定/タイマーの部位を初期選択。ジムで変わることがあるので選び直せる(＋その他も可)
  const list=[...SHEET_TAGS, ...postTags.filter(t=>!SHEET_TAGS.includes(t))];
  el.innerHTML=list.map(t=>
    `<button class="ps-tag pop text-[11px] font-bold px-3 py-1.5 rounded-full border ${postTags.includes(t)?'sel':'border-line text-ink bg-card'}" data-tag="${t}"><span class="inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle" style="background:${tagDot[t]||'#9AA09A'}"></span>${t}</button>`
  ).join('')
    + `<button class="ps-tag-other pop text-[11px] font-bold px-3 py-1.5 rounded-full border border-dashed border-line text-sub bg-card">＋その他</button>`;
}
function openPostSheet(tags, dur, durSec){
  pendingPhoto=null; postCtx={dur, durSec};
  postTags=(tags||[]).slice(); renderPostTags();
  document.getElementById('psDur').textContent='実施 '+dur;
  document.getElementById('psPhotoPreview').innerHTML='';
  document.getElementById('psText').value='';
  document.getElementById('psCamera').value=''; document.getElementById('psAlbum').value='';
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
  addPost(createPost({kind:'workout', who:CURRENT_USER, tags:postTags.slice(), dur:postCtx.dur, durSec:postCtx.durSec, photo:pendingPhoto, text, scope:'group'}));
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
  // 達成カード(kind:'achieve')は廃止。旧データは非表示にする(タイムラインはシンプルに保つ)。
  const feed=posts.filter(p=>p.kind!=='achieve');
  if(!feed.length){
    list.innerHTML=`<div class="text-center py-14 rounded-2xl bg-card border border-dashed border-line">
      <p class="text-[28px]">🌱</p>
      <p class="text-[13px] text-faint font-bold mt-2">まだ投稿はありません</p>
      <p class="text-[11px] text-faint mt-1">運動を記録するか、招待コードで仲間とつながると、ここに届きます</p>
      <button class="open-connect pop mt-3 text-[12px] font-extrabold text-accent border border-aline bg-asoft rounded-full px-4 py-2">招待コードで参加</button>
    </div>`;
    return;
  }
  list.innerHTML = feed.map((p,i)=>{
    const m=members[p.who];
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
        ${avatar(m,38,p.who)}
        <div class="flex-1">
          <p class="text-[14px] font-extrabold text-ink leading-none">${m.name}</p>
          <p class="text-[11px] text-faint mt-1">${relTime(p.createdAt)}</p>
        </div>
        <div class="flex flex-wrap justify-end gap-1.5">${(p.tags||[]).map(t=>chip(t)).join('')}</div>
      </div>
      ${imgBlock}
      ${body}
      ${ruleFooter(p)}
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
// 投稿カード下部に「投稿時点の公開ルール」を最大3つ併記。焼き込み済みスナップショットを描画=不変(ライブ計算しない)。
// 投稿自体に載るので、つながり相手(B)の投稿にも B のルールが正しく出る(他人ルールを別途取得しない)。
function ruleFooter(p){
  const snap = p.rulesSnapshot || [];
  if(!snap.length) return '';
  return `<div class="px-4 pb-2 -mt-0.5 flex flex-wrap gap-x-3 gap-y-1">${
    snap.map(r=>`<span class="text-[11px] font-bold text-accent">🔥 ${r.label} ${r.day}日目</span>`).join('')
  }</div>`;
}

/* ---------- SCHEDULE (type-tagged log · week/month · bottom sheet) ---------- */
let CURRENT_USER='boy';   // replaced with session.user.id in bootstrap (initApp)
let SPACE_ID=null;        // the personal space id resolved in bootstrap
// pure 'YYYY-MM-DD' helpers (built from parts to avoid timezone drift)
function ymd(y,m,d){ return `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`; }
function parseYmd(s){ const [y,m,d]=s.split('-').map(Number); return {y,m:m-1,d}; }
function wdIndex(s){ const {y,m,d}=parseYmd(s); return new Date(y,m,d).getDay(); } // Sun=0 (日曜始まり)
// 端末ローカルの実日付 → 'YYYY-MM-DD'。日付が変われば「本日」も自動で進む。
function todayStr(){ const n=new Date(); return ymd(n.getFullYear(), n.getMonth(), n.getDate()); }

let TODAY=todayStr();                    // 実日付(起動時)。ハードコード廃止
let selectedDate=TODAY;
let schedView='week';
let calCursor={ y:parseYmd(TODAY).y, m:parseYmd(TODAY).m };
const WD=['日','月','火','水','木','金','土'];   // Sunday-first (日曜始まりに確定)

// 日本の祝日: 2026-2027 をハードコード(春分/秋分は近似)。自動算出・毎年更新は将来(TODO)。
const JP_HOLIDAYS=new Set([
  '2026-01-01','2026-01-12','2026-02-11','2026-02-23','2026-03-20','2026-04-29','2026-05-03','2026-05-04','2026-05-05','2026-05-06','2026-07-20','2026-08-11','2026-09-21','2026-09-22','2026-09-23','2026-10-12','2026-11-03','2026-11-23',
  '2027-01-01','2027-01-11','2027-02-11','2027-02-23','2027-03-21','2027-04-29','2027-05-03','2027-05-04','2027-05-05','2027-07-19','2027-08-11','2027-09-20','2027-09-23','2027-10-11','2027-11-03','2027-11-23',
]);
function isHoliday(s){ return JP_HOLIDAYS.has(s); }
// 曜日色: 土=青系/日・祝=赤系(faintに)。null=平日(既定色)。警告ではなく示唆(ノーシェイム)。
function dowColor(s){ const wi=wdIndex(s); if(wi===0||isHoliday(s)) return '#D9686B'; if(wi===6) return '#3E86C9'; return null; }

function fmtLabel(s){
  if(s===TODAY) return 'きょうの予定';
  const {m,d}=parseYmd(s);
  const txt=`${m+1}月${d}日(${WD[wdIndex(s)]})`;
  return s<TODAY ? `${txt} の記録` : `${txt} の予定`;
}
// created_at(ISO) → 相対時刻。今/◯分前/◯時間前/昨日/◯日前、7日以上前は日付。
function relTime(iso){
  if(!iso) return '';
  const s=Math.floor((Date.now()-new Date(iso).getTime())/1000);
  if(s<60) return '今';
  const m=Math.floor(s/60); if(m<60) return `${m}分前`;
  const h=Math.floor(m/60); if(h<24) return `${h}時間前`;
  const d=Math.floor(h/24); if(d===1) return '昨日'; if(d<7) return `${d}日前`;
  const dt=new Date(iso); return `${dt.getMonth()+1}月${dt.getDate()}日`;
}

// Sunday-first week containing an anchor date, computed from real dates.
function buildWeek(anchor){
  const {y,m,d}=parseYmd(anchor);
  const dow=new Date(y,m,d).getDay();                 // Sun=0
  const sun=new Date(y,m,d-dow);
  return Array.from({length:7},(_,i)=>{
    const dt=new Date(sun.getFullYear(),sun.getMonth(),sun.getDate()+i);
    return { d:WD[i], date:ymd(dt.getFullYear(),dt.getMonth(),dt.getDate()) };
  });
}
let weekAnchor=TODAY;             // 週ストリップが表示中の週(先週/来週ナビで移動)
let week=buildWeek(weekAnchor);
function renderWeek(){
  // 週がまたぐ月を faint 表示(例「6月」/「6・7月」)
  const wm=document.getElementById('weekMonth');
  if(wm){ const ms=[...new Set(week.map(w=>parseYmd(w.date).m+1))]; wm.textContent=ms.join('・')+'月'; }
  document.getElementById('weekStrip').innerHTML = week.map(w=>{
    const sel=w.date===selectedDate, isToday=w.date===TODAY;
    const {d:dd}=parseYmd(w.date);
    const has=logEntries.some(e=>e.type==='workout'&&e.date===w.date);
    const dc=dowColor(w.date);   // 土=青/日祝=赤(faint)。sel/today は teal 優先
    // teal language: selected=teal fill, today=teal ring + "今日" mark (both distinguishable)
    const cardCls = sel?'bg-accent border-accent':(isToday?'bg-card border-accent':'bg-card border-line');
    const labelCls = sel?'text-white/80':(isToday?'text-accent':(dc?'':'text-faint'));
    const labelStyle = (!sel&&!isToday&&dc)?`style="color:${dc}"`:'';
    const numCls = sel?'text-white':(isToday?'text-accent':'text-ink');
    const marker = isToday
      ? `<span class="text-[8px] font-extrabold leading-none ${sel?'text-white/90':'text-accent'}">今日</span>`
      : `<span class="w-1 h-1 rounded-full ${has?(sel?'bg-white/70':'bg-accent'):(sel?'bg-white/40':'bg-line')}"></span>`;
    return `<button class="day-pill pop w-full py-3 rounded-2xl flex flex-col items-center gap-1.5 border ${cardCls}" data-date="${w.date}">
      <span class="text-[11px] font-bold ${labelCls}" ${labelStyle}>${w.d}</span>
      <span class="text-[16px] font-extrabold ${numCls}">${dd}</span>
      <span class="h-2.5 flex items-center">${marker}</span>
    </button>`;
  }).join('');
}
// 週ストリップの先週/来週ナビ。weekAnchor を±7日して週を作り直す。
function shiftWeek(days){
  const {y,m,d}=parseYmd(week[0].date);
  const dt=new Date(y,m,d+days);
  weekAnchor=ymd(dt.getFullYear(),dt.getMonth(),dt.getDate());
  week=buildWeek(weekAnchor); renderWeek();
}
// 今日を含む週へ戻り、今日を選択。
function weekToToday(){ weekAnchor=TODAY; week=buildWeek(weekAnchor); selectedDate=TODAY; renderWeek(); renderDayList(); }
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
function newId(){ return crypto.randomUUID(); }   // client-gen id = same id in DB (no re-map)
const planStat = {
  done:   {label:'実施済み', cls:'text-accent',    dot:'#14B87C', dim:false, check:true},
  planned:{label:'これから', cls:'text-ink',       dot:'#E0A53A', dim:false, check:false},
  changed:{label:'予定変更', cls:'text-[#E0A53A]', dot:'#E0A53A', dim:false, check:false},
  todo:   {label:'未実施',   cls:'text-faint',     dot:'#D2D5CF', dim:true,  check:false},
};
function workoutCard(p){
  const m=members[p.who]; const s=planStat[p.status]||planStat.planned;
  const active = timerRunning && activeEntryIds.includes(p.id);   // タイマー作動中=実施中
  const timeTxt = /^\d{1,2}:\d{2}$/.test(p.time||'') ? `予定 ${p.time}` : '予定';   // HH:mm のときだけ時刻
  const sh=memberShare[p.who]||{};
  const wtLine = sh.wt ? `<span class="text-[11px] font-bold ${sh.wt.startsWith('▼')?'text-accent':'text-sub'}">${sh.wt}</span>` : '';
  return `<div class="entry-edit pop cursor-pointer flex items-center gap-3 rounded-2xl bg-card border border-line shadow-card p-3.5 ${s.dim?'opacity-60':''}" data-id="${p.id}">
    ${avatar(m,40,p.who)}
    <div class="flex-1">
      <div class="flex flex-wrap items-center gap-1.5">
        <span class="text-[14px] font-extrabold text-ink">${m.name}</span>${(p.tags||[]).map(t=>chip(t)).join('')}
      </div>
      <p class="text-[11px] text-faint mt-1">${timeTxt}${p.note?` ・ <span class="font-bold text-[#E0A53A]">${p.note}</span>`:''}</p>
    </div>
    <div class="flex flex-col items-end gap-1">
      ${active
        ? `<span class="flex items-center gap-1.5 text-[12px] font-extrabold text-accent"><span class="w-1.5 h-1.5 rounded-full bg-accent animate-pulse"></span>🏃 トレーニング中</span>`
        : `<span class="flex items-center gap-1.5 text-[12px] font-bold ${s.cls}"><span class="w-1.5 h-1.5 rounded-full" style="background:${s.dot}"></span>${s.label}</span>`}
      ${wtLine}
    </div>
  </div>`;
}
// compact tappable rows for weight / meal in the selected-day list (非TODAY用)。
// entry-edit + data-id → 既存の編集シート(上書き/削除)を開く。
function weightRow(w){
  return `<div class="entry-edit pop cursor-pointer flex items-center justify-between rounded-2xl bg-card border border-line shadow-card px-4 py-2.5" data-id="${w.id}">
    <span class="text-[12px] font-bold text-sub">体重</span>
    <span class="text-[13px] font-extrabold text-ink">${w.kg}<span class="text-[10px] text-faint font-bold ml-0.5">kg</span> <span class="text-faint text-[11px] ml-0.5">✎</span></span>
  </div>`;
}
function mealRow(m){
  return `<div class="entry-edit pop cursor-pointer flex items-center justify-between rounded-2xl bg-card border border-line shadow-card px-4 py-2.5" data-id="${m.id}">
    <span class="text-[12px] font-bold text-sub">摂取</span>
    <span class="text-[13px] font-extrabold text-ink">${m.kcal}<span class="text-[10px] text-faint font-bold ml-0.5">kcal</span> <span class="text-faint text-[11px] ml-0.5">✎</span></span>
  </div>`;
}
function renderDayList(){
  document.getElementById('dayListLabel').textContent = fmtLabel(selectedDate);
  const items = logEntries.filter(e=>e.type==='workout'&&e.date===selectedDate);
  // TODAY は体重/食事を専用カードが担当。非TODAY(過去/未来)はこのリストに出す。
  const weight = logEntries.find(e=>e.type==='weight'&&e.who===CURRENT_USER&&e.date===selectedDate);
  const meal   = logEntries.find(e=>e.type==='meal'  &&e.who===CURRENT_USER&&e.date===selectedDate);
  const extra  = selectedDate!==TODAY ? [weight, meal].filter(Boolean) : [];
  const rows = items.map(workoutCard).join('')
    + extra.map(e=> e.type==='weight' ? weightRow(e) : mealRow(e)).join('');
  const empty = selectedDate<TODAY
    ? `<div class="text-center py-7 rounded-2xl bg-card border border-dashed border-line">
         <p class="text-[12px] text-faint font-bold">この日の記録はありません</p>
       </div>`
    : `<div class="text-center py-7 rounded-2xl bg-card border border-dashed border-line">
         <p class="text-[12px] text-faint font-bold">まだ予定がありません</p>
         <p class="text-[11px] text-faint mt-1">「＋追記」で宣言できます</p>
       </div>`;
  document.getElementById('planList').innerHTML = (items.length || extra.length) ? rows : empty;
  if(typeof renderMeal==='function') renderMeal();
  if(typeof renderDayWeight==='function') renderDayWeight();
}
function renderMonth(){
  const {y,m}=calCursor;
  document.getElementById('monthLabel').textContent=`${y}年${m+1}月`;
  const first=new Date(y,m,1).getDay();           // Sunday-first lead blanks
  const days=new Date(y,m+1,0).getDate();
  let cells='';
  for(let i=0;i<first;i++) cells+='<div></div>';
  for(let d=1;d<=days;d++){
    const ds=ymd(y,m,d);
    const isToday=ds===TODAY, sel=ds===selectedDate;
    const dayTags=logEntries.filter(e=>e.type==='workout'&&e.date===ds).flatMap(e=>e.tags||[]);
    const dots=dayTags.slice(0,3).map(t=>`<span class="w-1.5 h-1.5 rounded-full" style="background:${tagDot[t]||'#9AA09A'}"></span>`).join('');
    const more=dayTags.length>3?`<span class="text-[8px] font-bold text-faint leading-none">+${dayTags.length-3}</span>`:'';
    const dc=dowColor(ds);   // 土=青/日祝=赤(faint)。sel/today は teal 優先
    const numCls = sel
      ? (isToday?'bg-accent text-white ring-2 ring-aline':'bg-accent text-white')
      : (isToday?'text-accent ring-1 ring-accent':(dc?'':'text-ink'));
    const numStyle=(!sel&&!isToday&&dc)?`style="color:${dc}"`:'';
    cells+=`<button class="mcell pop flex flex-col items-center gap-1 py-1" data-date="${ds}">
      <span class="w-7 h-7 flex items-center justify-center rounded-full text-[12px] font-bold ${numCls}" ${numStyle}>${d}</span>
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
      const durTxt=e.dur?`<span class="text-[11px] font-bold text-sub shrink-0">${e.dur}</span>`:`<span class="flex items-center gap-1 text-[11px] font-bold ${s.cls} shrink-0"><span class="w-1.5 h-1.5 rounded-full" style="background:${s.dot}"></span>${s.label}</span>`;
      rows.push(`<div class="entry-edit pop cursor-pointer flex items-center gap-2.5" data-id="${e.id}">
        ${avatar(mem,28)}
        <span class="text-[12px] font-bold text-ink w-12 shrink-0">${mem.name}</span>
        <div class="flex flex-wrap items-center gap-1.5">${(e.tags||[]).map(t=>chip(t)).join('')}</div>
        <span class="ml-auto">${durTxt}</span>
      </div>`);
    });
    if(weight) rows.push(`<div class="entry-edit pop cursor-pointer flex items-center gap-2.5" data-id="${weight.id}">
      <span class="text-[12px] font-bold text-sub">体重</span>
      <span class="ml-auto text-[13px] font-extrabold text-ink">${weight.kg}<span class="text-[10px] text-faint font-bold ml-0.5">kg</span></span></div>`);
    if(meal) rows.push(`<div class="entry-edit pop cursor-pointer flex items-center gap-2.5" data-id="${meal.id}">
      <span class="text-[12px] font-bold text-sub">摂取</span>
      <span class="ml-auto text-[13px] font-extrabold text-ink">${meal.kcal}<span class="text-[10px] text-faint font-bold ml-0.5">kcal</span></span></div>`);
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
            <span class="ml-auto flex items-center gap-1 text-[11px] font-bold ${s.cls} shrink-0"><span class="w-1.5 h-1.5 rounded-full" style="background:${s.dot}"></span>${s.label}</span>
          </div>`;
        }).join('')+`</div>`
      : `<p class="text-[11px] text-faint">この日の予定はまだありません</p>`;
  }
  el.innerHTML=`<div class="rounded-2xl bg-card border border-line shadow-card p-3.5">${head}${body}</div>`;
  el.classList.remove('hidden');
}

/* ---------- bottom sheet (declare / log) ---------- */
const SHEET_TAGS=['胸トレ','背中','脚','肩','腕','有酸素','ストレッチ','休養'];
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
  // fixed 部位 + any user-added free-text tags (＋その他), then the add button
  const list=[...SHEET_TAGS, ...sfTags.filter(t=>!SHEET_TAGS.includes(t))];
  document.getElementById('sfTags').innerHTML=list.map(t=>
    `<button class="sf-tag pop text-[11px] font-bold px-3 py-1.5 rounded-full border ${sfTags.includes(t)?'sel':'border-line text-ink bg-card'}" data-tag="${t}"><span class="inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle" style="background:${tagDot[t]||'#9AA09A'}"></span>${t}</button>`
  ).join('')
    + `<button class="sf-tag-other pop text-[11px] font-bold px-3 py-1.5 rounded-full border border-dashed border-line text-sub bg-card">＋その他</button>`;
}
function showSheet(){
  document.getElementById('sheetScrim').classList.remove('hidden');
  document.getElementById('sheet').classList.add('open');
}
function openSheet(type, date){
  sfEditId=null; sfTags=['背中'];
  ['sfTime','sfKg','sfKcal'].forEach(id=>{const el=document.getElementById(id); if(el) el.value='';});
  document.getElementById('sfTypeToggle').classList.remove('hidden');
  document.getElementById('sheetDelete').classList.add('hidden');
  setSheetType(type||'workout');
  document.getElementById('sfDate').value=date||selectedDate;   // 本日カードからは TODAY を渡す
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
  // <input type="time"> は HH:mm のみ受け付ける。'いま'/'—' 等(タイマー由来)は空にして警告を出さない。
  if(en.type==='workout'){ sfTags=(en.tags||[]).slice(); renderSheetTags(); document.getElementById('sfTime').value=/^\d{1,2}:\d{2}$/.test(en.time||'')?en.time:''; }
  else if(en.type==='weight'){ document.getElementById('sfKg').value=en.kg; }
  else { document.getElementById('sfKcal').value=en.kcal; }   // 食事は摂取kcalのみ(P/F/C廃止)
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
  let saved=null;   // the entry to persist (edit=overwrite by id, new=append)
  if(sfType==='workout'){
    if(!sfTags.length){ closeSheet(); return; }
    const status=editing&&target?target.status:(date<TODAY?'done':'planned');
    const fields={date, tags:sfTags.slice(), time:document.getElementById('sfTime').value||'—', status};
    if(editing&&target){ Object.assign(target,fields); saved=target; }
    else{ saved={id:newId(), type:'workout', who:CURRENT_USER, ...fields}; logEntries.push(saved); }
  }else if(sfType==='weight'){
    const kg=parseFloat(document.getElementById('sfKg').value);
    if(!isNaN(kg)){
      if(editing&&target){ Object.assign(target,{date,kg}); saved=target; }
      else{
        const ex=logEntries.find(e=>e.type==='weight'&&e.who===CURRENT_USER&&e.date===date);
        if(ex){ ex.kg=kg; saved=ex; } else { saved={id:newId(),date,type:'weight',who:CURRENT_USER,kg}; logEntries.push(saved); }
      }
    }
  }else{ // meal — 摂取kcalのみ(P/F/C廃止)
    const kcal=parseInt(document.getElementById('sfKcal').value);
    if(!isNaN(kcal)){
      const fields={date,kcal};
      if(editing&&target){ Object.assign(target,fields); saved=target; }
      else{
        const ex=logEntries.find(e=>e.type==='meal'&&e.who===CURRENT_USER&&e.date===date);
        if(ex){ Object.assign(ex,fields); saved=ex; } else { saved={id:newId(),type:'meal',who:CURRENT_USER,...fields}; logEntries.push(saved); }
      }
    }
  }
  if(saved) upsertEntry(saved);   // ローカル反映後、裏でDB保存(失敗はconsole.error)
  selectedDate=date;
  closeSheet();
  rerenderAfterChange();
}
function deleteEntry(){
  if(sfEditId==null) return;
  const id=sfEditId;
  const i=logEntries.findIndex(e=>e.id===id);
  if(i>=0){ logEntries.splice(i,1); removeEntry(id); }
  closeSheet();
  rerenderAfterChange();
}

/* ---------- SCHEDULE: 本日の食事 / limits (type-tagged items) ---------- */
// meal input lives in 予定; intake feeds the 記録 calorie-balance graph (週). 食品DB検索なし
function renderMeal(){
  const el=document.getElementById('mealSummary'); if(!el) return;
  const card=document.getElementById('mealCard');
  // 本日カードは選択日=TODAYのときだけ表示。過去/未来日を選んでいる間はカードごと非表示
  // (その日の食事は選択日リストの mealRow で見る/直す)。
  if(selectedDate!==TODAY){ if(card) card.classList.add('hidden'); return; }
  if(card) card.classList.remove('hidden');
  const meal=logEntries.find(e=>e.type==='meal'&&e.who===CURRENT_USER&&e.date===TODAY);
  if(!meal){
    el.innerHTML=`<button class="meal-add pop w-full flex items-center justify-center gap-1.5 text-[12px] font-bold text-accent bg-card border border-dashed border-aline rounded-2xl py-3">＋ 食事を入力（摂取kcal）</button>`;
    return;
  }
  el.innerHTML=`<button class="entry-edit pop w-full text-left" data-id="${meal.id}"><div class="flex items-baseline px-1">
    <p class="text-[11px] text-faint font-bold">摂取</p>
    <p class="text-[16px] font-extrabold text-ink leading-none ml-auto">${meal.kcal}<span class="text-[10px] text-faint font-bold ml-0.5">kcal</span></p>
  </div></button>`;
}
// compact tappable 本日の体重 handle in 予定 (edit/add). Weight lives on 記録; this is just the edit handle.
function renderDayWeight(){
  const el=document.getElementById('dayWeightRow'); if(!el) return;
  // 本日カードは選択日=TODAYのときだけ表示。過去/未来日を選んでいる間は非表示
  // (その日の体重は選択日リストの weightRow で見る/直す)。
  if(selectedDate!==TODAY){ el.innerHTML=''; el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const lbl='本日の体重';
  const w=logEntries.find(e=>e.type==='weight'&&e.who===CURRENT_USER&&e.date===TODAY);
  el.innerHTML = w
    ? `<button class="entry-edit pop w-full flex items-center justify-between rounded-2xl bg-card border border-line shadow-card px-4 py-2.5" data-id="${w.id}">
         <span class="text-[12px] font-bold text-sub">${lbl}</span>
         <span class="text-[13px] font-extrabold text-ink">${w.kg}<span class="text-[10px] text-faint font-bold ml-0.5">kg</span> <span class="text-faint text-[11px] ml-0.5">✎</span></span>
       </button>`
    : `<button class="weight-add pop w-full flex items-center justify-center gap-1.5 text-[12px] font-bold text-accent bg-card border border-dashed border-aline rounded-2xl py-2.5">＋ ${lbl}を記録</button>`;
}

// self-rules: each picks 公開(みんなが見れる) or 自分だけ(非公開). No 4-step scope, no warnings. Max 3.
// Flat initial state: no rules yet. User adds up to 3 via 「＋ルール追加」.
const limits = [];
// 日数ストリーク型: 追加日から毎日そっと+1(実日付の引き算)。過去比較はしない(育てる思想=自己ベストは持たない)。
// 連続日数 = streakStart から今日までの経過日数+1(開始日=1日目)。streakStartなし=0。
function daysBetween(a,b){ const p=parseYmd(a),q=parseYmd(b); return Math.round((Date.UTC(q.y,q.m,q.d)-Date.UTC(p.y,p.m,p.d))/86400000); }
function ruleStreak(r){ return r.streakStart ? daysBetween(r.streakStart, TODAY)+1 : 0; }
function renderLimits(){
  const list=document.getElementById('limitList');
  if(!list) return;
  // ミニマル行: ルール名(フル・切れない) ＋ 🔥N日目 ＋ 公開/非公開マーク ＋ ✕
  list.innerHTML = limits.length ? limits.map((l,i)=>{
    const cur=ruleStreak(l);
    const streakChip = l.streakStart ? `<span class="text-[10px] font-extrabold text-accent ml-2 whitespace-nowrap">🔥${cur}日目</span>` : '';
    return `<div class="limit flex items-center gap-2 rounded-2xl border bg-card border-line px-3 py-2.5" data-i="${i}">
      <span class="text-[15px] shrink-0">${l.emoji}</span>
      <div class="flex-1 min-w-0"><p class="text-[13px] font-bold text-ink leading-snug">${l.label}${streakChip}</p></div>
      <button class="rule-pub pop text-[13px] leading-none shrink-0" title="${l.pub?'公開':'自分だけ'}">${l.pub?'🌐':'🔒'}</button>
      <button class="rule-del pop text-faint text-[13px] leading-none shrink-0 pl-0.5">✕</button>
    </div>`;
  }).join('') : `<p class="text-[12px] text-faint text-center py-3">まだ自分ルールはありません。「＋ルール追加」でそっと決められます</p>`;
  const addBtn=document.getElementById('ruleAddBtn');
  if(addBtn) addBtn.classList.toggle('hidden', limits.length>=3);
}
// ✕の軽い2択(ノーシェイム): 「また1日目から育てる」=リセット / 「このルールを終える」=削除。
let ruleXTarget=null;
function openRuleX(i){ ruleXTarget=i; document.getElementById('ruleXScrim').classList.remove('hidden'); document.getElementById('ruleXSheet').classList.add('open'); }
function closeRuleX(){ document.getElementById('ruleXSheet').classList.remove('open'); document.getElementById('ruleXScrim').classList.add('hidden'); ruleXTarget=null; }
function replantRule(){ const l=limits[ruleXTarget]; if(l){ l.streakStart=TODAY; upsertRule(l); renderLimits(); if(typeof renderProgressHero==='function') renderProgressHero(); } closeRuleX(); }
function endRule(){ const i=ruleXTarget; const l=limits[i]; if(l){ removeRule(l.id); limits.splice(i,1); renderLimits(); if(typeof renderProgressHero==='function') renderProgressHero(); } closeRuleX(); }

/* ---------- self-rule add + streak (日数ストリーク型) ---------- */
// 記録ヒーローの「連続記録」は当面 各ルールの日数連続の最大を表示(将来=運動ベース・実日付化とセット)。
function curStreak(){ return limits.reduce((m,l)=>Math.max(m,ruleStreak(l)),0); }
function openRule(){
  document.getElementById('rfLabel').value='';
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
  const r={id:crypto.randomUUID(), type:'limit', emoji:'🎯', label, pub:true, streakStart:TODAY};
  limits.push(r); upsertRule(r);
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
      ${avatar(m,26,g.who)}
      <span class="text-[12px] font-bold text-ink w-11">${m.name}</span>
      <div class="flex-1 h-1.5 rounded-full bg-[#F0EFEB] overflow-hidden"><div class="h-full rounded-full" style="width:${pct}%;background:${m.c}"></div></div>
      <span class="text-[12px] font-extrabold text-sub w-8 text-right">${g.d}日</span>
    </div>`;
  }).join('');
}

/* ---------- charts ---------- */
let charts={}; let chartsReady=false; let chartMode='week';
const chartLabels={ week:['日','月','火','水','木','金','土'], month:['7週前','6','5','4','3','2','先週','今週'] };
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
// 実績=status:'done' のみ。予定(planned)を運動日数に混ぜない。
function weekWorkoutDays(){ return new Set(logEntries.filter(e=>e.type==='workout'&&e.who===CURRENT_USER&&e.status==='done'&&week.some(w=>w.date===e.date)).map(e=>e.date)).size; }
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
// 体重差分(前週比/前月比): cutoff より前の最新値と、cutoff 以降の最新値の差。
// 減=▼(teal)/増=▲(faint・赤にしない=ノーシェイム)/変化なし=±0。データ不足は空。
function weightDelta(cutoff){
  const ws=logEntries.filter(e=>e.type==='weight'&&e.who===CURRENT_USER).slice().sort((a,b)=> a.date<b.date?-1:1);
  const before=ws.filter(e=>e.date<cutoff), within=ws.filter(e=>e.date>=cutoff);
  if(!within.length||!before.length) return '';
  const d=+(within[within.length-1].kg - before[before.length-1].kg).toFixed(1);
  if(d===0) return '±0kg';
  return (d<0?'▼':'▲')+Math.abs(d)+'kg';
}
function renderProgressHero(){
  // 週/月トグルに追随: 月ビューは「今月」の集計、週ビューは「今週」。メンテ差分だけは現状(週)維持。
  const month = chartMode==='month';
  const {y:ty,m:tm}=parseYmd(TODAY);
  const inPeriod = month ? (s)=>{ const p=parseYmd(s); return p.y===ty&&p.m===tm; } : (s)=> week.some(w=>w.date===s);
  const cutoff = month ? ymd(ty,tm,1) : week[0].date;   // 前月比/前週比の境界
  setHeroName();
  const wk=logEntries.filter(e=>e.type==='workout'&&e.who===CURRENT_USER&&inPeriod(e.date));
  const doneWk=wk.filter(e=>e.status==='done');   // 実績は done のみ
  const set=(id,v)=>{const el=document.getElementById(id); if(el) el.textContent=v;};
  set('statDays', new Set(doneWk.map(e=>e.date)).size);   // 運動日数=実施済みのみ(予定は数えない)
  set('heroStreak', curStreak());
  // 予定達成率リング(%)は廃止=プレッシャーになるため(ノーシェイム)
  const weights=logEntries.filter(e=>e.type==='weight'&&e.who===CURRENT_USER).slice().sort((a,b)=> a.date<b.date?-1:1);
  set('heroWeight', weights.length?weights[weights.length-1].kg:'—');
  const del=document.getElementById('heroWeightDelta');
  if(del){ const d=weightDelta(cutoff); del.textContent=d; del.classList.toggle('text-accent', d.startsWith('▼')); del.classList.toggle('text-faint', !d.startsWith('▼')); }
  const ht=document.getElementById('heroTime'); if(ht) ht.innerHTML=fmtMinHtml(doneWk.reduce((s,e)=>s+durToMin(e.dur),0));
  const bser=weekBalSeries().filter(x=>x!=null);   // カロリー差分は現状維持(週ベース)
  if(bser.length){ const sum=bser.reduce((a,b)=>a+b,0); set('heroMaint', (sum<=0?'-':'+')+Math.abs(sum/1000).toFixed(1)+'k'); }
  else set('heroMaint','—');
}

/* ---------- profile + maintenance (Katch-McArdle, mock — no auth/persistence) ---------- */
const profile = { nick:'ぼーい', photo:null, height:175, weight:71.0, bodyfat:18, activity:1.45, maintenanceOverride:null };
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
  el.textContent=`0ライン＝維持カロリー ${maintenanceValue().toLocaleString()}kcal（${note}）`;
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
  applyAvatarEl(document.getElementById('pfAvatar'), members[CURRENT_USER]);   // 開時に現在のアバターを同期
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
// 閲覧用プロフィールカード(nickname/アバター＋公開ルール最大3つと🔥日数)。今は自分のみ、他人参照はPhase 4。
function pcRuleRow(l){
  return `<div class="flex items-center gap-2 rounded-xl border border-line bg-card px-3 py-2"><span class="text-[14px]">${l.emoji||'🎯'}</span><span class="flex-1 text-[13px] font-bold text-ink truncate">${l.label}</span>${l.streakStart?`<span class="text-[11px] font-extrabold text-accent whitespace-nowrap">🔥${ruleStreak(l)}日目</span>`:''}</div>`;
}
// タップされた相手のカードを表示。自分=own limits、相手=公開ルールをその都度取得(rules RLSがpub＋つながりを担保)。
async function openProfileCard(userId){
  const id = userId || CURRENT_USER;
  const m = members[id] || {};
  applyAvatarEl(document.getElementById('pcAvatar'), m);
  const nm=document.getElementById('pcName'); if(nm) nm.textContent=m.name||'';
  const el=document.getElementById('pcRules');
  if(el) el.innerHTML=`<p class="text-[12px] text-faint text-center py-3">…</p>`;
  document.getElementById('pcScrim').classList.remove('hidden');
  document.getElementById('pcSheet').classList.add('open');
  const rules = id===CURRENT_USER ? limits.filter(l=>l.pub) : await loadPublicRules(id);
  const pub = rules.filter(l=>l.streakStart).slice(0,3);
  if(el) el.innerHTML = pub.length
    ? pub.map(pcRuleRow).join('')
    : `<p class="text-[12px] text-faint text-center py-3">公開中のルールはありません</p>`;
}
function closeProfileCard(){
  document.getElementById('pcSheet').classList.remove('open');
  document.getElementById('pcScrim').classList.add('hidden');
}
/* ---------- 通知パネル / 設定 / オンボーディングツアー(器) ---------- */
function openNotify(){ document.getElementById('notifyScrim').classList.remove('hidden'); document.getElementById('notifySheet').classList.add('open'); }
function closeNotify(){ document.getElementById('notifySheet').classList.remove('open'); document.getElementById('notifyScrim').classList.add('hidden'); }
function openSettings(){ closeProfile(); document.getElementById('settingsScrim').classList.remove('hidden'); document.getElementById('settingsSheet').classList.add('open'); }
function closeSettings(){ document.getElementById('settingsSheet').classList.remove('open'); document.getElementById('settingsScrim').classList.add('hidden'); }
// つながる(グループ招待): コード発行/コピー/参加。参加成功で再ロードしてタイムラインに反映。
let lastInviteCode=null;
async function onGenInvite(){
  const inv=await createInvite(SPACE_ID);
  if(!inv){ showToast('招待コードの発行に失敗しました。通信を確認してください'); return; }
  lastInviteCode=inv.code;
  document.getElementById('inviteCode').textContent=inv.code;
  document.getElementById('inviteCodeBox').classList.remove('hidden');
}
function onCopyInvite(){ if(lastInviteCode && navigator.clipboard){ navigator.clipboard.writeText(lastInviteCode); showToast('コピーしました'); } }
async function onJoin(){
  const code=(document.getElementById('joinCodeInput').value||'').trim();
  if(!code) return;
  try{ await joinWithCode(code); showToast('参加しました'); setTimeout(()=>location.reload(), 700); }
  catch(err){ console.error('join failed:', err.message||err); showToast('コードが無効か期限切れです'); }
}
// 初回オンボーディングツアー。各ステップで対象要素をハイライトし、その近くに吹き出しを出す。
// target=対象のCSSセレクタ(nullは中央表示)。文言は後で磨く前提のドラフト。
// 6ステップ確定版。文言はプロダクトオーナー(開発者本人)指定を一字一句そのまま表示する。
// AI側でタイトル等の文言を追加・整形しない(本文=指定テキストのみ・「使い方をもう一度見る」でも同一)。
// page=表示する画面(showPageを呼ぶだけ)。pos=吹き出しの固定位置(center/top/bottom)。
// 画面切替以外は実UI要素に一切触れない(ハイライト・自動スクロール・クリック発火なし=シート誤起動を防止)。
const TOUR_STEPS=[
  { page:'schedule', pos:'center', b:'fit tree は「運動の絵日記」。焦らず、あなたのペースで、そっと積み上げるアプリです！' },
  { page:'schedule', pos:'top',    b:'宣言をして予定を入れよう！' },
  { page:'schedule', pos:'bottom', b:'予定を入れたら指定の時間に運動開始をして、運動をスタート！' },
  { page:'feed',     pos:'bottom', b:'タイムラインに自分が運動した記録が残り、みんなが見ることができます！' },
  { page:'progress', pos:'bottom', b:'そして自分の運動の記録はタイムラインと、記録に蓄積されていきます！' },
  { page:null,       pos:'center', b:'一緒にあなただけの運動の記録を育てていきましょう！' },
];
let tourIdx=0, tourOpen=false;
function placeTourCard(pos){
  const card=document.getElementById('tourCard'); if(!card) return;
  const h=document.getElementById('app').getBoundingClientRect().height;
  const ch=card.offsetHeight||160;
  let top;
  if(pos==='top') top=Math.round(h*0.12);
  else if(pos==='bottom') top=Math.round(h-ch-96);   // 下部ナビを避ける
  else top=Math.round((h-ch)/2);                       // center
  card.style.top=Math.max(12, top)+'px';
}
function renderTourStep(){
  const s=TOUR_STEPS[tourIdx]; if(!s) return;
  if(s.page) showPage(s.page);   // 画面切替(タブ遷移)だけ行う。要素には触れない
  document.getElementById('tourStepNo').textContent=`${tourIdx+1} / ${TOUR_STEPS.length}`;
  document.getElementById('tourTitle').textContent='';   // AIタイトルは付けない(指定本文のみ)
  document.getElementById('tourBody').textContent=s.b;    // プロダクトオーナー指定を一字一句
  document.getElementById('tourNext').textContent = tourIdx===TOUR_STEPS.length-1 ? 'はじめる' : '次へ';
  setTimeout(()=>placeTourCard(s.pos), 30);              // 描画後に高さ確定→位置決め
}
function openTour(){ tourOpen=true; tourIdx=0; document.getElementById('tourOverlay').classList.remove('hidden'); renderTourStep(); }
function endTour(){
  tourOpen=false;
  document.getElementById('tourOverlay').classList.add('hidden');
  showPage('schedule');   // 終了/スキップ時は予定画面に戻す
  if(members[CURRENT_USER]) markTourDone(CURRENT_USER);   // 完了を保存(次回は出さない)
}
function tourNext(){ if(tourIdx>=TOUR_STEPS.length-1){ endTour(); } else { tourIdx++; renderTourStep(); } }
// 「＋その他」カスタムタグ入力(prompt置換の共通ボトムシート)。ctx=start/sheet/post
let tagOtherCtx=null;
function openTagOther(ctx){
  tagOtherCtx=ctx;
  const inp=document.getElementById('tagOtherInput'); if(inp){ inp.value=''; }
  document.getElementById('tagOtherScrim').classList.remove('hidden');
  document.getElementById('tagOtherSheet').classList.add('open');
  if(inp) setTimeout(()=>inp.focus(),50);
}
function closeTagOther(){
  document.getElementById('tagOtherSheet').classList.remove('open');
  document.getElementById('tagOtherScrim').classList.add('hidden');
  tagOtherCtx=null;
}
function confirmTagOther(){
  const v=(document.getElementById('tagOtherInput').value||'').trim();
  if(v){
    if(tagOtherCtx==='start'){ if(!startTags.includes(v)) startTags.push(v); renderStartTags(); }
    else if(tagOtherCtx==='sheet'){ if(!sfTags.includes(v)) sfTags.push(v); renderSheetTags(); }
    else if(tagOtherCtx==='post'){ if(!postTags.includes(v)) postTags.push(v); renderPostTags(); }
  }
  closeTagOther();
}
// nick is the single source of truth for display name + avatar initial (header + 記録 hero).
// 画像があれば画像、無ければ頭文字(ヘッダ・記録ヒーロー・プロフィールシート共通)
function applyAvatarEl(el, m){ if(!el || !m) return;
  if(m.photo){ el.textContent=''; el.style.backgroundImage=`url('${m.photo}')`; el.style.backgroundSize='cover'; el.style.backgroundPosition='center'; }
  else { el.style.backgroundImage=''; el.textContent=m.ini; }
}
function renderIdentity(){
  const m = members[CURRENT_USER]; if(!m) return;
  applyAvatarEl(document.getElementById('profileBtn'), m);
  applyAvatarEl(document.getElementById('heroAvatar'), m);
  setHeroName();
}
// 記録ヒーローの見出し「◯◯の今週/今月」。名前は絵文字二重を避け、期間は週/月トグルに追随。
function setHeroName(){
  const m = members[CURRENT_USER]; if(!m) return;
  const hn = document.getElementById('heroName'); if(!hn) return;
  hn.textContent = `${heroDisplayName(m.name)}の${chartMode==='month'?'今月':'今週'}`;
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
    .catch(err => { console.error('profile save failed:', err.message || err); showToast('保存に失敗しました。通信を確認してください'); });
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
  // ツアー表示中は「次へ/スキップ」以外のクリックを全遮断(背面UIの誤操作・シート誤起動を根絶)
  if(tourOpen){ if(e.target.closest('#tourNext')) tourNext(); else if(e.target.closest('#tourSkip')) endTour(); return; }
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
  if(rdel){ const li=rdel.closest('.limit'); if(li) openRuleX(+li.dataset.i); }   // ✕→2択シート
  const rpub=e.target.closest('.rule-pub');
  if(rpub){ const li=rpub.closest('.limit'); if(li){ const rl=limits[+li.dataset.i]; if(rl){ rl.pub=!rl.pub; upsertRule(rl); renderLimits(); } } }
  if(e.target.closest('#ruleXReplant')) replantRule();
  if(e.target.closest('#ruleXEnd')) endRule();
  if(e.target.closest('#ruleXCancel')||e.target.closest('#ruleXScrim')) closeRuleX();
  if(e.target.closest('.meal-add')) openSheet('meal', TODAY);   // 本日の食事カード → TODAY固定
  { const ab=e.target.closest('.avatar-btn'); if(ab) openProfileCard(ab.dataset.user); }   // タップされた相手のカード
  if(e.target.closest('#pcClose')||e.target.closest('#pcScrim')) closeProfileCard();
  const eedit=e.target.closest('.entry-edit'); if(eedit && !e.target.closest('.avatar-btn')) openSheetEdit(eedit.dataset.id);
  if(e.target.closest('#sheetDelete')) deleteEntry();
  if(e.target.closest('.rule-add')) openRule();
  if(e.target.closest('#ruleSave')) saveRule();
  if(e.target.closest('#ruleCancel')||e.target.closest('#ruleScrim')) closeRule();
  if(e.target.closest('.start-workout')) onStartWorkout();
  if(e.target.closest('.stop-workout')) onStopWorkout();
  const sct=e.target.closest('.start-tag');
  if(sct){ const t=sct.dataset.tag; const i=startTags.indexOf(t); if(i>=0) startTags.splice(i,1); else startTags.push(t); renderStartTags(); }
  if(e.target.closest('.start-tag-other')) openTagOther('start');
  if(e.target.closest('#startGo')) onStartGo();
  if(e.target.closest('#startCancel')||e.target.closest('#startScrim')) closeStartSheet();
  const ptag=e.target.closest('.ps-tag');
  if(ptag){ const t=ptag.dataset.tag; const i=postTags.indexOf(t); if(i>=0) postTags.splice(i,1); else postTags.push(t); renderPostTags(); }
  if(e.target.closest('.ps-tag-other')) openTagOther('post');
  if(e.target.closest('#tagOtherConfirm')) confirmTagOther();
  if(e.target.closest('#tagOtherCancel')||e.target.closest('#tagOtherScrim')) closeTagOther();
  if(e.target.closest('#psCameraBtn')) document.getElementById('psCamera').click();   // カメラ直接起動
  if(e.target.closest('#psAlbumBtn')) document.getElementById('psAlbum').click();      // アルバム選択
  if(e.target.closest('#postSubmit')) submitPost();
  if(e.target.closest('#postCancel')||e.target.closest('#postScrim')) closePostSheet();
  const day=e.target.closest('.day-pill');
  if(day){ selectedDate=day.dataset.date; renderWeek(); renderDayList(); }
  const wnav=e.target.closest('[data-wnav]');
  if(wnav) shiftWeek(wnav.dataset.wnav==='next'?7:-7);
  if(e.target.closest('[data-wtoday]')) weekToToday();

  const vseg=e.target.closest('.vseg');
  if(vseg){
    schedView=vseg.dataset.vview;
    document.querySelectorAll('.vseg').forEach(b=>{const on=b.dataset.vview===schedView;b.classList.toggle('active',on);b.classList.toggle('text-sub',!on);});
    document.getElementById('weekNav').classList.toggle('hidden',schedView!=='week');
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
  if(e.target.closest('.weight-add')) openSheet('weight', TODAY);   // 本日の体重カード → TODAY固定
  const sft=e.target.closest('.sf-type'); if(sft) setSheetType(sft.dataset.sftype);
  const stag=e.target.closest('.sf-tag');
  if(stag){ const t=stag.dataset.tag; const i=sfTags.indexOf(t); if(i>=0) sfTags.splice(i,1); else sfTags.push(t); renderSheetTags(); }
  if(e.target.closest('.sf-tag-other')) openTagOther('sheet');
  if(e.target.closest('#sheetConfirm')) confirmSheet();
  if(e.target.closest('#sheetCancel')||e.target.closest('#sheetScrim')) closeSheet();

  if(e.target.closest('#profileBtn')) openProfile();
  if(e.target.closest('#pfEditPhoto')) showToast('プロフィール画像の変更は近日対応します');   // 画像変更=Phase 5
  if(e.target.closest('#profileSave')) saveProfile();
  if(e.target.closest('#profileCancel')||e.target.closest('#profileScrim')) closeProfile();
  // 通知ベル / 設定 / ツアー
  if(e.target.closest('#bellBtn')) openNotify();
  if(e.target.closest('#notifyClose')||e.target.closest('#notifyScrim')) closeNotify();
  if(e.target.closest('#notifyTour')){ closeNotify(); openTour(); }
  if(e.target.closest('#openSettings')) openSettings();
  if(e.target.closest('#settingsClose')||e.target.closest('#settingsScrim')) closeSettings();
  if(e.target.closest('#settingsTour')){ closeSettings(); openTour(); }
  if(e.target.closest('#settingsLogout')){ closeSettings(); supabase.auth.signOut(); }
  if(e.target.closest('.open-connect')) openSettings();   // 新規ログイン後の参加入口→設定「つながる」欄へ
  if(e.target.closest('#genInvite')) onGenInvite();
  if(e.target.closest('#copyInvite')) onCopyInvite();
  if(e.target.closest('#joinBtn')) onJoin();
  // #tourNext/#tourSkip はツアー中のみ存在し、上部のガードで処理する
});
// live maintenance preview while editing the profile sheet
document.addEventListener('input', e=>{ if(e.target.closest('#profileSheet')) updateProfilePreview(); });
document.addEventListener('change', e=>{ if(e.target.id==='psCamera'||e.target.id==='psAlbum') handlePhoto(e.target.files && e.target.files[0]); });

/* ---------- init (runs once, after login) ---------- */
let appStarted=false;
async function initApp(session){
  if(appStarted) return; appStarted=true;
  try{
    // users row + personal space, then load cloud data into the in-memory stores.
    const { userId, spaceId, urow } = await bootstrap(session);
    CURRENT_USER=userId; SPACE_ID=spaceId;
    Object.assign(profile, profileFromRow(urow));
    members = { [CURRENT_USER]: { name:profile.nick, ini:firstCP(profile.nick), c:'#14B87C', photo:profile.photo } };
    // 他人の表示名/アバターは public_profiles(安全な窓)から。自分は自分のprofileを優先=上書きしない。
    (await loadPublicProfiles()).forEach(p=>{
      if(!members[p.id]) members[p.id]={ name:p.nickname||'', ini:firstCP(p.nickname), c:'#14B87C', photo:p.photo };
    });
    const data = await loadAll();
    logEntries.push(...data.entries);
    posts.push(...data.posts);
    limits.push(...data.rules);
    // つながり相手の投稿ownerが members に無ければニュートラル補完(表示が落ちないように)
    posts.forEach(p=>{ if(p.who && !members[p.who]) members[p.who]={ name:'メンバー', ini:'?', c:'#9AA09A', photo:null }; });
  }catch(err){
    console.error('bootstrap/load failed:', err.message || err);
  }
  renderFeedAvatars(); renderFeed(); renderWeek(); renderDayList(); renderGroup();
  renderMeal(); renderLimits(); renderMonth(); renderMaintCaption(); renderStartBar(); renderStats();
  renderIdentity();
  showPage('schedule');   // app opens on 予定 (also reveals the 運動開始 bar)
  // 初回のみ自動表示。既にデータがある既存ユーザーには突然出さない(手動再表示は設定/🔔から)
  const hasData = logEntries.length>0 || posts.length>0 || limits.length>0;
  if(!profile.tourDone && !hasData) openTour();

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
