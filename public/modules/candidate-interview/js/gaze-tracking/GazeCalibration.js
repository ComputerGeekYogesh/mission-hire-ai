/**
 * Optional 5-point gaze calibration (corners + center) to normalize per-user baselines.
 */
export class GazeCalibration {
  constructor() {
    this.points = [
      { id: 'top_left', label: 'Look at the top-left corner of your screen' },
      { id: 'top_right', label: 'Look at the top-right corner of your screen' },
      { id: 'bottom_left', label: 'Look at the bottom-left corner of your screen' },
      { id: 'bottom_right', label: 'Look at the bottom-right corner of your screen' },
      { id: 'center', label: 'Look at the center of your screen' },
    ];
    this.samples = {};
    this.index = 0;
    this.complete = false;
  }

  get currentStep() {
    if (this.complete) return null;
    return this.points[this.index] || null;
  }

  get progress() {
    return { index: this.index, total: this.points.length, complete: this.complete };
  }

  /**
   * Record gaze ratio sample for the current calibration point.
   * @param {{ x: number, y: number }} gazeRatio
   */
  recordSample(gazeRatio) {
    const step = this.currentStep;
    if (!step || !gazeRatio) return false;

    if (!this.samples[step.id]) this.samples[step.id] = [];
    this.samples[step.id].push({ x: gazeRatio.x, y: gazeRatio.y, at: Date.now() });
    if (this.samples[step.id].length < 12) return false;

    this.index += 1;
    if (this.index >= this.points.length) {
      this.complete = true;
    }
    return true;
  }

  /**
   * @returns {{ center: { x: number, y: number }, points: object }|null}
   */
  finish() {
    const centerSamples = this.samples.center;
    if (!centerSamples?.length) return null;

    const avg = (arr) => ({
      x: arr.reduce((s, v) => s + v.x, 0) / arr.length,
      y: arr.reduce((s, v) => s + v.y, 0) / arr.length,
    });

    const center = avg(centerSamples);
    const points = {};
    for (const p of this.points) {
      const list = this.samples[p.id];
      if (list?.length) points[p.id] = avg(list);
    }

    return { center, points };
  }

  reset() {
    this.samples = {};
    this.index = 0;
    this.complete = false;
  }
}
