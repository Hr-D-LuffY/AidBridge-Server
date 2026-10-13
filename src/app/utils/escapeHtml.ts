const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

// For text that goes inside an HTML email. The broadcast title and message are typed by an admin,
// but a copy-pasted snippet or a compromised admin account must not turn into markup in
// thousands of inboxes.
export const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char)
