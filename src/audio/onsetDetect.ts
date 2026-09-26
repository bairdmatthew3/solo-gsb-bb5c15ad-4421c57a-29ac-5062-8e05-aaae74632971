import { fftInPlace } from './fft';
import type { AudioDataLike } from './types';

/**
 * 起音（Onset）检测：针对给定采样点范围（未选时由调用方传入整段）执行，
 * 使用多频带短时能量的正向变化（multi-band positive energy flux）构造
 * 起音强度函数，并以局部噪声底自适应阈值、静音门限与最小峰间隔
 * 抑制弱噪声与密集伪峰。
 *
 * - 特征：范围内音频等权混合为单声道，Hann 窗 STFT（窗长约 23 ms 的 2 的幂），
 *   40 Hz ~ Nyquist 等比划分为 8 个对数频带，逐帧计算各频带能量（dB，
 *   动态下限，与重复片段发现 / 接缝频谱口径一致）；起音强度函数取
 *   逐频带 dB 能量相对前一帧正向增量之和（只计能量上升，忽略衰减）。
 * - 正向变化约束：起音必须伴随总能量上升——候选帧短时能量须严格高于前一帧。
 *   音符收尾 / 突发截断虽会改变频谱成分，但总能量在下降，不会被误判为起音
 *   （dB 域谱通量在低电平处也可能很大，单用频谱成分变化会产生尾部伪峰）。
 * - 静音门限：帧 RMS 低于 silenceDbfs（默认 −60 dBFS）的帧不参与检测，
 *   安静段落中的弱噪声不会产生起音；整段低于门限时返回 silence。
 * - 局部噪声底自适应阈值：对每帧取其前后各 localWindowSec/2 的邻域
 *   （默认 ±0.5 s，静音帧不参与统计）计算起音强度的局部均值（局部噪声底）
 *   与标准差，阈值 = max(minThresholdDb, 均值 + k·标准差)（默认 k = 1.5、
 *   绝对下限 1 dB）。安静段阈值随噪声底下放，密集能量活动段阈值自动抬高，
 *   仅显著超出局部背景的正向变化才被判为候选。
 * - 峰筛选：候选须为严格局部极大（高于两侧相邻帧），且起音位置映射回的
 *   采样点严格位于范围内部。
 * - 最小间隔：候选按强度降序贪心接受，距已接受起音不足 minIntervalSec
 *   （默认 70 ms）的较弱峰作为密集伪峰被抑制（非极大值抑制）。
 * - 切片：保留的起音按采样点升序作为内部切点，范围起止点作为首尾边界，
 *   切点去重并保证相邻切点至少相距 2 个采样点，不产生空片。
 */

export interface OnsetDetectOptions {
  /** 分析窗长（秒），默认 0.023（≈1024 采样点 @ 44.1 kHz，取最接近的 2 的幂） */
  frameSec?: number;
  /** 帧移（秒），默认 0.0116；长范围自动加大以限制总帧数 */
  hopSec?: number;
  /** 对数频带数量，默认 8 */
  bands?: number;
  /** 最低频带边缘 Hz，默认 40 */
  minFreqHz?: number;
  /** 静音门限（dBFS，帧 RMS），默认 −60 */
  silenceDbfs?: number;
  /** 逐频带正向增量的绝对阈值下限（dB），默认 1 */
  minThresholdDb?: number;
  /** 局部噪声底统计窗（秒，前后各取一半），默认 0.5 */
  localWindowSec?: number;
  /** 自适应阈值灵敏度系数 k（均值 + k·标准差），默认 1.5 */
  thresholdK?: number;
  /** 起音最小间隔（秒），默认 0.07 */
  minIntervalSec?: number;
  /** 最大分析帧数（超出时按比例加大帧移），默认 24000 */
  maxFrames?: number;
}

export interface OnsetPoint {
  /** 起音位置（绝对采样点，即分析帧起点，严格位于范围内部） */
  sample: number;
  /** 所在分析帧序号 */
  frame: number;
  /** 起音强度（该帧起音函数 / 自适应阈值，≥ 1） */
  strength: number;
}

export type OnsetDetectFailure = 'too-short' | 'silence' | 'no-onset';

export interface OnsetSlice {
  /** 片序号（从 0 开始） */
  index: number;
  /** 片起点 / 终点（绝对采样点，终点不含，长度恒 ≥ 2） */
  startSample: number;
  endSample: number;
}

export interface OnsetDetectResult {
  /** 无有效起音时的原因；成功时为 null */
  failure: OnsetDetectFailure | null;
  sampleRate: number;
  /** 分析范围起止（绝对采样点，终点不含） */
  rangeStartSample: number;
  rangeEndSample: number;
  /** 分析窗 / 帧移（采样点） */
  frameSamples: number;
  hopSamples: number;
  /** 频带数量 */
  bands: number;
  /** 总帧数 / 静音帧数 */
  frameCount: number;
  silentFrames: number;
  /** 最小间隔抑制前的局部峰数量（诊断用） */
  peakCandidates: number;
  /** 保留的起音（按采样点升序） */
  onsets: OnsetPoint[];
  /** 切片（范围起止为首尾边界，无空片，数量 = 起音数 + 1） */
  slices: OnsetSlice[];
}

/** 频带能量下限：约 −120 dB，避免静音时取对数得到 −Infinity */
const EPS = 1e-12;

export function detectOnsets(
  audio: AudioDataLike,
  rangeStartSample: number,
  rangeEndSample: number,
  options: OnsetDetectOptions = {},
): OnsetDetectResult {
  const sr = audio.sampleRate;
  const len = audio.length;
  const nCh = audio.numberOfChannels;
  const bands = Math.max(2, Math.round(options.bands ?? 8));
  const silenceDbfs = options.silenceDbfs ?? -60;
  const minThresholdDb = options.minThresholdDb ?? 1;
  const localWindowSec = options.localWindowSec ?? 0.5;
  const thresholdK = options.thresholdK ?? 1.5;
  const minIntervalSec = options.minIntervalSec ?? 0.07;
  const maxFrames = Math.max(200, Math.round(options.maxFrames ?? 24000));

  // ---- 范围夹取到有效音频 ----
  const rangeStart = Math.max(0, Math.min(Math.round(rangeStartSample), len - 1));
  const rangeEnd = Math.max(rangeStart + 1, Math.min(Math.round(rangeEndSample), len));
  const rangeLen = rangeEnd - rangeStart;

  // ---- 窗长：最接近 frameSec 的 2 的幂（256 ~ 4096）----
  const wantFrame = (options.frameSec ?? 0.023) * sr;
  let frame = 256;
  while (frame * 2 <= wantFrame * 1.5 && frame < 4096) frame <<= 1;

  // ---- 帧移：固定步长；长范围按比例加大以限制总帧数；不超过半窗 ----
  const baseHop = Math.max(32, Math.round((options.hopSec ?? 0.0116) * sr));
  const hop = Math.max(
    baseHop,
    Math.min(Math.floor(frame / 2), Math.ceil((rangeLen - frame) / maxFrames)),
  );

  const nFrames = rangeLen >= frame ? Math.floor((rangeLen - frame) / hop) + 1 : 0;

  const base: OnsetDetectResult = {
    failure: null,
    sampleRate: sr,
    rangeStartSample: rangeStart,
    rangeEndSample: rangeEnd,
    frameSamples: frame,
    hopSamples: hop,
    bands,
    frameCount: Math.max(0, nFrames),
    silentFrames: 0,
    peakCandidates: 0,
    onsets: [],
    slices: [],
  };

  if (
    !Number.isFinite(sr) ||
    sr <= 0 ||
    nCh <= 0 ||
    // 至少需要 4 帧才能在内部找到严格局部极大
    nFrames < 4
  ) {
    return { ...base, failure: 'too-short' };
  }

  // ---- 对数频带划分（与重复片段发现 / 接缝频谱口径一致）----
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

  // ---- STFT：逐帧多频带 dB 能量的正向增量之和（起音强度函数）----
  const silenceEnergy = 10 ** (silenceDbfs / 10); // 帧均方 → RMS dBFS = 10·log10(e)
  const channelData: Float32Array[] = [];
  for (let c = 0; c < nCh; c++) channelData.push(audio.getChannelData(c));
  const invCh = 1 / nCh;

  const re = new Float32Array(frame);
  const im = new Float32Array(frame);
  const bandAcc = new Float64Array(bands);
  const prevDb = new Float64Array(bands);
  const odf = new Float64Array(nFrames);
  const frameEnergy = new Float64Array(nFrames);
  const silent = new Uint8Array(nFrames);
  let maxEnergy = 0;
  let silentFrames = 0;

  for (let f = 0; f < nFrames; f++) {
    const off = rangeStart + f * hop;
    let energy = 0;
    for (let i = 0; i < frame; i++) {
      let mix = 0;
      for (let c = 0; c < nCh; c++) mix += channelData[c][off + i];
      mix *= invCh;
      energy += mix * mix;
      re[i] = mix * hann[i];
      im[i] = 0;
    }
    energy /= frame;
    if (energy > maxEnergy) maxEnergy = energy;

    fftInPlace(re, im);
    bandAcc.fill(0);
    for (let k = 1; k <= frame / 2; k++) {
      const b = binBand[k];
      if (b < 0) continue;
      bandAcc[b] += re[k] * re[k] + im[k] * im[k];
    }
    let total = 0;
    for (let b = 0; b < bands; b++) total += bandAcc[b];
    // 动态下限：帧总能量的 −90 dB（异常时回落到绝对下限 EPS）
    const floorE = Math.max(total * 1e-9, EPS);

    let flux = 0;
    for (let b = 0; b < bands; b++) {
      const db = 10 * Math.log10(bandAcc[b] > floorE ? bandAcc[b] : floorE);
      if (f > 0) {
        const d = db - prevDb[b];
        if (d > 0) flux += d; // 只计正向能量变化（起音），忽略衰减
      }
      prevDb[b] = db;
    }
    odf[f] = flux;
    frameEnergy[f] = energy;
    if (energy < silenceEnergy) {
      silent[f] = 1;
      silentFrames++;
    }
  }

  if (maxEnergy < silenceEnergy) {
    return { ...base, frameCount: nFrames, silentFrames, failure: 'silence' };
  }

  // ---- 局部噪声底自适应阈值：邻域内非静音帧的均值 + k·标准差 ----
  const halfWin = Math.max(1, Math.floor((localWindowSec * sr) / hop / 2));
  const threshold = new Float64Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    const lo = Math.max(0, f - halfWin);
    const hi = Math.min(nFrames, f + halfWin + 1);
    let sum = 0;
    let cnt = 0;
    for (let j = lo; j < hi; j++) {
      if (!silent[j]) {
        sum += odf[j];
        cnt++;
      }
    }
    if (cnt === 0) {
      threshold[f] = minThresholdDb;
      continue;
    }
    const mean = sum / cnt;
    let varSum = 0;
    for (let j = lo; j < hi; j++) {
      if (!silent[j]) {
        const d = odf[j] - mean;
        varSum += d * d;
      }
    }
    const sd = cnt > 1 ? Math.sqrt(varSum / (cnt - 1)) : 0;
    threshold[f] = Math.max(minThresholdDb, mean + thresholdK * sd);
  }

  // ---- 局部峰候选：非静音、总能量较前一帧上升（正向变化约束）、
  // 超过自适应阈值、严格高于两侧相邻帧 ----
  interface Candidate {
    frame: number;
    value: number;
  }
  const candidates: Candidate[] = [];
  // 首帧无前向能量、末帧无法验证单侧峰，均不纳入；对应采样点必严格位于范围内部
  for (let f = 1; f < nFrames - 1; f++) {
    if (silent[f]) continue;
    if (frameEnergy[f] <= frameEnergy[f - 1]) continue; // 总能量未上升：收尾 / 截断伪峰
    const v = odf[f];
    if (v <= threshold[f]) continue;
    if (v <= odf[f - 1] || v < odf[f + 1]) continue;
    candidates.push({ frame: f, value: v });
  }

  if (candidates.length === 0) {
    return { ...base, frameCount: nFrames, silentFrames, failure: 'no-onset' };
  }

  // ---- 最小间隔抑制（非极大值抑制）：按强度降序贪心接受，
  // 距任一已接受起音不足 minIntervalSec 的较弱峰作为密集伪峰被丢弃 ----
  const minGapFrames = Math.max(1, Math.round((minIntervalSec * sr) / hop));
  const byStrength = [...candidates].sort((a, b) => b.value - a.value);
  const accepted: Candidate[] = [];
  for (const cand of byStrength) {
    let crowded = false;
    for (const kept of accepted) {
      if (Math.abs(cand.frame - kept.frame) < minGapFrames) {
        crowded = true;
        break;
      }
    }
    if (!crowded) accepted.push(cand);
  }
  accepted.sort((a, b) => a.frame - b.frame);

  const onsets: OnsetPoint[] = accepted.map((c) => ({
    sample: rangeStart + c.frame * hop,
    frame: c.frame,
    strength: threshold[c.frame] > 0 ? c.value / threshold[c.frame] : c.value,
  }));

  // ---- 切点：范围起点 + 起音点（升序）+ 范围终点；去重并保证不产生空片 ----
  const rawCuts = [rangeStart, ...onsets.map((o) => o.sample), rangeEnd].sort((a, b) => a - b);
  const cuts: number[] = [];
  for (const c of rawCuts) {
    if (cuts.length === 0) {
      cuts.push(c);
      continue;
    }
    const last = cuts[cuts.length - 1];
    if (c === last) continue;
    // 过近的内部切点直接丢弃；起音帧距边界至少一个帧移（≥ 32 采样），正常不会触发
    if (c - last < 2) continue;
    cuts.push(c);
  }
  if (cuts[cuts.length - 1] !== rangeEnd) cuts.push(rangeEnd);

  const slices: OnsetSlice[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const startSample = cuts[i];
    const endSample = cuts[i + 1];
    if (endSample - startSample >= 2) {
      slices.push({ index: slices.length, startSample, endSample });
    }
  }

  return {
    ...base,
    failure: null,
    frameCount: nFrames,
    silentFrames,
    peakCandidates: candidates.length,
    onsets,
    slices,
  };
}
