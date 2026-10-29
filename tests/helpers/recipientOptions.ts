// Test helper: the recipient dropdowns (src/components/shared/RecipientSelect.tsx) render their options as ARIA listbox items so
// part of an option can be coloured. For assertions about WHICH options exist and which is chosen, this turns each item back into
// a plain `<option value="…"[ disabled=""][ selected=""]>text</option>` (tags inside the item stripped, so "name · note" reads as
// one string). Colours are asserted separately, on the real markup.
export function recipientOptionsAsHtml(html: string): string {
  return html.replace(/<li ([^>]*role="option"[^>]*)>([\s\S]*?)<\/li>/g, (_all, attrs: string, inner: string) => {
    const value = /data-value="([^"]*)"/.exec(attrs)?.[1] ?? '';
    const disabled = /aria-disabled="true"/.test(attrs) ? ' disabled=""' : '';
    const selected = /aria-selected="true"/.test(attrs) ? ' selected=""' : '';
    return `<option value="${value}"${disabled}${selected}>${inner.replace(/<[^>]+>/g, '')}</option>`;
  });
}
