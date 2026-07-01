-- =====================================================================
--  IMSAT 학생 포털 · 역할(teacher/student)/단체(org)/배부(assignments)
--  1단계 — DB 토대.  ⚠️ SQL Editor 에서 실행 (Edge Functions 아님)
--  여러 번 실행해도 안전(idempotent). 기존 선생님 기능은 그대로 유지됩니다.
-- =====================================================================

-- 0) 내 단체/역할 조회 헬퍼 (RLS 재귀 방지용, security definer) --------
create or replace function imsat.my_org() returns uuid
  language sql stable security definer set search_path = imsat as
  $$ select org_id from imsat.profiles where user_id = auth.uid() $$;
create or replace function imsat.my_role() returns text
  language sql stable security definer set search_path = imsat as
  $$ select role from imsat.profiles where user_id = auth.uid() $$;
grant execute on function imsat.my_org()  to anon, authenticated, service_role;
grant execute on function imsat.my_role() to anon, authenticated, service_role;

-- 1) 단체(org) -------------------------------------------------------
create table if not exists imsat.orgs (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);
alter table imsat.orgs enable row level security;
grant all on imsat.orgs to anon, authenticated, service_role;
drop policy if exists imsat_orgs_read on imsat.orgs;
create policy imsat_orgs_read on imsat.orgs
  for select to authenticated using (true);

-- 기본 단체 하나(없을 때만)
insert into imsat.orgs (name)
select 'INTO유학센터'
where not exists (select 1 from imsat.orgs);

-- 2) 프로필(역할·단체) ----------------------------------------------
create table if not exists imsat.profiles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  role         text not null default 'student',   -- 'teacher' | 'student'
  org_id       uuid references imsat.orgs(id),
  display_name text,
  created_at   timestamptz not null default now()
);
alter table imsat.profiles enable row level security;
grant all on imsat.profiles to anon, authenticated, service_role;

drop policy if exists imsat_profiles_self on imsat.profiles;
create policy imsat_profiles_self on imsat.profiles
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 같은 단체 구성원끼리 서로의 프로필(이름/역할) 조회 허용
drop policy if exists imsat_profiles_org_read on imsat.profiles;
create policy imsat_profiles_org_read on imsat.profiles
  for select to authenticated using (org_id = imsat.my_org());

-- 3) 기존 계정을 선생님으로 지정 (현재 두 계정) ----------------------
--    이후 신규 가입자는 기본 'student'. 재실행해도 기존 프로필은 안 바뀜.
insert into imsat.profiles (user_id, role, org_id, display_name)
select u.id, 'teacher', (select id from imsat.orgs order by created_at limit 1), coalesce(u.email,'선생님')
from auth.users u
on conflict (user_id) do nothing;

-- 4) students: 계정연결·초대코드·단체 --------------------------------
alter table imsat.students add column if not exists auth_user_id uuid references auth.users(id) on delete set null;
alter table imsat.students add column if not exists join_code text unique;
alter table imsat.students add column if not exists org_id uuid references imsat.orgs(id);

-- 기존 학생 → 담당 선생님의 단체로 채움
update imsat.students s
   set org_id = (select org_id from imsat.profiles p where p.user_id = s.teacher_id)
 where s.org_id is null;

-- 초대코드 자동 생성(없는 학생만) — 8자리 대문자/숫자
update imsat.students
   set join_code = upper(substr(replace(gen_random_uuid()::text,'-',''),1,8))
 where join_code is null;

create index if not exists students_auth_idx on imsat.students(auth_user_id);
create index if not exists students_org_idx  on imsat.students(org_id);

-- 학생 본인: 자기 레코드 읽기
drop policy if exists imsat_students_self on imsat.students;
create policy imsat_students_self on imsat.students
  for select to authenticated using (auth_user_id = auth.uid());

-- 같은 단체 선생님: 단체 학생 조회(다른 선생님 학생도 보기)
drop policy if exists imsat_students_org_read on imsat.students;
create policy imsat_students_org_read on imsat.students
  for select to authenticated using (imsat.my_role() = 'teacher' and org_id = imsat.my_org());

-- 5) 학생 가입 시 초대코드로 계정 연결 (RPC) -------------------------
create or replace function imsat.link_student(p_code text)
returns jsonb language plpgsql security definer set search_path = imsat as $$
declare s record;
begin
  select * into s from imsat.students where join_code = upper(trim(p_code)) limit 1;
  if s.id is null then
    return jsonb_build_object('ok', false, 'error', '유효하지 않은 초대 코드입니다.');
  end if;
  if s.auth_user_id is not null and s.auth_user_id <> auth.uid() then
    return jsonb_build_object('ok', false, 'error', '이미 다른 계정에 연결된 코드입니다.');
  end if;
  update imsat.students set auth_user_id = auth.uid() where id = s.id;
  insert into imsat.profiles (user_id, role, org_id, display_name)
    values (auth.uid(), 'student', s.org_id, s.name)
    on conflict (user_id) do update
      set role = 'student', org_id = excluded.org_id, display_name = excluded.display_name;
  return jsonb_build_object('ok', true, 'name', s.name);
end $$;
grant execute on function imsat.link_student(text) to authenticated;

-- 6) 배부(assignments) ----------------------------------------------
create table if not exists imsat.assignments (
  id             uuid primary key default gen_random_uuid(),
  problem_set_id uuid references imsat.problem_sets(id) on delete cascade,
  student_id     uuid references imsat.students(id) on delete cascade,
  teacher_id     uuid not null default auth.uid(),
  org_id         uuid references imsat.orgs(id),
  status         text not null default 'assigned',   -- assigned | done
  created_at     timestamptz not null default now(),
  unique(problem_set_id, student_id)
);
alter table imsat.assignments enable row level security;
grant all on imsat.assignments to anon, authenticated, service_role;
create index if not exists assignments_student_idx on imsat.assignments(student_id);
create index if not exists assignments_set_idx     on imsat.assignments(problem_set_id);

-- 선생님: 본인/단체 배부 관리
drop policy if exists imsat_assign_teacher on imsat.assignments;
create policy imsat_assign_teacher on imsat.assignments
  for all to authenticated
  using (teacher_id = auth.uid() or (imsat.my_role() = 'teacher' and org_id = imsat.my_org()))
  with check (teacher_id = auth.uid());

-- 학생: 본인에게 배부된 것 읽기
drop policy if exists imsat_assign_student on imsat.assignments;
create policy imsat_assign_student on imsat.assignments
  for select to authenticated using (
    student_id in (select id from imsat.students where auth_user_id = auth.uid()));

-- 7) 학생 본인 응시기록 읽기 ----------------------------------------
drop policy if exists imsat_attempts_student on imsat.test_attempts;
create policy imsat_attempts_student on imsat.test_attempts
  for select to authenticated using (
    student_id in (select id from imsat.students where auth_user_id = auth.uid()));

-- 완료. 확인용:
--   select role, count(*) from imsat.profiles group by role;   -- teacher 2
--   select name, join_code from imsat.students;                -- 초대코드 확인
