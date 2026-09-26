import type { PcmBuffer } from './types';

/**
 * 音频播放器：复用同一个 AudioContext，
 * 启停时做 20ms 淡入淡出避免操作本身产生爆音。
 * - play：循环播放（无缝循环试听）
 * - playOnce：单次播放（起音切片试听原声道片段，自然播完一次即结束）
 */
export class LoopPlayer {
  private ctx: AudioContext | null = null;
  private src: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  /** 播放序号：每次开始新播放递增，自然结束回调据此识别是否已被后续播放取代 */
  private seq = 0;

  getContext(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    return this.ctx;
  }

  get playing(): boolean {
    return this.src !== null;
  }

  private buildSource(pcm: PcmBuffer, loop: boolean): { src: AudioBufferSourceNode; g: GainNode; id: number } {
    const ctx = this.getContext();
    const buf = ctx.createBuffer(pcm.channels.length, pcm.channels[0].length, pcm.sampleRate);
    for (let i = 0; i < pcm.channels.length; i++) {
      buf.copyToChannel(pcm.channels[i], i);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = loop;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(1, t + 0.02);
    src.connect(g);
    g.connect(ctx.destination);
    const id = ++this.seq;
    src.start();
    this.src = src;
    this.gain = g;
    return { src, g, id };
  }

  async play(pcm: PcmBuffer): Promise<void> {
    const ctx = this.getContext();
    if (ctx.state === 'suspended') await ctx.resume();
    this.stop();
    this.buildSource(pcm, true);
  }

  /**
   * 单次播放（不循环）：自然播完时触发 onEnded；
   * 若在结束前被 stop / 新播放取代，则不触发 onEnded。
   */
  async playOnce(pcm: PcmBuffer, onEnded?: () => void): Promise<void> {
    const ctx = this.getContext();
    if (ctx.state === 'suspended') await ctx.resume();
    this.stop();
    const { src, g, id } = this.buildSource(pcm, false);
    src.onended = () => {
      src.disconnect();
      g.disconnect();
      // 仅在这次播放仍是当前播放时上报自然结束（被 stop 或新播放取代时忽略）
      if (this.seq === id) {
        this.src = null;
        this.gain = null;
        onEnded?.();
      }
    };
  }

  stop(): void {
    this.seq++; // 使进行中的自然结束回调失效
    if (!this.ctx || !this.src || !this.gain) {
      this.src = null;
      this.gain = null;
      return;
    }
    const src = this.src;
    const g = this.gain;
    const t = this.ctx.currentTime;
    try {
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(g.gain.value, t);
      g.gain.linearRampToValueAtTime(0, t + 0.02);
      src.stop(t + 0.03);
    } catch {
      // 已停止，忽略
    }
    src.onended = () => {
      src.disconnect();
      g.disconnect();
    };
    this.src = null;
    this.gain = null;
  }
}
