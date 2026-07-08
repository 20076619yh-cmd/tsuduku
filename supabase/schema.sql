-- =============================================================
-- つづく / fit tree  —  Supabase schema v1  (Phase 3a)
-- =============================================================
-- このファイルは「設計の真実」。Supabase SQL Editor にこの全文を貼って実行する。
-- 方針(CLAUDE.md): 最初から spaces / space_id 込みで作る(器を先に用意)。
--   - RLS: 同じスペースのメンバーだけ read / owner 本人だけ write
--   - users の生の体重/体脂肪は本人のみ
--   - space_members の自己参照による無限再帰を避けるため
--     SECURITY DEFINER の is_space_member() 経由で判定する
--   - 食事は摂取kcalのみ(P/F/C は持たない)
--   - text 列 = UTF-8 なので絵文字はそのまま保存可
-- このファイルは冪等(再実行しても壊れない)に書いてある。
-- =============================================================

-- 拡張: gen_random_uuid() を使うため(pgcrypto)。Supabase は既定で有効なことが多いが念のため。
create extension if not exists pgcrypto;

-- =============================================================
-- 1) TABLES
-- =============================================================

-- ---- users : 本人プロフィール。id は auth.users.id と一致 -----------------
create table if not exists public.users (
  id               uuid primary key references auth.users(id) on delete cascade,
  nickname         text not null default '',          -- 表示名・アバター頭文字の唯一の真実(絵文字可)
  photo            text,                               -- 将来 Storage の URL(Phase 5)。今は null
  height_cm        numeric,                            -- 身長
  weight_kg        numeric,                            -- 生の体重  ← 本人のみ閲覧
  body_fat_pct     numeric,                            -- 生の体脂肪率 ← 本人のみ閲覧
  activity_coef    numeric,                            -- 活動係数(メンテ算出用)
  maintenance_override integer,                        -- 手動補正値(null=自動算出を使う)
  maintenance_kcal integer,                            -- 実効メンテカロリー(override or 算出値)
  tour_done        boolean not null default false,     -- 初回オンボーディングツアー完了フラグ
  created_at       timestamptz not null default now()
);
-- 既存DB向け冪等マイグレーション(既に users を作成済みの環境で列を追加)。
alter table public.users add column if not exists activity_coef        numeric;
alter table public.users add column if not exists maintenance_override integer;
alter table public.users add column if not exists tour_done            boolean not null default false;

-- ---- spaces : 共有の箱(タイムライン/カレンダーの単位) ----------------------
create table if not exists public.spaces (
  id         uuid primary key default gen_random_uuid(),
  name       text not null default '',                 -- 後から編集可(絵文字可)
  icon       text,                                     -- 将来 Storage の URL(Phase 5)
  created_by uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ---- space_members : 誰がどのスペースに属するか(RLS の門番) ----------------
create table if not exists public.space_members (
  space_id uuid not null references public.spaces(id) on delete cascade,
  user_id  uuid not null references public.users(id) on delete cascade,
  role     text not null default 'member',             -- 'owner' | 'member'
  joined_at timestamptz not null default now(),
  primary key (space_id, user_id)
);

-- ---- entries : 記録(運動/体重/食事) ---------------------------------------
-- id はクライアントが crypto.randomUUID() で生成して渡す(付け替え不要)
create table if not exists public.entries (
  id         uuid primary key default gen_random_uuid(),
  owner      uuid not null references public.users(id)  on delete cascade,
  space_id   uuid not null references public.spaces(id) on delete cascade,
  type       text not null check (type in ('workout','weight','meal')),
  entry_date date not null,                            -- mock の date(YYYY-MM-DD)
  -- workout 用
  tags       text[] not null default '{}',            -- 部位タグ複数(胸/背中/脚/肩腕/有酸素/ストレッチ/休養)
  time_label text,                                     -- 表示用の時刻ラベル('19:00' / '—' / 'いま')
  dur_sec    integer,                                  -- 実施時間(秒)
  status     text check (status in ('planned','done','changed','todo')),
  -- weight 用
  kg         numeric,
  -- meal 用 (摂取kcalのみ。P/F/C は持たない)
  kcal       integer,
  created_at timestamptz not null default now()
);
create index if not exists entries_space_date_idx on public.entries (space_id, entry_date);
create index if not exists entries_owner_idx       on public.entries (owner);

-- ---- posts : タイムライン投稿 --------------------------------------------
create table if not exists public.posts (
  id         uuid primary key default gen_random_uuid(),
  owner      uuid not null references public.users(id)  on delete cascade,
  space_id   uuid not null references public.spaces(id) on delete cascade,
  kind       text not null check (kind in ('workout','resist','achieve')),
  tags       text[] not null default '{}',
  dur_sec    integer,
  photo      text,                                     -- 永続化は Phase 5(Storage)。今は null 想定
  body       text,                                     -- コメント(絵文字可)
  rule_label text,                                     -- achieve/resist 時の対象ルール名
  reactions  jsonb not null default '{"fire":0,"muscle":0,"clap":0}'::jsonb,  -- 永続化は後回し
  created_at timestamptz not null default now()
);
create index if not exists posts_space_idx on public.posts (space_id, created_at desc);

-- ---- rules : 自分ルール(limit)。週次振り返り型(Phase 3b-2) --------------------
create table if not exists public.rules (
  id           uuid primary key default gen_random_uuid(),
  owner        uuid not null references public.users(id)  on delete cascade,
  space_id     uuid not null references public.spaces(id) on delete cascade,
  emoji        text not null default '🎯',
  label        text not null,                            -- 「飲みは週2まで」等(絵文字可)
  total        integer not null default 1,               -- (旧)週回数目標。週次振り返り型では未使用・残置
  done         integer not null default 0,               -- (旧)達成カウント。未使用・残置
  pub          boolean not null default true,            -- true=公開 / false=自分だけ
  streak       integer not null default 0,               -- 現在の連続週数
  streak_best  integer not null default 0,               -- 自己ベスト(切れても残す=ノーシェイム)
  week_checked boolean not null default false,           -- 今週「守れた」を押したか(連打防止)
  created_at   timestamptz not null default now()
);
-- 既存DB向け冪等マイグレーション(週次振り返り型の3列を追加)。
alter table public.rules add column if not exists streak       integer not null default 0;
alter table public.rules add column if not exists streak_best  integer not null default 0;
alter table public.rules add column if not exists week_checked boolean not null default false;
create index if not exists rules_space_idx on public.rules (space_id);

-- =============================================================
-- 2) HELPER : is_space_member()  (SECURITY DEFINER で RLS を迂回し再帰回避)
-- =============================================================
create or replace function public.is_space_member(p_space_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.space_members
    where space_id = p_space_id
      and user_id  = auth.uid()
  );
$$;

-- =============================================================
-- 3) ENABLE RLS
-- =============================================================
alter table public.users         enable row level security;
alter table public.spaces        enable row level security;
alter table public.space_members enable row level security;
alter table public.entries       enable row level security;
alter table public.posts         enable row level security;
alter table public.rules         enable row level security;

-- =============================================================
-- 4) POLICIES
--    (drop → create で冪等に。再実行しても二重定義にならない)
-- =============================================================

-- ---- users : 本人のみ(生体重/体脂肪を守るため read も本人だけ) -------------
--   注: Phase 4 で「スペースメンバーには nickname/photo だけ見せる」公開ビューを
--       別途追加する。生の weight/body_fat はそのビューに含めない。
drop policy if exists users_select_self on public.users;
create policy users_select_self on public.users
  for select using (id = auth.uid());

drop policy if exists users_insert_self on public.users;
create policy users_insert_self on public.users
  for insert with check (id = auth.uid());

drop policy if exists users_update_self on public.users;
create policy users_update_self on public.users
  for update using (id = auth.uid()) with check (id = auth.uid());

-- ---- spaces : メンバーだけ read / 本人が作成・編集 -------------------------
drop policy if exists spaces_select_member on public.spaces;
create policy spaces_select_member on public.spaces
  for select using (is_space_member(id));

drop policy if exists spaces_insert_creator on public.spaces;
create policy spaces_insert_creator on public.spaces
  for insert with check (created_by = auth.uid());

drop policy if exists spaces_update_creator on public.spaces;
create policy spaces_update_creator on public.spaces
  for update using (created_by = auth.uid()) with check (created_by = auth.uid());

-- ---- space_members : メンバーだけ閲覧 / 自分の所属行のみ追加・削除 ----------
--   (他人を招待するフローは Phase 4 で別途。今は自分の所属だけ)
drop policy if exists members_select_member on public.space_members;
create policy members_select_member on public.space_members
  for select using (is_space_member(space_id));

drop policy if exists members_insert_self on public.space_members;
create policy members_insert_self on public.space_members
  for insert with check (user_id = auth.uid());

drop policy if exists members_delete_self on public.space_members;
create policy members_delete_self on public.space_members
  for delete using (user_id = auth.uid());

-- ---- entries : 同スペースのメンバーは read / owner 本人だけ write ----------
drop policy if exists entries_select_member on public.entries;
create policy entries_select_member on public.entries
  for select using (is_space_member(space_id));

drop policy if exists entries_insert_owner on public.entries;
create policy entries_insert_owner on public.entries
  for insert with check (owner = auth.uid() and is_space_member(space_id));

drop policy if exists entries_update_owner on public.entries;
create policy entries_update_owner on public.entries
  for update using (owner = auth.uid()) with check (owner = auth.uid());

drop policy if exists entries_delete_owner on public.entries;
create policy entries_delete_owner on public.entries
  for delete using (owner = auth.uid());

-- ---- posts : 同スペースのメンバーは read / owner 本人だけ write ------------
drop policy if exists posts_select_member on public.posts;
create policy posts_select_member on public.posts
  for select using (is_space_member(space_id));

drop policy if exists posts_insert_owner on public.posts;
create policy posts_insert_owner on public.posts
  for insert with check (owner = auth.uid() and is_space_member(space_id));

drop policy if exists posts_update_owner on public.posts;
create policy posts_update_owner on public.posts
  for update using (owner = auth.uid()) with check (owner = auth.uid());

drop policy if exists posts_delete_owner on public.posts;
create policy posts_delete_owner on public.posts
  for delete using (owner = auth.uid());

-- ---- rules : 公開ルールはメンバーに見える / 非公開(自分だけ)は本人のみ -------
--   write は owner 本人だけ。pub=false の行は他メンバーから read 不可。
drop policy if exists rules_select_visible on public.rules;
create policy rules_select_visible on public.rules
  for select using (
    owner = auth.uid()
    or (pub and is_space_member(space_id))
  );

drop policy if exists rules_insert_owner on public.rules;
create policy rules_insert_owner on public.rules
  for insert with check (owner = auth.uid() and is_space_member(space_id));

drop policy if exists rules_update_owner on public.rules;
create policy rules_update_owner on public.rules
  for update using (owner = auth.uid()) with check (owner = auth.uid());

drop policy if exists rules_delete_owner on public.rules;
create policy rules_delete_owner on public.rules
  for delete using (owner = auth.uid());

-- =============================================================
-- 5) GRANTS
--    RLS は「行」の門番。GRANT は「テーブルそのもの」への到達許可。両方必要。
--    (RLS を有効化しても、authenticated に GRANT が無いと 42501 permission denied)
--    authenticated(ログイン済) にだけ付与。anon(未ログイン) には付与しない
--    = ログインゲート＋プライバシー維持。GRANT は再実行しても無害(冪等)。
-- =============================================================
grant usage on schema public to authenticated;

grant select, insert, update, delete on
  public.users, public.spaces, public.space_members,
  public.entries, public.posts, public.rules
  to authenticated;

grant execute on function public.is_space_member(uuid) to authenticated;

-- =============================================================
-- 6) つながり型アーキテクチャ（確定版・Step1-3で適用）
--    上の 4)POLICIES の entries/posts/rules の "スペース(is_space_member)" 版は
--    ここで "つながり(is_connected)" 版に置き換わる(drop→create で上書き・冪等)。
--    可視性は space_id ではなく owner とのつながりで判定する(CLAUDE.md「アーキテクチャ確定版」)。
-- =============================================================

-- 6-1) is_connected: 自分自身 or いずれかのグループ(space)を共有 → true
create or replace function public.is_connected(p_user uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select p_user = auth.uid()
    or exists (
      select 1 from public.space_members m_self
      join public.space_members m_other on m_other.space_id = m_self.space_id
      where m_self.user_id = auth.uid() and m_other.user_id = p_user
    );
$$;
grant execute on function public.is_connected(uuid) to authenticated;
revoke execute on function public.is_connected(uuid) from public;

-- 6-2) entries/posts/rules の select を つながりベースに。書き込みは owner 本人のみ(space非依存)。
drop policy if exists entries_select_member    on public.entries;
drop policy if exists entries_select_connected on public.entries;
create policy entries_select_connected on public.entries for select using (is_connected(owner));
drop policy if exists entries_insert_owner on public.entries;
create policy entries_insert_owner on public.entries for insert with check (owner = auth.uid());

drop policy if exists posts_select_member    on public.posts;
drop policy if exists posts_select_connected on public.posts;
create policy posts_select_connected on public.posts for select using (is_connected(owner));
drop policy if exists posts_insert_owner on public.posts;
create policy posts_insert_owner on public.posts for insert with check (owner = auth.uid());

drop policy if exists rules_select_visible   on public.rules;
drop policy if exists rules_select_connected on public.rules;
create policy rules_select_connected on public.rules for select
  using (owner = auth.uid() or (pub and is_connected(owner)));
drop policy if exists rules_insert_owner on public.rules;
create policy rules_insert_owner on public.rules for insert with check (owner = auth.uid());

-- 6-3) public_profiles: 他人に見せる安全な窓(nickname/photo)。つながっている人だけ・anon非公開。
create or replace view public.public_profiles as
  select u.id, u.nickname, u.photo from public.users u where is_connected(u.id);
revoke all on public.public_profiles from anon;
grant select on public.public_profiles to authenticated;

-- 6-4) invitations: グループ招待コード(hex12・既定24h・人数無制限)。参加は join_space_with_code のみ。
create table if not exists public.invitations (
  id         uuid primary key default gen_random_uuid(),
  space_id   uuid not null references public.spaces(id) on delete cascade,
  created_by uuid not null references public.users(id)  on delete cascade,
  code       text not null unique default encode(gen_random_bytes(6),'hex'),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  created_at timestamptz not null default now()
);
create index if not exists invitations_code_idx on public.invitations (code);
alter table public.invitations enable row level security;
drop policy if exists inv_select_member on public.invitations;
create policy inv_select_member on public.invitations for select using (is_space_member(space_id));
drop policy if exists inv_insert_member on public.invitations;
create policy inv_insert_member on public.invitations for insert with check (created_by = auth.uid() and is_space_member(space_id));
drop policy if exists inv_delete_member on public.invitations;
create policy inv_delete_member on public.invitations for delete using (is_space_member(space_id));
grant select, insert, delete on public.invitations to authenticated;

-- space_members の自己追加は「自分が作成したグループのみ」に厳格化(他は招待経由のみ)
drop policy if exists members_insert_self on public.space_members;
create policy members_insert_self on public.space_members for insert with check (
  user_id = auth.uid()
  and exists (select 1 from public.spaces s where s.id = space_id and s.created_by = auth.uid())
);

-- 参加の唯一の入口(コード検証→自分をメンバー追加)。anon実行不可。
create or replace function public.join_space_with_code(p_code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_space uuid;
begin
  select space_id into v_space from public.invitations where code = p_code and expires_at > now();
  if v_space is null then raise exception 'invalid or expired code'; end if;
  insert into public.space_members (space_id, user_id, role)
    values (v_space, auth.uid(), 'member') on conflict (space_id, user_id) do nothing;
  return v_space;
end; $$;
grant execute on function public.join_space_with_code(text) to authenticated;
revoke execute on function public.join_space_with_code(text) from public;

-- =============================================================
-- 完了(v2: つながり型)。
-- =============================================================
