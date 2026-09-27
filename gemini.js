// Gemini makes the carousel pictures, through its REST API with Node's own fetch. GEMINI_API_KEY is used only here.
// `gemini.picture` is an object property so tests can replace it without calling the API.
import { clip } from './text.js';

const API = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_BYTES = 5 * 1024 * 1024; // the largest picture Claude's picture check accepts

// `retry`: another attempt may work (a refusal, a busy service). Otherwise the whole job stops with the message.
export class PictureError extends Error {
  constructor(message, retry) {
    super(message);
    this.retry = retry;
  }
}

// The picture's type from its first bytes (PNG, JPEG or WebP), or null.
export function imageType(bytes) {
  if (bytes.length > 8 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length > 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export const gemini = {
  // One 1K picture. Returns { bytes, type, usage: { input, output } } or throws a PictureError that is safe to show.
  async picture(prompt, { model, aspectRatio }) {
    let res;
    try {
      res = await fetch(`${API}/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY ?? '' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio, imageSize: '1K' } },
        }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      throw new PictureError(`Gemini could not be reached (${err.name === 'TimeoutError' ? 'timed out' : err.message}).`, true);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = clip(String(data.error?.message ?? ''), 200);
      throw new PictureError(`Gemini rejected the request (HTTP ${res.status})${detail ? `: ${detail}` : '.'}`, res.status === 429 || res.status >= 500);
    }
    if (data.promptFeedback?.blockReason) throw new PictureError(`Gemini refused the prompt (${data.promptFeedback.blockReason}).`, true);
    const candidate = data.candidates?.[0];
    // Gemini 3 image models may send interim "thought" pictures first; the last other picture is the answer.
    const part = (candidate?.content?.parts ?? []).filter((p) => (p.inlineData ?? p.inline_data)?.data && !p.thought).at(-1);
    if (!part) throw new PictureError(`Gemini made no picture (${candidate?.finishReason ?? 'no reason given'}).`, true);
    const bytes = Buffer.from((part.inlineData ?? part.inline_data).data, 'base64');
    const type = imageType(bytes);
    if (!type) throw new PictureError('Gemini sent something that is not a PNG, JPEG or WebP picture.', true);
    if (bytes.length > MAX_BYTES) throw new PictureError('Gemini sent a picture over 5 MB.', true);
    return { bytes, type, usage: { input: data.usageMetadata?.promptTokenCount ?? 0, output: data.usageMetadata?.candidatesTokenCount ?? 0 } };
  },
};
