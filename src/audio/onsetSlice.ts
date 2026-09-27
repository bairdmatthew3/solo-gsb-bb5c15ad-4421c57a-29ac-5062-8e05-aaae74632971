import { fftInPlace } from './fft';
import type { AudioDataLike } from './types';

/**
 * 起音切片：对指定范围（波形选区，未框选时为整段音频）检测瞬态起音并切片。
 *
 * - 特征：范围内音频混合为单声道，Hann 窗 STFT，minFreqHz ~ Nyquist 等比划分的
 *   对数频带短时能量（dB，动态下限，与重复片段发现口径一致）。
 * - 起音新颖度：各频带能量的正向变化 max(0, E[t] − E[t−1]) 跨频带求和，
 *   对打击/起音敏感，且不被能量衰减段触发。
 * - 局部噪声底自适应阈值：逐帧取 ±localWindowSec 窗口内新颖度的
 *   中位数 + thresholdK × 1.4826 × MAD（中位绝对偏差）作为阈值，
 *   随局部噪声水平浮动，抑制弱噪声引起的低幅伪峰。
 * - 静音门限：帧 RMS 低于 gateDbfs 的帧不产生起音（静音中的噪声起伏不算起音）。
 * - 峰值拾取与最小间隔：新颖度严格超过阈值且为局部最大者成为候选；
 *   间隔小于 minIntervalSec 的候选只保留新颖度更强者，抑制密集伪峰。
 * - 切片：保留的起音按采样点升序作为内部切点，范围起止点作首尾边界，
 *   相邻边界构成切片；距边界不足 minSliceSec 的起音被丢弃，保证不产生空片。
 */

export interface OnsetSliceOptions {
  /** 分析窗长（秒），默认 0.023（≈1024 采样点 @ 44.1 kHz） */
  frameSec?: number;
  /** 帧移（秒），默认 0.005；超长范围按比例加大以限制总帧数 */
  hopSec?: number;
  /** 最大分析帧数（超出时按比例加大帧移），默认 40000 */
  maxFrames?: number;
  /** 对数频带数量，默认 6 */
  bands?: number;
  /** 最低频带边缘 Hz，默认 40 */
  minFreqHz?: number;
  /** 局部噪声底统计窗口半径（秒），默认 0.1 */
  localWindowSec?: number;
  /** 自适应阈值系数：阈值 = 局部中位数 + K × 1.4826 × MAD，默认 3.5 */
  thresholdK?: number;
  /** 静音门限（dBFS，帧 RMS），低于该电平的帧不产生起音，默认 −60 */
  gateDbfs?: number;
  /** 最小起音间隔（秒），间隔小于该值的候选只保留更强者，默认 0.05 */
  minIntervalSec?: number;
  /** 起音距范围边界的最小距离（秒），不足该距离的起音被丢弃以避免碎屑片，默认 0.02 */
  minSliceSec?: number;
}

export interface OnsetSlice {
  /** 切片起点 / 终点（采样点，终点不含） */
  startSample: number;
  endSample: number;
  /** 切片起点 / 终点（秒） */
  startSec: number;
  endSec: number;
}

export type OnsetSliceFailure = 'too-short' | 'silence' | 'no-onset';

export interface OnsetSliceResult {
  /** 无有效起音 / 无法分析时的原因；正常切片为 null */
  failure: OnsetSliceFailure | null;
  /** 采样率 Hz */
  sampleRate: number;
  /** 分析范围起点 / 终点（采样点，终点不含） */
  rangeStartSample: number;
  rangeEndSample: number;
  /** 分析窗长 / 实际帧移（采样点） */
  frameSamples: number;
  hopSamples: number;
  /** 频带数量与实际使用的静音门限（dBFS） */
  bands: number;
  gateDbfs: number;
  /** 分析帧数 / 被静音门限排除的帧数 */
  totalFrames: number;
  gatedFrames: number;
  /** 保留的起音切点（采样点，升序；不含范围首尾边界） */
  onsets: number[];
  /** 切片（按时间顺序，起点 < 终点，无空片） */
  slices: OnsetSlice[];
}

/** 频带能量下限：约 −120 dB，避免静音时取对数得到 −Infinity */
const EPS = 1e-12;

/** 前 n 项的中位数（scratch 为可重用暂存数组，内容会被排序改写） */
function medianOf(scratch: Float32Array, n: number): number {
  const s = scratch.subarray(0, n).sort();
  const mid = n >> 1;
  return n % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function detectOnsetSlices(
  audio: AudioDataLike,
  startSec: number,
  endSec: number,
  options: OnsetSliceOptions = {},
): OnsetSliceResult {
  const sr = audio.sampleRate;
  const len = audio.length;
  const nCh = audio.numberOfChannels;
  const bands = Math.max(2, Math.round(options.bands ?? 6));
  const gateDbfs = options.gateDbfs ?? -60;
  const thresholdK = options.thresholdK ?? 3.5;
  const minIntervalSec = options.minIntervalSec ?? 0.05;
  const minSliceSec = options.minSliceSec ?? 0.02;

  // 分析范围夹取到音频内
  const rangeStart = Math.max(0, Math.min(Math.round(startSec * sr), len));
  const rangeEnd = Math.max(rangeStart, Math.min(Math.round(endSec * sr), len));
  const rangeLen = rangeEnd - rangeStart;

  // ---- 窗长：最接近 frameSec 的 2 的幂（256 ~ 4096）----
  const wantFrame = (options.frameSec ?? 0.023) * sr;
  let frame = 256;
  while (frame * 2 <= wantFrame * 1.5 && frame < 4096) frame <<= 1;

  // ---- 帧移：固定步长；超长范围按比例加大以限制总帧数（与重复片段发现同口径）----
  const baseHop = Math.max(1, Math.round((options.hopSec ?? 0.005) * sr));
  const maxFrames = Math.max(1000, Math.round(options.maxFrames ?? 40000));
  const hop = Math.max(baseHop, Math.ceil(rangeLen / maxFrames));

  const base: OnsetSliceResult = {
    failure: null,
    sampleRate: sr,
    rangeStartSample: rangeStart,
    rangeEndSample: rangeEnd,
    frameSamples: frame,
    hopSamples: hop,
    bands,
    gateDbfs,
    totalFrames: 0,
    gatedFrames: 0,
    onsets: [],
    slices: [],
  };

  if (!Number.isFinite(sr) || sr <= 0 || nCh <= 0) {
    return { ...base, failure: 'too-short' };
  }

  // 峰值拾取需要至少 3 帧
  const nFrames = Math.floor((rangeLen - frame) / hop) + 1;
  if (nFrames < 3) {
    return { ...base, totalFrames: Math.max(0, nFrames), failure: 'too-short' };
  }

  // ---- 范围内音频混合为单声道 ----
  const mono = new Float32Array(rangeLen);
  for (let c = 0; c < nCh; c++) {
    const d = audio.getChannelData(c);
    for (let i = 0; i < rangeLen; i++) mono[i] += d[rangeStart + i];
  }
  if (nCh > 1) {
    const inv = 1 / nCh;
    for (let i = 0; i < rangeLen; i++) mono[i] *= inv;
  }

  // ---- 对数频带划分（与重复片段发现口径一致）----
  const nyq = sr / 2;
  const fMin = Math.max(1, Math.min(options.minFreqHz ?? 40, nyq / 2));
  const binBand = new Int16Array(frame / 2 + 1).fill(-1);
  const logRatio = Math.log(nyq / fMin);
  for (let k = 1; k <= frame / 2; k++) {
    const f = (k * sr) / frame;
    if (f < fMin || f > nyq) continue;
    binBand[k] = Math.min(bands - 1, Math.floor((bands * Math.log(f / fMin)) / logRatio));
  }

  const hann = new Float32Array(frame);
  for (let i = 0; i < frame; i++) {
    hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (frame - 1));
  }

  // ---- STFT：每帧的对数频带能量（dB）与时域能量（静音门限）----
  const bandDb = new Float32Array(nFrames * bands);
  const gated = new Uint8Array(nFrames);
  const gateRms = 10 ** (gateDbfs / 20);
  const gateEnergy = gateRms * gateRms;
  const re = new Float32Array(frame);
  const im = new Float32Array(frame);
  const bandAcc = new Float64Array(bands);
  let maxE = 0;
  let gatedFrames = 0;
  for (let t = 0; t < nFrames; t++) {
    const off = t * hop;
    let e = 0;
    for (let i = 0; i < frame; i++) {
      const x = mono[off + i];
      e += x * x;
      re[i] = x * hann[i];
      im[i] = 0;
    }
    e /= frame;
    if (e > maxE) maxE = e;
    fftInPlace(re, im);
    bandAcc.fill(0);
    for (let k = 1; k <= frame / 2; k++) {
      const b = binBand[k];
      if (b < 0) continue;
      bandAcc[b] += re[k] * re[k] + im[k] * im[k];
    }
    let total = 0;
    for (let b = 0; b < bands; b++) total += bandAcc[b];
    // 动态下限：帧总能量的 −90 dB（静音或异常时回落到绝对下限 EPS）
    const rel = total * 1e-9;
    const floor = rel > EPS ? rel : EPS;
    const row = t * bands;
    for (let b = 0; b < bands; b++) {
      const safe = bandAcc[b] > floor ? bandAcc[b] : floor;
      bandDb[row + b] = 10 * Math.log10(safe);
    }
    if (e < gateEnergy) {
      gated[t] = 1;
      gatedFrames++;
    }
  }
  // 整个范围都低于静音门限：无有效起音
  if (maxE < gateEnergy) {
    return { ...base, totalFrames: nFrames, gatedFrames, failure: 'silence' };
  }

  // ---- 起音新颖度：各频带能量的正向变化跨频带求和 ----
  const nov = new Float32Array(nFrames);
  for (let t = 1; t < nFrames; t++) {
    const prev = (t - 1) * bands;
    const cur = t * bands;
    let s = 0;
    for (let b = 0; b < bands; b++) {
      const d = bandDb[cur + b] - bandDb[prev + b];
      if (d > 0) s += d;
    }
    nov[t] = s;
  }

  // ---- 局部噪声底自适应阈值：±localWindowSec 窗口内 中位数 + K × 1.4826 × MAD ----
  const W = Math.max(1, Math.round(((options.localWindowSec ?? 0.1) * sr) / hop));
  const thr = new Float32Array(nFrames);
  const scratch = new Float32Array(2 * W + 1);
  for (let t = 0; t < nFrames; t++) {
    const lo = Math.max(0, t - W);
    const hi = Math.min(nFrames - 1, t + W);
    const m = hi - lo + 1;
    for (let i = 0; i < m; i++) scratch[i] = nov[lo + i];
    const med = medianOf(scratch, m);
    for (let i = 0; i < m; i++) scratch[i] = Math.abs(nov[lo + i] - med);
    const mad = medianOf(scratch, m);
    thr[t] = med + thresholdK * 1.4826 * mad;
  }

  // ---- 峰值拾取：非静音帧、新颖度严格超过阈值且为局部最大 ----
  const candidates: { t: number; v: number }[] = [];
  for (let t = 1; t < nFrames - 1; t++) {
    if (gated[t]) continue;
    const v = nov[t];
    if (v <= 0 || v <= thr[t]) continue;
    if (v < nov[t - 1] || v < nov[t + 1]) continue;
    candidates.push({ t, v });
  }

  // ---- 最小间隔抑制：间隔过近的候选只保留新颖度更强者 ----
  const minIntervalFrames = Math.max(1, Math.round((minIntervalSec * sr) / hop));
  const kept: { t: number; v: number }[] = [];
  for (const c of candidates) {
    const last = kept[kept.length - 1];
    if (last && c.t - last.t < minIntervalFrames) {
      if (c.v > last.v) kept[kept.length - 1] = c;
      continue;
    }
    kept.push(c);
  }

  // ---- 内部切点：换算为采样点（升序），丢弃距边界过近者以保证不产生空片 ----
  const minSliceSamples = Math.max(1, Math.round(minSliceSec * sr));
  const onsets: number[] = [];
  for (const c of kept) {
    const s = rangeStart + c.t * hop;
    if (s - rangeStart < minSliceSamples || rangeEnd - s < minSliceSamples) continue;
    onsets.push(s);
  }
  if (onsets.length === 0) {
    return { ...base, totalFrames: nFrames, gatedFrames, failure: 'no-onset' };
  }

  // ---- 切片：范围起止点作首尾边界，相邻边界构成切片 ----
  const slices: OnsetSlice[] = [];
  let prev = rangeStart;
  for (const s of onsets) {
    if (s - prev >= 1) {
      slices.push({ startSample: prev, endSample: s, startSec: prev / sr, endSec: s / sr });
    }
    prev = s;
  }
  if (rangeEnd - prev >= 1) {
    slices.push({ startSample: prev, endSample: rangeEnd, startSec: prev / sr, endSec: rangeEnd / sr });
  }
  if (slices.length === 0) {
    return { ...base, totalFrames: nFrames, gatedFrames, failure: 'no-onset' };
  }

  return { ...base, totalFrames: nFrames, gatedFrames, onsets, slices };
}
