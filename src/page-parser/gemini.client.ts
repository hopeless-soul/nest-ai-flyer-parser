import {
  FinishReason,
  GoogleGenAI,
  ThinkingLevel,
  type GenerateContentConfig,
  type GenerateContentResponse,
} from '@google/genai';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { FatalParseError, InvalidResponseError } from './page-parser.errors';
import {
  PAGE_PROMPT,
  PAGE_RESPONSE_SCHEMA,
  PAGE_SYSTEM_INSTRUCTION,
  PARSER_MAX_OUTPUT_TOKENS,
} from './page-prompt';

/** Raw model answer of one page */
export interface PageExtraction {
  /** JSON text; validated by `normalizePage` */
  text: string | undefined;
  /** Model id that produced it */
  model: string;
}

/** Timeout of a single Gemini HTTP request, in ms (`httpOptions.timeout`) */
const GEMINI_TIMEOUT_MS = 120_000;

/** Image mime types by file extension */
const MIME_TYPES: Record<string, string> = {
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

/**
 * Mime type of an image from its R2 key's extension
 * @throws FatalParseError for an unsupported format
 */
export function mimeTypeOfKey(key: string): string {
  const ext = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
  const mimeType = MIME_TYPES[ext];
  if (!mimeType)
    throw new FatalParseError(`Unsupported page image format: ${key}`);
  return mimeType;
}

/**
 * Thinking off, temperature per model family
 * Note: Gemini 2.5 turns thinking off with a zero budget; 3.x has no "off", `MINIMAL` is its lowest level
 * Note: Gemini 3 keeps its default temperature (1.0); Google warns that lower values may cause looping
 */
export function modelConfigFor(
  model: string,
): Pick<GenerateContentConfig, 'thinkingConfig' | 'temperature'> {
  return /^gemini-2\.5-/.test(model)
    ? { thinkingConfig: { thinkingBudget: 0 }, temperature: 0 }
    : { thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } };
}

/**
 * Answer text of a response
 * @throws InvalidResponseError if the answer was cut off at the output token cap
 */
export function answerText(
  response: Pick<GenerateContentResponse, 'candidates' | 'text'>,
): string | undefined {
  if (response.candidates?.[0]?.finishReason === FinishReason.MAX_TOKENS) {
    throw new InvalidResponseError(
      `Response cut off at ${PARSER_MAX_OUTPUT_TOKENS} output tokens`,
    );
  }
  return response.text;
}

/** Gemini client for page extraction (GEMINI_API_KEY, GEMINI_MODEL) */
@Injectable()
export class GeminiClient {
  private readonly client: GoogleGenAI;
  /** Model id used for every request */
  readonly model: string;

  /** @param config - Reads GEMINI_API_KEY and GEMINI_MODEL */
  constructor(config: ConfigService<Env, true>) {
    this.client = new GoogleGenAI({
      apiKey: config.get('GEMINI_API_KEY', { infer: true }),
      httpOptions: { timeout: GEMINI_TIMEOUT_MS },
    });
    this.model = config.get('GEMINI_MODEL', { infer: true });
  }

  /** Ask the model for the offers on one page image (sent inline; the bytes come from R2) */
  async extractPage(image: Buffer, mimeType: string): Promise<PageExtraction> {
    const response = await this.client.models.generateContent({
      model: this.model,
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType, data: image.toString('base64') } },
            { text: PAGE_PROMPT },
          ],
        },
      ],
      config: {
        ...modelConfigFor(this.model),
        systemInstruction: PAGE_SYSTEM_INSTRUCTION,
        responseMimeType: 'application/json',
        responseJsonSchema: PAGE_RESPONSE_SCHEMA,
        maxOutputTokens: PARSER_MAX_OUTPUT_TOKENS,
      },
    });
    return { text: answerText(response), model: this.model };
  }
}
