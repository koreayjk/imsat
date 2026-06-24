-- =====================================================================
--  problem_sets : "문제 출제" 기능으로 생성한 SAT 시험지를 저장하는 테이블
--  Supabase 대시보드 > SQL Editor 에 붙여넣고 한 번 실행하세요.
--  (diagnostics 테이블과 동일하게 teacher_id 로 본인 데이터만 보이도록 RLS 적용)
-- =====================================================================

create table if not exists public.problem_sets (
  id          uuid primary key default gen_random_uuid(),
  teacher_id  uuid not null default auth.uid() references auth.users(id) on delete cascade,
  student_id  uuid references public.students(id) on delete set null,  -- 일반 출제는 null
  title       text,
  section     text,          -- 'rw' | 'math'
  difficulty  text,          -- 'easy' | 'medium' | 'hard' | 'mixed'
  topics      text[],        -- 선택한 세부 유형들
  questions   jsonb not null default '[]'::jsonb,  -- [{number,skill,difficulty,passage,stem,choices,answer,explanation,distractors}]
  created_at  timestamptz not null default now()
);

alter table public.problem_sets enable row level security;

-- 본인(teacher)이 만든 시험지만 접근
create policy "problem_sets_own_select" on public.problem_sets
  for select using (teacher_id = auth.uid());
create policy "problem_sets_own_insert" on public.problem_sets
  for insert with check (teacher_id = auth.uid());
create policy "problem_sets_own_update" on public.problem_sets
  for update using (teacher_id = auth.uid());
create policy "problem_sets_own_delete" on public.problem_sets
  for delete using (teacher_id = auth.uid());

create index if not exists problem_sets_student_idx on public.problem_sets(student_id);
create index if not exists problem_sets_teacher_idx on public.problem_sets(teacher_id);
