import type { z } from '@deepseek-ai/schemastery'

export declare const name: 'tokens-loop-guard'

export declare const Config: z.ZodType<{
  remindThresholds: number[]
  blockThreshold: number
  fuzzyRemindThresholds: number[]
  fuzzyBlockThreshold: number
  fuzzyTools: string[]
  include: string[]
  exclude: string[]
  argumentsPreviewChars: number
}>

export declare function apply(ctx: unknown, config: {
  remindThresholds: number[]
  blockThreshold: number
  fuzzyRemindThresholds: number[]
  fuzzyBlockThreshold: number
  fuzzyTools: string[]
  include: string[]
  exclude: string[]
  argumentsPreviewChars: number
}): void

export declare function guardStream(
  stream: AsyncIterable<unknown>,
  config: {
    minChars: number
    maxRepeatLines: number
    minLineLen: number
    maxChars: number
  },
): AsyncGenerator<unknown>
