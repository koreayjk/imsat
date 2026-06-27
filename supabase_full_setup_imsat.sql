-- =====================================================================
--  imsat 앱 전체 셋업 (빈 새 프로젝트용) — 한 번에 실행
--  스키마 + 테이블 4개 + 권한 + RLS 정책까지 모두 생성합니다.
--  Supabase 대시보드 > SQL Editor 에 붙여넣고 Run 하세요.
--  실행 후: Settings > API > Exposed schemas 에 'imsat' 추가 + Save
-- =====================================================================

-- 0) 스키마
create schema if not exists imsat;

-- 1) 학생
create table if not exists imsat.students (
  id          uuid primary key default gen_random_uuid(),
  teacher_id  uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null,
  created_at  timestamptz not null default now()
);

-- 2) 진단 (1회)
create table if not exists imsat.diagnostics (
  id                uuid primary key default gen_random_uuid(),
  teacher_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  student_id        uuid references imsat.students(id) on delete cascade,
  exam_name         text,
  section           text,                       -- 'rw' | 'math'
  score             text,
  status            text not null default 'processing',  -- processing | done | error
  error_type_counts jsonb default '{}'::jsonb,
  weakness_summary  text,
  prescription      jsonb default '[]'::jsonb,  -- 문자열 배열
  teacher_notes     text,
  error_msg         text,
  created_at        timestamptz not null default now()
);

-- 3) 진단 문항별 상세 (Edge Function이 service_role로 insert)
create table if not exists imsat.diagnostic_questions (
  id             uuid primary key default gen_random_uuid(),
  teacher_id     uuid default auth.uid(),
  diagnostic_id  uuid references imsat.diagnostics(id) on delete cascade,
  number         text,
  student_answer text,
  correct_answer text,
  why_chose      text,
  trap_intent    text,
  correct_logic  text,
  error_type     text,
  created_at     timestamptz not null default now()
);

-- 4) 출제한 시험지 (문제 출제 기능)
create table if not exists imsat.problem_sets (
  id          uuid primary key default gen_random_uuid(),
  teacher_id  uuid not null default auth.uid() references auth.users(id) on delete cascade,
  student_id  uuid references imsat.students(id) on delete set null,
  title       text,
  section     text,          -- 'rw' | 'math'
  difficulty  text,          -- 'easy' | 'medium' | 'hard' | 'mixed'
  topics      text[],
  questions   jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now()
);

-- 인덱스
create index if not exists diagnostics_student_idx          on imsat.diagnostics(student_id);
create index if not exists diagnostic_questions_diag_idx    on imsat.diagnostic_questions(diagnostic_id);
create index if not exists problem_sets_student_idx         on imsat.problem_sets(student_id);
create index if not exists problem_sets_teacher_idx         on imsat.problem_sets(teacher_id);

-- =====================================================================
--  권한 (Data API에서 사용 가능하게)
-- =====================================================================
grant usage on schema imsat to anon, authenticated, service_role;
grant all on all tables    in schema imsat to anon, authenticated, service_role;
grant all on all sequences in schema imsat to anon, authenticated, service_role;
grant all on all routines  in schema imsat to anon, authenticated, service_role;
alter default privileges in schema imsat grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema imsat grant all on sequences to anon, authenticated, service_role;

-- =====================================================================
--  RLS — "교사는 본인 데이터만"
-- =====================================================================
drop policy if exists imsat_students_own            on imsat.students;
create policy imsat_students_own            on imsat.students
  for all to authenticated using (teacher_id = auth.uid()) with check (teacher_id = auth.uid());

drop policy if exists imsat_diagnostics_own         on imsat.diagnostics;
create policy imsat_diagnostics_own         on imsat.diagnostics
  for all to authenticated using (teacher_id = auth.uid()) with check (teacher_id = auth.uid());

drop policy if exists imsat_diagnostic_questions_own on imsat.diagnostic_questions;
create policy imsat_diagnostic_questions_own on imsat.diagnostic_questions
  for all to authenticated using (teacher_id = auth.uid()) with check (teacher_id = auth.uid());

drop policy if exists imsat_problem_sets_own        on imsat.problem_sets;
create policy imsat_problem_sets_own        on imsat.problem_sets
  for all to authenticated using (teacher_id = auth.uid()) with check (teacher_id = auth.uid());

alter table imsat.students             enable row level security;
alter table imsat.diagnostics          enable row level security;
alter table imsat.diagnostic_questions enable row level security;
alter table imsat.problem_sets         enable row level security;

-- 확인
select table_name from information_schema.tables where table_schema = 'imsat' order by table_name;
