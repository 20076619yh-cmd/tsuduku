// Supabase data layer. All Supabase data access lives here (isolated from UI logic).
// Phase 3a: bootstrap (users row + personal space) + READ (loadAll) + profile cloud save.
// Phase 3b: WRITE wiring (upsert/remove). 3b-1 = entries; posts/rules land in 3b-2.
import { supabase } from './supabase.js';

// owner + space resolved once in bootstrap, reused by the write helpers so call sites
// in main.js stay terse (single space / single user through Phase 3).
let _uid = null, _spaceId = null;
// uid は常に auth の UUID。旧デモ既定値 "boy" 等の非UUIDが渡ったら弾く(防御的)。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(s){ return typeof s === 'string' && UUID_RE.test(s); }
// 保存失敗の共通通知(main.jsがトースト表示を登録)。console.error＋UI通知を一箇所に。
let _onSaveError = null;
export function setSaveErrorHandler(fn){ _onSaveError = fn; }
function fail(where, error){ console.error(where + ' failed:', error?.message || error); if(_onSaveError) _onSaveError(); }
// seconds → display label (mirrors main.js durFromSec so the data layer is self-contained)
function durLabel(sec){
  if(sec == null) return null;
  const min = Math.max(1, Math.round(sec / 60));
  if(min < 60) return `${min}分`;
  const h = Math.floor(min / 60), mm = min % 60;
  return mm ? `${h}時間${mm}分` : `${h}時間`;
}

// Ensure the self users row and a personal space exist; return ids + the users row.
// RLS lets each insert through because id/created_by/user_id all equal auth.uid().
export async function bootstrap(session){
  const uid = session.user.id;
  if(!isUuid(uid)) throw new Error('bootstrap: session uid が UUID でない: ' + uid);   // 防御(旧"boy"等を弾く)
  const meta = session.user.user_metadata || {};
  const defaultNick =
    meta.full_name || meta.name || (session.user.email || '').split('@')[0] || 'you';
  // Google プロフィール画像を users.photo の既定に(好きな画像への変更=Phase 5/Storage)
  const defaultPhoto = meta.avatar_url || meta.picture || null;

  // 1) users row (self). users_select_self → only my own row is visible.
  let { data: urow, error: uErr } = await supabase
    .from('users').select('*').eq('id', uid).maybeSingle();
  if(uErr) throw uErr;
  if(!urow){
    const ins = await supabase
      .from('users').insert({ id: uid, nickname: defaultNick, photo: defaultPhoto }).select().single();
    if(ins.error) throw ins.error;
    urow = ins.data;
  } else if(!urow.photo && defaultPhoto){
    // 既存ユーザー(行が写真機能より前に作られた)への遡り: photoが空ならGoogle画像で埋める。
    // これで再ログイン不要・次のロードで画像が出る(INSERTは既存行では走らないため)。
    const upd = await supabase
      .from('users').update({ photo: defaultPhoto }).eq('id', uid).select().single();
    if(!upd.error && upd.data) urow = upd.data;
  }

  // 2) personal space. spaces_select_member returns only spaces I belong to;
  //    for Phase 3a there is exactly one. Create it (+ my membership) on first login.
  let { data: spaces, error: sErr } = await supabase.from('spaces').select('id').limit(1);
  if(sErr) throw sErr;
  let spaceId = spaces && spaces[0] ? spaces[0].id : null;
  if(!spaceId){
    // Client-generate the id so we never read the row back before membership exists.
    // (spaces_select_member = is_space_member(id) is still false at insert-time → a
    //  .select() read-back would return 0 rows and throw. Skip it entirely.)
    spaceId = crypto.randomUUID();
    const sp = await supabase
      .from('spaces').insert({ id: spaceId, name: '自分', created_by: uid });
    if(sp.error) throw sp.error;
    const mem = await supabase
      .from('space_members').insert({ space_id: spaceId, user_id: uid, role: 'owner' });
    if(mem.error) throw mem.error;
  }

  _uid = uid; _spaceId = spaceId;    // stash for the write helpers
  return { userId: uid, spaceId, urow };
}

// users row → in-memory profile (3 derived-calc fields round-trip fully).
export function profileFromRow(row){
  return {
    nick:    row.nickname || '',
    photo:   row.photo || null,
    height:  row.height_cm    ?? 175,
    weight:  row.weight_kg    ?? 71.0,
    bodyfat: row.body_fat_pct ?? 18,
    activity: row.activity_coef ?? 1.45,
    maintenanceOverride: row.maintenance_override ?? null,
    tourDone: !!row.tour_done,   // 初回オンボーディング完了フラグ
    settings: row.settings || {},   // ユーザー設定バッグ(jsonb)。customTags等・将来のウィジェットON/OFFもここ
  };
}
// ユーザー設定(jsonb)を丸ごと保存。呼び出し側で既存settingsにマージしてから渡す(他キーを消さない)。
export async function saveSettings(userId, settings){
  const { error } = await supabase.from('users').update({ settings }).eq('id', userId);
  if(error) fail('saveSettings', error);
}
// ツアー完了を保存。列(tour_done)未追加でも致命ではないので console.error のみ(トーストは出さない)。
export async function markTourDone(userId){
  if(!isUuid(userId)){ console.error('markTourDone: invalid uid(スキップ):', userId); return; }   // "boy"等を弾く
  const { error } = await supabase.from('users').update({ tour_done: true }).eq('id', userId);
  if(error) console.error('markTourDone failed:', error.message || error);
}

// in-memory profile → users row. maintenanceKcal = effective value (override or computed),
// stored for convenience/future member-facing use; override + activity keep full fidelity.
export async function saveProfileRow(userId, profile, maintenanceKcal){
  const { error } = await supabase.from('users').update({
    nickname:             profile.nick,
    height_cm:            profile.height,
    weight_kg:            profile.weight,
    body_fat_pct:         profile.bodyfat,
    activity_coef:        profile.activity,
    maintenance_override: profile.maintenanceOverride,
    maintenance_kcal:     maintenanceKcal,
  }).eq('id', userId);
  if(error) throw error;
}

// つながり相手の公開ルール(プロフィールカード用)。rules RLS が pub＋is_connected を担保。
export async function loadPublicRules(userId){
  const { data, error } = await supabase.from('rules').select('*').eq('owner', userId).eq('pub', true);
  if(error){ console.error('loadPublicRules failed:', error.message || error); return []; }
  return (data || []).map(mapRule);
}

// つながる(グループ招待): 招待コードを発行。generate_invite RPC が「同space_idの既存コード削除→新規発行」を
// まとめて行うため、常に最新の1コードだけが有効(再発行で直前のコードは無効化=送り間違えを殺せる)。
// ※このRPCは task-2 のSQL実行が前提(未実行だと404)。
export async function createInvite(spaceId){
  const { data, error } = await supabase.rpc('generate_invite', { p_space_id: spaceId });
  if(error){ console.error('createInvite failed:', error.message || error); return null; }
  // generate_invite は json(code,expires_at)を返す。念のため配列/オブジェクト両対応で正規化。
  const row = Array.isArray(data) ? data[0] : data;
  return row || null;   // { code, expires_at }
}
// 招待コードで参加(唯一の入口)。成功で参加した space_id を返す・無効/期限切れは throw。
export async function joinWithCode(code){
  const { data, error } = await supabase.rpc('join_space_with_code', { p_code: code });
  if(error) throw error;
  return data;   // space_id
}

// グループ管理: 自分がownerのグループの「外せるメンバー」＋自分が参加(非owner)の「抜けられるグループ」。
//   removable = [{spaceId,userId}] (自分作成のspaceの自分以外)  / joinedSpaceIds = 参加中(非owner)のspace_id[]
//   ownedを spaces.created_by=自分 で明示解決(bootstrapのSPACE_IDは参加先を拾い得るため使わない)。
export async function loadGroupAdmin(){
  const { data: owned, error: e1 } = await supabase.from('spaces').select('id').eq('created_by', _uid);
  if(e1){ console.error('loadGroupAdmin(spaces) failed:', e1.message || e1); return { removable:[], joinedSpaceIds:[] }; }
  const ownedIds = (owned || []).map(s => s.id);
  const { data: mine, error: e2 } = await supabase.from('space_members').select('space_id').eq('user_id', _uid);
  if(e2){ console.error('loadGroupAdmin(mine) failed:', e2.message || e2); return { removable:[], joinedSpaceIds:[] }; }
  const joinedSpaceIds = (mine || []).map(m => m.space_id).filter(id => !ownedIds.includes(id));
  let removable = [];
  if(ownedIds.length){
    const { data: mem, error: e3 } = await supabase.from('space_members')
      .select('space_id, user_id').in('space_id', ownedIds).neq('user_id', _uid);
    if(e3) console.error('loadGroupAdmin(members) failed:', e3.message || e3);
    else removable = (mem || []).map(r => ({ spaceId: r.space_id, userId: r.user_id }));
  }
  return { removable, joinedSpaceIds };
}
// ownerがメンバーを外す(RLS: members_delete_by_owner が門番)。
export async function removeGroupMember(spaceId, userId){
  const { error } = await supabase.from('space_members').delete().eq('space_id', spaceId).eq('user_id', userId);
  if(error){ fail('removeGroupMember', error); return false; }
  return true;
}
// 自分が参加中のグループから抜ける(RLS: members_leave_self・非ownerのみ)。
export async function leaveGroups(spaceIds){
  if(!spaceIds || !spaceIds.length) return false;
  const { error } = await supabase.from('space_members').delete().eq('user_id', _uid).in('space_id', spaceIds);
  if(error){ fail('leaveGroups', error); return false; }
  return true;
}

// Phase 4a: 公開プロフィール(安全な窓)。他人に見せてよい最小限(id/nickname/photo)だけ。
// selectは同スペースのメンバーに限定(ビュー側で is_space_member 判定)・anon非公開。
// 生の体重/体脂肪/身長/メンテ/設定は含まれない。今は自分の行のみ返る。
export async function loadPublicProfiles(){
  const { data, error } = await supabase.from('public_profiles').select('id, nickname, photo');
  if(error){ console.error('loadPublicProfiles failed:', error.message || error); return []; }
  return data || [];
}

// つながり型: 予定/記録/自分ルールは本人のみ(personal)、posts は自分＋つながり(RLSが範囲を担保)=1本タイムライン。
// space_id では絞らない(可視性は RLS の is_connected(owner) が判定)。
export async function loadAll(){
  const [e, p, r] = await Promise.all([
    supabase.from('entries').select('*').eq('owner', _uid),                        // 予定/記録=本人のみ
    supabase.from('posts').select('*').order('created_at', { ascending: false }),  // 自分＋つながり=タイムライン
    supabase.from('rules').select('*').eq('owner', _uid),                          // 自分ルール=本人のみ
  ]);
  if(e.error) throw e.error;
  if(p.error) throw p.error;
  if(r.error) throw r.error;
  return {
    entries: (e.data || []).map(mapEntry),
    posts:   (p.data || []).map(mapPost),
    rules:   (r.data || []).map(mapRule),
  };
}

// タイムライン(posts)だけ再取得(ポーリング/プル更新用)。RLSが is_connected(owner) を担保=1本TL。
export async function loadPosts(){
  const { data, error } = await supabase.from('posts').select('*').order('created_at', { ascending: false });
  if(error){ console.error('loadPosts failed:', error.message || error); return null; }
  return (data || []).map(mapPost);
}

// つながり相手の運動だけ(指定期間)。安全な列のみ・RLSが type=workout & is_connected を担保。
// 体重/食事は列にもRLSにも乗らない=生体重は絶対に返らない。
export async function loadConnectedWorkouts(fromDate, toDate){
  const { data, error } = await supabase.from('entries')
    .select('id, owner, type, entry_date, tags, time_label, dur_sec, status, started_at')
    .in('type', ['workout','rest']).neq('owner', _uid)    // 運動＋休養(宣言)を共有。体重/食事は列にもRLSにも乗らない
    .gte('entry_date', fromDate).lte('entry_date', toDate);
  if(error){ console.error('loadConnectedWorkouts failed:', error.message || error); return []; }
  return (data || []).map(mapEntry);
}

// リアクション永続化(post_reactions)。見える投稿ぶんだけRLSが返す。集計はアプリ側。
export async function loadReactions(){
  const { data, error } = await supabase.from('post_reactions').select('post_id, user_id, kind');
  if(error){ console.error('loadReactions failed:', error.message || error); return []; }
  return data || [];
}
export async function addReaction(postId, kind){
  const { error } = await supabase.from('post_reactions').insert({ post_id: postId, user_id: _uid, kind });
  if(error) fail('addReaction', error);
}
export async function removeReaction(postId, kind){
  const { error } = await supabase.from('post_reactions').delete()
    .eq('post_id', postId).eq('user_id', _uid).eq('kind', kind);
  if(error) fail('removeReaction', error);
}

// DB (snake_case) → in-memory shapes used across main.js.
// dur_sec is the source of truth; keep both durSec (persist) and dur (display label).
function mapEntry(x){
  return { id:x.id, who:x.owner, type:x.type, date:x.entry_date,
    tags:x.tags || [], time:x.time_label, durSec:x.dur_sec, dur:durLabel(x.dur_sec),
    status:x.status, kg:x.kg, kcal:x.kcal, satiety:x.satiety, startedAt:x.started_at };
}
function mapPost(x){
  return { id:x.id, who:x.owner, kind:x.kind, tags:x.tags || [], durSec:x.dur_sec, dur:durLabel(x.dur_sec),
    photo:x.photo, text:x.body, ruleLabel:x.rule_label, rulesSnapshot:x.rules_snapshot || [], scope:'group', createdAt:x.created_at,
    r:x.reactions || { fire:0, muscle:0, clap:0 } };
}
// 日数ストリーク型: streakStart(開始/最終リセット日)のみ。自己ベストは持たない(育てる思想)。
function mapRule(x){
  return { id:x.id, type:'limit', emoji:x.emoji, label:x.label, pub:x.pub,
    streakStart:x.streak_start };
}

// ---- WRITE (Phase 3b) : fire-and-forget. Local update + render happen first in main.js;
//      these run in the background and only console.error on failure (no throw). ----
// in-memory entry → DB row. owner/space_id auto-filled from bootstrap context.
function entryToRow(e){
  return {
    id: e.id, owner: _uid, space_id: _spaceId,
    type: e.type, entry_date: e.date,
    tags: e.tags || [], time_label: e.time ?? null,
    dur_sec: e.durSec ?? null, status: e.status ?? null,
    kg: e.kg ?? null, kcal: e.kcal ?? null, satiety: e.satiety ?? null,   // satiety=満腹度(腹何分目 0〜10・meal行のみ・本人のみ)
    started_at: e.startedAt ?? null,   // タイマー開始時刻(仲間の🏃トレ中判定・①通知の起点)
  };
}
// upsert = insert-or-overwrite by PK id → editing a row never double-inserts.
export async function upsertEntry(e){
  const { error } = await supabase.from('entries').upsert(entryToRow(e));
  if(error) fail('upsertEntry', error);
}
export async function removeEntry(id){
  const { error } = await supabase.from('entries').delete().eq('id', id);
  if(error) fail('removeEntry', error);
}

// posts. 写真は Phase 5(Storage)まで非永続 → photo:null。reactions は DB 既定のまま(非永続)。
function postToRow(p){
  return {
    id: p.id, owner: _uid, space_id: _spaceId, kind: p.kind,
    tags: p.tags || [], dur_sec: p.durSec ?? null, photo: null,
    body: p.text ?? null, rule_label: p.ruleLabel ?? null,
    rules_snapshot: p.rulesSnapshot ?? [],   // 投稿時点の公開ルール(名前＋日数)を焼き込み・以後不変
  };
}
export async function upsertPost(p){
  const { error } = await supabase.from('posts').upsert(postToRow(p));
  if(error) fail('upsertPost', error);
}

// rules(日数ストリーク型)。total/done/streak/week_checked/streak_best は本モデルで未使用(DB既定のまま)。
function ruleToRow(r){
  return {
    id: r.id, owner: _uid, space_id: _spaceId,
    emoji: r.emoji, label: r.label, pub: r.pub,
    streak_start: r.streakStart ?? null,
  };
}
export async function upsertRule(r){
  const { error } = await supabase.from('rules').upsert(ruleToRow(r));
  if(error) fail('upsertRule', error);
}
export async function removeRule(id){
  const { error } = await supabase.from('rules').delete().eq('id', id);
  if(error) fail('removeRule', error);
}
