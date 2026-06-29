-- =====================================================================
--  시험 링크(온라인 응시) 기능용 스키마
--  Supabase SQL Editor 에 붙여넣고 실행하세요.
-- =====================================================================

-- 1) 시험지에 공유 토큰(링크용) 추가
alter table imsat.problem_sets add column if not exists share_token text unique;
create index if not exists problem_sets_share_idx on imsat.problem_sets(share_token);

-- 2) 응시 기록 테이블
create table if not exists imsat.test_attempts (
  id             uuid primary key default gen_random_uuid(),
  teacher_id     uuid not null,
  problem_set_id uuid references imsat.problem_sets(id) on delete cascade,
  student_id     uuid references imsat.students(id) on delete set null,
  student_name   text,
  section        text,
  score          int,
  total          int,
  answers        jsonb,        -- 학생 답안 배열
  per_question   jsonb,        -- 문항별 정오답 상세
  diagnostic_id  uuid,         -- 자동 생성된 진단 연결
  created_at     timestamptz not null default now()
);

alter table imsat.test_attempts enable row level security;

-- 교사는 본인 응시기록만 (학생 제출은 Edge Function이 service_role로 기록 → RLS 우회)
drop policy if exists imsat_test_attempts_own on imsat.test_attempts;
create policy imsat_test_attempts_own on imsat.test_attempts
  for all to authenticated using (teacher_id = auth.uid()) with check (teacher_id = auth.uid());

grant all on imsat.test_attempts to anon, authenticated, service_role;
create index if not exists test_attempts_student_idx on imsat.test_attempts(student_id);
create index if not exists test_attempts_set_idx     on imsat.test_attempts(problem_set_id);
