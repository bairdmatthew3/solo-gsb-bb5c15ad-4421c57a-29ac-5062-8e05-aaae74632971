import { detectOnsetSlices } from '../audio/onsetSlice';
import type { OnsetSliceOptions, OnsetSliceResult } from '../audio/onsetSlice';

/**
 * 起音切片的后台 Worker：在独立线程中对指定范围（选区或整段）执行
 * 多频带短时能量分析与起音检测，避免阻塞页面。主线程通过 postMessage
 * 传入声道数据副本（Transferable 转移，零拷贝），结果经结构化克隆返回。
 */

export interface OnsetAnalyzeRequest {
  sampleRate: number;
  channels: Float32Array[];
  /** 分析范围（秒）：当前选区；未框选时为整段音频 */
  range: { startSec: number; endSec: number };
  options?: OnsetSliceOptions;
}

export type OnsetWorkerResponse =
  | { type: 'result'; result: OnsetSliceResult }
  | { type: 'error'; message: string };

// 与 DOM lib 并存的最小 Worker 全局对象类型（避免引入 webworker lib 的类型冲突）
interface WorkerScope {
  onmessage: ((e: MessageEvent<OnsetAnalyzeRequest>) => void) | null;
  postMessage(message: OnsetWorkerResponse, transfer?: Transferable[]): void;
}
const ctx = self as unknown as WorkerScope;

ctx.onmessage = (e) => {
  const { sampleRate, channels, range, options } = e.data;
  try {
    const audio = {
      numberOfChannels: channels.length,
      sampleRate,
      length: channels[0]?.length ?? 0,
      getChannelData: (c: number) => channels[c],
    };
    ctx.postMessage({
      type: 'result',
      result: detectOnsetSlices(audio, range.startSec, range.endSec, options),
    });
  } catch (err) {
    ctx.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
