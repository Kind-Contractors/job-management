// The words of the "send report to client" email, in ONE place used by both sides:
//   - the send-client-report Edge Function (which builds the email and calls the email provider), and
//   - the manager's browser (the Send to client dialog shows and edits exactly this text before sending).
// Pure functions only - no Deno or browser APIs - so it can be imported by either, and unit-tested in Node.
//
// The manager can replace the message; whatever he confirms is what is sent. The server still validates and escapes it
// on its own (never trusting the browser), and builds the HTML itself: the text is escaped, never inserted as markup.

export const MAX_EMAIL_MESSAGE_LENGTH = 2000;

/** Characters, not UTF-16 units: an emoji counts as one, matching what a person sees in the counter. */
export function countCharacters(text: string): number {
  return Array.from(text).length;
}

/** Escapes text for safe insertion into HTML (names, building names and the manager's own message alike). */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Normalises line endings to \n and drops control characters (keeping newlines and tabs). */
export function cleanMessage(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

export type EmailMessageCheck = { ok: true; message: string } | { ok: false; error: string };

/**
 * Validates a message: must be text, not empty or whitespace-only, and at most MAX_EMAIL_MESSAGE_LENGTH characters
 * (after cleaning and trimming). Returns the cleaned message to send, or a plain-words reason it cannot be sent.
 */
export function checkEmailMessage(raw: unknown): EmailMessageCheck {
  if (typeof raw !== 'string') return { ok: false, error: 'The message must be text.' };
  const message = cleanMessage(raw).trim();
  if (message === '') return { ok: false, error: 'The message cannot be empty.' };
  const length = countCharacters(message);
  if (length > MAX_EMAIL_MESSAGE_LENGTH) {
    return { ok: false, error: `The message is ${length} characters; the maximum is ${MAX_EMAIL_MESSAGE_LENGTH}.` };
  }
  return { ok: true, message };
}

/** The length the counter shows and the server enforces: characters of the cleaned, trimmed message. */
export function emailMessageLength(raw: string): number {
  return countCharacters(cleanMessage(raw).trim());
}

/** "15 September 2026" - the date as it appears in the email; 'date not set' is honest rather than inventing one. */
export function formatReportDateLong(scheduledDate: string | null): string {
  if (!scheduledDate) return 'date not set';
  return new Date(`${scheduledDate}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export interface DefaultEmailMessageInput {
  contactName: string;
  buildingName: string;
  dateLabel: string;
}

/** The standard message - what the manager sees pre-filled, and what is sent if he leaves it as it is. */
export function defaultEmailMessage({ contactName, buildingName, dateLabel }: DefaultEmailMessageInput): string {
  return `Hello ${contactName},\n\nPlease find attached the service report for ${buildingName}, dated ${dateLabel}. This report is for your records.\n\nKind regards,\nKind Contractors`;
}

/**
 * The HTML body: blank lines separate paragraphs, single line breaks become <br/>, and every character of the text is
 * escaped, so nothing the manager (or a contact or building name) types can become markup.
 */
export function emailMessageToHtml(message: string): string {
  return cleanMessage(message)
    .trim()
    .split(/\n(?:[ \t]*\n)+/)
    .map((paragraph) => `<p>${escapeHtml(paragraph.trim()).replace(/\n/g, '<br/>')}</p>`)
    .join('');
}

/** The plain-text alternative sent alongside the HTML (better for mail clients and spam filters). */
export function emailMessageToText(message: string): string {
  return cleanMessage(message).trim();
}
