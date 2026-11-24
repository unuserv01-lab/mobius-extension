// PromptBuilder — builds prompts with local context attached.
// Prompts carry page context ONLY to the on-device model by default; the
// cloud model receives page text only when AIRouter has already verified
// that "Allow Cloud AI" is ON (P10: no memory ever sent to the cloud).
import type { TaskContext } from '../core/ContextManager';

export class PromptBuilder {
  static whatsappReply(lastMessage: string, sender: string | undefined, userInstruction: string): string {
    const instruction = userInstruction.trim()
      ? `User instruction for tone/style: "${userInstruction}".`
      : 'Match the sender\'s tone; keep it short, natural, and friendly.';
    return [
      'You are MOBIUS, a helpful on-device assistant. Draft ONE short reply to the last WhatsApp message below.',
      instruction,
      'Reply in the same language as the incoming message. Output ONLY the reply text, no quotes, no explanation.',
      `Sender: ${sender ?? 'unknown'}`,
      `Last message: """${lastMessage}"""`,
    ].join('\n');
  }

  static summarize(pageText: string, url: string | undefined, userInstruction: string): string {
    const instruction = userInstruction.trim() && !/summar/i.test(userInstruction)
      ? `Focus on: ${userInstruction}.`
      : '';
    return [
      'Summarize the following page content in 5-8 concise bullet points.',
      instruction,
      'Keep names, numbers and facts exact. If the content is not in English, answer in its language.',
      url ? `Page URL: ${url}` : '',
      `Content:\n"""${pageText}"""`,
    ].join('\n');
  }

  static chat(userInput: string, context: TaskContext): string {
    const ctx = [
      context.title ? `Current page: ${context.title}` : '',
      context.url ? `URL: ${context.url}` : '',
      context.pageText ? `Page excerpt:\n"""${context.pageText.slice(0, 2000)}"""` : '',
      context.recentTaskSummaries.length > 0
        ? `Recent local tasks:\n- ${context.recentTaskSummaries.join('\n- ')}`
        : '',
    ].filter(Boolean).join('\n');
    return [
      'You are MOBIUS, a helpful on-device assistant running locally in the user\'s browser.',
      'Answer briefly and helpfully. If you do not know, say so.',
      ctx,
      `User: ${userInput}`,
    ].join('\n');
  }
}
