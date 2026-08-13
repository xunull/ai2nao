/**
 * AskUserQuestion 的问答卡。
 *
 * 数据分在两条消息上:题目在 assistant 的 `tool_use.input`,你的选择在**下一条 user 行**
 * 顶层的 `toolUseResult.answers`。而那条 user 行是纯 tool_result,在阅读模式下会被过滤掉 ——
 * 所以答案必须在过滤**之前**按 tool_use_id 收集好再传进来。
 *
 * 三种形态都要能显示:正常问答、被 hook 拦下(没弹到人面前,无答案)、多题一次弹出。
 */

type Option = { label: string; description?: string };
type Question = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: Option[];
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** tool_use.input 是模型生成的任意 JSON,逐层校验后再渲染,坏形状直接跳过而不是抛。 */
function parseQuestions(params: unknown): Question[] {
  if (!isRecord(params) || !Array.isArray(params.questions)) return [];
  const out: Question[] = [];
  for (const q of params.questions) {
    if (!isRecord(q) || typeof q.question !== "string") continue;
    const options: Option[] = [];
    if (Array.isArray(q.options)) {
      for (const o of q.options) {
        if (isRecord(o) && typeof o.label === "string") {
          options.push({
            label: o.label,
            description: typeof o.description === "string" ? o.description : undefined,
          });
        }
      }
    }
    out.push({
      question: q.question,
      header: typeof q.header === "string" ? q.header : undefined,
      multiSelect: q.multiSelect === true,
      options,
    });
  }
  return out;
}

/** 多选的答案是逗号分隔的一串 label;单选就是一个 label。 */
function isChosen(answer: string | undefined, label: string): boolean {
  if (!answer) return false;
  if (answer === label) return true;
  return answer.split(",").some((s) => s.trim() === label);
}

export function AskUserQuestionCard({
  params,
  answers,
}: {
  params: unknown;
  answers?: Record<string, string>;
}) {
  const questions = parseQuestions(params);
  if (questions.length === 0) return null;

  return (
    <div className="my-3 space-y-3">
      {questions.map((q, qi) => {
        const answer = answers?.[q.question];
        const answered = answer != null && answer !== "";
        return (
          <div
            key={qi}
            className="overflow-hidden rounded-xl border border-indigo-200/70 bg-indigo-50/40"
          >
            <div className="flex flex-wrap items-center gap-2 border-b border-indigo-200/60 px-3 py-2">
              <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-semibold text-indigo-900">
                {q.header?.trim() || "请选择"}
              </span>
              {q.multiSelect && (
                <span className="text-[11px] text-indigo-700">多选</span>
              )}
              {!answered && (
                <span className="ml-auto rounded-full bg-neutral-200 px-2 py-0.5 text-[11px] font-medium text-neutral-600">
                  未回答
                </span>
              )}
            </div>

            <div className="px-3 py-2.5">
              <p className="whitespace-pre-wrap break-words text-sm font-medium text-neutral-800">
                {q.question}
              </p>

              <ul className="mt-2 space-y-1.5">
                {q.options.map((o, oi) => {
                  const chosen = isChosen(answer, o.label);
                  return (
                    <li
                      key={oi}
                      className={[
                        "rounded-lg border px-2.5 py-1.5 text-xs",
                        chosen
                          ? "border-indigo-300 bg-white font-medium text-indigo-950"
                          : "border-transparent text-neutral-500",
                      ].join(" ")}
                    >
                      <div className="flex items-start gap-2">
                        <span
                          aria-hidden
                          className={[
                            "mt-0.5 inline-block h-3 w-3 shrink-0 rounded-full border",
                            chosen
                              ? "border-indigo-500 bg-indigo-500"
                              : "border-neutral-300",
                          ].join(" ")}
                        />
                        <div className="min-w-0">
                          <span className="break-words">{o.label}</span>
                          {chosen && (
                            <span className="ml-1.5 text-[11px] text-indigo-600">
                              ✓ 你选的
                            </span>
                          )}
                          {o.description && (
                            <p className="mt-0.5 break-words text-[11px] leading-relaxed text-neutral-400">
                              {o.description}
                            </p>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>

              {/* 答案不在给出的选项里(用户走了 Other,自己打了字)也要显示出来。 */}
              {answered && !q.options.some((o) => isChosen(answer, o.label)) && (
                <p className="mt-2 rounded-lg border border-indigo-300 bg-white px-2.5 py-1.5 text-xs font-medium text-indigo-950">
                  {answer}
                  <span className="ml-1.5 text-[11px] font-normal text-indigo-600">
                    ✓ 你填的
                  </span>
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
