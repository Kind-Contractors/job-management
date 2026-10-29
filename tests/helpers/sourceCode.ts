// Test helper: some tests check that a piece of code is present in a source file. A code formatter (for example an editor's
// format-on-save) changes quote style and line wrapping without changing behaviour, which would break those checks. For the files
// that have been reformatted, the tests read the source through `formatNeutral`, which removes those differences:
//   - plain string literals use single quotes ("x" -> 'x'; JSX attribute values such as className="…" are left as they are),
//   - every run of whitespace becomes one space (line wrapping disappears),
//   - a trailing comma the formatter adds before a closing bracket is dropped, and so is padding just inside ( ), [ ] and a
//     wrapped JSX expression {…}.
// The assertions themselves stay written in the original style.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The files known to be formatted differently from the style the source assertions were written in. */
export const REFORMATTED_FILES = ['InvoiceEditor.tsx', 'BuildingDefaultRecipientPanel.tsx'];

export function formatNeutral(code: string): string {
  return code
    // Line comments become block comments first, so they still end where they ended once the line breaks are gone (the tests'
    // own comment stripping removes both kinds). In these files every "//" starts a comment.
    .replace(/\/\/([^\n]*)/g, (_m, text: string) => `/*${text.replace(/\*\//g, '* /')} */`)
    .replace(/(?<![=\w])"([^"'\n\\]*)"/g, "'$1'")
    .replace(/\s+/g, ' ')
    // A trailing comma the formatter adds when it wraps a list - but not "}," closing an object or callback, which was there before.
    .replace(/([^}]),\s*([)\]}])/g, '$1 $2')
    .replace(/([([]) /g, '$1')
    .replace(/ ([)\]])/g, '$1')
    // Padding the formatter adds inside a wrapped JSX expression: ={ x } -> ={x}, and ") }" -> ")}".
    .replace(/=\{ ([^{}]*?) \}/g, '={$1}')
    .replace(/\) \}/g, ')}')
    .replace(/ {2,}/g, ' ');
}

/** Reads a source file; a reformatted one comes back format-neutral (see above), any other one exactly as it is. */
export function readSourceFile(...parts: string[]): string {
  const code = readFileSync(join(process.cwd(), ...parts), 'utf8').replace(/\r\n/g, '\n');
  return REFORMATTED_FILES.some((f) => parts[parts.length - 1] === f) ? formatNeutral(code) : code;
}
