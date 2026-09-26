import type { OnsetDetectResult } from '../audio/onsetDetect';
import { fmtTime } from '../utils/format';

interface OnsetSlicePanelProps {
  /** 后台分析进行中 */
  busy: boolean;
  /** 后台分析结果（分析中 / 未开始时为 null） */
  result: OnsetDetectResult | null;
  /** 分析目标描述（当前选区或整段） */
  targetLabel: string;
  /** 已点击试听的切片序号（再点一次或自然播完后可保留高亮，null 表示无） */
  selectedIdx: number | null;
  /** 正在单次试听中的切片序号 */
  playingIdx: number | null;
  onAnalyze: () => void;
  onPlaySlice: (idx: number) => void;
  onStop: () => void;
  onDownloadSlice: (idx: number) => void;
}

/**
 * 起音切片面板：在后台线程对当前波形选区（未选时为整段）做多频带短时能量
 * 正向变化起音分析，局部噪声底自适应阈值 + 静音门限 + 最小间隔抑制弱噪声与
 * 密集伪峰。保留的起音作为内部切点（范围起止点为首尾边界，不产生空片）。
 * 列表展示各片起止时间与时长；点击行单次试听原声道片段（不循环，再点停止），
 * 可单独下载不带循环标记的 16-bit PCM WAV。换文件 / 改选区后结果由父组件清空。
 */
export function OnsetSlicePanel({
  busy,
  result,
  targetLabel,
  selectedIdx,
  playingIdx,
  onAnalyze,
  onPlaySlice,
  onStop,
  onDownloadSlice,
}: OnsetSlicePanelProps) {
  const sr = result?.sampleRate ?? 0;

  return (
    <section className="panel onset">
      <h2>起音切片</h2>
      <p className="onset-desc">
        在后台线程对<strong>{targetLabel}</strong>分析瞬态：多频带短时能量的正向变化找起音，
        局部噪声底自适应阈值（邻域均值 + 1.5σ、1 dB 绝对下限）、−60 dBFS 静音门限与 70 ms 最小间隔
        抑制弱噪声与密集伪峰。保留的起音按采样点排序作为内部切点，范围起止点为首尾边界，不产生空片。
        点击切片单次试听原声道片段（不循环），并可单独下载不带循环标记的 16-bit PCM WAV。
      </p>

      <div className="transport">
        <button className="primary" onClick={onAnalyze} disabled={busy}>
          {busy ? '后台分析中…' : result ? '重新分析起音' : '分析起音'}
        </button>
        <button onClick={onStop} disabled={playingIdx === null}>停止试听</button>
      </div>

      {busy && !result && <p className="onset-note">后台线程分析瞬态中，页面可继续操作…</p>}

      {result && !busy && result.failure !== null && (
        <p className="clamp-note">
          {result.failure === 'too-short' &&
            `分析范围过短：不足 4 个分析帧（窗 ${Math.round((result.frameSamples / result.sampleRate) * 1000)} ms / 步长 ${Math.round((result.hopSamples / result.sampleRate) * 1000)} ms），无法检测起音，请扩大选区。`}
          {result.failure === 'silence' &&
            '分析范围接近静音：各帧 RMS 均低于 −60 dBFS 静音门限，未检测到起音。'}
          {result.failure === 'no-onset' &&
            `未检测到有效起音：${result.frameCount} 帧中有 ${result.silentFrames} 个静音帧（低于 −60 dBFS），其余帧的能量正向变化均未超过局部噪声底自适应阈值（均值 + 1.5σ、1 dB 绝对下限），可能是持续平稳信号或过于密集的弱噪声。`}
        </p>
      )}

      {result && result.failure === null && (
        <>
          <p className="onset-summary">
            分析范围 {fmtTime(result.rangeStartSample / sr)} – {fmtTime(result.rangeEndSample / sr)}
            （时长 {fmtTime((result.rangeEndSample - result.rangeStartSample) / sr)}）：
            共 {result.frameCount} 帧（静音帧 {result.silentFrames} 个），局部峰候选 {result.peakCandidates} 个，
            经 70 ms 最小间隔抑制后保留 <b>{result.onsets.length}</b> 个起音，
            切出 <b>{result.slices.length}</b> 片。
          </p>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>起点</th>
                <th>终点</th>
                <th>时长</th>
                <th>起音强度</th>
                <th>试听</th>
                <th>下载</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {result.slices.map((sl) => {
                // 第 i 片（i ≥ 1）的起点即第 i−1 个起音；第 0 片起点为范围边界
                const onset = sl.index > 0 ? result.onsets[sl.index - 1] : undefined;
                const isSelected = sl.index === selectedIdx;
                const isPlaying = sl.index === playingIdx;
                return (
                  <tr
                    key={sl.index}
                    className={isSelected ? 'selected' : ''}
                    onClick={() => onPlaySlice(sl.index)}
                  >
                    <td><span className="rank">{sl.index + 1}</span></td>
                    <td>{fmtTime(sl.startSample / sr)}</td>
                    <td>{fmtTime(sl.endSample / sr)}</td>
                    <td>{fmtTime((sl.endSample - sl.startSample) / sr)}</td>
                    <td>
                      {onset ? (
                        <>
                          <span className="conf">
                            <span
                              className="conf-fill"
                              style={{ width: `${Math.min(100, Math.round((onset.strength / 4) * 100))}%` }}
                            />
                          </span>
                          {onset.strength.toFixed(2)}×
                        </>
                      ) : (
                        <span className="onset-boundary">起始边界</span>
                      )}
                    </td>
                    <td>
                      <button
                        className={isPlaying ? 'active onset-btn' : 'onset-btn'}
                        onClick={(e) => {
                          e.stopPropagation();
                          onPlaySlice(sl.index);
                        }}
                      >
                        {isPlaying ? '■ 试听中（停止）' : '▶ 单次试听'}
                      </button>
                    </td>
                    <td>
                      <button
                        className="onset-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDownloadSlice(sl.index);
                        }}
                      >
                        WAV
                      </button>
                    </td>
                    <td className="row-state">
                      {isPlaying ? '■ 试听中（自然播完一次）' : isSelected ? '✓ 已试听' : '点击行试听'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
