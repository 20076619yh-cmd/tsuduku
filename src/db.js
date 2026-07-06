// Phase 3a data layer. All Supabase data access lives here (isolated from UI logic).
// Scope 3a: bootstrap (users row + personal space) + READ (loadAll) + profile cloud save.
// entries/posts/rules WRITE wiring (insert/update/delete) is Phase 3b — loadAll only READs
// them here, which proves the read/mapping path even while the tables are empty.
import { supabase } from './supabase.js';

// Ensure the self users row and a personal space exist; return ids + the users row.
// RLS lets each insert through because id/created_by/user_id all equal auth.uid().
export async function bootstrap(session){
  const uid = session.user.id;
  const meta = session.user.user_metadata || {};
  const defaultNick =
    meta.full_name || meta.name || (session.user.email || '').split('@')[0] || 'you';

  // 1) users row (self). users_select_self → only my own row is visible.
  let { data: urow, error: uErr } = await supabase
    .from('users').select('*').eq('id', uid).maybeSingle();
  if(uErr) throw uErr;
  if(!urow){
    const ins = await supabase
      .from('users').insert({ id: uid, nickname: defaultNick }).select().single();
    if(ins.error) throw ins.error;
    urow = ins.data;
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

  return { userId: uid, spaceId, urow };
}

// users row → in-memory profile (3 derived-calc fields round-trip fully).
export function profileFromRow(row){
  return {
    nick:    row.nickname || '',
    height:  row.height_cm    ?? 175,
    weight:  row.weight_kg    ?? 71.0,
    bodyfat: row.body_fat_pct ?? 18,
    activity: row.activity_coef ?? 1.45,
    maintenanceOverride: row.maintenance_override ?? null,
  };
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

// Read every row visible in the space and map to the app's in-memory shapes.
// Empty in Phase 3a; write-back (and dur_sec ↔ label reconciliation) finalizes in 3b.
export async function loadAll(spaceId){
  const [e, p, r] = await Promise.all([
    supabase.from('entries').select('*').eq('space_id', spaceId),
    supabase.from('posts').select('*').eq('space_id', spaceId).order('created_at', { ascending: false }),
    supabase.from('rules').select('*').eq('space_id', spaceId),
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

// DB (snake_case) → in-memory shapes used across main.js.
function mapEntry(x){
  return { id:x.id, who:x.owner, type:x.type, date:x.entry_date,
    tags:x.tags || [], time:x.time_label, dur:x.dur_sec, status:x.status, kg:x.kg, kcal:x.kcal };
}
function mapPost(x){
  return { id:x.id, who:x.owner, kind:x.kind, tags:x.tags || [], dur:x.dur_sec,
    photo:x.photo, text:x.body, ruleLabel:x.rule_label, scope:'group', time:'いま',
    r:x.reactions || { fire:0, muscle:0, clap:0 } };
}
function mapRule(x){
  return { id:x.id, type:'limit', emoji:x.emoji, label:x.label, total:x.total, done:x.done, pub:x.pub };
}
