// =====================================================================
//  Supabase Edge Function: analyze (하이브리드)
//   - 문제 출제(task:"generate", 텍스트만)        → Google Gemini
//   - 스캔/OCR(이미지 포함) + 오답 진단(diagnosticId) → Anthropic Claude
//
//  필요한 시크릿:
//    ANTHROPIC_API_KEY  (스캔·진단용)
//    GEMINI_API_KEY     (문제 출제용)
//  (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY 는 런타임 자동 주입)
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const GEMINI_API_KEY    = Deno.env.get("GEMINI_API_KEY")!;
const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// 스캔(이미지)·진단용 Claude — 비전 지원 모델
const CLAUDE_MODEL = "claude-sonnet-4-6";
// 문제 출제용 Gemini — 품질: gemini-2.5-pro / 저렴·빠름: gemini-2.5-flash
const GEMINI_MODEL = "gemini-2.5-flash";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

// ---- Anthropic (스캔/진단) ----
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

// ---- Gemini (문제 출제) ----  Anthropic식 messages(텍스트) → Gemini contents
async function callGemini(messages, max_tokens) {
  const contents = (messages || []).map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{
      text: typeof m.content === "string"
        ? m.content
        : (m.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n"),
    }],
  }));
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents,
      generationConfig: {
        maxOutputTokens: Math.min(8192, max_tokens || 8000),
        temperature: 0.9,
        responseMimeType: "application/json",
      },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || ("Gemini " + res.status));
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || "").join("");
}

function parseJSON(raw) {
  let t = String(raw || "").replace(/```json|```/g, "").trim();
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  return JSON.parse(t);
}

// ---- 진단 프롬프트 (클라이언트와 동일) ----
function buildSystemPrompt(secLabel) {
  return `당신은 미국 대학입시 SAT 전문 강사이자 오답 진단 전문가입니다. 한국 학생을 가르치는 학원 선생님이 수업 준비에 쓸 진단 리포트를 작성합니다. 모든 출력은 한국어로 작성합니다.

분석 대상 영역: ${secLabel}

각 틀린 문항에 대해 다음을 깊이 있게 분석하세요:
1. whyChose(오답 선택 배경): 이 학생이 "왜 하필 그 오답을 매력적이라고 느꼈는지" 학생의 사고 과정을 구체적으로 추정.
2. trapIntent(출제자 함정 의도): 출제자가 그 오답 선택지를 어떤 의도로 깔아두었는지.
3. correctLogic(정답 논리): 정답이 왜 정답인지 단계적으로, 학생이 따라올 수 있게.
4. errorType(오답 유형): R&W: ["어휘/문맥","핵심 근거 찾기","추론","글의 구조/목적","문법/문장 규칙","함정 선택지","시간 압박/실수"] / Math: ["개념 이해 부족","계산 실수","문제 해석 오류","공식 적용 오류","함정 선택지","시간 압박/실수"] 중 가장 가까운 하나.

종합:
- weaknessSummary: 약점 패턴을 2~4문장. 근본 원인을 짚을 것.
- errorTypeCounts: errorType 등장 횟수 객체. 예: {"추론":2}
- prescription: 우선순위 학습 처방 3~4개(구체적 행동). 배열.
- teacherNotes: "교사용 수업 포인트". 선생님이 이 학생을 가르칠 때 강조할 핵심 2~3가지를 선생님에게 말하듯. 가장 중요.

반드시 아래 JSON 형식으로만 응답(백틱·설명 없이 순수 JSON):
{"perQuestion":[{"number":"","studentAnswer":"","correctAnswer":"","whyChose":"","trapIntent":"","correctLogic":"","errorType":""}],"weaknessSummary":"","errorTypeCounts":{},"prescription":[],"teacherNotes":""}`;
}
function buildUserMsg(name, exam, secLabel, score, valid) {
  return `학생: ${name}\n시험: ${exam || "(미입력)"}\n영역: ${secLabel}\n${score ? ("점수/맞은 개수: " + score + "\n") : ""}\n아래는 학생이 틀린 문항들입니다.\n\n` +
    valid.map((q) => `[문항 ${q.number}] 학생이 고른 답: ${q.student} / 정답: ${q.correct}\n문제 내용:\n${q.content}`).join("\n\n---\n\n");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json();

    // ---- 오답 진단 (백그라운드) → Claude ----
    if (body.diagnosticId && Array.isArray(body.questions)) {
      const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { db: { schema: "imsat" }, auth: { persistSession: false } });
      const { diagnosticId, studentName, secLabel, exam, score, questions } = body;

      const work = (async () => {
        try {
          const { data: drow } = await sb.from("diagnostics").select("teacher_id").eq("id", diagnosticId).single();
          const teacherId = drow?.teacher_id ?? null;

          const system = buildSystemPrompt(secLabel);
          const user = buildUserMsg(studentName, exam, secLabel, score, questions);
          const text = await callAnthropic({ system, messages: [{ role: "user", content: user }], max_tokens: 4000 });
          const out = parseJSON(text);

          await sb.from("diagnostics").update({
            error_type_counts: out.errorTypeCounts || {},
            weakness_summary: out.weaknessSummary || "",
            prescription: out.prescription || [],
            teacher_notes: out.teacherNotes || "",
            status: "done",
          }).eq("id", diagnosticId);

          const rows = (out.perQuestion || []).map((q) => ({
            diagnostic_id: diagnosticId,
            teacher_id: teacherId,
            number: String(q.number ?? ""),
            student_answer: q.studentAnswer || "",
            correct_answer: q.correctAnswer || "",
            why_chose: q.whyChose || "",
            trap_intent: q.trapIntent || "",
            correct_logic: q.correctLogic || "",
            error_type: q.errorType || "",
          }));
          if (rows.length) await sb.from("diagnostic_questions").insert(rows);
        } catch (err) {
          await sb.from("diagnostics").update({ status: "error", error_msg: String(err?.message || err) }).eq("id", diagnosticId);
        }
      })();

      if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) EdgeRuntime.waitUntil(work);
      else await work;
      return json({ status: "processing" }, 202);
    }

    // ---- 패스스루 ----
    if (Array.isArray(body.messages)) {
      const hasImage = body.messages.some((m) =>
        Array.isArray(m.content) && m.content.some((c) => c.type === "image"));

      // 문제 출제(텍스트만) → Gemini
      if (body.task === "generate" && !hasImage) {
        const text = await callGemini(body.messages, body.max_tokens);
        return json({ text });
      }
      // 스캔/OCR(이미지) 등 → Claude
      const text = await callAnthropic({ messages: body.messages, max_tokens: body.max_tokens });
      return json({ text });
    }

    return json({ error: "알 수 없는 요청 형식입니다." }, 400);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
});
