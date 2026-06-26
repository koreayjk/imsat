-- =====================================================================
--  STEP 1 : imsat 스키마를 Data API(PostgREST)에서 사용 가능하게 권한 부여
--  (대시보드 Settings > API > Exposed schemas 에 'imsat' 추가 후 실행)
--  Supabase 대시보드 > SQL Editor 에 붙여넣고 실행하세요.
-- =====================================================================

-- 역할에 스키마 사용 권한
grant usage on schema imsat to anon, authenticated, service_role;

-- 현재 존재하는 모든 테이블/시퀀스/함수 권한
grant all on all tables    in schema imsat to anon, authenticated, service_role;
grant all on all sequences in schema imsat to anon, authenticated, service_role;
grant all on all routines  in schema imsat to anon, authenticated, service_role;

-- 앞으로 만들 객체에도 자동 권한
alter default privileges in schema imsat grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema imsat grant all on sequences to anon, authenticated, service_role;

-- 확인: imsat 스키마의 테이블 목록
select table_name from information_schema.tables where table_schema = 'imsat' order by table_name;
