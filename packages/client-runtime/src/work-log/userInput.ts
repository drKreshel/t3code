import { type UserInputAttachmentAnswerPayload } from "@t3tools/contracts";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function getQuestionAnswerText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(getQuestionAnswerText).filter(Boolean).join(", ");
  const nested = record(value);
  return nested ? getQuestionAnswerText(nested.answers) : "";
}

export function getQuestionTextPreview(answer: UserInputAttachmentAnswerPayload): string {
  return Object.values(answer.questionTextById ?? {})
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" · ");
}

export function getQuestionAnswerPreview(answer: UserInputAttachmentAnswerPayload): string {
  const answers = Object.values(answer.answers).map(getQuestionAnswerText).filter(Boolean);
  const attachments = Object.values(answer.attachmentsByQuestionId)
    .flat()
    .map((attachment) => attachment.name);
  return (
    answers.length > 0
      ? answers.join(" · ")
      : attachments.length > 0
        ? attachments.join(", ")
        : Object.values(answer.questionTextById ?? {}).join(" · ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

export function hasQuestionAnswer(answer: UserInputAttachmentAnswerPayload): boolean {
  return (
    Object.values(answer.answers).some(getQuestionAnswerText) ||
    Object.values(answer.attachmentsByQuestionId).some((attachments) => attachments.length > 0)
  );
}

/**
 * Reply text for a question answered in place. Message-mode answers arrive as their own
 * `async-answer:` user message; live answers go straight to the provider and leave none,
 * so clients show this as the user's reply.
 */
export function liveQuestionReplyText(item: {
  readonly responseMode?: "message" | undefined;
  readonly questions: ReadonlyArray<{ readonly id: string; readonly question: string }>;
  readonly questionAnswer?: UserInputAttachmentAnswerPayload | undefined;
}): string | undefined {
  if (item.responseMode === "message" || item.questionAnswer === undefined) return undefined;
  const { answers } = item.questionAnswer;
  const replies = item.questions.flatMap((question) => {
    const answer = getQuestionAnswerText(answers[question.id]).trim();
    return answer ? [`${question.question}\n${answer}`] : [];
  });
  return replies.length > 0 ? replies.join("\n\n") : undefined;
}
