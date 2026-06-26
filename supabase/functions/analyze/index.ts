// =====================================================================
//  Supabase Edge Function: analyze
//  - 모드 1 (패스스루): { max_tokens, messages } → Anthropic 호출 → { text }
//      · OMR/정답지 OCR, 문제집 추출, SAT 문제 출제에 사용
//  - 모드 2 (오답 진단): { diagnosticId, studentName, secLabel, exam, score, questions }
//      · 백그라운드로 분석 → imsat.diagnostics 업데이트 + imsat.diagnostic_questions 삽입
//
//  배포 전 필요한 시크릿: ANTHROPIC_API_KEY
//  (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY 는 런타임에 자동 주입됨)
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// 비전(이미지) + 텍스트를 모두 지원하는 모델. 필요 시 교체하세요.
const MODEL = "claude-3-5-sonnet-latest";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

async function callAnthropic(
  { system, messages, max_tokens }:
  { system?: string; messages: unknown[]; max_tokens?: number },
): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: max_tokens || 4000,
      ...(system ? { system } : {}),
      messages,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || ("Anthropic " + res.status));
  return (data.content || [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");
}

function parseJSON(raw: string) {
  let t = String(raw || "").replace(/```json|```/g, "").trim();
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  return JSON.parse(t);
}

// ---- 진단 프롬프트 (클라이언트와 동일) ----
function buildSystemPrompt(secLabel: string) {
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
function buildUserMsg(
  name: string, exam: string, secLabel: string, score: string,
  valid: Array<{ number: string; student: string; correct: string; content: string }>,
) {
  return `학생: ${name}\n시험: ${exam || "(미입력)"}\n영역: ${secLabel}\n${score ? ("점수/맞은 개수: " + score + "\n") : ""}\n아래는 학생이 틀린 문항들입니다.\n\n` +
    valid.map((q) =>
      `[문항 ${q.number}] 학생이 고른 답: ${q.student} / 정답: ${q.correct}\n문제 내용:\n${q.content}`
    ).join("\n\n---\n\n");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json();

    // ---- 모드 1: 패스스루 (OCR / 문제 출제) ----
    if (Array.isArray(body.messages)) {
      const text = await callAnthropic({
        messages: body.messages,
        max_tokens: body.max_tokens,
      });
      return json({ text });
    }

    // ---- 모드 2: 오답 진단 (백그라운드) ----
    if (body.diagnosticId && Array.isArray(body.questions)) {
      const sb = createClient(SUPABASE_URL, SERVICE_ROLE, {
        db: { schema: "imsat" },
        auth: { persistSession: false },
      });
      const { diagnosticId, studentName, secLabel, exam, score, questions } = body;

      const work = (async () => {
        try {
          const { data: drow } = await sb.from("diagnostics")
            .select("teacher_id").eq("id", diagnosticId).single();
          const teacherId = drow?.teacher_id ?? null;

          const system = buildSystemPrompt(secLabel);
          const user = buildUserMsg(studentName, exam, secLabel, score, questions);
          const text = await callAnthropic({
            system,
            messages: [{ role: "user", content: user }],
            max_tokens: 4000,
          });
          const out = parseJSON(text);

          await sb.from("diagnostics").update({
            error_type_counts: out.errorTypeCounts || {},
            weakness_summary: out.weaknessSummary || "",
            prescription: out.prescription || [],
            teacher_notes: out.teacherNotes || "",
            status: "done",
          }).eq("id", diagnosticId);

          const rows = (out.perQuestion || []).map((q: any) => ({
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
          await sb.from("diagnostics").update({
            status: "error",
            error_msg: String((err as any)?.message || err),
          }).eq("id", diagnosticId);
        }
      })();

      // 즉시 202 응답, 분석은 백그라운드로 계속
      // @ts-ignore EdgeRuntime 은 Supabase Edge 런타임 전역
      if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
        // @ts-ignore
        EdgeRuntime.waitUntil(work);
      } else {
        await work;
      }
      return json({ status: "processing" }, 202);
    }

    return json({ error: "알 수 없는 요청 형식입니다." }, 400);
  } catch (e) {
    return json({ error: String((e as any)?.message || e) }, 500);
  }
});
