-- =====================================================================
--  적응형 2모듈 시험 지원: problem_sets 에 컬럼 추가
--  Supabase SQL Editor 에서 실행하세요.
-- =====================================================================
alter table imsat.problem_sets add column if not exists adaptive boolean default false;
alter table imsat.problem_sets add column if not exists modules jsonb;
alter table imsat.problem_sets add column if not exists route_threshold real default 0.6;
-- modules 예: { "m1":[...], "m2e":[...], "m2h":[...] }  (각 문항은 정답/해설 포함)
-- route_threshold: 모듈1 정답률이 이 값 이상이면 모듈2 '어려움' 배정 (기본 0.6)
