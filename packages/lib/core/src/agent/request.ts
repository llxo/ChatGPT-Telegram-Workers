import type { ChatStreamTextHandler } from './types';
import { ENV } from '#/config';
import { Stream } from './stream';

function stripThinkingContent(text: string): string {
    // 移除已闭合的 <think>...</think> 和 <thinking>...</thinking> 块
    text = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/g, '');
    // 如果存在未闭合的 <think> 或 <thinking> 标签，移除该标签及其后的所有内容
    const match = text.match(/<think(?:ing)?>/);
    if (match) {
        text = text.substring(0, match.index!);
    }
    return text.trimStart();
}

export interface SseChatCompatibleOptions {
    streamBuilder?: (resp: Response, controller: AbortController) => Stream;
    contentExtractor?: (data: object) => string | null;
    fullContentExtractor?: (data: object) => string | null;
    errorExtractor?: (data: object) => string | null;
}

function fixOpenAICompatibleOptions(options: SseChatCompatibleOptions | null): SseChatCompatibleOptions {
    options = options || {};
    options.streamBuilder = options.streamBuilder || function (r, c) {
        return new Stream(r, c);
    };
    options.contentExtractor = options.contentExtractor || function (d: any) {
        return d?.choices?.at(0)?.delta?.content;
    };
    options.fullContentExtractor = options.fullContentExtractor || function (d: any) {
        return d.choices?.at(0)?.message.content;
    };
    options.errorExtractor = options.errorExtractor || function (d: any) {
        return d.error?.message;
    };
    return options;
}

export function isJsonResponse(resp: Response): boolean {
    const contentType = resp.headers.get('content-type');
    return contentType?.toLowerCase().includes('application/json') ?? false;
}

export function isEventStreamResponse(resp: Response): boolean {
    const types = ['application/stream+json', 'text/event-stream'];
    const content = resp.headers.get('content-type')?.toLowerCase() || '';
    for (const type of types) {
        if (content.includes(type)) {
            return true;
        }
    }
    return false;
}

export async function streamHandler<T>(stream: AsyncIterable<T>, contentExtractor: (data: T) => string | null, onStream?: (text: string) => Promise<any>): Promise<string> {
    let contentFull = '';
    let lengthDelta = 0;
    let updateStep = 50;
    let lastUpdateTime = Date.now();
    let lastStreamText = '';
    try {
        for await (const part of stream) {
            const textPart = contentExtractor(part);
            if (!textPart) {
                continue;
            }
            lengthDelta += textPart.length;
            contentFull = contentFull + textPart;
            if (lengthDelta > updateStep) {
                if (ENV.TELEGRAM_MIN_STREAM_INTERVAL > 0) {
                    const delta = Date.now() - lastUpdateTime;
                    if (delta < ENV.TELEGRAM_MIN_STREAM_INTERVAL) {
                        continue;
                    }
                    lastUpdateTime = Date.now();
                }
                lengthDelta = 0;
                updateStep += 20;
                const displayText = stripThinkingContent(contentFull);
                if (displayText && displayText !== lastStreamText) {
                    lastStreamText = displayText;
                    await onStream?.(`${displayText}\n...`);
                }
            }
        }
    } catch (e) {
        contentFull += `\nError: ${(e as Error).message}`;
    }
    return stripThinkingContent(contentFull);
}

export async function mapResponseToAnswer(resp: Response, controller: AbortController, options: SseChatCompatibleOptions | null, onStream: ((text: string) => Promise<any>) | null): Promise<string> {
    options = fixOpenAICompatibleOptions(options || null);
    if (onStream && resp.ok && isEventStreamResponse(resp)) {
        const stream = options.streamBuilder?.(resp, controller || new AbortController());
        if (!stream) {
            throw new Error('Stream builder error');
        }
        return streamHandler<object>(stream, options.contentExtractor!, onStream);
    }
    if (!isJsonResponse(resp)) {
        throw new Error(resp.statusText);
    }

    const result = await resp.json() as any;
    if (!result) {
        throw new Error('Empty response');
    }
    if (options.errorExtractor?.(result)) {
        throw new Error(options.errorExtractor?.(result) || 'Unknown error');
    }

    return stripThinkingContent(options.fullContentExtractor?.(result) || '');
}

export async function requestChatCompletions(url: string, header: Record<string, string>, body: any, onStream: ChatStreamTextHandler | null, options: SseChatCompatibleOptions | null): Promise<string> {
    const controller = new AbortController();
    const { signal } = controller;

    let timeoutID = null;
    if (ENV.CHAT_COMPLETE_API_TIMEOUT > 0) {
        timeoutID = setTimeout(() => controller.abort(), ENV.CHAT_COMPLETE_API_TIMEOUT);
    }

    const resp = await fetch(url, {
        method: 'POST',
        headers: header,
        body: JSON.stringify(body),
        signal,
    });
    if (timeoutID) {
        clearTimeout(timeoutID);
    }

    return await mapResponseToAnswer(resp, controller, options, onStream);
}
