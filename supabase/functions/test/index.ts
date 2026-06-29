// =====================================================================
//  Supabase Edge Function: test  (온라인 시험 응시)
//   - action "info"   : 토큰으로 시험 정보 + 등록 학생 목록 + 정답 뺀 문항 반환
//   - action "submit" : 채점(서버) → 응시기록 저장 → AI 진단 자동 생성(백그라운드)
//                       → 점수 + 정답·해설(리뷰) 반환
//
//  ⚠️ 이 함수는 학생(비로그인)이 호출하므로 verify_jwt = false 로 배포하세요.
//  필요한 시크릿: ANTHROPIC_API_KEY  (진단용)
//  (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY 는 자동 주입)
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLAUDE_MODEL = "claude-sonnet-4-6";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
function svc() {
  return createClient(SUPABASE_URL, SERVICE_ROLE, { db: { schema: "imsat" }, auth: { persistSession: false } });
}

// 실전형 제한시간(초): R&W ~71s/문항, Math ~95s/문항
function timeLimitSec(section, count) {
  const per = section === "math" ? 95 : 71;
  return Math.max(60, Math.round((count || 1) * per));
}
function norm(v) { return String(v ?? "").trim(); }
function gradeOne(q, ans) {
  const a = norm(ans);
  const correct = norm(q.answer);
  const isGrid = q.format === "grid" || !(q.choices && ["A","B","C","D"].some((c) => q.choices[c] !== undefined));
  if (isGrid) {
    if (!a) return false;
    if (a.toLowerCase() === correct.toLowerCase()) return true;
    const na = Number(a.replace(/\s/g, "")), nc = Number(correct.replace(/\s/g, ""));
    return !isNaN(na) && !isNaN(nc) && na === nc;
  }
  return a.toUpperCase() === correct.toUpperCase();
}
function composeContent(q) {
  const c = q.choices || {};
  const ch = ["A","B","C","D"].filter((k) => c[k] !== undefined).map((k) => k + ") " + c[k]).join("\n");
  return [ (q.passage && String(q.passage).trim()) ? String(q.passage).trim() : "", q.stem || "", ch ].filter(Boolean).join("\n\n");
}

// ---- 진단(Claude) ----
async function callAnthropic({ system, messages, max_tokens }) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: max_tokens || 4000, ...(system ? { system } : {}), messages }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || ("Anthropic " + res.status));
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
}
function parseJSON(raw) {
  let t = String(raw || "").replace(/```json|```/g, "").trim();
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  return JSON.parse(t);
}
function buildSystemPrompt(secLabel) {
  return `당신은 미국 대학입시 SAT 전문 강사이자 오답 진단 전문가입니다. 한국 학생을 가르치는 학원 선생님이 수업 준비에 쓸 진단 리포트를 작성합니다. 모든 출력은 한국어로 작성합니다.

분석 대상 영역: ${secLabel}

각 틀린 문항에 대해: 1. whyChose(오답 선택 배경) 2. trapIntent(출제자 함정 의도) 3. correctLogic(정답 논리) 4. errorType(오답 유형: R&W는 ["어휘/문맥","핵심 근거 찾기","추론","글의 구조/목적","문법/문장 규칙","함정 선택지","시간 압박/실수"], Math는 ["개념 이해 부족","계산 실수","문제 해석 오류","공식 적용 오류","함정 선택지","시간 압박/실수"] 중 하나).

종합: weaknessSummary(2~4문장), errorTypeCounts(객체), prescription(배열 3~4개), teacherNotes.

반드시 아래 JSON만(백틱·설명 없이):
{"perQuestion":[{"number":"","studentAnswer":"","correctAnswer":"","whyChose":"","trapIntent":"","correctLogic":"","errorType":""}],"weaknessSummary":"","errorTypeCounts":{},"prescription":[],"teacherNotes":""}`;
}

async function runDiagnosis(sb, diagId, secLabel, examName, scoreStr, wrongQs, teacherId) {
  try {
    const user = `학생 시험 채점 결과 기반 오답 분석.\n영역: ${secLabel}\n시험: ${examName}\n점수: ${scoreStr}\n\n` +
      wrongQs.map((q) => `[문항 ${q.number}] 학생이 고른 답: ${q.student} / 정답: ${q.correct}\n문제 내용:\n${q.content}`).join("\n\n---\n\n");
    const text = await callAnthropic({ system: buildSystemPrompt(secLabel), messages: [{ role: "user", content: user }], max_tokens: 4000 });
    const out = parseJSON(text);
    await sb.from("diagnostics").update({
      error_type_counts: out.errorTypeCounts || {}, weakness_summary: out.weaknessSummary || "",
      prescription: out.prescription || [], teacher_notes: out.teacherNotes || "", status: "done",
    }).eq("id", diagId);
    const rows = (out.perQuestion || []).map((q) => ({
      diagnostic_id: diagId, teacher_id: teacherId, number: String(q.number ?? ""),
      student_answer: q.studentAnswer || "", correct_answer: q.correctAnswer || "",
      why_chose: q.whyChose || "", trap_intent: q.trapIntent || "",
      correct_logic: q.correctLogic || "", error_type: q.errorType || "",
    }));
    if (rows.length) await sb.from("diagnostic_questions").insert(rows);
  } catch (err) {
    await sb.from("diagnostics").update({ status: "error", error_msg: String(err?.message || err) }).eq("id", diagId);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json();
    const token = norm(body.token);
    if (!token) return json({ error: "토큰이 없습니다." }, 400);
    const sb = svc();

    const { data: ps } = await sb.from("problem_sets").select("*").eq("share_token", token).single();
    if (!ps) return json({ error: "유효하지 않은 시험 링크입니다." }, 404);
    const questions = ps.questions || [];
    const secLabel = ps.section === "math" ? "Math" : "Reading & Writing";

    // ---- 시험 정보 + 학생 목록 (정답 제외) ----
    if (body.action === "info") {
      const { data: studs } = await sb.from("students").select("id,name").eq("teacher_id", ps.teacher_id).order("name");
      const qOut = questions.map((q, i) => ({
        number: q.number || (i + 1), skill: q.skill || "", format: q.format || "mc",
        passage: q.passage || "", stem: q.stem || "", choices: q.choices || {},
      }));
      return json({
        title: ps.title, section: ps.section, secLabel, count: questions.length,
        timeLimitSec: timeLimitSec(ps.section, questions.length),
        students: studs || [], questions: qOut,
      });
    }

    // ---- 제출 → 채점 ----
    if (body.action === "submit") {
      const answers = Array.isArray(body.answers) ? body.answers : [];
      const studentId = body.studentId || null;
      // 학생 검증(등록된 학생만)
      let studentName = "";
      if (studentId) {
        const { data: st } = await sb.from("students").select("id,name").eq("id", studentId).eq("teacher_id", ps.teacher_id).single();
        if (!st) return json({ error: "등록된 학생이 아닙니다." }, 400);
        studentName = st.name;
      } else {
        return json({ error: "학생을 선택하세요." }, 400);
      }

      let score = 0;
      const per = [], review = [], wrongQs = [];
      questions.forEach((q, i) => {
        const ans = answers[i] ?? "";
        const ok = gradeOne(q, ans);
        if (ok) score++;
        else wrongQs.push({ number: q.number || (i + 1), student: norm(ans) || "(미응답)", correct: norm(q.answer), content: composeContent(q) });
        per.push({ number: q.number || (i + 1), your: norm(ans), answer: norm(q.answer), correct: ok });
        review.push({
          number: q.number || (i + 1), skill: q.skill || "", format: q.format || "mc",
          passage: q.passage || "", stem: q.stem || "", choices: q.choices || {},
          answer: norm(q.answer), your: norm(ans), correct: ok,
          explanation: q.explanation || "", distractors: q.distractors || {},
        });
      });
      const total = questions.length;
      const scoreStr = score + "/" + total;

      // 진단 행 생성(자동 평가)
      let diagId = null;
      if (wrongQs.length) {
        const { data: drow } = await sb.from("diagnostics").insert({
          teacher_id: ps.teacher_id, student_id: studentId, exam_name: ps.title || "온라인 시험",
          section: ps.section, score: scoreStr, status: "processing",
        }).select("id").single();
        diagId = drow?.id || null;
      }

      // 응시 기록 저장
      await sb.from("test_attempts").insert({
        teacher_id: ps.teacher_id, problem_set_id: ps.id, student_id: studentId, student_name: studentName,
        section: ps.section, score, total, answers, per_question: per, diagnostic_id: diagId,
      });

      // 진단은 백그라운드로 (학생은 즉시 결과 확인)
      if (diagId) {
        const work = runDiagnosis(sb, diagId, secLabel, ps.title || "온라인 시험", scoreStr, wrongQs, ps.teacher_id);
        if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) EdgeRuntime.waitUntil(work);
        else await work;
      }

      return json({ score, total, studentName, review });
    }

    return json({ error: "알 수 없는 action" }, 400);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
});
