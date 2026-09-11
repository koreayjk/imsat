-- =====================================================================
--  IMSAT 학생 연습 + 오답 누적 + 기간 재복습 토대
--  ⚠️ Supabase SQL Editor 에서 실행. 여러 번 실행해도 안전(idempotent).
--  선행: supabase_step_portal.sql(profiles/students/my_role/my_org),
--        supabase_exam_type.sql(exam_type).
-- =====================================================================

-- 1) 학생 연습 세트 ----------------------------------------------------
create table if not exists imsat.practice_sets (
  id          uuid primary key default gen_random_uuid(),
  student_id  uuid references imsat.students(id) on delete cascade,
  teacher_id  uuid,                        -- 담당 선생님(가시성용)
  org_id      uuid references imsat.orgs(id),
  exam_type   text not null default 'sat',
  section     text,
  kind        text not null default 'practice',   -- 'practice' | 'review'(오답 변형 재복습)
  title       text,
  questions   jsonb not null,              -- 문제 전체(정답·해설 포함)
  answers     jsonb,                       -- 학생이 고른 답
  score       int, total int,
  created_at  timestamptz not null default now()
);
alter table imsat.practice_sets enable row level security;
grant all on imsat.practice_sets to anon, authenticated, service_role;
create index if not exists practice_student_idx on imsat.practice_sets(student_id, created_at desc);
create index if not exists practice_org_idx     on imsat.practice_sets(org_id);

-- 2) 오답 기록(문항 단위) ---------------------------------------------
create table if not exists imsat.wrong_answers (
  id             uuid primary key default gen_random_uuid(),
  student_id     uuid references imsat.students(id) on delete cascade,
  teacher_id     uuid,
  org_id         uuid references imsat.orgs(id),
  exam_type      text not null default 'sat',
  section        text,
  skill          text,                     -- 유형(오답 유형별 집계용)
  question       jsonb not null,           -- 틀린 문제 전체
  student_answer text,
  correct_answer text,
  practice_set_id uuid references imsat.practice_sets(id) on delete set null,
  resolved       boolean not null default false,   -- 재복습에서 맞히면 true
  created_at     timestamptz not null default now()
);
alter table imsat.wrong_answers enable row level security;
grant all on imsat.wrong_answers to anon, authenticated, service_role;
create index if not exists wrong_student_idx on imsat.wrong_answers(student_id, created_at desc);
create index if not exists wrong_org_idx     on imsat.wrong_answers(org_id);

-- 3) 정책: 학생은 본인 것, 선생님은 담당/단체 학생 것 -------------------
--    (학생 계정 ↔ students.auth_user_id 로 연결)
drop policy if exists imsat_practice_rw on imsat.practice_sets;
create policy imsat_practice_rw on imsat.practice_sets
  for all to authenticated
  using (
    student_id in (select id from imsat.students where auth_user_id = auth.uid())
    or teacher_id = auth.uid()
    or (imsat.my_role() = 'teacher' and org_id = imsat.my_org())
  )
  with check (
    student_id in (select id from imsat.students where auth_user_id = auth.uid())
    or teacher_id = auth.uid()
    or (imsat.my_role() = 'teacher' and org_id = imsat.my_org())
  );

drop policy if exists imsat_wrong_rw on imsat.wrong_answers;
create policy imsat_wrong_rw on imsat.wrong_answers
  for all to authenticated
  using (
    student_id in (select id from imsat.students where auth_user_id = auth.uid())
    or teacher_id = auth.uid()
    or (imsat.my_role() = 'teacher' and org_id = imsat.my_org())
  )
  with check (
    student_id in (select id from imsat.students where auth_user_id = auth.uid())
    or teacher_id = auth.uid()
    or (imsat.my_role() = 'teacher' and org_id = imsat.my_org())
  );

-- 4) 확인:
--   select section, count(*) from imsat.wrong_answers group by 1;
--   select kind, count(*) from imsat.practice_sets group by 1;
