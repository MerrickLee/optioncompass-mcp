import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it, afterEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import {
  DEFAULT_GEMINI_EMBEDDING_DIMENSIONS,
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_THINKING_LEVEL,
  SKIP_THOUGHT_SIGNATURE,
  appendFunctionResponse,
  buildEmbedContentRequest,
  buildGenerateContentRequest,
  getGeminiEmbeddingDimensions,
  getGeminiEmbeddingModel,
  getGeminiModel,
  getGeminiThinkingLevel,
  readFunctionCall,
} from '../geminiConfig.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_KEYS = [
  'GEMINI_MODEL',
  'GEMINI_EMBEDDING_MODEL',
  'GEMINI_EMBEDDING_DIMENSIONS',
  'GEMINI_THINKING_LEVEL',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
}

afterEach(restoreEnv);

describe('Gemini model config', () => {
  it('defaults to current GA models', () => {
    delete process.env.GEMINI_MODEL;
    delete process.env.GEMINI_EMBEDDING_MODEL;
    delete process.env.GEMINI_EMBEDDING_DIMENSIONS;
    delete process.env.GEMINI_THINKING_LEVEL;

    assert.equal(DEFAULT_GEMINI_MODEL, 'gemini-3.5-flash-lite');
    assert.equal(DEFAULT_GEMINI_EMBEDDING_MODEL, 'gemini-embedding-2');
    assert.equal(DEFAULT_GEMINI_EMBEDDING_DIMENSIONS, 768);
    assert.equal(DEFAULT_GEMINI_THINKING_LEVEL, ThinkingLevel.MEDIUM);
    assert.equal(getGeminiModel(), DEFAULT_GEMINI_MODEL);
    assert.equal(getGeminiEmbeddingModel(), DEFAULT_GEMINI_EMBEDDING_MODEL);
    assert.equal(getGeminiEmbeddingDimensions(), 768);
    assert.equal(getGeminiThinkingLevel(), ThinkingLevel.MEDIUM);
  });

  it('honors env overrides and ignores blank model ids', () => {
    process.env.GEMINI_MODEL = 'gemini-3.8-flash';
    process.env.GEMINI_EMBEDDING_MODEL = 'gemini-embedding-custom';
    process.env.GEMINI_EMBEDDING_DIMENSIONS = '1536';
    process.env.GEMINI_THINKING_LEVEL = 'high';

    assert.equal(getGeminiModel(), 'gemini-3.8-flash');
    assert.equal(getGeminiEmbeddingModel(), 'gemini-embedding-custom');
    assert.equal(getGeminiEmbeddingDimensions(), 1536);
    assert.equal(getGeminiThinkingLevel(), ThinkingLevel.HIGH);

    process.env.GEMINI_MODEL = '   ';
    process.env.GEMINI_EMBEDDING_DIMENSIONS = '64';
    process.env.GEMINI_THINKING_LEVEL = 'not-a-level';
    assert.equal(getGeminiModel(), DEFAULT_GEMINI_MODEL);
    assert.equal(getGeminiEmbeddingDimensions(), DEFAULT_GEMINI_EMBEDDING_DIMENSIONS);
    assert.equal(getGeminiThinkingLevel(), DEFAULT_GEMINI_THINKING_LEVEL);
  });
});

describe('generateContent request shape', () => {
  it('sends the configured model, tools, and thinking level without deprecated sampling params', () => {
    delete process.env.GEMINI_MODEL;
    delete process.env.GEMINI_THINKING_LEVEL;

    const tools = [{ functionDeclarations: [{ name: 'search_knowledge_base' }] }];
    const request = buildGenerateContentRequest({
      contents: [{ role: 'user', parts: [{ text: 'Where are the picks?' }] }],
      systemInstruction: 'Be concise.',
      tools,
    });

    assert.equal(request.model, 'gemini-3.5-flash-lite');
    assert.equal(request.config.systemInstruction, 'Be concise.');
    assert.equal(request.config.tools, tools);
    assert.deepEqual(request.config.thinkingConfig, { thinkingLevel: 'MEDIUM' });
    assert.equal(request.contents[0].parts[0].text, 'Where are the picks?');
    for (const removed of ['temperature', 'topP', 'topK', 'thinkingBudget']) {
      assert.equal(request.config[removed], undefined);
    }
  });

  it('omits tools on the post-tool answer turn', () => {
    const request = buildGenerateContentRequest({
      contents: [],
      systemInstruction: 'Be concise.',
    });
    assert.equal(request.config.tools, undefined);
  });
});

describe('embedContent request shape', () => {
  it('requests 768-d gemini-embedding-2 vectors and does not send taskType', () => {
    delete process.env.GEMINI_EMBEDDING_MODEL;
    delete process.env.GEMINI_EMBEDDING_DIMENSIONS;

    const request = buildEmbedContentRequest('I cannot log in');
    assert.equal(request.model, 'gemini-embedding-2');
    assert.equal(request.contents, 'I cannot log in');
    assert.deepEqual(request.config, { outputDimensionality: 768 });
    assert.equal(request.config.taskType, undefined);
  });
});

describe('function calling', () => {
  it('still reads name and args from the first function call', () => {
    const call = readFunctionCall({
      functionCalls: [
        { id: 'call-1', name: 'escalate_to_human', args: { reason: 'Refund request' } },
        { name: 'search_knowledge_base', args: { query: 'ignored' } },
      ],
    });
    assert.equal(call.name, 'escalate_to_human');
    assert.deepEqual(call.args, { reason: 'Refund request' });
    assert.equal(call.id, 'call-1');
    assert.equal(readFunctionCall({ functionCalls: [] }), null);
    assert.equal(readFunctionCall({}), null);
  });

  it('echoes thought signatures and matches functionResponse id and name', () => {
    const contents = [
      { role: 'user', parts: [{ text: 'What is in the Gold plan?' }] },
    ];
    const response = {
      functionCalls: [
        { id: 'fn-9', name: 'search_knowledge_base', args: { query: 'gold plan' } },
      ],
      candidates: [{
        content: {
          role: 'model',
          parts: [
            { thought: true, text: 'Look this up.', thoughtSignature: 'thought-sig' },
            {
              thoughtSignature: 'call-sig',
              functionCall: { id: 'fn-9', name: 'search_knowledge_base', args: { query: 'gold plan' } },
            },
            {
              functionCall: { id: 'fn-other', name: 'escalate_to_human', args: { reason: 'no' } },
            },
          ],
        },
      }],
    };

    const followUp = appendFunctionResponse(contents, response, {
      name: 'search_knowledge_base',
      result: 'Title: Gold\nContent: 25 chats a week.',
    });

    assert.equal(contents.length, 1);
    assert.equal(followUp.length, 3);
    assert.deepEqual(followUp[0], contents[0]);

    const modelTurn = followUp[1];
    assert.equal(modelTurn.role, 'model');
    assert.equal(modelTurn.parts.length, 2);
    assert.equal(modelTurn.parts[0].thoughtSignature, 'thought-sig');
    assert.equal(modelTurn.parts[1].thoughtSignature, 'call-sig');
    assert.equal(modelTurn.parts[1].functionCall.id, 'fn-9');
    assert.deepEqual(modelTurn.parts[1].functionCall.args, { query: 'gold plan' });
    assert.equal(modelTurn.parts.some((part) => part.functionCall?.name === 'escalate_to_human'), false);

    const toolTurn = followUp[2];
    assert.equal(toolTurn.role, 'user');
    assert.deepEqual(toolTurn.parts, [{
      functionResponse: {
        id: 'fn-9',
        name: 'search_knowledge_base',
        response: { result: 'Title: Gold\nContent: 25 chats a week.' },
      },
    }]);
  });

  it('normalizes snake_case signatures and fills a missing one', () => {
    const withSnake = appendFunctionResponse([], {
      candidates: [{
        content: {
          parts: [{
            thought_signature: 'raw-sig',
            functionCall: { name: 'search_knowledge_base', args: { query: 'tiers' } },
          }],
        },
      }],
    }, { name: 'search_knowledge_base', result: 'none' });

    const part = withSnake[0].parts[0];
    assert.equal(part.thoughtSignature, 'raw-sig');
    assert.equal(part.thought_signature, undefined);

    const missing = appendFunctionResponse([], {
      functionCalls: [{ name: 'search_knowledge_base', args: { query: 'tiers' } }],
    }, { name: 'search_knowledge_base', result: 'none' });

    assert.equal(missing[0].role, 'model');
    assert.equal(missing[0].parts[0].thoughtSignature, SKIP_THOUGHT_SIGNATURE);
    assert.deepEqual(missing[0].parts[0].functionCall, {
      name: 'search_knowledge_base',
      args: { query: 'tiers' },
    });
    assert.equal(missing[1].parts[0].functionResponse.id, undefined);
    assert.equal(missing[1].parts[0].functionResponse.name, 'search_knowledge_base');
    assert.equal(missing[1].parts[0].functionResponse.response.result, 'none');
  });
});

describe('SDK request and response shapes', () => {
  it('round-trips function calls and embeddings through @google/genai', async () => {
    delete process.env.GEMINI_MODEL;
    delete process.env.GEMINI_EMBEDDING_MODEL;
    delete process.env.GEMINI_EMBEDDING_DIMENSIONS;
    delete process.env.GEMINI_THINKING_LEVEL;

    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const href = String(url);
      calls.push({ url: href, body: init?.body ? JSON.parse(init.body) : null });
      const payload = href.includes(':batchEmbedContents')
        ? { embeddings: [{ values: [0.25, 0.5] }] }
        : calls.length === 1
          ? {
              candidates: [{
                content: {
                  role: 'model',
                  parts: [{
                    thoughtSignature: 'sig-from-api',
                    functionCall: {
                      id: 'fn-1',
                      name: 'search_knowledge_base',
                      args: { query: 'gold' },
                    },
                  }],
                },
                finishReason: 'STOP',
              }],
            }
          : {
              candidates: [{
                content: { role: 'model', parts: [{ text: 'Gold includes 25 chats a week.' }] },
                finishReason: 'STOP',
              }],
            };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      const ai = new GoogleGenAI({ apiKey: 'test-key' });
      const contents = [{ role: 'user', parts: [{ text: 'What is Gold?' }] }];
      const tools = [{
        functionDeclarations: [{
          name: 'search_knowledge_base',
          parameters: {
            type: 'OBJECT',
            properties: { query: { type: 'STRING' } },
            required: ['query'],
          },
        }],
      }];

      const first = await ai.models.generateContent(buildGenerateContentRequest({
        contents,
        systemInstruction: 'Be concise.',
        tools,
      }));
      const call = readFunctionCall(first);
      assert.equal(call.name, 'search_knowledge_base');
      assert.deepEqual(call.args, { query: 'gold' });
      assert.equal(call.id, 'fn-1');

      const followUp = appendFunctionResponse(contents, first, {
        name: call.name,
        result: 'Gold includes 25 chats a week.',
      });
      const second = await ai.models.generateContent(buildGenerateContentRequest({
        contents: followUp,
        systemInstruction: 'Be concise.',
      }));
      assert.equal(second.text, 'Gold includes 25 chats a week.');

      const embedded = await ai.models.embedContent(buildEmbedContentRequest('cannot log in'));
      assert.deepEqual(embedded.embeddings?.[0]?.values, [0.25, 0.5]);
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(calls.length, 3);
    assert.match(calls[0].url, /models\/gemini-3\.5-flash-lite:generateContent$/);
    assert.equal(calls[0].body.generationConfig.thinkingConfig.thinkingLevel, 'MEDIUM');
    assert.equal(calls[0].body.generationConfig.temperature, undefined);
    assert.equal(calls[0].body.tools[0].functionDeclarations[0].name, 'search_knowledge_base');

    const modelTurn = calls[1].body.contents[1];
    const toolTurn = calls[1].body.contents[2];
    assert.equal(modelTurn.role, 'model');
    assert.equal(modelTurn.parts[0].thoughtSignature, 'sig-from-api');
    assert.equal(modelTurn.parts[0].functionCall.id, 'fn-1');
    assert.equal(modelTurn.parts[0].functionCall.name, 'search_knowledge_base');
    assert.deepEqual(toolTurn.parts[0].functionResponse, {
      id: 'fn-1',
      name: 'search_knowledge_base',
      response: { result: 'Gold includes 25 chats a week.' },
    });
    assert.equal(calls[1].body.tools, undefined);

    assert.match(calls[2].url, /models\/gemini-embedding-2:batchEmbedContents$/);
    assert.equal(calls[2].body.requests[0].outputDimensionality, 768);
    assert.equal(calls[2].body.requests[0].model, 'models/gemini-embedding-2');
    assert.equal(calls[2].body.requests[0].taskType, undefined);
  });
});

describe('live sources', () => {
  it('does not keep retired Gemini model ids', () => {
    const retired = ['gemini-2.5-' + 'flash', 'text-embedding-' + '004', 'embedding-' + '001'];
    const files = readdirSync(ROOT).filter((name) => name.endsWith('.js'));
    const hits = [];
    for (const name of files) {
      const source = readFileSync(join(ROOT, name), 'utf8');
      for (const id of retired) {
        if (source.includes(id)) hits.push(`${name}: ${id}`);
      }
    }
    assert.deepEqual(hits, []);
  });
});
