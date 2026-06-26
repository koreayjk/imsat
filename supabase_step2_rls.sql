-- =====================================================================
--  STEP 2 : imsat 스키마 RLS(행 수준 보안) — "교사는 본인 데이터만"
--  네 테이블 모두 teacher_id(uuid) 보유 → teacher_id = auth.uid() 로 통일
--  Supabase SQL Editor 에 붙여넣고 실행하세요.
--  (순서: 기본값 → 정책 생성 → RLS 활성화. 잠김 구간 없음)
-- =====================================================================

-- 1) teacher_id 자동 기록 (클라이언트 insert 시 로그인 사용자로 채움)
alter table imsat.students            alter column teacher_id set default auth.uid();
alter table imsat.diagnostics         alter column teacher_id set default auth.uid();
alter table imsat.problem_sets        alter column teacher_id set default auth.uid();
-- diagnostic_questions 는 Edge Function(service_role)이 insert하며 teacher_id를 직접 넣습니다.

-- 2) 정책 생성 (로그인 사용자가 본인 행만 select/insert/update/delete)
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

-- 3) RLS 활성화 (정책이 이미 있으므로 안전)
alter table imsat.students            enable row level security;
alter table imsat.diagnostics         enable row level security;
alter table imsat.diagnostic_questions enable row level security;
alter table imsat.problem_sets        enable row level security;

-- 확인: 정책 목록
select tablename, policyname, cmd
from pg_policies
where schemaname = 'imsat'
order by tablename;
