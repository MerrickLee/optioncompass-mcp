import dotenv from 'dotenv';
import { ThinkingLevel } from '@google/genai';

dotenv.config({ quiet: true });

/**
 * Chat model used by every generateContent call.
 * GA Flash-Lite model from the Gemini deprecations page (2026-12-01 routing).
 * Override with GEMINI_MODEL.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';

/**
 * Embedding model used when logging unanswered questions.
 * Current GA embedding model from the Gemini deprecations page.
 * Override with GEMINI_EMBEDDING_MODEL.
 */
export const DEFAULT_GEMINI_EMBEDDING_MODEL = 'gemini-embedding-2';

/**
 * Previous embedding output width was 768. gemini-embedding-2 defaults to
 * 3072 and accepts 128-3072; 768 keeps existing vector columns the same width.
 * Override with GEMINI_EMBEDDING_DIMENSIONS.
 */
export const DEFAULT_GEMINI_EMBEDDING_DIMENSIONS = 768;

/**
 * Flash-Lite defaults to minimal thinking, which can stop tool use early.
 * Medium is the level Google recommends for tool-calling turns.
 * Override with GEMINI_THINKING_LEVEL (MINIMAL, LOW, MEDIUM, HIGH).
 */
export const DEFAULT_GEMINI_THINKING_LEVEL = ThinkingLevel.MEDIUM;

/** Last-resort signature Gemini 3 accepts when a function-call part has none. */
export const SKIP_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';

const THINKING_LEVELS = new Set(Object.values(ThinkingLevel));

export function getGeminiModel() {
  const override = process.env.GEMINI_MODEL?.trim();
  return override || DEFAULT_GEMINI_MODEL;
}

export function getGeminiEmbeddingModel() {
  const override = process.env.GEMINI_EMBEDDING_MODEL?.trim();
  return override || DEFAULT_GEMINI_EMBEDDING_MODEL;
}

export function getGeminiEmbeddingDimensions() {
  const raw = process.env.GEMINI_EMBEDDING_DIMENSIONS?.trim();
  if (!raw) return DEFAULT_GEMINI_EMBEDDING_DIMENSIONS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 128 || value > 3072) {
    return DEFAULT_GEMINI_EMBEDDING_DIMENSIONS;
  }
  return value;
}

export function getGeminiThinkingLevel() {
  const raw = process.env.GEMINI_THINKING_LEVEL?.trim().toUpperCase();
  if (raw && THINKING_LEVELS.has(raw)) return raw;
  return DEFAULT_GEMINI_THINKING_LEVEL;
}

export function buildGenerateContentRequest({ contents, systemInstruction, tools }) {
  const config = {
    systemInstruction,
    thinkingConfig: { thinkingLevel: getGeminiThinkingLevel() },
  };
  if (tools) config.tools = tools;
  return { model: getGeminiModel(), contents, config };
}

export function buildEmbedContentRequest(contents) {
  return {
    model: getGeminiEmbeddingModel(),
    contents,
    config: { outputDimensionality: getGeminiEmbeddingDimensions() },
  };
}

/** First function call the helpdesk acts on. Shape: { name, args, id? }. */
export function readFunctionCall(response) {
  return response?.functionCalls?.[0] ?? null;
}

function thoughtSignatureOf(part) {
  if (!part || typeof part !== 'object') return undefined;
  return part.thoughtSignature || part.thought_signature;
}

function clonePart(part) {
  const copy = structuredClone(part);
  const signature = thoughtSignatureOf(copy);
  if (signature) {
    copy.thoughtSignature = signature;
    delete copy.thought_signature;
  }
  return copy;
}

/**
 * Continue a tool turn in the shape Gemini 3 generateContent expects:
 * echo the model parts (including thoughtSignature) and answer with one
 * functionResponse whose id matches the function call.
 * Extra function calls are omitted so the response count stays 1:1 with the
 * single tool this helpdesk executes.
 */
export function appendFunctionResponse(contents, response, { name, result }) {
  const history = (contents ?? []).map((turn) => ({
    role: turn.role,
    parts: (turn.parts ?? []).map(clonePart),
  }));

  const modelContent = response?.candidates?.[0]?.content;
  const sourceParts = Array.isArray(modelContent?.parts)
    ? modelContent.parts.map(clonePart)
    : [];

  const echoed = [];
  let selected = null;
  for (const part of sourceParts) {
    if (!part?.functionCall) {
      echoed.push(part);
      continue;
    }
    if (!selected && (!name || part.functionCall.name === name)) {
      selected = part;
      echoed.push(part);
    }
  }

  if (!selected) {
    const fallbackCall = readFunctionCall(response);
    selected = {
      functionCall: {
        name: name || fallbackCall?.name,
        ...(fallbackCall?.args ? { args: structuredClone(fallbackCall.args) } : {}),
        ...(fallbackCall?.id ? { id: fallbackCall.id } : {}),
      },
    };
    echoed.push(selected);
  }

  if (selected.functionCall && !thoughtSignatureOf(selected)) {
    selected.thoughtSignature = SKIP_THOUGHT_SIGNATURE;
  }

  history.push({
    role: modelContent?.role || 'model',
    parts: echoed,
  });

  const call = selected.functionCall;
  history.push({
    role: 'user',
    parts: [
      {
        functionResponse: {
          name: call.name,
          ...(call.id ? { id: call.id } : {}),
          response: { result },
        },
      },
    ],
  });

  return history;
}
