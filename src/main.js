// fit tree — app entry. Logic unchanged from the prototype; Phase 2 adds a login gate.
import './style.css';
import Chart from 'chart.js/auto';   // auto = same all-controllers registration as the old UMD CDN
import { supabase } from './supabase.js';
import { bootstrap, loadAll, profileFromRow, saveProfileRow, upsertEntry, removeEntry, upsertPost, upsertRule, removeRule, setSaveErrorHandler, markTourDone, loadPublicProfiles, loadPublicRules, createInvite, joinWithCode, loadGroupAdmin, removeGroupMember, leaveGroups, loadConnectedWorkouts, loadReactions, addReaction, removeReaction, saveSettings, loadPosts, loadComments, addComment, removeComment, loadCommentReactions, addCommentReaction, removeCommentReaction, loadNotifications, markNotificationsRead } from './db.js';

/* ---------- members ---------- */
// Flat initial state: just me. Friends arrive in the backend/sharing phase (I/I2).
// Re-keyed to the logged-in user's id in bootstrap (see initApp) so members[CURRENT_USER] resolves.
let members = {
  boy:   { name:'ぼーい', ini:'ボ', c:'#14B87C' },
};
// グループ管理: 自分がownerのグループの外せるメンバー[{spaceId,userId}] / 自分が参加(非owner)中で抜けられるグループ
let removableMembers = [];
let joinedSpaceIds = [];
// B-2: つながり相手の今週の運動(仲間の今日の宣言用) / 見えるpost_reactions(post_id,user_id,kind)
let connectedWork = [];
let reactionRows = [];
// コメント(4d)。postId で投稿にぶら下がる(全員に見える=DMにならない構造)。created_at 昇順で保持。
let comments = [];
// コメントへの🔥(comment_reactions・🔥のみ)。{comment_id,user_id} の見える分だけRLSが返す。
let commentReactionRows = [];
// カード単位の表示状態(再描画で保持): コメント全展開。
const commentsOpen = new Set();
// 通知(B-3)。recipient=本人のみRLSで返る。直近30件・新しい順。表示は既知3種のみ(廃止分は出さない)。
let notifications = [];
// クロスユーザーの自由テキスト(コメント本文)は必ずエスケープしてから innerHTML に流す(XSS防止)。
function esc(s){ return (s==null?'':String(s)).replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
// ユーザーが「＋その他」で追加したカスタム部位。users.custom_tags に永続化・全ピッカーの選択肢に出す。
let userParts = [];
// 部位チップ列(HTML): 部位が空なら既定の「運動」チップを出す(部位なしでも空表示にしない)。
function partsOrDefault(tags){ return (tags&&tags.length) ? tags.map(t=>chip(t)).join('') : chip('運動'); }
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
const tagDot = {
  '胸トレ':'#FF6A3D','背中':'#3E86C9','脚':'#7C6CD0',
  '肩':'#E0A53A','腕':'#B5836A','有酸素':'#14B87C','ストレッチ':'#5FB6A8','休養':'#9AA09A'
};
// カスタム部位(＋その他)の色: 既存と調和する固定パレットを、名前のハッシュで安定割当(同名=常に同色)。
const CUSTOM_PALETTE=['#E07A5F','#5B8C9E','#9B7EDE','#D4A15A','#3FA787','#C98BB9','#6FB4A6','#B07A4E'];
function hashStr(s){ let h=0; for(let i=0;i<s.length;i++){ h=(h*31+s.charCodeAt(i))|0; } return Math.abs(h); }
function partColor(tag){
  if(tagDot[tag]) return tagDot[tag];
  if(tag==='運動') return '#9AA09A';   // 部位なしの既定ラベルはニュートラル灰
  return CUSTOM_PALETTE[hashStr(tag)%CUSTOM_PALETTE.length];
}
function avatar(m,size=40,who=''){
  const du = who ? ` data-user="${who}"` : '';   // タップ相手を特定するため
  const base=`avatar-btn cursor-pointer rounded-full shrink-0 flex items-center justify-center text-white font-bold`;
  const letter=`<span style="font-size:${Math.round(size*0.4)}px">${m.ini}</span>`;
  // 頭文字を土台に置き画像を重ねる。null=画像なしで頭文字/壊れ・期限切れURL=onerrorで画像を外し頭文字に戻す。
  if(m.photo) return `<div${du} style="width:${size}px;height:${size}px;background:${m.c}" class="${base} relative overflow-hidden">${letter}<img src="${m.photo}" onerror="this.remove()" class="absolute inset-0 w-full h-full object-cover" alt=""></div>`;
  return `<div${du} style="width:${size}px;height:${size}px;background:${m.c}" class="${base}">${letter}</div>`;
}
function chip(tag,status){
  const dot=partColor(tag);
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
// タイマーは「経過秒」を刻まず、started_at(壁時計)から毎回算出する=バックグラウンド/タブ復帰/再読込でも狂わない。
let timerRunning=false, timerStartedAt=null, timerInterval=null, timerTags=[];
function elapsedSec(){ return timerStartedAt ? Math.max(0, Math.floor((Date.now()-new Date(timerStartedAt).getTime())/1000)) : 0; }
function updateTimerDisp(){ const d=document.getElementById('timerDisp'); if(d) d.textContent=fmtTimer(elapsedSec()); }
let timerFromPlan=false;    // true=今日の予定から開始（既存エントリを更新）／false=予定なし開始（新規追加）
let activeEntryIds=[];      // タイマー作動中に「実施中」表示する予定エントリのid(UI専用・非永続)
let startTags=[];           // category-select (no-plan start)
let pendingPhoto=null, postCtx=null, postTags=[];
const START_CATS=['胸トレ','背中','脚','肩','腕','有酸素','ストレッチ'];
function fmtTimer(s){ return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`; }
function durFromSec(s){ const min=Math.max(1,Math.round(s/60)); if(min<60) return `${min}分`; const h=Math.floor(min/60), mm=min%60; return mm?`${h}時間${mm}分`:`${h}時間`; }
function renderStartBar(){
  const el=document.getElementById('startBarInner'); if(!el) return;
  if(timerRunning){
    el.innerHTML=`<div class="bg-card border border-aline rounded-full shadow-lift pl-5 pr-2 py-2 flex items-center gap-3">
         <span class="flex items-center gap-2 text-[14px] font-extrabold text-ink"><span class="w-2 h-2 rounded-full bg-accent animate-pulse"></span><span id="timerDisp">${fmtTimer(elapsedSec())}</span></span>
         <span class="text-[11px] font-bold text-sub truncate max-w-[110px]">${timerTags.join('・')}</span>
         <button class="stop-workout pop bg-accent text-white text-[12px] font-extrabold rounded-full px-4 py-2">運動終了</button>
       </div>`;
    return;
  }
  // 「運動記録」=後入れで記録(タイマーは記録シート内の計測オプション)。常に出す。
  el.innerHTML = `<button class="record-open pop bg-accent text-white text-[13px] font-extrabold rounded-full shadow-lift px-6 py-3 flex items-center gap-2"><span class="text-[13px]">✎</span>運動記録</button>`;
}
function startTimer(tags, startedAtISO){
  timerTags=(tags||[]).slice();
  timerStartedAt = startedAtISO || new Date().toISOString();   // started_at(永続値)と一致させる
  timerRunning=true;
  if(timerInterval) clearInterval(timerInterval);
  timerInterval=setInterval(updateTimerDisp, 1000);   // 表示更新のみ・経過は毎回 started_at から算出
  renderStartBar();
}
function onStartWorkout(){
  const todays=logEntries.filter(e=>e.type==='workout'&&e.who===CURRENT_USER&&e.date===TODAY);
  const tags=[...new Set(todays.flatMap(e=>e.tags||[]))];
  if(tags.length){
    timerFromPlan=true; activeEntryIds=todays.map(e=>e.id);
    const now=new Date().toISOString();
    todays.forEach(e=>{ e.startedAt=now; upsertEntry(e); });   // 開始を永続化(仲間に🏃/①通知・復元の起点)
    startTimer(tags, now); renderDayList();
  }
  else { timerFromPlan=false; startTags=[]; tagAdding.start=false; renderStartTags(); closeAllSheets('startSheet'); document.getElementById('startScrim').classList.remove('hidden'); document.getElementById('startSheet').classList.add('open'); }
}
function closeStartSheet(){ document.getElementById('startSheet').classList.remove('open'); document.getElementById('startScrim').classList.add('hidden'); }
// 「＋その他」= シートを開かずインライン入力。チップ列の直下に 入力＋追加＋× をその場展開。
// ctx=sheet(予定)/start(運動開始)/post(投稿)。シートを一切開かないので重なりが構造的に起きない。
let tagAdding={ sheet:false, start:false, post:false };
function tagArr(ctx){ return ctx==='start'?startTags : ctx==='post'?postTags : sfTags; }
function tagRender(ctx){ if(ctx==='start') renderStartTags(); else if(ctx==='post') renderPostTags(); else renderSheetTags(); }
function openTagInput(ctx){ tagAdding[ctx]=true; tagRender(ctx); const inp=document.querySelector('.tag-input[data-ctx="'+ctx+'"]'); if(inp) setTimeout(()=>inp.focus(),30); }
function closeTagInput(ctx){ tagAdding[ctx]=false; tagRender(ctx); }   // ×/Esc=入力欄だけ閉じる
function addTagFromInput(ctx){
  const inp=document.querySelector('.tag-input[data-ctx="'+ctx+'"]');
  const v=(inp && inp.value || '').trim();
  const arr=tagArr(ctx);
  if(v){
    if(!arr.includes(v)) arr.push(v);                                   // このピッカーで選択状態に
    if(!SHEET_TAGS.includes(v) && !userParts.includes(v)){ userParts.push(v); persistUserParts(); }  // ユーザー部位リストに保持(次回以降も出る)
    if(ctx==='sheet') sfRest=false;                                     // 部位追加=休養を外す(排他)
  }
  tagAdding[ctx]=false; tagRender(ctx);
}
// カスタム部位の削除(チップの×)。ユーザーリスト＋全ピッカーの選択から外し永続化。既存部位は削除不可。
function deleteCustomPart(tag, ctx){
  const i=userParts.indexOf(tag); if(i>=0) userParts.splice(i,1);
  [sfTags,startTags,postTags].forEach(a=>{ const j=a.indexOf(tag); if(j>=0) a.splice(j,1); });
  persistUserParts(); tagRender(ctx);
}
function persistUserParts(){
  if(!members[CURRENT_USER]) return;
  profile.settings = { ...(profile.settings||{}), customTags: userParts.slice() };   // 他キーを消さずマージ
  saveSettings(CURRENT_USER, profile.settings);
}
// 部位ピッカーのチップ列: 固定部位＋userParts＋(読み込んだ選択のみ)。カスタムは色付き＋×(即削除)。
const SHEET_SET=new Set(['胸トレ','背中','脚','肩','腕','有酸素','ストレッチ']);
const START_SET=new Set(['胸トレ','背中','脚','肩','腕','有酸素','ストレッチ']);
// 選択スタイル(全チップ共通): 選択中=部位色の薄い塗り＋色の内枠＋色文字 / 未選択=白＋色ドット(現状踏襲)。
function selCls(on){ return on ? 'border-transparent' : 'border-line bg-card'; }
function selStyle(color, on){ return on ? `background:${color}22;box-shadow:inset 0 0 0 1.5px ${color};color:${color}` : ''; }
function partChips(fixed, fixedSet, sel, ctx){
  const list=[...fixed];
  userParts.forEach(t=>{ if(!list.includes(t)) list.push(t); });
  sel.forEach(t=>{ if(!list.includes(t)) list.push(t); });   // 既存エントリのカスタム部位も表示に残す
  return list.map(t=>{
    const on=sel.includes(t), custom=!fixedSet.has(t), col=partColor(t);
    // カスタムは×で即削除(確認なし=誤って消してもまた作れる)。要素は inline-flex items-center で垂直中央。
    const del=custom?`<span class="part-del leading-none text-faint" data-tag="${t}" data-ctx="${ctx}" style="font-size:14px">×</span>`:'';
    return `<button class="pk-tag pop inline-flex items-center gap-1.5 text-[12px] font-bold px-3 py-1.5 rounded-full border ${selCls(on)} text-ink" data-tag="${t}" data-ctx="${ctx}" style="${selStyle(col,on)}"><span class="w-1.5 h-1.5 rounded-full shrink-0" style="background:${col}"></span>${t}${del}</button>`;
  }).join('');
}
// チップ列末尾: 通常は「＋その他」/ 追加中はインライン入力行(入力＋追加＋×)。新しいシートは開かない。
function tagAdderHtml(ctx){
  if(tagAdding[ctx]){
    return `<span class="inline-flex items-center gap-1 align-middle">`
      + `<input class="tag-input bg-bg border border-aline rounded-full px-3 py-1.5 text-[12px] font-bold text-ink w-28" type="text" placeholder="部位・メニュー" data-ctx="${ctx}">`
      + `<button class="tag-add pop text-[12px] font-extrabold text-accent px-1.5" data-ctx="${ctx}">追加</button>`
      + `<button class="tag-close pop text-[15px] leading-none text-faint px-1" data-ctx="${ctx}" aria-label="閉じる">×</button>`
      + `</span>`;
  }
  return `<button class="tag-other pop text-[11px] font-bold px-3 py-1.5 rounded-full border border-dashed border-line text-sub bg-card" data-ctx="${ctx}">＋その他</button>`;
}
function renderStartTags(){
  // 固定部位＋userParts(色付き・×削除可)、末尾に「＋その他」
  document.getElementById('startTags').innerHTML = partChips(START_CATS, START_SET, startTags, 'start') + tagAdderHtml('start');
}
function onStartGo(){
  if(!startTags.length) return;
  timerFromPlan=false; closeStartSheet();
  const now=new Date().toISOString();
  // 休養日に運動開始=休養宣言を運動に切り替える(1日1予定を維持・「休養日なのに実施済み」の矛盾を避ける)。
  const rest=logEntries.find(e=>e.type==='rest'&&e.who===CURRENT_USER&&e.date===TODAY);
  let en;
  if(rest){
    rest.type='workout'; rest.tags=startTags.slice(); rest.time='いま'; rest.status='planned'; rest.startedAt=now;
    en=rest; timerFromPlan=true;   // 既存エントリを上書き=新規追加しない
  }else{
    en={id:newId(), date:TODAY, type:'workout', who:CURRENT_USER, tags:startTags.slice(), time:'いま', status:'planned', startedAt:now};
    logEntries.push(en);
  }
  activeEntryIds=[en.id]; upsertEntry(en);
  startTimer(startTags, now); renderDayList();
}
function onStopWorkout(){
  if(timerInterval) clearInterval(timerInterval);
  timerRunning=false;
  const durSec=elapsedSec();           // 経過は started_at(壁時計)基準=バックグラウンドでも正確
  timerStartedAt=null; activeEntryIds=[];
  renderStartBar();
  // 計測後は記録シートへ戻り、実施時間を埋めて「記録する」で確定(done化＋投稿)。ここでは作らない。
  openRecordSheet({ tags: timerTags.slice(), durSec });
}
// （restoreActiveTimer は廃止=タイマーは記録シート内の軽い計測オプションに格下げ。旧「🏃実施中」復元は不要）
function renderPostTags(){
  const el=document.getElementById('psTags'); if(!el) return;
  // 予定/タイマーの部位を初期選択。ジムで変わることがあるので選び直せる。固定＋userParts＋末尾に「＋その他」
  el.innerHTML = partChips(SHEET_TAGS, SHEET_SET, postTags, 'post') + tagAdderHtml('post');
}
// 運動記録シート(旧投稿シートを流用)。後入れで 部位・実施時間(任意)・写真・ひとこと を入れ「記録する」で
// done化＋投稿を一度に作る。タイマーは中の計測オプション。
let recordDurSec=null;   // タイマーで計った秒数(あれば優先・なければ手入力の分を使う)
function openRecordSheet(opts){
  opts=opts||{};
  closeAllSheets('postSheet');
  pendingPhoto=null; tagAdding.post=false;
  // 部位: タイマー計測後はその部位／直接開いた時は今日の予定の部位を初期選択(記録が楽)
  const plan=logEntries.find(e=>e.type==='workout'&&e.who===CURRENT_USER&&e.date===TODAY);
  postTags = (opts.tags && opts.tags.length) ? opts.tags.slice() : (plan ? (plan.tags||[]).slice() : []);
  recordDurSec = opts.durSec ?? null;
  renderPostTags();
  document.getElementById('psDurMin').value = recordDurSec!=null ? Math.max(1,Math.round(recordDurSec/60)) : '';
  document.getElementById('psPhotoPreview').innerHTML='';
  document.getElementById('psText').value='';
  document.getElementById('psCamera').value=''; document.getElementById('psAlbum').value='';
  document.getElementById('postScrim').classList.remove('hidden');
  document.getElementById('postSheet').classList.add('open');
}
function closePostSheet(){ document.getElementById('postSheet').classList.remove('open'); document.getElementById('postScrim').classList.add('hidden'); }
// 記録シート内の「⏱ タイマーで計る」: シートを閉じて計測開始。終了(onStopWorkout)で記録シートに時間が入って戻る。
function startRecordTimer(){ const tags=postTags.slice(); closePostSheet(); startTimer(tags); }
function handlePhoto(file){
  if(!file) return;
  const reader=new FileReader();
  reader.onload=ev=>{ pendingPhoto=ev.target.result; document.getElementById('psPhotoPreview').innerHTML=`<img src="${pendingPhoto}" class="w-full h-40 object-cover rounded-xl mt-2">`; };
  reader.readAsDataURL(file);
}
function submitRecord(){
  const tags=postTags.slice();
  const text=document.getElementById('psText').value.trim();
  const minVal=parseInt(document.getElementById('psDurMin').value);
  const durSec = recordDurSec!=null ? recordDurSec : (!isNaN(minVal)&&minVal>0 ? minVal*60 : null);
  const dur = durSec!=null ? durFromSec(durSec) : null;
  // 今日の予定(運動/休養)があれば done 化(1日1予定維持・休養→運動切替)。無ければ新規done。
  const plan=logEntries.find(e=>(e.type==='workout'||e.type==='rest')&&e.who===CURRENT_USER&&e.date===TODAY);
  let en;
  if(plan){ Object.assign(plan,{type:'workout', tags, status:'done', dur, durSec, time:/^\d{1,2}:\d{2}$/.test(plan.time||'')?plan.time:'いま'}); en=plan; }
  else { en={id:newId(), date:TODAY, type:'workout', who:CURRENT_USER, tags, time:'いま', status:'done', dur, durSec}; logEntries.push(en); }
  upsertEntry(en);
  addPost(createPost({kind:'workout', who:CURRENT_USER, tags, dur, durSec, photo:pendingPhoto, text, scope:'group'}));   // 記録=投稿(通知②の対象)
  pendingPhoto=null; recordDurSec=null;
  closePostSheet();
  rerenderAfterChange();
  showPage('feed');
}
// 記録ヒーローを丸ごと再計算（renderProgressHero に統合。下位互換のため名前は残す）
function renderStats(){ if(typeof renderProgressHero==='function') renderProgressHero(); }
function renderFeedAvatars(){
  // unique posters (up to 3), derived from current posts
  const whos=[...new Set(posts.map(p=>p.who))].filter(k=>members[k]).slice(0,3);
  document.getElementById('feedAvatars').innerHTML =
    whos.map(k=>`<div class="ring-2 ring-bg rounded-full">${avatar(members[k],24)}</div>`).join('');
  const cnt=document.getElementById('feedCount');
  if(cnt){ const n=posts.filter(p=>p.kind!=='achieve'&&isTodayIso(p.createdAt)).length; cnt.textContent=`きょう ${n}件`; }
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
    <article class="relative rounded-2xl bg-card border border-line shadow-card overflow-hidden" data-postcard="${p.id}">
      <div class="flex items-center gap-3 px-4 pt-3.5">
        ${avatar(m,38,p.who)}
        <div class="flex-1">
          <p class="text-[14px] font-extrabold text-ink leading-none">${m.name}</p>
          <p class="text-[11px] text-faint mt-1">${relTime(p.createdAt)}</p>
        </div>
        <div class="flex flex-wrap justify-end gap-1.5">${partsOrDefault(p.tags)}</div>
      </div>
      ${imgBlock}
      ${body}
      ${ruleSection(p)}
      ${fireRow(p)}
      ${commentSection(p)}
    </article>`;
  }).join('');
}
// リアクションは post_reactions が真実(永続・共有)。カウント/自分が付けたかを都度集計。
function reactCount(pid,kind){ return reactionRows.filter(r=>r.post_id===pid&&r.kind===kind).length; }
function reactMine(pid,kind){ return reactionRows.some(r=>r.post_id===pid&&r.kind===kind&&r.user_id===CURRENT_USER); }
function reactBtn(pid,kind,emo){
  const n=reactCount(pid,kind), mine=reactMine(pid,kind);
  return `<button class="react pop flex items-center gap-1.5 border px-3 py-1.5 rounded-full text-[13px] font-bold ${mine?'border-aline bg-asoft text-accent':'border-line bg-card text-sub'}" data-post="${pid}" data-k="${kind}"><span>${emo}</span><span class="cnt">${n}</span></button>`;
}
// リアクションは🔥(エール)のみに統一(💪👏・定型5種は廃止)。ピル=タップでトグル＋カウント表示。
// 加えてカード本体のダブルタップでも🔥が付く(Instagram式・付ける専用、解除はピル)。post_reactionsの
// 旧muscle/clapデータは残置(RLS/GRANTそのまま)だが、集計・表示は kind='fire' だけ見る。
function fireRow(p){
  return `<div class="flex items-center gap-2 px-4 py-3 border-t border-line">${reactBtn(p.id,'fire','🔥')}</div>`;
}
// カード中央に控えめな🔥ポップ(ダブルタップ時)。描画後の要素に後付け→animationendで自ら消える。
function flyFire(el, size=58){
  if(!el) return;
  const s=document.createElement('span');
  s.className='fire-pop'; s.textContent='🔥'; s.style.fontSize=size+'px';
  el.appendChild(s);
  s.addEventListener('animationend', ()=> s.remove());
}
// 投稿への🔥はダブルタップで「付ける」専用(既にあれば維持・再ポップのみ)。解除はピルで。
function addPostFire(pid){
  const already=reactMine(pid,'fire');
  if(!already){ reactionRows.push({post_id:pid,user_id:CURRENT_USER,kind:'fire'}); addReaction(pid,'fire'); renderFeed(); }
  const card=document.querySelector(`[data-postcard="${CSS.escape(pid)}"]`); flyFire(card, 58);
}
// コメントへの🔥はダブルタップでトグル(ボタンは置かず=カウントのみ表示)。付与時だけポップ。
function cFireCount(cid){ return commentReactionRows.filter(r=>r.comment_id===cid).length; }
function cFireMine(cid){ return commentReactionRows.some(r=>r.comment_id===cid && r.user_id===CURRENT_USER); }
function toggleCommentFire(cid){
  const mine=cFireMine(cid);
  if(mine){ commentReactionRows=commentReactionRows.filter(r=>!(r.comment_id===cid && r.user_id===CURRENT_USER)); removeCommentReaction(cid); }
  else{ commentReactionRows.push({comment_id:cid,user_id:CURRENT_USER}); addCommentReaction(cid); }
  renderFeed();
  if(!mine){ const el=document.querySelector(`[data-commentcard="${CSS.escape(cid)}"]`); flyFire(el, 30); }
}
// コメント欄。新しい2件を表示・3件以上は「他N件を見る」で全展開(折りたたみ)。自分のコメントは✕で削除。
// 本文はクロスユーザーの自由テキストなので esc() 必須。入力は投稿カードから直接(画面遷移なし=3〜4分ルール)。
function commentSection(p){
  const cs=comments.filter(c=>c.postId===p.id);   // created_at 昇順
  const open=commentsOpen.has(p.id);
  const shown=open?cs:cs.slice(-2);                // 折りたたみ時=最新2件(末尾2)
  const hiddenN=cs.length-shown.length;
  const moreBtn=(!open&&hiddenN>0)
    ? `<button class="comments-expand pop text-[11px] font-bold text-sub mb-2" data-post="${p.id}">他${hiddenN}件のコメントを見る</button>` : '';
  const rows=shown.map(c=>{
    const m=members[c.who]||{name:'メンバー',ini:'?',c:'#9AA09A',photo:null};
    const del=c.who===CURRENT_USER
      ? `<button class="comment-del pop text-faint text-[12px] ml-1 shrink-0 leading-none" data-id="${c.id}" aria-label="削除">✕</button>` : '';
    // 🔥はダブルタップで付く(ボタンは置かない)。カウントのみ表示・自分が付けていれば teal。
    const fc=cFireCount(c.id), fireTag=fc>0
      ? `<span class="text-[11px] font-bold ${cFireMine(c.id)?'text-accent':'text-faint'} ml-1 shrink-0 leading-none self-center">🔥${fc}</span>` : '';
    return `<div class="relative flex items-start gap-2 mb-2" data-commentcard="${c.id}">
      ${avatar(m,22,c.who)}
      <div class="flex-1 min-w-0"><span class="text-[12px] font-extrabold text-ink">${esc(m.name)}</span><span class="text-[13px] text-ink ml-1.5 break-words">${esc(c.body)}</span></div>
      ${fireTag}${del}</div>`;
  }).join('');
  const composer=`<div class="flex items-center gap-2 ${cs.length?'mt-1':''}">
    <input class="comment-input flex-1 bg-bg border border-line rounded-full px-3.5 py-2 text-[13px] text-ink placeholder:text-faint outline-none focus:border-aline" data-post="${p.id}" placeholder="コメントを書く…" maxlength="300">
    <button class="comment-send pop text-[13px] font-extrabold text-accent shrink-0" data-post="${p.id}">送信</button>
  </div>`;
  return `<div class="px-4 py-3 border-t border-line">${moreBtn}${rows}${composer}</div>`;
}
// コメント送信=楽観更新(即描画)→裏で永続化。送信後は全展開して自分のコメントが隠れないように。
function sendComment(pid){
  const inp=document.querySelector(`.comment-input[data-post="${CSS.escape(pid)}"]`);
  if(!inp) return;
  const body=inp.value.trim(); if(!body) return;
  const c={ id:crypto.randomUUID(), postId:pid, who:CURRENT_USER, body, createdAt:new Date().toISOString() };
  comments.push(c); commentsOpen.add(pid);
  renderFeed();
  addComment(c);
  const ni=document.querySelector(`.comment-input[data-post="${CSS.escape(pid)}"]`); if(ni) ni.focus();
}
function delComment(id){ comments=comments.filter(c=>c.id!==id); renderFeed(); removeComment(id); }

/* ---------- 通知(B-3): 「共有と誘い」のトーンのみ。催促・脅迫の文言は憲法で禁止=絶対に出さない ---------- */
// type→文言。正確な文字列に依存しないよう部分一致で堅牢化。既知3種以外(廃止のトレ開始等)は null=非表示。
function notifText(n){
  const name=(members[n.actor] && members[n.actor].name) || 'メンバー';
  const t=(n.type||'').toLowerCase();
  if(t.includes('comment')) return `${name}さんがコメントしました`;
  if(t.includes('react')||t.includes('fire')||t.includes('like')||t.includes('heart')) return `${name}さんが🔥を送りました`;
  if(t.includes('post')||t.includes('workout')||t.includes('train')||t.includes('entry')) return `${name}さんが運動しました`;
  return null;   // 既知3種以外は表示しない
}
// 表示対象(既知3種のみ)。バッジ・一覧の両方でこの絞り込みを使う。
function visibleNotifs(){ return notifications.filter(n=>notifText(n)!==null); }
// 未読バッジ(赤ドットのみ・件数は出さない=催促トーンを避ける)。
function renderBell(){
  const dot=document.getElementById('bellDot'); if(!dot) return;
  const unread=visibleNotifs().some(n=>!n.read);
  dot.classList.toggle('hidden', !unread);
}
function renderNotifyList(){
  const el=document.getElementById('notifyList'); if(!el) return;
  const list=visibleNotifs();
  if(!list.length){
    el.innerHTML=`<div class="text-center py-10 rounded-2xl bg-bg border border-dashed border-line">
      <p class="text-[26px]">🌱</p>
      <p class="text-[13px] text-faint font-bold mt-2">お知らせはまだありません</p>
    </div>`;
    return;
  }
  el.innerHTML=list.map(n=>{
    const m=members[n.actor]||{name:'メンバー',ini:'?',c:'#9AA09A',photo:null};
    const nav=n.ref_id?` data-notif-post="${n.ref_id}"`:'';
    return `<button class="notif-row pop w-full flex items-center gap-3 rounded-2xl px-3 py-2.5 text-left ${n.read?'':'bg-asoft'}"${nav}>
      ${avatar(m,34,n.actor)}
      <span class="flex-1 min-w-0 text-[13px] text-ink leading-snug">${esc(notifText(n))}</span>
      <span class="text-[11px] text-faint shrink-0">${relTime(n.created_at)}</span>
    </button>`;
  }).join('');
}
// 通知タップ→該当投稿へ。フィードに切替→描画後に data-postcard へスクロール＋一瞬ハイライト。
// 読めない/消えた投稿は何もしない(エラーにしない)。
function gotoNotifPost(postId){
  closeNotify();
  showPage('feed');
  setTimeout(()=>{
    const card=document.querySelector(`[data-postcard="${CSS.escape(postId)}"]`);
    if(!card) return;
    card.scrollIntoView({ behavior:'smooth', block:'center' });
    card.classList.add('notif-hl');
    setTimeout(()=>card.classList.remove('notif-hl'), 1600);
  }, 120);
}
// 投稿カード下部に「投稿時点の公開ルール」を最大3つ併記。焼き込み済みスナップショットのルール名のみを描画。
// 🔥日数は出さない(焼き込み値=投稿時点で、プロフィールのライブ値と食い違い混乱の元。現在の連続は
// プロフィール/自分ルールに一本化)。縦並び=長いルール名でも折り返さず読みやすい。
// 投稿自体に載るので、つながり相手(B)の投稿にも B のルールが正しく出る(他人ルールを別途取得しない)。
function ruleSection(p){
  const snap = p.rulesSnapshot || [];
  if(!snap.length) return '';
  return `<div class="px-4 py-3 border-t border-line">
    <p class="text-[10px] font-bold text-faint mb-1.5">継続中の自分ルール</p>
    <div class="flex flex-col gap-1">${
      snap.map(r=>`<span class="text-[12px] font-bold text-accent">${r.label}</span>`).join('')
    }</div>
  </div>`;
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
// ISO(created_at)が端末ローカルで「今日」か。タイムラインの「きょう◯件」用。
function isTodayIso(iso){ if(!iso) return false; const d=new Date(iso); return ymd(d.getFullYear(),d.getMonth(),d.getDate())===TODAY; }
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
    const hasRest=!has && logEntries.some(e=>e.type==='rest'&&e.date===w.date);   // 休養日はスレートのドット
    const dc=dowColor(w.date);   // 土=青/日祝=赤(faint)。sel/today は teal 優先
    // teal language: selected=teal fill, today=teal ring + "今日" mark (both distinguishable)
    const cardCls = sel?'bg-accent border-accent':(isToday?'bg-card border-accent':'bg-card border-line');
    const labelCls = sel?'text-white/80':(isToday?'text-accent':(dc?'':'text-faint'));
    const labelStyle = (!sel&&!isToday&&dc)?`style="color:${dc}"`:'';
    const numCls = sel?'text-white':(isToday?'text-accent':'text-ink');
    const marker = isToday
      ? `<span class="text-[8px] font-extrabold leading-none ${sel?'text-white/90':'text-accent'}">今日</span>`
      : hasRest
        ? `<span class="w-1 h-1 rounded-full" style="background:${sel?'rgba(255,255,255,.6)':REST_COLOR}"></span>`
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
// 休養(rest)=独立ステータス。落ち着いたスレート＋🌙。運動の緑とは別トーン(ノーシェイム=計画的回復)。
const REST_COLOR='#8993A8';
function workoutCard(p){
  const m=members[p.who]; const s=planStat[p.status]||planStat.planned;
  const isRest = p.type==='rest';
  // 🏃ライブ表示は廃止(ライブ→記録の共有へ転換)。ステータスは 予定/実施済み/休養 のみ。
  const timeTxt = /^\d{1,2}:\d{2}$/.test(p.time||'') ? `予定 ${p.time}` : '予定';   // HH:mm のときだけ時刻
  const sh=memberShare[p.who]||{};
  const wtLine = sh.wt ? `<span class="text-[11px] font-bold ${sh.wt.startsWith('▼')?'text-accent':'text-sub'}">${sh.wt}</span>` : '';
  const partsHtml = isRest
    ? `<span class="inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-1 rounded-full text-white" style="background:${REST_COLOR}">🌙 休養日</span>`
    : partsOrDefault(p.tags);   // 部位なしは「運動」チップ
  const statusHtml = isRest
    ? `<span class="flex items-center gap-1.5 text-[12px] font-bold" style="color:${REST_COLOR}"><span class="w-1.5 h-1.5 rounded-full" style="background:${REST_COLOR}"></span>${p.status==='done'?'休んだ':'休養'}</span>`
    : `<span class="flex items-center gap-1.5 text-[12px] font-bold ${s.cls}"><span class="w-1.5 h-1.5 rounded-full" style="background:${s.dot}"></span>${s.label}</span>`;
  return `<div class="entry-edit pop cursor-pointer flex items-center gap-3 rounded-2xl bg-card border border-line shadow-card p-3.5 ${(!isRest&&s.dim)?'opacity-60':''}" data-id="${p.id}">
    ${avatar(m,40,p.who)}
    <div class="flex-1">
      <div class="flex flex-wrap items-center gap-1.5">
        <span class="text-[14px] font-extrabold text-ink">${m.name}</span>${partsHtml}
      </div>
      ${isRest ? (p.note?`<p class="text-[11px] text-faint mt-1"><span class="font-bold text-[#E0A53A]">${p.note}</span></p>`:'') : `<p class="text-[11px] text-faint mt-1">${timeTxt}${p.note?` ・ <span class="font-bold text-[#E0A53A]">${p.note}</span>`:''}</p>`}
    </div>
    <div class="flex flex-col items-end gap-1">
      ${statusHtml}
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
function renderDayList(){
  document.getElementById('dayListLabel').textContent = fmtLabel(selectedDate);
  // 1日1予定: 選択日に自分の予定があれば「編集」、無ければ「＋ 追記」
  const addBtn=document.getElementById('dayAddBtn'); if(addBtn) addBtn.textContent = todayPlan(selectedDate) ? '編集' : '＋ 追記';
  const items = logEntries.filter(e=>(e.type==='workout'||e.type==='rest')&&e.date===selectedDate);   // 休養も予定リストに出す
  // TODAY は体重を専用カードが担当。非TODAY(過去/未来)はこのリストに出す。食事入力は廃止。
  const weight = logEntries.find(e=>e.type==='weight'&&e.who===CURRENT_USER&&e.date===selectedDate);
  const extra  = selectedDate!==TODAY ? [weight].filter(Boolean) : [];
  const rows = items.map(workoutCard).join('')
    + extra.map(weightRow).join('');
  const empty = selectedDate<TODAY
    ? `<div class="text-center py-7 rounded-2xl bg-card border border-dashed border-line">
         <p class="text-[12px] text-faint font-bold">この日の記録はありません</p>
       </div>`
    : `<div class="text-center py-7 rounded-2xl bg-card border border-dashed border-line">
         <p class="text-[12px] text-faint font-bold">まだ予定がありません</p>
         <p class="text-[11px] text-faint mt-1">「＋追記」で宣言できます</p>
       </div>`;
  // つながっている仲間の同日の運動宣言＋ステータス(自分の下に)。体重/食事は経路になく漏れない。
  const mates = connectedWork.filter(e=>e.date===selectedDate);
  const mateRows = mates.length
    ? `<p class="text-[11px] font-bold text-faint mt-4 mb-1.5 ml-0.5">つながっている仲間</p>` + mates.map(workoutCard).join('')
    : '';
  document.getElementById('planList').innerHTML = ((items.length || extra.length) ? rows : empty) + mateRows;
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
    const isRestDay=!dayTags.length && logEntries.some(e=>e.type==='rest'&&e.date===ds);   // 運動が無く休養がある日
    const dots=(isRestDay
      ? `<span class="w-1.5 h-1.5 rounded-full" style="background:${REST_COLOR}"></span>`
      : dayTags.slice(0,3).map(t=>`<span class="w-1.5 h-1.5 rounded-full" style="background:${partColor(t)}"></span>`).join(''));
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
  const workouts=logEntries.filter(e=>(e.type==='workout'||e.type==='rest')&&e.date===selectedDate);   // 休養も含める
  const restChipHtml=`<span class="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full text-white" style="background:${REST_COLOR}">🌙 休養日</span>`;
  const isPast=selectedDate<TODAY;
  let head, body;
  if(isPast){
    // actuals as of that day: workout 実績 + 体重 (食事入力は廃止)
    head=`<p class="text-[12px] font-bold text-sub mb-2.5">${dateLabel} の記録</p>`;
    const weight=logEntries.find(e=>e.type==='weight'&&e.who===CURRENT_USER&&e.date===selectedDate);
    const rows=[];
    workouts.forEach(e=>{
      const mem=members[e.who]; const s=planStat[e.status]||planStat.done;
      const isRest=e.type==='rest';
      const durTxt=isRest
        ? `<span class="text-[11px] font-bold shrink-0" style="color:${REST_COLOR}">休んだ</span>`
        : (e.dur?`<span class="text-[11px] font-bold text-sub shrink-0">${e.dur}</span>`:`<span class="flex items-center gap-1 text-[11px] font-bold ${s.cls} shrink-0"><span class="w-1.5 h-1.5 rounded-full" style="background:${s.dot}"></span>${s.label}</span>`);
      rows.push(`<div class="entry-edit pop cursor-pointer flex items-center gap-2.5" data-id="${e.id}">
        ${avatar(mem,28)}
        <span class="text-[12px] font-bold text-ink w-12 shrink-0">${mem.name}</span>
        <div class="flex flex-wrap items-center gap-1.5">${isRest?restChipHtml:partsOrDefault(e.tags)}</div>
        <span class="ml-auto">${durTxt}</span>
      </div>`);
    });
    if(weight) rows.push(`<div class="entry-edit pop cursor-pointer flex items-center gap-2.5" data-id="${weight.id}">
      <span class="text-[12px] font-bold text-sub">体重</span>
      <span class="ml-auto text-[13px] font-extrabold text-ink">${weight.kg}<span class="text-[10px] text-faint font-bold ml-0.5">kg</span></span></div>`);
    body = rows.length ? `<div class="space-y-2.5">${rows.join('')}</div>` : `<p class="text-[11px] text-faint">この日の記録はありません</p>`;
  }else{
    // today / future = plan ("誰が何をする")
    head=`<p class="text-[12px] font-bold text-sub mb-2.5">${dateLabel}・誰が何をする</p>`;
    body = workouts.length
      ? `<div class="space-y-2.5">`+workouts.map(e=>{
          const mem=members[e.who]; const s=planStat[e.status]||planStat.planned; const isRest=e.type==='rest';
          const statusChip=isRest
            ? `<span class="ml-auto flex items-center gap-1 text-[11px] font-bold shrink-0" style="color:${REST_COLOR}"><span class="w-1.5 h-1.5 rounded-full" style="background:${REST_COLOR}"></span>休養</span>`
            : `<span class="ml-auto flex items-center gap-1 text-[11px] font-bold ${s.cls} shrink-0"><span class="w-1.5 h-1.5 rounded-full" style="background:${s.dot}"></span>${s.label}</span>`;
          return `<div class="entry-edit pop cursor-pointer flex items-center gap-2.5" data-id="${e.id}">
            ${avatar(mem,28)}
            <span class="text-[12px] font-bold text-ink w-12 shrink-0">${mem.name}</span>
            <div class="flex flex-wrap items-center gap-1.5">${isRest?restChipHtml:partsOrDefault(e.tags)}</div>
            ${statusChip}
          </div>`;
        }).join('')+`</div>`
      : `<p class="text-[11px] text-faint">この日の予定はまだありません</p>`;
  }
  el.innerHTML=`<div class="rounded-2xl bg-card border border-line shadow-card p-3.5">${head}${body}</div>`;
  el.classList.remove('hidden');
}

/* ---------- bottom sheet (declare / log) ---------- */
const SHEET_TAGS=['胸トレ','背中','脚','肩','腕','有酸素','ストレッチ'];   // 休養は部位ではなく独立ステータス(sfRest)へ
let sfType='workout', sfTags=[], sfEditId=null;   // 新規予定は部位を初期選択しない(ユーザーが選ぶ)
let sfRest=false;   // 休養トグル(部位と排他)。true=type:'rest'で保存
function sheetTitle(){
  const ed=sfEditId!=null;
  if(sfType==='workout') return ed?'運動を編集':'予定を宣言';
  return ed?'体重を編集':'体重を記録';
}
function setSheetType(t){
  sfType=t;
  document.querySelectorAll('.sf-type').forEach(b=>{
    const on=b.dataset.sftype===t; b.classList.toggle('active',on); b.classList.toggle('text-sub',!on);
  });
  document.getElementById('sfWorkout').classList.toggle('hidden',t!=='workout');
  document.getElementById('sfWeight').classList.toggle('hidden',t!=='weight');
  document.getElementById('sheetTitle').textContent=sheetTitle();
}
function renderSheetTags(){
  // 並び: 固定部位＋userParts(色付き・×削除可) → 🌙休養 → ＋その他(常に最後)
  // 🌙 休養: 選ぶと部位が全て外れる/部位を選ぶと外れる(排他)。運動の緑とは別トーン。
  const restBtn=`<button class="sf-rest pop inline-flex items-center gap-1 text-[12px] font-bold px-3 py-1.5 rounded-full border ${selCls(sfRest)} text-ink" style="${selStyle(REST_COLOR,sfRest)}">🌙 休養</button>`;
  document.getElementById('sfTags').innerHTML = partChips(SHEET_TAGS, SHEET_SET, sfTags, 'sheet') + restBtn + tagAdderHtml('sheet');
}
// ボトムシートの排他制御: exceptId 以外の全シート/スクリムを閉じる=同時に複数開かない。
// 「親に重ねる」サブシート(tagOther)は except で親を残す。これが3枚重なりバグの根治。
const SHEET_PAIRS=[
  ['sheet','sheetScrim'],['profileSheet','profileScrim'],['notifySheet','notifyScrim'],
  ['settingsSheet','settingsScrim'],['membersSheet','membersScrim'],['memberActSheet','memberActScrim'],
  ['pcSheet','pcScrim'],['ruleSheet','ruleScrim'],
  ['ruleXSheet','ruleXScrim'],['startSheet','startScrim'],['postSheet','postScrim'],
];
function closeAllSheets(exceptId){
  SHEET_PAIRS.forEach(([s,scr])=>{
    if(s===exceptId) return;
    const se=document.getElementById(s); if(se) se.classList.remove('open');
    const sc=document.getElementById(scr); if(sc) sc.classList.add('hidden');
  });
}
function showSheet(){
  closeAllSheets('sheet');   // 予定シートを開く前に他シートを全て閉じる
  document.getElementById('sheetScrim').classList.remove('hidden');
  document.getElementById('sheet').classList.add('open');
}
function openSheet(type, date){
  sfEditId=null; sfTags=[]; sfRest=false; tagAdding.sheet=false;   // 新規は部位未選択・休養オフ・入力も閉じた状態から
  ['sfTime','sfKg'].forEach(id=>{const el=document.getElementById(id); if(el) el.value='';});
  document.getElementById('sfTypeToggle').classList.remove('hidden');
  document.getElementById('sheetDelete').classList.add('hidden');
  setSheetType(type||'workout');
  document.getElementById('sfDate').value=date||selectedDate;   // 本日カードからは TODAY を渡す
  renderSheetTags();
  showSheet();
}
// 1日1予定: 選択日に自分の予定(運動/休養)が既にあれば「編集」、無ければ新規。部位追加/時間変更/休養切替は編集で行う。
function todayPlan(date){ return logEntries.find(e=>(e.type==='workout'||e.type==='rest')&&e.who===CURRENT_USER&&e.date===(date||selectedDate)); }
function openWorkoutPlan(){
  const existing=todayPlan(selectedDate);
  if(existing) openSheetEdit(existing.id); else openSheet('workout', selectedDate);
}
function openSheetEdit(id){
  const en=logEntries.find(x=>x.id===id); if(!en) return;
  sfEditId=id; tagAdding.sheet=false;
  document.getElementById('sfTypeToggle').classList.add('hidden');   // lock type while editing
  document.getElementById('sheetDelete').classList.remove('hidden');
  const isRest=en.type==='rest';
  setSheetType(isRest?'workout':en.type);   // 休養は workout シートで休養トグルON状態で編集
  document.getElementById('sfDate').value=en.date;
  // <input type="time"> は HH:mm のみ受け付ける。'いま'/'—' 等(タイマー由来)は空にして警告を出さない。
  if(en.type==='workout'||isRest){ sfRest=isRest; sfTags=isRest?[]:(en.tags||[]).slice(); renderSheetTags(); document.getElementById('sfTime').value=/^\d{1,2}:\d{2}$/.test(en.time||'')?en.time:''; }
  else if(en.type==='weight'){ document.getElementById('sfKg').value=en.kg; }
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
    // 部位なしも許可(「運動」とだけ記録・投稿シートで後から選べる)。必須にしない。
    // 休養トグルON=type:'rest'(部位なし・独立ステータス)。OFF=type:'workout'。
    const status=editing&&target?target.status:(date<TODAY?'done':'planned');
    const etype = sfRest ? 'rest' : 'workout';
    const fields={date, type:etype, tags:sfRest?[]:sfTags.slice(), time:document.getElementById('sfTime').value||'—', status};
    if(editing&&target){ Object.assign(target,fields); saved=target; }
    else{ saved={id:newId(), who:CURRENT_USER, ...fields}; logEntries.push(saved); }
  }else{ // weight
    const kg=parseFloat(document.getElementById('sfKg').value);
    if(!isNaN(kg)){
      if(editing&&target){ Object.assign(target,{date,kg}); saved=target; }
      else{
        const ex=logEntries.find(e=>e.type==='weight'&&e.who===CURRENT_USER&&e.date===date);
        if(ex){ ex.kg=kg; saved=ex; } else { saved={id:newId(),date,type:'weight',who:CURRENT_USER,kg}; logEntries.push(saved); }
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

/* 食事入力(満腹度ゲージ/kcal)は削除。運動軸に全振り(CLAUDE.md「食事入力を削除した理由」)。satiety/mealデータはDB残置。次は運動記録から消費kcalを貯金として積む。 */
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
  // ミニマル行: ルール名(フル・切れない) ＋ 🔥N(連続日数・Snapchat式・「日目」表記なし) ＋ 公開/非公開マーク ＋ ✕
  list.innerHTML = limits.length ? limits.map((l,i)=>{
    const cur=ruleStreak(l);
    const streakChip = l.streakStart ? `<span class="text-[10px] font-extrabold text-accent ml-2 whitespace-nowrap">🔥${cur}</span>` : '';
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
function openRuleX(i){ closeAllSheets('ruleXSheet'); ruleXTarget=i; document.getElementById('ruleXScrim').classList.remove('hidden'); document.getElementById('ruleXSheet').classList.add('open'); }
function closeRuleX(){ document.getElementById('ruleXSheet').classList.remove('open'); document.getElementById('ruleXScrim').classList.add('hidden'); ruleXTarget=null; }
function replantRule(){ const l=limits[ruleXTarget]; if(l){ l.streakStart=TODAY; upsertRule(l); renderLimits(); if(typeof renderProgressHero==='function') renderProgressHero(); } closeRuleX(); }
function endRule(){ const i=ruleXTarget; const l=limits[i]; if(l){ removeRule(l.id); limits.splice(i,1); renderLimits(); if(typeof renderProgressHero==='function') renderProgressHero(); } closeRuleX(); }

/* ---------- self-rule add + streak (日数ストリーク型) ---------- */
// 記録ヒーローの「連続記録」は当面 各ルールの日数連続の最大を表示(将来=運動ベース・実日付化とセット)。
function curStreak(){ return limits.reduce((m,l)=>Math.max(m,ruleStreak(l)),0); }
function openRule(){
  closeAllSheets('ruleSheet');
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
  return week.map(w=>{ const meal=logEntries.find(e=>e.type==='meal'&&e.who===CURRENT_USER&&e.date===w.date); return (meal&&meal.kcal!=null)?Math.round(meal.kcal-maint):null; });
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

  // カロリー収支チャートは廃止(食事入力削除)。カロリーは消費貯金=treeCardへ。

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
  const wser=weightSeries(mode);
  const hasWB = wser.some(x=>x!=null);
  document.getElementById('weightBody').classList.toggle('hidden', !hasWB);
  document.getElementById('weightEmpty').classList.toggle('hidden', hasWB);
  if(hasWB){
    charts.weight.data.labels=chartLabels[mode];   charts.weight.data.datasets[0].data=wser;   charts.weight.update();
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
  // 今週の消費kcal(月ビュー時は今月)。数字は本人のみ=通帳(CLAUDE.md 推論プライバシー)
  const burn = month ? burnMonth() : burnWeek();
  set('heroBurn', burn>0 ? burn.toLocaleString() : '—');
  renderTree();
}

/* ---------- fit tree: 消費カロリー貯金 → 木の育成 (Phase 1・自分のみ・SQL不要) ----------
   消費kcal = METs × 体重kg × 時間h × 1.05。数字は本人のみ(体重逆算防止=CLAUDE.md「推論プライバシー」)。
   部位タグ→METs。複数タグは平均。カスタムはキーワード一致→既定4.0。休養は対象外。 */
const MET_MAP = { '胸トレ':5.0,'背中':5.0,'脚':5.0,'肩':5.0,'腕':5.0,'有酸素':8.0,'ストレッチ':2.5 };
const MET_DEFAULT = 4.0;   // 部位なし「運動」/ 未知のカスタム部位
const MET_KEYWORDS = [ [/ヨガ|よが|yoga/i,2.5],[/ストレッチ/,2.5],[/ウォーク|ウォーキング|散歩|walk/i,3.5],[/ラン|ランニング|ジョグ|ジョギング|run|jog/i,8.0] ];
function metsForTag(tag){
  if(MET_MAP[tag]!=null) return MET_MAP[tag];
  for(const [re,v] of MET_KEYWORDS){ if(re.test(tag)) return v; }
  return MET_DEFAULT;
}
function metsForEntry(e){
  const tags=(e.tags||[]).filter(Boolean);
  if(!tags.length) return MET_DEFAULT;
  return tags.reduce((s,t)=>s+metsForTag(t),0)/tags.length;   // 複数部位は平均
}
// entry日付に最も近い体重(その日以前の最新→無ければ最古)。1件も無ければ null=計算スキップ。
function weightForDate(date){
  const ws=logEntries.filter(e=>e.type==='weight'&&e.who===CURRENT_USER&&e.kg!=null).slice().sort((a,b)=> a.date<b.date?-1:1);
  if(!ws.length) return null;
  const before=ws.filter(e=>e.date<=date);
  return before.length ? before[before.length-1].kg : ws[0].kg;
}
// 1件の消費kcal(done運動のみ・時間と体重があるときだけ・無ければ0=捏造しない)。
function burnForEntry(e){
  if(e.type!=='workout'||e.status!=='done') return 0;
  const min=durToMin(e.dur); if(!min) return 0;             // 時間未入力=スキップ(回数だけ)
  const kg=weightForDate(e.date); if(kg==null) return 0;    // 体重未入力=スキップ
  return Math.round(metsForEntry(e) * kg * (min/60) * 1.05);
}
function burnInPeriod(pred){ return logEntries.filter(e=>e.who===CURRENT_USER&&pred(e.date)).reduce((s,e)=>s+burnForEntry(e),0); }
function burnTotal(){ return burnInPeriod(()=>true); }                                   // 累計(遡り=初期残高)
function burnWeek(){ return burnInPeriod(d=> week.some(w=>w.date===d)); }
function burnMonth(){ const {y,m}=parseYmd(TODAY); return burnInPeriod(d=>{ const p=parseYmd(d); return p.y===y&&p.m===m; }); }
function hasAnyWeight(){ return logEntries.some(e=>e.type==='weight'&&e.who===CURRENT_USER&&e.kg!=null); }

// 成長段階の閾値(累計消費kcal)。★ハードコード集約=将来実データで調整する前提★
const TREE_STAGES = [
  { min:0,     label:'種',   emoji:'🌰' },
  { min:300,   label:'芽',   emoji:'🌱' },
  { min:1500,  label:'若葉', emoji:'🌿' },
  { min:4000,  label:'苗木', emoji:'🪴' },
  { min:9000,  label:'若木', emoji:'🌲' },
  { min:20000, label:'成木', emoji:null },   // null=種類ごとの絵文字(mature)を使う
  { min:40000, label:'開花', emoji:null },   // 種類ごとの開花/結実(bloom)を使う
];
// 植物の種類(絵文字ベース)。ランダム抽選→users.settings に永続。種を選べる機能は将来のプレミアム候補(TODO)。
const TREE_SPECIES = [
  { key:'sakura', name:'さくら',   mature:'🌳', bloom:'🌸' },
  { key:'momiji', name:'もみじ',   mature:'🌳', bloom:'🍁' },
  { key:'mikan',  name:'みかん',   mature:'🌳', bloom:'🍊' },
  { key:'ringo',  name:'りんご',   mature:'🌳', bloom:'🍎' },
  { key:'matsu',  name:'まつ',     mature:'🌲', bloom:'🌲' },
  { key:'yashi',  name:'やし',     mature:'🌴', bloom:'🥥' },
  { key:'olive',  name:'オリーブ', mature:'🌳', bloom:'🫒' },
];
function treeSpecies(){
  let sp=TREE_SPECIES.find(s=>s.key===(profile.settings&&profile.settings.treeSpecies));
  if(!sp){ sp=TREE_SPECIES[Math.floor(Math.random()*TREE_SPECIES.length)];   // 初回のみ抽選→固定
    profile.settings={ ...(profile.settings||{}), treeSpecies:sp.key };
    saveSettings(CURRENT_USER, profile.settings);
  }
  return sp;
}
function treeStage(total){ let i=0; TREE_STAGES.forEach((s,k)=>{ if(total>=s.min) i=k; }); return { ...TREE_STAGES[i], idx:i }; }
function treeEmoji(stage, sp){ return stage.emoji || (stage.label==='開花'?sp.bloom:sp.mature); }
function renderTree(){
  const el=document.getElementById('treeCard'); if(!el) return;
  const total=burnTotal(), sp=treeSpecies(), stage=treeStage(total), emoji=treeEmoji(stage,sp);
  const nextMin = stage.idx+1<TREE_STAGES.length ? TREE_STAGES[stage.idx+1].min : null;
  const foot = !hasAnyWeight()
    ? `<p class="text-[11px] text-accent font-bold mt-2">🚿 体重を入れると水やりできる（消費カロリーが計算されます）</p>`
    : (nextMin!=null
        ? `<p class="text-[10px] text-faint font-bold mt-2">次の段階まで あと ${(nextMin-total).toLocaleString()} kcal</p>`
        : `<p class="text-[10px] text-accent font-bold mt-2">🌟 最後まで育ちました</p>`);
  el.innerHTML=`
    <div class="flex items-center gap-4">
      <div class="text-[52px] leading-none select-none">${emoji}</div>
      <div class="flex-1 min-w-0">
        <p class="text-[13px] font-extrabold text-ink">${sp.name}の木・${stage.label}</p>
        <p class="text-[11px] text-faint font-bold mt-0.5">累計消費 <span class="text-accent font-extrabold text-[13px]">${total.toLocaleString()}</span> kcal</p>
        <div class="flex gap-4 mt-1">
          <p class="text-[10px] text-faint font-bold">今週 <span class="text-ink font-extrabold">${burnWeek().toLocaleString()}</span></p>
          <p class="text-[10px] text-faint font-bold">今月 <span class="text-ink font-extrabold">${burnMonth().toLocaleString()}</span></p>
        </div>
        ${foot}
      </div>
    </div>
    <p class="text-[9px] text-faint mt-3">※消費カロリーはMETsからの概算です。この数字はあなただけに表示されます。</p>`;
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
  closeAllSheets('profileSheet');
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
  return `<div class="flex items-center gap-2 rounded-xl border border-line bg-card px-3 py-2"><span class="text-[14px]">${l.emoji||'🎯'}</span><span class="flex-1 text-[13px] font-bold text-ink truncate">${l.label}</span>${l.streakStart?`<span class="text-[11px] font-extrabold text-accent whitespace-nowrap">🔥${ruleStreak(l)}</span>`:''}</div>`;
}
// マイページのサマリー(自分のカードのみ): 木・連続記録・つながり人数・参加グループ数。
// 数字は本人だけが見る=通帳(消費kcalは出さない・木の姿と回数系のみ)。◯代目(世代)はPhase 2で。
function mySummaryHtml(){
  const sp=treeSpecies(), stage=treeStage(burnTotal()), emoji=treeEmoji(stage,sp);
  const conns=Object.keys(members).filter(id=>id!==CURRENT_USER).length;
  const groups=1 + (Array.isArray(joinedSpaceIds)?joinedSpaceIds.length:0);   // 自分のグループ＋参加中
  const cell=(v,label)=>`<div class="text-center px-1"><p class="text-[17px] font-extrabold text-ink leading-none">${v}</p><p class="text-[10px] text-faint font-bold mt-1">${label}</p></div>`;
  return `
    <div class="rounded-2xl bg-asoft border border-aline px-4 py-3 flex items-center gap-3 mb-3">
      <div class="text-[34px] leading-none select-none">${emoji}</div>
      <div class="min-w-0"><p class="text-[12px] font-extrabold text-ink truncate">${sp.name}の木・${stage.label}</p>
        <p class="text-[10px] text-faint font-bold mt-0.5">運動を続けて育てよう</p></div>
    </div>
    <div class="grid grid-cols-3 divide-x divide-line">
      ${cell('🔥'+curStreak(),'連続記録')}${cell(conns,'つながり')}${cell(groups,'グループ')}
    </div>`;
}
// タップされた相手のカードを表示。自分=own limits＋マイページサマリー、相手=公開ルールをその都度取得(rules RLSがpub＋つながりを担保)。
let pcFromMembers=false;
async function openProfileCard(userId){
  pcFromMembers = document.getElementById('membersSheet').classList.contains('open');   // 復帰先の記憶
  closeAllSheets();   // 常に1枚
  const id = userId || CURRENT_USER;
  const isSelf = id===CURRENT_USER;
  const m = members[id] || {};
  applyAvatarEl(document.getElementById('pcAvatar'), m);
  const nm=document.getElementById('pcName'); if(nm) nm.textContent=m.name||'';
  // 自分のみ: サマリー表示＋編集ボタン。相手は非表示。
  const sum=document.getElementById('pcSummary');
  if(sum){ sum.classList.toggle('hidden', !isSelf); sum.innerHTML = isSelf ? mySummaryHtml() : ''; }
  document.getElementById('pcEdit').classList.toggle('hidden', !isSelf);
  const head=document.getElementById('pcRulesHead'); if(head) head.textContent = `${m.name||''}の自分ルール`;
  const el=document.getElementById('pcRules');
  if(el) el.innerHTML=`<p class="text-[12px] text-faint text-center py-3">…</p>`;
  document.getElementById('pcScrim').classList.remove('hidden');
  document.getElementById('pcSheet').classList.add('open');
  const rules = isSelf ? limits.filter(l=>l.pub) : await loadPublicRules(id);
  const pub = rules.filter(l=>l.streakStart).slice(0,3);
  if(el) el.innerHTML = pub.length
    ? pub.map(pcRuleRow).join('')
    : `<p class="text-[12px] text-faint text-center py-3">公開中のルールはありません</p>`;
}
function closeProfileCard(){
  document.getElementById('pcSheet').classList.remove('open');
  document.getElementById('pcScrim').classList.add('hidden');
  if(pcFromMembers){ pcFromMembers=false; openMembers(); }   // メンバー一覧から来たら戻る
}
// つながっているメンバー一覧(自分＋public_profilesで見えるつながり相手)。名前・アバターを一覧表示。
// スペース切替ではなく「つながっている人の一覧」(つながり型)。行内アバターのタップ→その人のプロフィールカード。
function renderMembersList(){
  const el=document.getElementById('membersList'); if(!el) return;
  const removableMap=new Map(removableMembers.map(r=>[r.userId, r.spaceId]));   // 外せる人→対象space
  const others=Object.keys(members).filter(id=>id!==CURRENT_USER);
  const row=(id,isSelf)=>{
    const m=members[id];
    // ownerである自分だけに見える「外す」(自分以外＆自グループのメンバー)。RLSが最終門番。
    const removeBtn=(!isSelf && removableMap.has(id))
      ? `<button class="member-remove pop text-[11px] font-bold text-faint border border-line rounded-full px-2.5 py-1 shrink-0" data-user="${id}" data-space="${removableMap.get(id)}">外す</button>`
      : '';
    return `<div class="flex items-center gap-3 rounded-2xl border border-line bg-card px-3 py-2.5">
      ${avatar(m,36,id)}
      <span class="flex-1 text-[13px] font-bold text-ink truncate">${m.name||'メンバー'}</span>
      ${isSelf?'<span class="text-[10px] font-bold text-faint shrink-0">あなた</span>':removeBtn}
    </div>`;
  };
  el.innerHTML = row(CURRENT_USER,true) + others.map(id=>row(id,false)).join('')
    + (others.length?'':'<p class="text-[12px] text-faint text-center py-3">まだ他のメンバーはいません。招待コードでつながれます</p>')
    // 参加(非owner)中のグループがあるときだけ「グループを抜ける」を出す(ノーシェイム・静かに)
    + (joinedSpaceIds.length?`<button class="group-leave pop w-full mt-3 text-[12px] font-bold text-sub border border-line rounded-2xl py-2.5">グループを抜ける</button>`:'');
}
function openMembers(){ closeAllSheets('membersSheet'); renderMembersList(); document.getElementById('membersScrim').classList.remove('hidden'); document.getElementById('membersSheet').classList.add('open'); }
function closeMembers(){ document.getElementById('membersSheet').classList.remove('open'); document.getElementById('membersScrim').classList.add('hidden'); }
// メンバー排除/離脱の確認シート(JSのconfirm()は使わない=画面ブロック回避)。
let memberAct=null;   // {kind:'remove',userId,spaceId} | {kind:'leave',spaceIds:[]}
function openMemberRemove(userId, spaceId){
  closeAllSheets();   // 常に1枚
  const m=members[userId]||{};
  memberAct={kind:'remove', userId, spaceId};
  document.getElementById('memberActMsg').textContent=`${m.name||'この人'}をグループから外しますか？`;
  document.getElementById('memberActConfirm').textContent='外す';
  document.getElementById('memberActScrim').classList.remove('hidden');
  document.getElementById('memberActSheet').classList.add('open');
}
function openGroupLeave(){
  closeAllSheets();   // 常に1枚
  memberAct={kind:'leave', spaceIds:joinedSpaceIds.slice()};
  document.getElementById('memberActMsg').textContent='参加しているグループから抜けますか？（つながりが解除されます）';
  document.getElementById('memberActConfirm').textContent='抜ける';
  document.getElementById('memberActScrim').classList.remove('hidden');
  document.getElementById('memberActSheet').classList.add('open');
}
function closeMemberAct(reopenMembers){
  document.getElementById('memberActSheet').classList.remove('open');
  document.getElementById('memberActScrim').classList.add('hidden');
  memberAct=null;
  if(reopenMembers) openMembers();   // キャンセル時はメンバー一覧へ復帰
}
async function confirmMemberAct(){
  const act=memberAct; closeMemberAct(false);   // 実行後はreloadするので復帰不要
  if(!act) return;
  const ok = act.kind==='remove'
    ? await removeGroupMember(act.spaceId, act.userId)
    : await leaveGroups(act.spaceIds);
  if(ok){ showToast(act.kind==='remove'?'グループから外しました':'グループを抜けました'); setTimeout(()=>location.reload(), 700); }
  else showToast('操作に失敗しました。通信を確認してください');
}
/* ---------- 通知パネル / 設定 / オンボーディングツアー(器) ---------- */
function openNotify(){
  closeAllSheets('notifySheet');
  renderNotifyList();
  document.getElementById('notifyScrim').classList.remove('hidden'); document.getElementById('notifySheet').classList.add('open');
  // 開いた瞬間に既読化(楽観: ローカルを既読→ドット消し→裏でDB更新)。憲法トーン=静かに消えるだけ。
  if(visibleNotifs().some(n=>!n.read)){
    notifications.forEach(n=>{ n.read=true; }); renderBell();
    markNotificationsRead();
  }
}
function closeNotify(){ document.getElementById('notifySheet').classList.remove('open'); document.getElementById('notifyScrim').classList.add('hidden'); }
function openSettings(){ closeAllSheets('settingsSheet'); document.getElementById('settingsScrim').classList.remove('hidden'); document.getElementById('settingsSheet').classList.add('open'); }
function closeSettings(){ document.getElementById('settingsSheet').classList.remove('open'); document.getElementById('settingsScrim').classList.add('hidden'); }
// つながる(グループ招待): コード発行/コピー/参加。設定とメンバーシートの両方でインライン発行できる(scopeで表示先を切替)。
let lastInviteCode=null;
const INVITE_BOX={ settings:{code:'inviteCode', box:'inviteCodeBox'}, members:{code:'mInviteCode', box:'mInviteBox'} };
async function onGenInvite(scope='settings'){
  const t=INVITE_BOX[scope]||INVITE_BOX.settings;
  const inv=await createInvite(SPACE_ID);
  const code = inv && inv.code;
  if(!code){ console.error('invite: コードを取り出せません', inv); showToast('招待コードの発行に失敗しました。通信を確認してください'); return; }
  lastInviteCode=code;
  document.getElementById(t.code).textContent=code;
  document.getElementById(t.box).classList.remove('hidden');
}
async function onCopyInvite(scope='settings'){
  if(!lastInviteCode) return;
  try{ await navigator.clipboard.writeText(lastInviteCode); showToast('コピーしました'); }
  catch(err){
    // clipboard API不可(古い環境/権限)時はコード文字列を選択状態にして手動コピーを促す
    const t=INVITE_BOX[scope]||INVITE_BOX.settings;
    const el=document.getElementById(t.code);
    if(el){ const r=document.createRange(); r.selectNodeContents(el); const s=window.getSelection(); s.removeAllRanges(); s.addRange(r); }
    showToast('コードを選択しました。長押しでコピーしてください');
  }
}
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
// （「＋その他」は tagAdderHtml/openTagInput 等のインライン方式に置換済み=シートを開かない）
// nick is the single source of truth for display name + avatar initial (header + 記録 hero).
// 画像があれば画像、無ければ頭文字(ヘッダ・記録ヒーロー・プロフィールシート共通)
function applyAvatarEl(el, m){ if(!el || !m) return;
  el.style.backgroundImage='';
  el.textContent = m.ini || '?';   // 頭文字を土台に(画像失敗時のフォールバック)
  if(m.photo){
    el.style.position='relative'; el.style.overflow='hidden';
    const img=document.createElement('img');
    img.src=m.photo; img.alt=''; img.className='absolute inset-0 w-full h-full object-cover';
    img.onerror=()=>img.remove();   // 壊れ/期限切れURLなら外して頭文字に戻す
    el.appendChild(img);
  }
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
  if(id==='schedule'||id==='feed') refreshConnected({forceFeed:true});   // 画面に入った瞬間に最新化(明示=即描画)
}
// フィードを見ているか(スクロール保護のため・見ている時は再構築しない)
function feedIsActive(){ const f=document.getElementById('feed'); return !!(f && f.classList.contains('active')); }
// A/B/C共通の土台。つながり相手の運動(connectedWork)＋リアクション＋投稿を再取得して再描画。
// 使うのは既存のRLS実証済みロードのみ=新しい漏洩経路なし(体重/食事は取得列にもRLSにも乗らない)。
let refreshing=false, lastRefresh=0;
// opts.forceFeed=true(タブ入場・プル更新)は必ずフィード再描画。背面更新は「上部にいる時だけ」再描画=
// スクロール中に飛ばさない。フィード非表示なら常に再描画。→「タイムラインを開いても新着が出ない」の根治。
async function refreshConnected(opts={}){
  if(refreshing || CURRENT_USER==='boy') return; refreshing=true; lastRefresh=Date.now();
  try{
    const wk=buildWeek(TODAY);
    const [cw, rx, ps, cm, crx, nt]=await Promise.all([ loadConnectedWorkouts(wk[0].date, wk[6].date), loadReactions(), loadPosts(), loadComments(), loadCommentReactions(), loadNotifications() ]);
    connectedWork=cw; reactionRows=rx; comments=cm; commentReactionRows=crx; notifications=nt; renderBell();
    const prevIds = posts.map(p=>p.id).join(',');
    if(ps){ posts.length=0; posts.push(...ps); }
    const changed = !!ps && posts.map(p=>p.id).join(',')!==prevIds;
    connectedWork.forEach(e=>{ if(e.who && !members[e.who]) members[e.who]={ name:'メンバー', ini:'?', c:'#9AA09A', photo:null }; });
    posts.forEach(p=>{ if(p.who && !members[p.who]) members[p.who]={ name:'メンバー', ini:'?', c:'#9AA09A', photo:null }; });
    renderDayList(); renderGroup();
    const main=document.querySelector('main');
    const nearTop = !main || main.scrollTop < 80;
    // コメント入力中(フォーカス中)は背面再描画で入力を飛ばさない(明示更新=forceFeedは除く)
    const typing = document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('comment-input');
    if(opts.forceFeed || (!typing && (!feedIsActive() || (changed && nearTop)))) renderFeed();   // 見ている最中でも上部なら反映
  }catch(err){ console.error('refreshConnected failed:', err.message || err); }
  finally{ refreshing=false; }
}
// 復帰/ポーリングからの更新はデバウンス(直近8秒以内は叩かない=多重発火/バッテリー配慮)。
// 明示更新(タブ入場・プル)は forceFeed で即時・デバウンス対象外。
function refreshIfStale(){ if(Date.now()-lastRefresh > 8000) refreshConnected(); }
function onSyncPage(){ return ['schedule','feed'].some(id=>{ const el=document.getElementById(id); return el && el.classList.contains('active'); }); }
document.querySelectorAll('.nav-btn').forEach(b=> b.addEventListener('click',()=>showPage(b.dataset.page)));
// コメント入力で Enter=送信(改行しない・投稿カードから直接送れる)
document.addEventListener('keydown',e=>{
  if(e.key==='Enter' && e.target.classList && e.target.classList.contains('comment-input')){
    e.preventDefault(); sendComment(e.target.dataset.post);
  }
});
// ダブルタップ/ダブルクリックで🔥。コメント上ならコメント🔥(トグル)、それ以外は投稿🔥(付ける専用)。
// 操作系(ボタン/入力/リンク)の上では発火しない=誤操作防止。
function handleDoubleFire(target){
  if(!target || (target.closest && target.closest('button, input, textarea, a'))) return;
  const cc=target.closest && target.closest('[data-commentcard]'); if(cc){ toggleCommentFire(cc.dataset.commentcard); return; }
  const pc=target.closest && target.closest('[data-postcard]');    if(pc){ addPostFire(pc.dataset.postcard); return; }
}
document.addEventListener('dblclick', e=> handleDoubleFire(e.target));
// モバイル: touchend の300ms二連(近接)で疑似ダブルタップ。consume時は既定操作(ズーム/合成click)を抑止。
let _lastTapT=0, _lastTapX=0, _lastTapY=0;
document.addEventListener('touchend', e=>{
  const t=e.changedTouches && e.changedTouches[0]; if(!t) return;
  const now=Date.now(), dt=now-_lastTapT;
  const dx=Math.abs(t.clientX-_lastTapX), dy=Math.abs(t.clientY-_lastTapY);
  if(dt>0 && dt<300 && dx<24 && dy<24){
    if(e.target.closest && e.target.closest('[data-postcard]') && !e.target.closest('button, input, textarea, a')){ e.preventDefault(); }
    handleDoubleFire(e.target); _lastTapT=0;
  } else { _lastTapT=now; _lastTapX=t.clientX; _lastTapY=t.clientY; }
}, { passive:false });

document.addEventListener('click',e=>{
  // ツアー表示中は「次へ/スキップ」以外のクリックを全遮断(背面UIの誤操作・シート誤起動を根絶)
  if(tourOpen){ if(e.target.closest('#tourNext')) tourNext(); else if(e.target.closest('#tourSkip')) endTour(); return; }
  // 「＋その他」インライン入力(シートを開かない)。処理後 return で後続ハンドラに伝播させない。
  { const to=e.target.closest('.tag-other'); if(to){ openTagInput(to.dataset.ctx); return; } }
  { const ta=e.target.closest('.tag-add');   if(ta){ addTagFromInput(ta.dataset.ctx); return; } }
  { const tc=e.target.closest('.tag-close'); if(tc){ closeTagInput(tc.dataset.ctx); return; } }
  // 部位チップ: ×=即削除(確認なし) / 本体=選択トグル。全ピッカー共通(data-ctx)。
  { const pd=e.target.closest('.part-del'); if(pd){ deleteCustomPart(pd.dataset.tag, pd.dataset.ctx); return; } }
  { const pk=e.target.closest('.pk-tag'); if(pk){ const t=pk.dataset.tag, ctx=pk.dataset.ctx, a=tagArr(ctx); const i=a.indexOf(t); if(i>=0) a.splice(i,1); else a.push(t); if(ctx==='sheet') sfRest=false; tagRender(ctx); return; } }
  const r=e.target.closest('.react');
  if(r){
    const pid=r.dataset.post, kind=r.dataset.k;
    // 楽観更新(ローカル即反映)→裏で永続化。付け外しのトグル。付与時は③通知がB-1トリガーで発火。
    if(reactMine(pid,kind)){ reactionRows=reactionRows.filter(x=>!(x.post_id===pid&&x.user_id===CURRENT_USER&&x.kind===kind)); removeReaction(pid,kind); }
    else{ reactionRows.push({post_id:pid,user_id:CURRENT_USER,kind}); addReaction(pid,kind); }
    renderFeed();
  }
  // コメント全展開 / コメント送信・削除(投稿カードから直接)
  { const ce=e.target.closest('.comments-expand'); if(ce){ commentsOpen.add(ce.dataset.post); renderFeed(); return; } }
  { const cs=e.target.closest('.comment-send');    if(cs){ sendComment(cs.dataset.post); return; } }
  { const cd=e.target.closest('.comment-del');     if(cd){ delComment(cd.dataset.id); return; } }
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
  { const ab=e.target.closest('.avatar-btn'); if(ab) openProfileCard(ab.dataset.user); }   // タップされた相手のカード
  if(e.target.closest('#pcClose')||e.target.closest('#pcScrim')) closeProfileCard();
  const eedit=e.target.closest('.entry-edit'); if(eedit && !e.target.closest('.avatar-btn')) openSheetEdit(eedit.dataset.id);
  if(e.target.closest('#sheetDelete')) deleteEntry();
  if(e.target.closest('.rule-add')) openRule();
  if(e.target.closest('#ruleSave')) saveRule();
  if(e.target.closest('#ruleCancel')||e.target.closest('#ruleScrim')) closeRule();
  if(e.target.closest('.record-open')) openRecordSheet();   // FAB「運動記録」→記録シート
  if(e.target.closest('#psTimerBtn')) startRecordTimer();   // 記録シート内「⏱ タイマーで計る」
  if(e.target.closest('.stop-workout')) onStopWorkout();
  if(e.target.closest('#startGo')) onStartGo();
  if(e.target.closest('#startCancel')||e.target.closest('#startScrim')) closeStartSheet();
  if(e.target.closest('#psCameraBtn')) document.getElementById('psCamera').click();   // カメラ直接起動
  if(e.target.closest('#psAlbumBtn')) document.getElementById('psAlbum').click();      // アルバム選択
  if(e.target.closest('#postSubmit')) submitRecord();
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

  if(e.target.closest('.declare-btn')||e.target.closest('.day-add')) openWorkoutPlan();   // 既存予定があれば編集/無ければ新規(1日1予定)
  if(e.target.closest('.weight-add')) openSheet('weight', TODAY);   // 本日の体重カード → TODAY固定
  const sft=e.target.closest('.sf-type'); if(sft) setSheetType(sft.dataset.sftype);
  if(e.target.closest('.sf-rest')){ sfRest=!sfRest; if(sfRest) sfTags=[]; renderSheetTags(); }   // 休養=部位を全て外す(排他)
  if(e.target.closest('#sheetConfirm')) confirmSheet();
  if(e.target.closest('#sheetCancel')||e.target.closest('#sheetScrim')) closeSheet();

  if(e.target.closest('#profileBtn')) openProfileCard(CURRENT_USER);   // ヘッダ右上=マイページ(サマリーカード)
  if(e.target.closest('#pcEdit')) openProfile();                       // カード内「編集」→プロフィール編集シート
  if(e.target.closest('#pfEditPhoto')) showToast('プロフィール画像の変更は近日対応します');   // 画像変更=Phase 5
  if(e.target.closest('#profileSave')) saveProfile();
  if(e.target.closest('#profileCancel')||e.target.closest('#profileScrim')) closeProfile();
  // メンバー一覧 / 通知ベル / 設定 / ツアー
  if(e.target.closest('#membersBtn')) openMembers();
  if(e.target.closest('#membersClose')||e.target.closest('#membersScrim')) closeMembers();
  if(e.target.closest('#membersInvite')) onGenInvite('members');   // メンバーシート内でインライン発行(遷移しない)
  if(e.target.closest('#mCopyInvite')) onCopyInvite('members');
  { const mr=e.target.closest('.member-remove'); if(mr) openMemberRemove(mr.dataset.user, mr.dataset.space); }
  if(e.target.closest('.group-leave')) openGroupLeave();
  if(e.target.closest('#memberActConfirm')) confirmMemberAct();
  if(e.target.closest('#memberActCancel')||e.target.closest('#memberActScrim')) closeMemberAct(true);
  if(e.target.closest('#bellBtn')) openNotify();
  if(e.target.closest('#notifyClose')||e.target.closest('#notifyScrim')) closeNotify();
  if(e.target.closest('#notifyTour')){ closeNotify(); openTour(); }
  { const nr=e.target.closest('.notif-row'); if(nr && nr.dataset.notifPost){ gotoNotifPost(nr.dataset.notifPost); return; } }
  if(e.target.closest('#openSettings')) openSettings();
  if(e.target.closest('#settingsClose')||e.target.closest('#settingsScrim')) closeSettings();
  if(e.target.closest('#settingsTour')){ closeSettings(); openTour(); }
  if(e.target.closest('#settingsLogout')){ closeSettings(); supabase.auth.signOut(); }
  if(e.target.closest('.open-connect')) openSettings();   // 新規ログイン後の参加入口→設定「つながる」欄へ
  if(e.target.closest('#genInvite')) onGenInvite('settings');
  if(e.target.closest('#copyInvite')) onCopyInvite('settings');
  if(e.target.closest('#joinBtn')) onJoin();
  // #tourNext/#tourSkip はツアー中のみ存在し、上部のガードで処理する
});
// live maintenance preview while editing the profile sheet
document.addEventListener('input', e=>{ if(e.target.closest('#profileSheet')) updateProfilePreview(); });
document.addEventListener('change', e=>{ if(e.target.id==='psCamera'||e.target.id==='psAlbum') handlePhoto(e.target.files && e.target.files[0]); });
// 復帰検知の強化: モバイルでは visibilitychange 単独だと復帰時に発火しないことがある
// (iOS Safariのアプリ切替/ホーム復帰/bfcache復元)。pageshow・focus・online も併用しデバウンスで束ねる。
// タイマー表示も復帰時に即補正(バックグラウンドのsetInterval間引きを吸収・経過はstarted_at基準)。
function onResume(){ if(document.hidden) return; if(timerRunning) updateTimerDisp(); refreshIfStale(); }
document.addEventListener('visibilitychange', onResume);
window.addEventListener('pageshow', onResume);
window.addEventListener('focus', onResume);
window.addEventListener('online', onResume);
// 緩いポーリング(90秒): ライブ感でなく「開いている画面が古すぎない」保険。表示中かつ同期対象ページのみ・背面は叩かない。
setInterval(()=>{ if(!document.hidden && onSyncPage()) refreshIfStale(); }, 90000);
// プル・トゥ・リフレッシュ(Instagram式): main を最上部で下に引っ張ると明示更新。同期ページのみ。
(function initPullToRefresh(){
  const main=document.querySelector('main'); if(!main) return;
  const ind=document.getElementById('ptrIndicator');
  const THRESH=70; let startY=0, pulling=false, ready=false;
  const reset=()=>{ if(ind){ ind.style.height='0px'; ind.style.opacity='0'; } };
  main.addEventListener('touchstart',e=>{
    if(main.scrollTop>0 || !onSyncPage()){ pulling=false; return; }
    startY=e.touches[0].clientY; pulling=true; ready=false;
  },{passive:true});
  main.addEventListener('touchmove',e=>{
    if(!pulling) return;
    const dy=e.touches[0].clientY-startY;
    if(dy<=0){ reset(); ready=false; return; }
    const pull=Math.min(dy*0.5, 90);
    if(ind){ ind.style.height=pull+'px'; ind.style.opacity=String(Math.min(pull/THRESH,1)); ind.textContent = pull>=THRESH?'離して更新':'引っ張って更新'; }
    ready = pull>=THRESH;
  },{passive:true});
  main.addEventListener('touchend',()=>{
    if(!pulling) return; pulling=false;
    if(ready){ if(ind){ ind.textContent='更新中…'; } refreshConnected({forceFeed:true}).finally(reset); }
    else reset();
  });
})();
// 「＋その他」インライン入力: Enter=追加 / Esc=閉じる
document.addEventListener('keydown', e=>{
  const inp=e.target; if(!inp.classList || !inp.classList.contains('tag-input')) return;
  if(e.key==='Enter'){ e.preventDefault(); addTagFromInput(inp.dataset.ctx); }
  else if(e.key==='Escape'){ e.preventDefault(); closeTagInput(inp.dataset.ctx); }
});

/* ---------- init (runs once, after login) ---------- */
let appStarted=false;
async function initApp(session){
  if(appStarted) return; appStarted=true;
  try{
    // users row + personal space, then load cloud data into the in-memory stores.
    const { userId, spaceId, urow } = await bootstrap(session);
    CURRENT_USER=userId; SPACE_ID=spaceId;
    Object.assign(profile, profileFromRow(urow));
    userParts = ((profile.settings && profile.settings.customTags) || []).slice();   // settings.customTags から復元
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
    // グループ管理: 外せるメンバー＋抜けられるグループを解決(メンバー一覧の管理操作用)
    const ga = await loadGroupAdmin();
    removableMembers = ga.removable; joinedSpaceIds = ga.joinedSpaceIds;
    // B-2: つながり相手の今週の運動(仲間の今日の宣言用)＋リアクション。運動のみ・体重食事は返らない。
    const wk = buildWeek(TODAY);
    connectedWork = await loadConnectedWorkouts(wk[0].date, wk[6].date);
    connectedWork.forEach(e=>{ if(e.who && !members[e.who]) members[e.who]={ name:'メンバー', ini:'?', c:'#9AA09A', photo:null }; });
    reactionRows = await loadReactions();
    comments = await loadComments();
    commentReactionRows = await loadCommentReactions();
    notifications = await loadNotifications();
  }catch(err){
    console.error('bootstrap/load failed:', err.message || err);
    showToast('読み込みに失敗しました。再読み込みしてください');
  }
  renderFeedAvatars(); renderFeed(); renderWeek(); renderDayList(); renderGroup();
  renderLimits(); renderMonth(); renderMaintCaption(); renderStartBar(); renderStats();
  renderIdentity(); renderBell();
  showPage('schedule');   // app opens on 予定 (also reveals the 運動開始 bar)
  // 初回のみ自動表示。既にデータがある既存ユーザーには突然出さない(手動再表示は設定/🔔から)
  const hasData = logEntries.length>0 || posts.length>0 || limits.length>0;
  // bootstrap失敗時は CURRENT_USER が 'boy'(初期値)のまま=ツアーを出さない(markTourDoneに"boy"が渡り uuid エラーになるのを防ぐ)
  if(!profile.tourDone && !hasData && CURRENT_USER!=='boy') openTour();

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
