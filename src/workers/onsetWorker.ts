import { detectOnsets } from '../audio/onsetDetect';
import type { OnsetDetectOptions } from '../audio/onsetDetect';

/**
 * 起音切片的后台 Worker：在独立线程中对当前波形选区（未选时为整段）
 * 执行多频带正向能量变化起音分析，避免阻塞页面。主线程通过 postMessage
 * 传入声道数据副本（Transferable 转移，零拷贝）与分析范围，结果经结构化克隆返回。
 */

export interface OnsetAnalyzeRequest {
  sampleRate: number;
  channels: Float32Array[];
  /** 分析范围起止（绝对采样点，终点不含） */
  rangeStartSample: number;
  rangeEndSample: number;
  options?: OnsetDetectOptions;
}

export type OnsetWorkerResponse =
  | { type: 'result'; result: import('../audio/onsetDetect').OnsetDetectResult }
  | { type: 'error'; message: string };

// 与 DOM lib 并存的最小 Worker 全局对象类型（避免引入 webworker lib 的类型冲突）
interface WorkerScope {
  onmessage: ((e: MessageEvent<OnsetAnalyzeRequest>) => void) | null;
  postMessage(message: OnsetWorkerResponse, transfer?: Transferable[]): void;
}
const ctx = self as unknown as WorkerScope;

ctx.onmessage = (e) => {
  const { sampleRate, channels, rangeStartSample, rangeEndSample, options } = e.data;
  try {
    const audio = {
      numberOfChannels: channels.length,
      sampleRate,
      length: channels[0]?.length ?? 0,
      getChannelData: (c: number) => channels[c],
    };
    ctx.postMessage({
      type: 'result',
      result: detectOnsets(audio, rangeStartSample, rangeEndSample, options),
    });
  } catch (err) {
    ctx.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
