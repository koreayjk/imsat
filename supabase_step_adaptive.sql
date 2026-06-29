-- =====================================================================
--  적응형 2모듈 시험 지원: problem_sets 에 컬럼 추가
--  Supabase SQL Editor 에서 실행하세요.
-- =====================================================================
alter table imsat.problem_sets add column if not exists adaptive boolean default false;
alter table imsat.problem_sets add column if not exists modules jsonb;
-- modules 예: { "m1":[...], "m2e":[...], "m2h":[...] }  (각 문항은 정답/해설 포함)
