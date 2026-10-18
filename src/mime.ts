// src/mime.ts
//
// RFC 2047 MIME Header Encoding and Decoding for Pacific Horizon Ops.
// Ensures Unicode subjects, recipient names, emojis, and accents survive
// RFC 2822 / 5322 MIME transport through Gmail API without mojibake.

/**
 * Decodes a single RFC 2047 encoded-word payload into raw bytes.
 */
function decodeWordBytes(encoding: string, encodedText: string): Buffer {
  const normEnc = encoding.toUpperCase();

  if (normEnc === 'B') {
    const clean = encodedText.trim();
    if (!/^[A-Za-z0-9+/=]+$/.test(clean) || clean.length % 4 !== 0) {
      throw new Error(`Malformed base64 in RFC 2047 encoded-word: "${encodedText}"`);
    }
    return Buffer.from(clean, 'base64');
  }

  if (normEnc === 'Q') {
    const bytes: number[] = [];
    for (let i = 0; i < encodedText.length; i++) {
      const c = encodedText[i];
      if (c === '_') {
        bytes.push(0x20); // RFC 2047: underscore represents space in Q-encoding
      } else if (c === '=') {
        if (i + 2 >= encodedText.length) {
          throw new Error(`Malformed quoted-printable escape in RFC 2047 encoded-word: "${encodedText}"`);
        }
        const hex = encodedText.slice(i + 1, i + 3);
        if (!/^[0-9A-Fa-f]{2}$/.test(hex)) {
          throw new Error(`Invalid hex sequence in quoted-printable encoded-word: "${hex}"`);
        }
        bytes.push(parseInt(hex, 16));
        i += 2;
      } else {
        bytes.push(c.charCodeAt(0));
      }
    }
    return Buffer.from(bytes);
  }

  throw new Error(`Unsupported RFC 2047 encoding: "${encoding}"`);
}

/**
 * Decodes a Buffer into a Unicode string based on the declared charset.
 */
function decodeBufferByCharset(buf: Buffer, charset: string): string {
  const normCharset = charset.toLowerCase();

  if (normCharset === 'utf-8' || normCharset === 'utf8') {
    return buf.toString('utf-8').normalize('NFC');
  }
  if (normCharset === 'iso-8859-1' || normCharset === 'latin1') {
    return buf.toString('latin1').normalize('NFC');
  }
  if (normCharset === 'us-ascii' || normCharset === 'ascii') {
    return buf.toString('ascii').normalize('NFC');
  }

  throw new Error(`Unsupported RFC 2047 charset: "${charset}"`);
}

/**
 * Decodes RFC 2047 MIME encoded-words (e.g. "=?UTF-8?B?...?=") in a header string.
 *
 * Requirements:
 * - RFC 2047 §6.2: Any linear-white-space separating adjacent encoded-words is discarded.
 * - Adjacent encoded-words of the same charset have their byte buffers concatenated before
 *   string decoding so multi-byte UTF-8 sequences (e.g. emojis with skin-tone modifiers)
 *   are not corrupted if split across word boundaries.
 * - Already-decoded UTF-8 or ASCII strings (containing no "=?") are returned untouched.
 * - Malformed or undecodable headers throw an Error (fail closed).
 */
export function decodeRfc2047(header: string): string {
  if (typeof header !== 'string' || !header.includes('=?')) {
    return typeof header === 'string' ? header.normalize('NFC') : header;
  }

  // RFC 2047 §6.2: Discard linear whitespace between adjacent encoded words
  let collapsed = header;
  let prev: string;
  do {
    prev = collapsed;
    collapsed = collapsed.replace(
      /(=\?[^? \t\r\n]+\?[bBqQ]\?[^? \t\r\n]+\?=)[ \t\r\n]+(=\?[^? \t\r\n]+\?[bBqQ]\?[^? \t\r\n]+\?=)/g,
      '$1$2'
    );
  } while (collapsed !== prev);

  const wordPattern = /=\?([a-zA-Z0-9_-]+)\?([bBqQ])\?([^\?]+)\?=/g;

  interface Token {
    type: 'text' | 'word';
    value?: string;
    charset?: string;
    bytes?: Buffer;
  }

  const tokens: Token[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = wordPattern.exec(collapsed)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({
        type: 'text',
        value: collapsed.slice(lastIndex, match.index),
      });
    }

    const [raw, charset, enc, text] = match;
    const bytes = decodeWordBytes(enc, text);
    tokens.push({
      type: 'word',
      charset: charset.toLowerCase(),
      bytes,
    });

    lastIndex = match.index + raw.length;
  }

  if (lastIndex < collapsed.length) {
    tokens.push({
      type: 'text',
      value: collapsed.slice(lastIndex),
    });
  }

  // Concatenate consecutive encoded-word byte buffers of the same charset before decoding to string
  const outputParts: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.type === 'text') {
      outputParts.push(tok.value!);
    } else if (tok.type === 'word' && tok.bytes && tok.charset) {
      const byteChunks: Buffer[] = [tok.bytes];
      while (
        i + 1 < tokens.length &&
        tokens[i + 1].type === 'word' &&
        tokens[i + 1].charset === tok.charset &&
        tokens[i + 1].bytes
      ) {
        byteChunks.push(tokens[i + 1].bytes!);
        i++;
      }
      const combined = Buffer.concat(byteChunks);
      outputParts.push(decodeBufferByCharset(combined, tok.charset));
    }
  }

  return outputParts.join('').normalize('NFC');
}

/**
 * Encodes a Unicode string into RFC 2047 encoded-word syntax using UTF-8 Base64.
 * If the string is purely printable ASCII and does not contain "=?", it is returned as-is.
 */
export function encodeRfc2047(text: string): string {
  if (typeof text !== 'string') return text;

  // Pure printable ASCII without RFC delimiters does not need encoding
  if (/^[\x20-\x7E]*$/.test(text) && !text.includes('=?')) {
    return text;
  }

  // Max encoded-word length is 75 chars per RFC 2047 §2.
  // "=?UTF-8?B?" (10 chars) + base64 + "?=" (2 chars) = 12 + base64.
  // 60 base64 chars max -> 45 UTF-8 bytes max per chunk.
  const maxBytesPerChunk = 45;
  const chunks: string[] = [];
  let currentChunk = '';

  const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter() : null;
  const graphemes = segmenter ? [...segmenter.segment(text)].map((s) => s.segment) : [...text];

  for (const g of graphemes) {
    const candidate = currentChunk + g;
    if (Buffer.byteLength(candidate, 'utf-8') > maxBytesPerChunk) {
      if (currentChunk) chunks.push(currentChunk);
      currentChunk = g;
    } else {
      currentChunk = candidate;
    }
  }
  if (currentChunk) chunks.push(currentChunk);

  return chunks
    .map((chunk) => `=?UTF-8?B?${Buffer.from(chunk, 'utf-8').toString('base64')}?=`)
    .join(' ');
}

/**
 * Encodes an email Subject header for RFC 2822 / 5322.
 * Preserves the ASCII "Re: " prefix outside the encoded word when present.
 */
export function encodeSubjectHeader(subject: string): string {
  if (typeof subject !== 'string') return subject;

  if (/^[\x20-\x7E]*$/.test(subject) && !subject.includes('=?')) {
    return subject;
  }

  const match = subject.match(/^(re:\s*)(.*)$/i);
  if (match) {
    const prefix = match[1];
    const rest = match[2];
    return `${prefix}${encodeRfc2047(rest)}`;
  }

  return encodeRfc2047(subject);
}

/**
 * Encodes a recipient/sender header (e.g. "To", "From", "Cc").
 * Non-ASCII display names before "<email@domain>" are encoded while
 * keeping the address specification in US-ASCII as required by RFC 2047 §5.
 */
export function encodeRecipientHeader(raw: string): string {
  if (typeof raw !== 'string') return raw;

  const match = raw.match(/^(.*)<([^>]+)>$/);
  if (match) {
    const displayName = match[1].trim();
    const address = match[2].trim();
    if (/^[\x20-\x7E]*$/.test(displayName) && !displayName.includes('=?')) {
      return `${displayName} <${address}>`;
    }
    return `${encodeRfc2047(displayName)} <${address}>`;
  }

  return encodeRfc2047(raw);
}
