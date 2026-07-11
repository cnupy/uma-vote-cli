// Shared TUI helpers — dependency-free (no ink import) so any screen or
// non-ink code can use them.

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// Secret prompts (signer PINs, passphrases) must never echo. Pairing codes
// and other prompts stay visible.
export const isSecretPrompt = (question: string): boolean => /pin|passphrase|password/i.test(question)

// Masked rendering of an in-progress prompt answer
export const maskBuf = (question: string, buf: string): string =>
    isSecretPrompt(question) ? '•'.repeat(buf.length) : buf

// A qrcode-terminal output block (multi-line half-block art). Screens render
// it full-height in a dedicated slot — a tailed log window would cut it in
// half, making the pairing QR unscannable.
export const isQrBlock = (text: string): boolean => text.split('\n').length > 8 && /[█▄▀]/.test(text)

// OSC 8 terminal hyperlink: the label is ctrl+clickable with the full URL
// attached (Windows Terminal, iTerm2, …) — unlike raw URL text, it survives
// shortening and never depends on the URL fitting on one line.
export const hyperlink = (url: string, label: string): string => `\x1b]8;;${url}\x07${label}\x1b]8;;\x07`

// URL matcher shared by every linkifier (trailing punctuation excluded), and
// the shortened one-line label a link renders as
export const URL_RE = /https?:\/\/\S*[^\s).,;:!?\]]/g
export const urlLabel = (url: string, max = 34): string => {
    const bare = url.replace(/^https?:\/\//, '')
    return bare.length > max ? bare.slice(0, max - 1) + '…' : bare
}

// URL → OSC 8 link with a shortened label, for single-line Ink text. (The
// pre-wrapped scroll windows tokenize first instead — see commit-ui.)
export const linkifyUrls = (text: string): string =>
    text.replace(URL_RE, u => hyperlink(u, urlLabel(u)))

// App-wide round-navigation chord: [ ]/ctrl+←→ = prev/next round. Returns 0
// when the input is not a round-nav key.
export const roundNavDelta = (input: string, key: { ctrl: boolean; leftArrow: boolean; rightArrow: boolean }): -1 | 0 | 1 =>
    (key.ctrl && key.leftArrow) || input === '[' ? -1
        : (key.ctrl && key.rightArrow) || input === ']' ? 1 : 0
