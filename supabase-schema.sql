-- ============================================================
--  웨딩여기 · Supabase 스키마 v2 (실서비스)
--  Supabase 대시보드 > SQL Editor 에 전체 붙여넣고 RUN 하세요.
--  여러 번 실행해도 안전합니다 (idempotent).
-- ============================================================

create extension if not exists "pgcrypto";

-- ────────────────────────────────────────────────────────────
--  0. 역할 판별 헬퍼
-- ────────────────────────────────────────────────────────────
create table if not exists public.admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  memo       text,
  created_at timestamptz default now()
);
alter table public.admins enable row level security;

drop policy if exists "관리자 목록은 본인만 확인" on public.admins;
create policy "관리자 목록은 본인만 확인" on public.admins
  for select using (auth.uid() = user_id);

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.admins a where a.user_id = auth.uid());
$$;

-- 최초 관리자 지정: 아래 한 줄의 이메일을 본인 것으로 바꿔 실행하세요.
-- insert into public.admins(user_id)
--   select id from auth.users where email = 'you@example.com'
--   on conflict do nothing;

-- ────────────────────────────────────────────────────────────
--  0.1 통합 마스터 계정 (이 이메일로 가입하면 자동으로 관리자)
--  ※ 이메일을 원하는 것으로 바꾼 뒤 실행하세요. 계정 생성은
--     Supabase 대시보드 > Authentication > Users > Add user 에서
--     이 이메일 + 비밀번호로 만들면 됩니다.
-- ────────────────────────────────────────────────────────────
create or replace function public.master_email()
returns text language sql immutable as $$ select 'master@wedhere.co.kr' $$;

create or replace function public.grant_master()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if lower(new.email) = lower(public.master_email()) then
    insert into public.admins(user_id, memo) values (new.id, '통합 마스터')
    on conflict do nothing;
  end if;
  return new;
end $$;

drop trigger if exists trg_grant_master on auth.users;
create trigger trg_grant_master after insert on auth.users
  for each row execute function public.grant_master();

-- 이미 해당 이메일로 가입돼 있다면 즉시 관리자 등록
insert into public.admins(user_id, memo)
  select id, '통합 마스터' from auth.users where lower(email) = lower(public.master_email())
on conflict do nothing;


-- ────────────────────────────────────────────────────────────
--  1. 회원 프로필 (+ 개인화 필드)
-- ────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  name         text not null,
  phone        text,
  wedding_date date,
  is_date_tbd  boolean default false,
  points       integer default 30000,
  provider     text default 'local',
  created_at   timestamptz default now()
);

alter table public.profiles add column if not exists role          text default 'member';   -- member | vendor | admin
alter table public.profiles add column if not exists region        text;                   -- 희망 지역 (예: 부산 해운대구)
alter table public.profiles add column if not exists budget        integer;                -- 총 예산(원)
alter table public.profiles add column if not exists guests        integer;                -- 예상 하객수
alter table public.profiles add column if not exists interests     text[] default '{}';     -- ['hall','studio',...]
alter table public.profiles add column if not exists hall_types    text[] default '{}';     -- ['호텔','컨벤션',...]
alter table public.profiles add column if not exists onboarded     boolean default false;
alter table public.profiles add column if not exists onboard_step  integer default 0;
alter table public.profiles add column if not exists marketing_opt boolean default false;
alter table public.profiles add column if not exists terms_at      timestamptz;
alter table public.profiles add column if not exists privacy_at    timestamptz;
alter table public.profiles add column if not exists avatar_url    text;
alter table public.profiles add column if not exists couple_code   text unique;            -- 커플 연동 초대코드
alter table public.profiles add column if not exists partner_id    uuid references auth.users(id) on delete set null;
alter table public.profiles add column if not exists updated_at    timestamptz default now();

alter table public.profiles enable row level security;

drop policy if exists "본인 프로필 조회" on public.profiles;
drop policy if exists "프로필 조회" on public.profiles;
create policy "프로필 조회" on public.profiles
  for select using (auth.uid() = id or public.is_admin() or partner_id = auth.uid());

drop policy if exists "본인 프로필 생성" on public.profiles;
drop policy if exists "프로필 생성" on public.profiles;
create policy "본인 프로필 생성" on public.profiles
  for insert with check (auth.uid() = id);

drop policy if exists "본인 프로필 수정" on public.profiles;
drop policy if exists "프로필 수정" on public.profiles;
create policy "본인 프로필 수정" on public.profiles
  for update using (auth.uid() = id or public.is_admin());

-- 커플 초대코드 자동 생성
create or replace function public.gen_couple_code()
returns trigger language plpgsql as $$
begin
  if new.couple_code is null then
    new.couple_code := upper(substr(replace(gen_random_uuid()::text,'-',''),1,6));
  end if;
  return new;
end $$;

drop trigger if exists trg_couple_code on public.profiles;
create trigger trg_couple_code before insert on public.profiles
  for each row execute function public.gen_couple_code();


-- ────────────────────────────────────────────────────────────
--  2. 업체 (입점 신청 → 관리자 승인 → 노출)
-- ────────────────────────────────────────────────────────────
create table if not exists public.vendors (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid references auth.users(id) on delete set null,
  status        text not null default 'draft',   -- draft | pending | approved | rejected | suspended
  reject_reason text,

  -- 사업자 검증
  biz_no        text,                            -- 사업자등록번호
  biz_owner     text,                            -- 대표자명
  biz_file_url  text,                            -- 사업자등록증 사본

  -- 기본 정보
  name          text not null,
  cat           text not null,                   -- hall | studio | dress | makeup | hanbok
  region        text,                            -- 부산 / 경남 …
  sigungu       text,                            -- 해운대구 …
  dong          text,
  address       text,
  address_detail text,
  lat           double precision,
  lng           double precision,

  -- 연락
  tel           text,
  kakao_url     text,
  insta_url     text,
  homepage      text,
  manager_name  text,
  manager_phone text,

  -- 콘텐츠
  cover_url     text,
  intro         text,                            -- 한 줄 소개
  detail        text,                            -- 상세설명
  price_from    integer default 0,               -- 시작가 (목록/핀 표시용)

  -- 영업
  open_hours    jsonb default '{}'::jsonb,       -- {mon:{o:'10:00',c:'19:00'},…}
  closed_days   text[] default '{}',
  holiday_memo  text,

  -- 웨딩홀 전용
  guarantee     integer,                         -- 보증인원
  hall_types    text[] default '{}',             -- ['호텔','하우스','컨벤션','채플','야외']
  meal_price    integer,                         -- 1인 식대
  hall_count    integer,
  parking       text,

  -- 제휴/노출
  tier          text default 'basic',            -- basic | plus | premium
  tier_until    date,
  featured      boolean default false,
  sort_weight   integer default 0,

  -- 지표
  view_count    integer default 0,
  wish_count    integer default 0,

  submitted_at  timestamptz,
  approved_at   timestamptz,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

create index if not exists vendors_status_idx on public.vendors(status);
create index if not exists vendors_cat_idx    on public.vendors(cat);
create index if not exists vendors_owner_idx  on public.vendors(owner_id);
create index if not exists vendors_geo_idx    on public.vendors(lat,lng);

alter table public.vendors enable row level security;

drop policy if exists "승인 업체는 공개" on public.vendors;
create policy "승인 업체는 공개" on public.vendors
  for select using (status = 'approved' or owner_id = auth.uid() or public.is_admin());

drop policy if exists "업체 등록은 로그인" on public.vendors;
create policy "업체 등록은 로그인" on public.vendors
  for insert with check (auth.uid() = owner_id);

drop policy if exists "업체 등록은 관리자" on public.vendors;
create policy "업체 등록은 관리자" on public.vendors
  for insert with check (public.is_admin());

drop policy if exists "본인 업체 수정" on public.vendors;
create policy "본인 업체 수정" on public.vendors
  for update using (owner_id = auth.uid() or public.is_admin());

drop policy if exists "본인 업체 삭제" on public.vendors;
create policy "본인 업체 삭제" on public.vendors
  for delete using (owner_id = auth.uid() or public.is_admin());


-- ── 2-1. 갤러리 이미지 ──────────────────────────────────────
create table if not exists public.vendor_images (
  id         bigserial primary key,
  vendor_id  uuid not null references public.vendors(id) on delete cascade,
  url        text not null,
  caption    text,
  sort       integer default 0,
  created_at timestamptz default now()
);
create index if not exists vendor_images_vid_idx on public.vendor_images(vendor_id);
alter table public.vendor_images enable row level security;

drop policy if exists "이미지 조회" on public.vendor_images;
create policy "이미지 조회" on public.vendor_images
  for select using (exists(
    select 1 from public.vendors v where v.id = vendor_id
      and (v.status='approved' or v.owner_id = auth.uid() or public.is_admin())));

drop policy if exists "이미지 관리" on public.vendor_images;
create policy "이미지 관리" on public.vendor_images
  for all using (exists(
    select 1 from public.vendors v where v.id = vendor_id
      and (v.owner_id = auth.uid() or public.is_admin())))
  with check (exists(
    select 1 from public.vendors v where v.id = vendor_id
      and (v.owner_id = auth.uid() or public.is_admin())));


-- ── 2-1a. 웨딩홀 층/뷔페/협의 메모 ─────────────────────────
alter table public.vendors add column if not exists halls jsonb default '[]'::jsonb;  -- [{floor:'3F',name:'그랜드홀',rental:'날짜에 따라 협의'}]
alter table public.vendors add column if not exists buffet_floor text;
alter table public.vendors add column if not exists price_note text;                  -- 대관료·식대 협의 메모

-- ── 2-1b. 업체 단가표·입금가 (내부용: 관리자+해당 업체만) ──
create table if not exists public.vendor_internal (
  vendor_id     uuid primary key references public.vendors(id) on delete cascade,
  cost_table    jsonb default '[]'::jsonb,   -- [{name:'A상품 20p', sale:1320000, deposit:660000}]
  deposit_price integer,
  memo          text,
  updated_at    timestamptz default now()
);
alter table public.vendor_internal enable row level security;

drop policy if exists "내부단가 열람" on public.vendor_internal;
create policy "내부단가 열람" on public.vendor_internal
  for select using (public.is_admin() or exists(
    select 1 from public.vendors v where v.id = vendor_id and v.owner_id = auth.uid()));

drop policy if exists "내부단가 관리" on public.vendor_internal;
create policy "내부단가 관리" on public.vendor_internal
  for all using (public.is_admin() or exists(
    select 1 from public.vendors v where v.id = vendor_id and v.owner_id = auth.uid()))
  with check (public.is_admin() or exists(
    select 1 from public.vendors v where v.id = vendor_id and v.owner_id = auth.uid()));

-- ── 2-2. 가격표(상품) ───────────────────────────────────────
create table if not exists public.vendor_products (
  id         bigserial primary key,
  vendor_id  uuid not null references public.vendors(id) on delete cascade,
  name       text not null,
  price      integer not null default 0,
  unit       text default '원',
  options    jsonb default '[]'::jsonb,   -- [{name:'추가촬영', price:150000}]
  includes   text,                        -- 포함사항
  note       text,
  sort       integer default 0,
  active     boolean default true,
  created_at timestamptz default now()
);
create index if not exists vendor_products_vid_idx on public.vendor_products(vendor_id);
alter table public.vendor_products enable row level security;

drop policy if exists "상품 조회" on public.vendor_products;
create policy "상품 조회" on public.vendor_products
  for select using (exists(
    select 1 from public.vendors v where v.id = vendor_id
      and (v.status='approved' or v.owner_id = auth.uid() or public.is_admin())));

drop policy if exists "상품 관리" on public.vendor_products;
create policy "상품 관리" on public.vendor_products
  for all using (exists(
    select 1 from public.vendors v where v.id = vendor_id
      and (v.owner_id = auth.uid() or public.is_admin())))
  with check (exists(
    select 1 from public.vendors v where v.id = vendor_id
      and (v.owner_id = auth.uid() or public.is_admin())));


-- ────────────────────────────────────────────────────────────
--  3. 주문 / 예약 (+ 결제 연동 대비)
-- ────────────────────────────────────────────────────────────
create table if not exists public.orders (
  id           text primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  items        jsonb not null default '[]'::jsonb,
  summary      text,
  total        integer not null default 0,
  order_total  integer not null default 0,
  status       text default '예약금 결제완료',
  created_at   timestamptz default now()
);

alter table public.orders add column if not exists vendor_id   uuid references public.vendors(id) on delete set null;
alter table public.orders add column if not exists pay_status  text default 'pending';   -- pending | paid | failed | canceled | refunded
alter table public.orders add column if not exists pay_method  text;                     -- card | transfer | kakaopay …
alter table public.orders add column if not exists pg_provider text;                     -- toss | portone
alter table public.orders add column if not exists pg_tid      text;                     -- PG 거래키
alter table public.orders add column if not exists paid_at     timestamptz;
alter table public.orders add column if not exists canceled_at timestamptz;
alter table public.orders add column if not exists visit_date  date;
alter table public.orders add column if not exists memo        text;
alter table public.orders add column if not exists updated_at  timestamptz default now();

create index if not exists orders_user_idx   on public.orders(user_id);
create index if not exists orders_vendor_idx on public.orders(vendor_id);

alter table public.orders enable row level security;

drop policy if exists "본인 주문 조회" on public.orders;
drop policy if exists "주문 조회" on public.orders;
create policy "주문 조회" on public.orders
  for select using (
    auth.uid() = user_id or public.is_admin()
    or exists(select 1 from public.vendors v where v.id = vendor_id and v.owner_id = auth.uid()));

drop policy if exists "본인 주문 생성" on public.orders;
drop policy if exists "주문 생성" on public.orders;
create policy "본인 주문 생성" on public.orders
  for insert with check (auth.uid() = user_id);

drop policy if exists "주문 수정" on public.orders;
create policy "주문 수정" on public.orders
  for update using (
    public.is_admin()
    or exists(select 1 from public.vendors v where v.id = vendor_id and v.owner_id = auth.uid()));


-- ────────────────────────────────────────────────────────────
--  4. 빠른상담
-- ────────────────────────────────────────────────────────────
create table if not exists public.consults (
  id         bigserial primary key,
  user_id    uuid references auth.users(id) on delete set null,
  name       text not null,
  phone      text not null,
  target     text,
  wish_time  text,
  memo       text,
  status     text default '접수완료',
  created_at timestamptz default now()
);

alter table public.consults add column if not exists vendor_id    uuid references public.vendors(id) on delete set null;
alter table public.consults add column if not exists cat          text;
alter table public.consults add column if not exists wedding_date date;
alter table public.consults add column if not exists guests       integer;
alter table public.consults add column if not exists budget       integer;
alter table public.consults add column if not exists admin_memo   text;
alter table public.consults add column if not exists handled_by   uuid references auth.users(id) on delete set null;
alter table public.consults add column if not exists handled_at   timestamptz;
alter table public.consults add column if not exists fee_status   text default 'none';  -- none | billable | billed | paid (건당 수수료)

create index if not exists consults_status_idx on public.consults(status);
create index if not exists consults_vendor_idx on public.consults(vendor_id);

alter table public.consults enable row level security;

drop policy if exists "상담 신청은 누구나" on public.consults;
create policy "상담 신청은 누구나" on public.consults
  for insert with check (true);

drop policy if exists "본인 상담내역 조회" on public.consults;
drop policy if exists "상담내역 조회" on public.consults;
create policy "상담내역 조회" on public.consults
  for select using (
    auth.uid() = user_id or public.is_admin()
    or exists(select 1 from public.vendors v where v.id = vendor_id and v.owner_id = auth.uid()));

drop policy if exists "상담 처리" on public.consults;
create policy "상담 처리" on public.consults
  for update using (
    public.is_admin()
    or exists(select 1 from public.vendors v where v.id = vendor_id and v.owner_id = auth.uid()));


-- ────────────────────────────────────────────────────────────
--  5. 찜 / 최근 본 업체
-- ────────────────────────────────────────────────────────────
create table if not exists public.wishes (
  user_id    uuid not null references auth.users(id) on delete cascade,
  vendor_id  text not null,
  created_at timestamptz default now(),
  primary key (user_id, vendor_id)
);
alter table public.wishes enable row level security;

drop policy if exists "본인 찜 관리" on public.wishes;
drop policy if exists "찜 관리" on public.wishes;
create policy "찜 관리" on public.wishes
  for all using (auth.uid() = user_id or exists(
      select 1 from public.profiles p where p.id = auth.uid() and p.partner_id = wishes.user_id))
  with check (auth.uid() = user_id);

create table if not exists public.recent_views (
  user_id    uuid not null references auth.users(id) on delete cascade,
  vendor_id  text not null,
  cat        text,
  viewed_at  timestamptz default now(),
  primary key (user_id, vendor_id)
);
alter table public.recent_views enable row level security;

drop policy if exists "최근본 관리" on public.recent_views;
create policy "최근본 관리" on public.recent_views
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ────────────────────────────────────────────────────────────
--  6. 준비 체크리스트 (D-day 연동)
-- ────────────────────────────────────────────────────────────
create table if not exists public.checklist_items (
  id         bigserial primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  title      text not null,
  cat        text,                    -- 예: 예식장 / 스드메 / 예단 / 신혼여행
  d_offset   integer,                 -- 예식일 기준 -180 = 180일 전
  due_date   date,
  done       boolean default false,
  done_at    timestamptz,
  sort       integer default 0,
  is_default boolean default false,
  created_at timestamptz default now()
);
create index if not exists checklist_user_idx on public.checklist_items(user_id);
alter table public.checklist_items enable row level security;

drop policy if exists "체크리스트 관리" on public.checklist_items;
create policy "체크리스트 관리" on public.checklist_items
  for all using (auth.uid() = user_id or exists(
      select 1 from public.profiles p where p.id = auth.uid() and p.partner_id = checklist_items.user_id))
  with check (auth.uid() = user_id or exists(
      select 1 from public.profiles p where p.id = auth.uid() and p.partner_id = checklist_items.user_id));


-- ────────────────────────────────────────────────────────────
--  7. 예산 트래커
-- ────────────────────────────────────────────────────────────
create table if not exists public.budget_items (
  id         bigserial primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  cat        text not null,           -- 예식장 / 스드메 / 예복 / 예단 / 신혼여행 / 기타
  label      text,
  planned    integer default 0,       -- 예상
  actual     integer default 0,       -- 실제 지출
  paid       boolean default false,
  vendor_id  text,
  memo       text,
  sort       integer default 0,
  created_at timestamptz default now()
);
create index if not exists budget_user_idx on public.budget_items(user_id);
alter table public.budget_items enable row level security;

drop policy if exists "예산 관리" on public.budget_items;
create policy "예산 관리" on public.budget_items
  for all using (auth.uid() = user_id or exists(
      select 1 from public.profiles p where p.id = auth.uid() and p.partner_id = budget_items.user_id))
  with check (auth.uid() = user_id or exists(
      select 1 from public.profiles p where p.id = auth.uid() and p.partner_id = budget_items.user_id));


-- ────────────────────────────────────────────────────────────
--  8. 광고 (유닛 on/off + 슬롯 배정)
-- ────────────────────────────────────────────────────────────
create table if not exists public.ad_units (
  id         text primary key,
  enabled    boolean default true,
  updated_at timestamptz default now()
);
alter table public.ad_units enable row level security;

drop policy if exists "광고 설정 조회는 공개" on public.ad_units;
create policy "광고 설정 조회는 공개" on public.ad_units for select using (true);

drop policy if exists "광고 설정 변경은 로그인" on public.ad_units;
drop policy if exists "광고 설정 변경은 관리자" on public.ad_units;
create policy "광고 설정 변경은 관리자" on public.ad_units
  for all using (public.is_admin()) with check (public.is_admin());

insert into public.ad_units (id, enabled) values
  ('hero',true),('strip',true),('brand',true),('infeed',true),
  ('sponsor',true),('sticky',true),('popup',true),('_master',true)
on conflict (id) do nothing;

-- 어느 업체를 어느 슬롯에, 언제까지
create table if not exists public.ad_slots (
  id         bigserial primary key,
  unit       text not null references public.ad_units(id) on delete cascade,
  vendor_id  uuid references public.vendors(id) on delete cascade,
  headline   text,
  sub        text,
  image_url  text,
  link_url   text,
  sort       integer default 0,
  starts_at  date,
  ends_at    date,
  price      integer default 0,          -- 광고비(원/월)
  active     boolean default true,
  created_at timestamptz default now()
);
create index if not exists ad_slots_unit_idx on public.ad_slots(unit, active);
alter table public.ad_slots enable row level security;

drop policy if exists "광고 슬롯 조회는 공개" on public.ad_slots;
create policy "광고 슬롯 조회는 공개" on public.ad_slots for select using (true);

drop policy if exists "광고 슬롯 관리는 관리자" on public.ad_slots;
create policy "광고 슬롯 관리는 관리자" on public.ad_slots
  for all using (public.is_admin()) with check (public.is_admin());

-- 광고센터: 업체 소유주가 자기 업체의 광고 슬롯을 직접 만들고 관리
alter table public.ad_slots add column if not exists status text default 'pending';   -- pending | approved | rejected
alter table public.ad_slots add column if not exists reject_reason text;

drop policy if exists "광고 슬롯은 소유 업체가 관리" on public.ad_slots;
drop policy if exists "광고 슬롯은 소유 업체가 관리" on public.ad_slots;
create policy "광고 슬롯은 소유 업체가 관리" on public.ad_slots
  for all using (exists(select 1 from public.vendors v where v.id = vendor_id and v.owner_id = auth.uid()))
  with check (exists(select 1 from public.vendors v where v.id = vendor_id and v.owner_id = auth.uid()));

-- 노출·클릭 집계 (CPM/CPC 정산용): RLS를 우회해 카운터만 안전하게 증가시킵니다.
alter table public.ad_slots add column if not exists impressions bigint not null default 0;
alter table public.ad_slots add column if not exists clicks bigint not null default 0;
alter table public.ad_slots add column if not exists cta text;
alter table public.ad_slots add column if not exists bg_preset text;
alter table public.ad_slots add column if not exists icon text;
alter table public.ad_slots add column if not exists text_size text;
alter table public.ad_slots add column if not exists cta_pos text;

create or replace function public.increment_ad_impression(p_slot_id bigint)
returns void language sql security definer set search_path = public as $$
  update public.ad_slots set impressions = impressions + 1 where id = p_slot_id;
$$;
grant execute on function public.increment_ad_impression(bigint) to anon, authenticated;

create or replace function public.increment_ad_click(p_slot_id bigint)
returns void language sql security definer set search_path = public as $$
  update public.ad_slots set clicks = clicks + 1 where id = p_slot_id;
$$;
grant execute on function public.increment_ad_click(bigint) to anon, authenticated;


-- ────────────────────────────────────────────────────────────
--  9. 정산 / 청구 (입점료·수수료)
-- ────────────────────────────────────────────────────────────
create table if not exists public.billings (
  id         bigserial primary key,
  vendor_id  uuid not null references public.vendors(id) on delete cascade,
  kind       text not null,             -- subscription | ad | consult_fee | booking_fee
  period     text,                      -- '2026-08'
  amount     integer not null default 0,
  qty        integer default 1,
  status     text default 'unpaid',     -- unpaid | paid | void
  memo       text,
  due_date   date,
  paid_at    timestamptz,
  created_at timestamptz default now()
);
create index if not exists billings_vendor_idx on public.billings(vendor_id, period);
alter table public.billings enable row level security;

drop policy if exists "정산 조회" on public.billings;
create policy "정산 조회" on public.billings
  for select using (public.is_admin() or exists(
    select 1 from public.vendors v where v.id = vendor_id and v.owner_id = auth.uid()));

drop policy if exists "정산 관리는 관리자" on public.billings;
create policy "정산 관리는 관리자" on public.billings
  for all using (public.is_admin()) with check (public.is_admin());


-- ────────────────────────────────────────────────────────────
--  10. Storage 버킷 (업체 사진 / 사업자등록증)
--      대시보드 > Storage 에서 만들어도 됩니다.
-- ────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public)
  values ('vendor-media','vendor-media', true)
  on conflict (id) do nothing;
insert into storage.buckets (id, name, public)
  values ('vendor-docs','vendor-docs', false)
  on conflict (id) do nothing;

drop policy if exists "업체사진 공개조회" on storage.objects;
create policy "업체사진 공개조회" on storage.objects
  for select using (bucket_id = 'vendor-media');

drop policy if exists "업체사진 업로드는 로그인" on storage.objects;
create policy "업체사진 업로드는 로그인" on storage.objects
  for insert to authenticated with check (bucket_id in ('vendor-media','vendor-docs'));

drop policy if exists "업체사진 본인삭제" on storage.objects;
create policy "업체사진 본인삭제" on storage.objects
  for delete to authenticated using (bucket_id in ('vendor-media','vendor-docs') and owner = auth.uid());

drop policy if exists "사업자서류 본인조회" on storage.objects;
create policy "사업자서류 본인조회" on storage.objects
  for select to authenticated using (bucket_id = 'vendor-docs' and (owner = auth.uid() or public.is_admin()));


-- ────────────────────────────────────────────────────────────
--  11. 관리자 통계 뷰
-- ────────────────────────────────────────────────────────────
create or replace view public.admin_stats as
select
  (select count(*) from public.profiles)                                as members,
  (select count(*) from public.profiles where created_at > now() - interval '7 days') as members_7d,
  (select count(*) from public.vendors  where status='approved')        as vendors_live,
  (select count(*) from public.vendors  where status='pending')         as vendors_pending,
  (select count(*) from public.consults where status='접수완료')         as consults_open,
  (select count(*) from public.consults where created_at > now() - interval '7 days') as consults_7d,
  (select count(*) from public.orders)                                 as orders_all,
  (select coalesce(sum(total),0) from public.orders where pay_status='paid') as revenue_paid;
