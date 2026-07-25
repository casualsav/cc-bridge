// Detect tg's own output spliced into a message body — the fingerprint of the backtick footgun.
//
// A session writes Markdown, Markdown code spans use `backticks`, and inside a double-quoted shell
// string a backtick is COMMAND SUBSTITUTION: the shell runs the command and pastes its stdout into
// the message. It happened live on 2026-07-25 — an answer explaining a `tg spawn …` bug executed it
// and shipped the usage text mid-sentence.
//
// Nothing can undo that (it happens in the caller's shell, before tgctl exists). But sessions
// overwhelmingly backtick `tg …` commands, and those splice OUR text, which is recognisable. This
// catches that case so the CLI can refuse instead of relaying a message the caller didn't write.
// Deliberately narrow: it matches result/usage lines with their trailing separator, so ordinary
// prose about the same commands still sends.
const SPLICED_OUTPUT = /(?:error: )?usage: tg(?:ctl)? |(?:ok|error): (?:spawned|answered|delivered|posted|reopened|reopening|ending|sent) /

export function looksSpliced(text: string): boolean {
  return SPLICED_OUTPUT.test(text)
}
