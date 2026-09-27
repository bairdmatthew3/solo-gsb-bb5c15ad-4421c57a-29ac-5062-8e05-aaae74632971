import type { OnsetSliceResult } from '../audio/onsetSlice';
import { fmtTime } from '../utils/format';

interface OnsetSlicePanelProps {
  /** 当前是否有波形选区（决定分析范围提示） */
  hasSelection: boolean;
  /** 后台分析结果（分析中 / 未开始时为 null） */
  result: OnsetSliceResult | null;
  /** 后台分析进行中 */
  busy: boolean;
  /** 正在单次试听的切片序号（未试听为 null） */
  playingIdx: number | null;
  onAnalyze: () => void;
  onPlaySlice: (idx: number) => void;
  onDownloadSlice: (idx: number) => void;
  onStop: () => void;
}

/**
 * 起音切片面板：对当前选区（未框选时为整段音频）在后台 Worker 检测瞬态起音，
 * 以保留起音为内部切点、范围起止点为首尾边界切出音频片（不产生空片）。
 * 列表展示各片起止时间与时长，点击行单次试听原声道片段（再点一次停止），
 * 每片可单独下载不带循环标记的 16-bit PCM WAV；无有效起音时显示原因。
 */
export function OnsetSlicePanel({
  hasSelection,
  result,
  busy,
  playingIdx,
  onAnalyze,
  onPlaySlice,
  onDownloadSlice,
  onStop,
}: OnsetSlicePanelProps) {
  const sr = result?.sampleRate ?? 44100;

  return (
    <section className="panel onsets">
      <h2>起音切片</h2>
      <p className="onsets-desc">
        在后台线程对{hasSelection ? '当前选区' : '整段音频（未框选选区）'}检测瞬态起音：
        以多频带短时能量的正向变化构成新颖度曲线，用局部噪声底自适应阈值（窗口中位数 + 3.5 × MAD）、
        −60 dBFS 静音门限与 50 ms 最小起音间隔抑制弱噪声与密集伪峰。
        保留的起音按采样点排序作为内部切点，范围起止点作首尾边界切出音频片（不产生空片）。
        点击列表行单次试听原声道片段（不循环），每片可单独下载不带循环标记的 16-bit PCM WAV；
        换文件或改动选区时结果自动清除。
      </p>

      <div className="transport">
        <button className="primary" onClick={onAnalyze} disabled={busy}>
          {busy ? '分析中…' : result ? '重新分析并切片' : '分析起音并切片'}
        </button>
        <button onClick={onStop} disabled={playingIdx === null}>停止</button>
      </div>

      {busy && !result && <p className="onsets-note">后台线程分析中，页面可继续操作…</p>}

      {result && !busy && result.failure === 'too-short' && (
        <p className="clamp-note">范围太短：不足一个分析窗，无法检测起音。请框选更长的区间。</p>
      )}
      {result && !busy && result.failure === 'silence' && (
        <p className="clamp-note">
          范围电平低于静音门限（{result.gateDbfs} dBFS）：无有效起音，未产生切片。
        </p>
      )}
      {result && !busy && result.failure === 'no-onset' && (
        <p className="clamp-note">
          未发现有效起音：新颖度峰值均未超过局部噪声底自适应阈值（弱噪声与密集伪峰已被抑制），未产生切片。
        </p>
      )}

      {result && result.failure === null && (
        <>
          <p className="onsets-summary">
            范围 {fmtTime(result.rangeStartSample / sr)} – {fmtTime(result.rangeEndSample / sr)}：
            共 {result.totalFrames} 帧（静音门限排除 {result.gatedFrames} 帧），
            保留 <b>{result.onsets.length}</b> 个起音，切出 <b>{result.slices.length}</b> 片。
          </p>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>起点</th>
                <th>终点</th>
                <th>时长</th>
                <th>状态</th>
                <th>导出</th>
              </tr>
            </thead>
            <tbody>
              {result.slices.map((s, i) => (
                <tr
                  key={i}
                  className={i === playingIdx ? 'playing' : ''}
                  onClick={() => onPlaySlice(i)}
                >
                  <td><span className="rank">{i + 1}</span></td>
                  <td>{fmtTime(s.startSec)}</td>
                  <td>{fmtTime(s.endSec)}</td>
                  <td>{fmtTime(s.endSec - s.startSec)}</td>
                  <td className="row-state">
                    {i === playingIdx ? '■ 试听中（再点停止）' : '点击单次试听'}
                  </td>
                  <td>
                    <button
                      className="slice-dl"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDownloadSlice(i);
                      }}
                    >
                      下载 WAV
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
