-- =====================================================================
--  IMSAT → 멀티 시험 플랫폼 토대: exam_type 컬럼 추가 (SAT/토익/토플/수능)
--  ⚠️ Supabase SQL Editor 에서 실행. 여러 번 실행해도 안전(additive).
--  기존 데이터는 전부 'sat' 으로 자동 태깅되어 SAT 기능은 그대로 유지됩니다.
-- =====================================================================
alter table imsat.problem_sets  add column if not exists exam_type text not null default 'sat';
alter table imsat.item_bank     add column if not exists exam_type text not null default 'sat';
alter table imsat.diagnostics   add column if not exists exam_type text not null default 'sat';
alter table imsat.assignments   add column if not exists exam_type text not null default 'sat';
alter table imsat.test_attempts add column if not exists exam_type text not null default 'sat';

create index if not exists problem_sets_exam_idx on imsat.problem_sets(exam_type, section);
create index if not exists item_bank_exam_idx    on imsat.item_bank(exam_type, section, difficulty);
create index if not exists diagnostics_exam_idx  on imsat.diagnostics(exam_type);

-- 확인:  select exam_type, count(*) from imsat.problem_sets group by 1;
