// =====================================================================
//  Supabase Edge Function: test  (온라인 시험 · 적응형 2모듈 지원)
//   action "info"    : 시험 정보 + 학생목록 + (정답 뺀) 1모듈/단일 문항
//   action "module2" : 모듈1 답안 채점 → 라우팅(쉬움/어려움) → 모듈2 문항
//   action "submit"  : 최종 채점 → 응시기록 + AI 진단 → 점수/해설 반환
//  ⚠️ verify_jwt = false 로 배포. 시크릿: ANTHROPIC_API_KEY
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLAUDE_MODEL = "claude-sonnet-4-6";

const cors = { "Access-Control-Allow-Origin":"*", "Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods":"POST, OPTIONS" };
function json(b,s=200){ return new Response(JSON.stringify(b),{status:s,headers:{...cors,"Content-Type":"application/json"}}); }
function svc(){ return createClient(SUPABASE_URL,SERVICE_ROLE,{db:{schema:"imsat"},auth:{persistSession:false}}); }
function moduleTimeSec(sec){ return sec==="math"?2100:1920; }            // Math 35분 / R&W 32분
function flatTimeSec(sec,c){ const per=sec==="math"?95:71; return Math.max(60,Math.round((c||1)*per)); }
function norm(v){ return String(v??"").trim(); }
function strip(qs){ return (qs||[]).map((q,i)=>({number:q.number||(i+1),skill:q.skill||"",format:q.format||"mc",passage:q.passage||"",figure:q.figure||"",stem:q.stem||"",choices:q.choices||{}})); }
function gradeOne(q,ans){ const a=norm(ans),correct=norm(q.answer);
  const isGrid=q.format==="grid"||!(q.choices&&["A","B","C","D"].some(c=>q.choices[c]!==undefined));
  if(isGrid){ if(!a) return false; if(a.toLowerCase()===correct.toLowerCase()) return true;
    const na=Number(a.replace(/\s/g,"")),nc=Number(correct.replace(/\s/g,"")); return !isNaN(na)&&!isNaN(nc)&&na===nc; }
  return a.toUpperCase()===correct.toUpperCase(); }
function composeContent(q){ const c=q.choices||{}; const ch=["A","B","C","D"].filter(k=>c[k]!==undefined).map(k=>k+") "+c[k]).join("\n");
  return [(q.passage&&String(q.passage).trim())?String(q.passage).trim():"",q.stem||"",ch].filter(Boolean).join("\n\n"); }
// 한 모듈 채점 → {score, review, wrong}
function scoreModule(qs, answers, offset){
  let score=0; const review=[], wrong=[];
  (qs||[]).forEach((q,i)=>{ const ans=(answers||[])[i]??""; const ok=gradeOne(q,ans); if(ok) score++;
    else wrong.push({number:q.number||(offset+i+1),student:norm(ans)||"(미응답)",correct:norm(q.answer),content:composeContent(q)});
    review.push({number:q.number||(offset+i+1),skill:q.skill||"",format:q.format||"mc",passage:q.passage||"",figure:q.figure||"",stem:q.stem||"",choices:q.choices||{},answer:norm(q.answer),your:norm(ans),correct:ok,explanation:q.explanation||"",distractors:q.distractors||{}}); });
  return { score, review, wrong };
}
function routeOf(m1score,m1count,th){ const t=(typeof th==="number"&&th>0)?th:0.6; return (m1count>0 && m1score/m1count>=t) ? "hard":"easy"; }
function scaledSection(correct,total,route){ const p=total?correct/total:0;
  return route==="hard" ? Math.round(Math.min(800,400+p*400)) : Math.round(Math.min(620,200+p*420)); }

async function callAnthropic({system,messages,max_tokens}){
  const res=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",
    headers:{"x-api-key":ANTHROPIC_API_KEY,"anthropic-version":"2023-06-01","content-type":"application/json"},
    body:JSON.stringify({model:CLAUDE_MODEL,max_tokens:max_tokens||4000,...(system?{system}:{}),messages})});
  const d=await res.json(); if(!res.ok) throw new Error(d?.error?.message||("Anthropic "+res.status));
  return (d.content||[]).filter(b=>b.type==="text").map(b=>b.text).join(""); }
function parseJSON(raw){ let t=String(raw||"").replace(/```json|```/g,"").trim(); const s=t.indexOf("{"),e=t.lastIndexOf("}"); if(s>=0&&e>s) t=t.slice(s,e+1); return JSON.parse(t); }
function buildSystemPrompt(secLabel){ return `당신은 미국 대학입시 SAT 전문 강사이자 오답 진단 전문가입니다. 모든 출력은 한국어. 영역: ${secLabel}
각 틀린 문항: 1.whyChose 2.trapIntent 3.correctLogic 4.errorType(R&W:["어휘/문맥","핵심 근거 찾기","추론","글의 구조/목적","문법/문장 규칙","함정 선택지","시간 압박/실수"], Math:["개념 이해 부족","계산 실수","문제 해석 오류","공식 적용 오류","함정 선택지","시간 압박/실수"] 중 하나).
종합: weaknessSummary, errorTypeCounts(객체), prescription(배열 3~4), teacherNotes.
아래 JSON만(백틱·설명 없이): {"perQuestion":[{"number":"","studentAnswer":"","correctAnswer":"","whyChose":"","trapIntent":"","correctLogic":"","errorType":""}],"weaknessSummary":"","errorTypeCounts":{},"prescription":[],"teacherNotes":""}`; }
async function runDiagnosis(sb,diagId,secLabel,examName,scoreStr,wrongQs,teacherId){
  try{ const sample=wrongQs.slice(0,18);   // 문항이 많으면 대표 18개만 상세 분석(출력 토큰 초과 방지)
    const more = wrongQs.length>sample.length ? `\n\n(틀린 문항이 총 ${wrongQs.length}개 — 위 ${sample.length}개를 대표로 분석)` : "";
    const user=`학생 시험 채점 결과 기반 오답 분석.\n영역: ${secLabel}\n시험: ${examName}\n점수: ${scoreStr}\n\n`+
      sample.map(q=>`[문항 ${q.number}] 학생이 고른 답: ${q.student} / 정답: ${q.correct}\n문제 내용:\n${q.content}`).join("\n\n---\n\n")+more;
    const text=await callAnthropic({system:buildSystemPrompt(secLabel),messages:[{role:"user",content:user}],max_tokens:8000});
    const out=parseJSON(text);
    await sb.from("diagnostics").update({error_type_counts:out.errorTypeCounts||{},weakness_summary:out.weaknessSummary||"",prescription:out.prescription||[],teacher_notes:out.teacherNotes||"",status:"done"}).eq("id",diagId);
    const rows=(out.perQuestion||[]).map(q=>({diagnostic_id:diagId,teacher_id:teacherId,number:String(q.number??""),student_answer:q.studentAnswer||"",correct_answer:q.correctAnswer||"",why_chose:q.whyChose||"",trap_intent:q.trapIntent||"",correct_logic:q.correctLogic||"",error_type:q.errorType||""}));
    if(rows.length) await sb.from("diagnostic_questions").insert(rows);
  }catch(err){ await sb.from("diagnostics").update({status:"error",error_msg:String(err?.message||err)}).eq("id",diagId); } }

async function verifyStudent(sb,studentId,teacherId){
  if(!studentId) return null;
  const { data:st }=await sb.from("students").select("id,name").eq("id",studentId).eq("teacher_id",teacherId).single();
  return st||null;
}

Deno.serve(async(req)=>{
  if(req.method==="OPTIONS") return new Response("ok",{headers:cors});
  try{
    const body=await req.json(); const token=norm(body.token);
    if(!token) return json({error:"토큰이 없습니다."},400);
    const sb=svc();
    const { data:ps, error:pErr }=await sb.from("problem_sets").select("*").eq("share_token",token).single();
    if(pErr) return json({error:"시험지 조회 실패: "+pErr.message},500);
    if(!ps) return json({error:"유효하지 않은 시험 링크입니다."},404);
    const secLabel=ps.section==="math"?"Math":"Reading & Writing";
    const adaptive = !!ps.adaptive && ps.modules && Array.isArray(ps.modules.m1);

    // ---------- info ----------
    if(body.action==="info"){
      const { data:studs, error:sErr }=await sb.from("students").select("id,name").eq("teacher_id",ps.teacher_id).order("name");
      if(sErr) return json({error:"학생 목록 조회 실패: "+sErr.message},500);
      if(adaptive){
        return json({ adaptive:true, title:ps.title, section:ps.section, secLabel,
          m1Count:ps.modules.m1.length, m2Count:(ps.modules.m2h||ps.modules.m2e||[]).length,
          moduleTimeSec:moduleTimeSec(ps.section), students:studs||[], questions:strip(ps.modules.m1) });
      }
      const questions=ps.questions||[];
      return json({ adaptive:false, title:ps.title, section:ps.section, secLabel, count:questions.length,
        timeLimitSec:flatTimeSec(ps.section,questions.length), students:studs||[], questions:strip(questions) });
    }

    // ---------- result (지난 응시 결과·해설 다시 보기) ----------
    if(body.action==="result"){
      const st=await verifyStudent(sb,body.studentId,ps.teacher_id);
      if(!st) return json({error:"등록된 학생이 아닙니다."},400);
      const { data:att }=await sb.from("test_attempts").select("*")
        .eq("problem_set_id",ps.id).eq("student_id",body.studentId)
        .order("created_at",{ascending:false}).limit(1).maybeSingle();
      if(!att) return json({found:false});
      const ans=att.answers||{};
      let total=0,score=0,review=[],route=null,scaled=null;
      if(adaptive){
        const m1=scoreModule(ps.modules.m1, ans.m1||[], 0);
        route = ans.route || routeOf(m1.score, ps.modules.m1.length, ps.route_threshold);
        const m2qs = route==="hard" ? (ps.modules.m2h||[]) : (ps.modules.m2e||[]);
        const m2=scoreModule(m2qs, ans.m2||[], ps.modules.m1.length);
        score=m1.score+m2.score; total=ps.modules.m1.length+m2qs.length;
        review=[...m1.review,...m2.review]; scaled=scaledSection(score,total,route);
      }else{
        const arr=Array.isArray(ans)?ans:(ans.answers||[]);
        const r=scoreModule(ps.questions||[], arr, 0);
        score=r.score; total=(ps.questions||[]).length; review=r.review;
      }
      return json({ found:true, score, total, scaled, route, studentName:st.name, review, createdAt:att.created_at });
    }

    // ---------- module2 (적응형: 모듈1 채점 → 라우팅) ----------
    if(body.action==="module2"){
      if(!adaptive) return json({error:"적응형 시험이 아닙니다."},400);
      const st=await verifyStudent(sb,body.studentId,ps.teacher_id);
      if(!st) return json({error:"등록된 학생이 아닙니다."},400);
      const m1=scoreModule(ps.modules.m1, body.m1Answers||[], 0);
      const route=routeOf(m1.score, ps.modules.m1.length, ps.route_threshold);
      const m2 = route==="hard" ? (ps.modules.m2h||[]) : (ps.modules.m2e||[]);
      return json({ route, m2Count:m2.length, moduleTimeSec:moduleTimeSec(ps.section), questions:strip(m2) });
    }

    // ---------- submit ----------
    if(body.action==="submit"){
      const st=await verifyStudent(sb,body.studentId,ps.teacher_id);
      if(!st) return json({error:"등록된 학생이 아닙니다."},400);
      const studentName=st.name; const studentId=body.studentId;

      let total=0, score=0, review=[], wrongQs=[], route=null, scaled=null;
      if(adaptive){
        const m1=scoreModule(ps.modules.m1, body.m1Answers||[], 0);
        route=routeOf(m1.score, ps.modules.m1.length, ps.route_threshold);
        const m2qs = route==="hard" ? (ps.modules.m2h||[]) : (ps.modules.m2e||[]);
        const m2=scoreModule(m2qs, body.m2Answers||[], ps.modules.m1.length);
        score=m1.score+m2.score; total=ps.modules.m1.length+m2qs.length;
        review=[...m1.review,...m2.review]; wrongQs=[...m1.wrong,...m2.wrong];
        scaled=scaledSection(score,total,route);
      }else{
        const r=scoreModule(ps.questions||[], body.answers||[], 0);
        score=r.score; total=(ps.questions||[]).length; review=r.review; wrongQs=r.wrong;
      }
      const scoreStr=score+"/"+total;

      let diagId=null;
      if(wrongQs.length){
        const { data:drow }=await sb.from("diagnostics").insert({teacher_id:ps.teacher_id,student_id:studentId,
          exam_name:(ps.title||"온라인 시험")+(adaptive?(" ("+(route==="hard"?"상위":"하위")+" 모듈)"):""),
          section:ps.section,score:scoreStr+(scaled?(" · ~"+scaled+"점"):""),status:"processing"}).select("id").single();
        diagId=drow?.id||null;
      }
      await sb.from("test_attempts").insert({teacher_id:ps.teacher_id,problem_set_id:ps.id,student_id:studentId,student_name:studentName,
        section:ps.section,score,total,answers:adaptive?{m1:body.m1Answers||[],m2:body.m2Answers||[],route}:(body.answers||[]),
        per_question:review.map(r=>({number:r.number,your:r.your,answer:r.answer,correct:r.correct})),diagnostic_id:diagId});

      if(diagId){ const work=runDiagnosis(sb,diagId,secLabel,ps.title||"온라인 시험",scoreStr,wrongQs,ps.teacher_id);
        if(typeof EdgeRuntime!=="undefined"&&EdgeRuntime.waitUntil) EdgeRuntime.waitUntil(work); else await work; }

      return json({ score, total, scaled, route, studentName, review });
    }

    return json({error:"알 수 없는 action"},400);
  }catch(e){ return json({error:String(e?.message||e)},500); }
});
