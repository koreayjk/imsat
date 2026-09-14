-- =====================================================================
--  IMSAT 학원(단체) 공용 가입 코드 — 학생이 코드 1개로 스스로 가입·등록
--  ⚠️ Supabase SQL Editor 에서 실행. 여러 번 실행해도 안전.
--  선행: supabase_step_portal.sql
-- =====================================================================

-- 1) 단체에 공용 가입 코드 부여 (6자리)
alter table imsat.orgs add column if not exists join_code text unique;
update imsat.orgs
   set join_code = upper(substr(replace(gen_random_uuid()::text,'-',''),1,6))
 where join_code is null;

-- 2) 학원 코드 + 이름으로 학생 스스로 등록 (RPC)
create or replace function imsat.join_org(p_code text, p_name text)
returns jsonb language plpgsql security definer set search_path = imsat as $$
declare o record; sid uuid; tid uuid;
begin
  select * into o from imsat.orgs where join_code = upper(trim(p_code)) limit 1;
  if o.id is null then
    return jsonb_build_object('ok', false, 'error', '유효하지 않은 학원 가입 코드입니다.');
  end if;
  if nullif(trim(p_name),'') is null then
    return jsonb_build_object('ok', false, 'error', '이름을 입력하세요.');
  end if;
  -- 이 단체의 대표 선생님(가장 먼저 등록된 teacher) — 소유자 표기용
  select user_id into tid from imsat.profiles where org_id = o.id and role='teacher' order by created_at limit 1;
  -- 이미 이 계정에 연결된 학생이 있으면 재사용, 없으면 새로 생성
  select id into sid from imsat.students where auth_user_id = auth.uid() limit 1;
  if sid is null then
    insert into imsat.students (name, teacher_id, org_id, auth_user_id, join_code)
      values (trim(p_name), tid, o.id, auth.uid(),
              upper(substr(replace(gen_random_uuid()::text,'-',''),1,8)))
      returning id into sid;
  else
    update imsat.students
       set name = trim(p_name), org_id = o.id, auth_user_id = auth.uid(),
           teacher_id = coalesce(teacher_id, tid)
     where id = sid;
  end if;
  insert into imsat.profiles (user_id, role, org_id, display_name)
    values (auth.uid(), 'student', o.id, trim(p_name))
    on conflict (user_id) do update
      set role='student', org_id=excluded.org_id, display_name=excluded.display_name;
  return jsonb_build_object('ok', true, 'name', trim(p_name));
end $$;
grant execute on function imsat.join_org(text,text) to authenticated;

-- 확인:  select name, join_code from imsat.orgs;
