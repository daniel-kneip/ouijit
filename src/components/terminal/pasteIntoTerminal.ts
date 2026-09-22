/**
 * Puts text in a terminal's prompt without sending it.
 *
 * Wrapped in bracketed-paste markers: without them the terminal reads each
 * newline as Enter and submits a multi-line text partway through. Nothing
 * follows the closing marker, so it sits in the prompt for the user to send.
 */
export function pasteIntoTerminal(ptyId: string, text: string): void {
  window.api.pty.write(ptyId, `\x1b[200~${text}\x1b[201~`);
}
