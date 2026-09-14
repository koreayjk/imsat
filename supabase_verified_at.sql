-- 시험지 검증 완료 표시(재검증 방지) — Supabase SQL Editor 에서 실행. 안전(additive).
alter table imsat.problem_sets add column if not exists verified_at timestamptz;
