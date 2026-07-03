-- =====================================================================
--  IMSAT 검증 문제은행 (item_bank)
--  제미나이 생성 → 클로드 검증 통과 문항만 적립 → 다음 출제 때 재사용.
--  쓰면 쓸수록 "정답이 검증된 정품 문항"이 쌓입니다.
--  ⚠️ Supabase SQL Editor 에서 실행 (Edge Functions 아님). 여러 번 실행해도 안전.
--  선행: supabase_step_portal.sql (imsat.orgs / imsat.profiles / my_role()/my_org()).
-- =====================================================================

create table if not exists imsat.item_bank (
  id          uuid primary key default gen_random_uuid(),
  teacher_id  uuid not null default auth.uid(),
  org_id      uuid references imsat.orgs(id),
  section     text not null,                    -- 'math' | 'rw' 등 problem_sets.section 과 동일
  domain      text,                             -- 유형/스킬 (q.skill)
  difficulty  text,                             -- easy | medium | hard
  format      text,                             -- mc | grid
  qkey        text,                             -- 중복판별 키 (지문/발문 앞부분)
  question    jsonb not null,                   -- 문항 전체(JSON)
  verified    boolean not null default true,    -- 검증 통과 여부
  times_used  int not null default 0,           -- 재사용 횟수(적게 쓴 것부터 우선)
  created_at  timestamptz not null default now()
);
alter table imsat.item_bank enable row level security;
grant all on imsat.item_bank to anon, authenticated, service_role;

create index if not exists item_bank_lookup_idx on imsat.item_bank(section, difficulty, verified);
create index if not exists item_bank_org_idx    on imsat.item_bank(org_id);
-- 같은 선생님이 같은 문항을 중복 적립하지 않도록 (qkey는 항상 채워 넣음)
--  ※ upsert(onConflict) 추론이 되도록 부분(partial) 인덱스가 아닌 일반 유니크 인덱스 사용
create unique index if not exists item_bank_owner_qkey
  on imsat.item_bank(teacher_id, qkey);

-- 본인 것 + 같은 단체(org) 공유 문항을 읽고 쓸 수 있게
drop policy if exists imsat_bank_rw on imsat.item_bank;
create policy imsat_bank_rw on imsat.item_bank
  for all to authenticated
  using (teacher_id = auth.uid() or (imsat.my_role() = 'teacher' and org_id = imsat.my_org()))
  with check (teacher_id = auth.uid() or (imsat.my_role() = 'teacher' and org_id = imsat.my_org()));

-- 은행에서 검증 문항을 뽑아온다(적게 쓴 것 우선 + 무작위). 뽑은 문항은 times_used +1.
--   p_exclude: 이번 시험지에 이미 들어간(또는 최근 출제된) 문항 키 배열 → 중복 회피
create or replace function imsat.bank_draw(p_section text, p_difficulty text, p_limit int, p_exclude text[])
returns setof imsat.item_bank
language plpgsql volatile security definer set search_path = imsat as $$
declare picked uuid[];
begin
  select array_agg(id) into picked from (
    select id from imsat.item_bank
    where section = p_section and verified = true
      and (p_difficulty is null or p_difficulty = '' or difficulty = p_difficulty)
      and (teacher_id = auth.uid() or (imsat.my_role() = 'teacher' and org_id = imsat.my_org()))
      and (p_exclude is null or coalesce(qkey,'') <> all(p_exclude))
    order by times_used asc, random()
    limit greatest(coalesce(p_limit,0), 0)
  ) s;
  if picked is null then return; end if;
  update imsat.item_bank set times_used = times_used + 1 where id = any(picked);
  return query select * from imsat.item_bank where id = any(picked);
end $$;
grant execute on function imsat.bank_draw(text,text,int,text[]) to authenticated;

-- 확인:
--   select section, difficulty, count(*) from imsat.item_bank group by 1,2 order by 1,2;
