'use strict';

/**
 * A metronome for the bar grid.
 *
 * Its own AudioContext, separate from the Tone.js melody engine: the click has
 * to run against the bar grid's tempo while the melody engine may be stopped,
 * loaded with a different tempo, or not initialised at all, and sharing one
 * transport would couple two things that have no reason to move together.
 *
 * Beats are scheduled ahead on the audio clock rather than fired from
 * setInterval. A timer fires on the main thread, which is busy rendering and
 * therefore late by a variable few milliseconds every time — audible as drift
 * within a couple of bars. The lookahead timer only decides *what* to
 * schedule; the audio clock decides when each click actually sounds.
 */

// How far ahead to schedule, and how often to top it up. The gap between them
// is the slack that absorbs a late timer callback.
const SCHEDULE_AHEAD_S = 0.15;
const LOOKAHEAD_MS = 25;

const CLICK_MS = 30;
const DOWNBEAT_HZ = 1600;
const BEAT_HZ = 880;

class ClickTrack {
  constructor() {
    this.context = null;
    this.gain = null;
    this.timer = null;
    this.running = false;

    this.bpm = 120;
    this.beatsPerBar = 4;
    this.totalBars = 0;

    // Position of the next beat to schedule.
    this.nextBeatTime = 0;
    this.beatIndex = 0;

    this.onBar = null;
    this.onStop = null;
  }

  get supported() {
    return typeof window !== 'undefined' && Boolean(window.AudioContext || window.webkitAudioContext);
  }

  /** Current bar (1-based), or 0 when stopped. */
  get currentBar() {
    return this.running ? Math.floor(this.beatIndex / this.beatsPerBar) + 1 : 0;
  }

  configure({ bpm, beatsPerBar, totalBars }) {
    if (Number.isFinite(bpm) && bpm > 0) this.bpm = bpm;
    if (Number.isFinite(beatsPerBar) && beatsPerBar > 0) this.beatsPerBar = beatsPerBar;
    this.totalBars = Number.isFinite(totalBars) && totalBars > 0 ? totalBars : 0;
  }

  /** Requires a user gesture: browsers start an AudioContext suspended. */
  async start() {
    if (!this.supported || this.running) return false;

    if (!this.context) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      this.context = new Ctor();
      this.gain = this.context.createGain();
      this.gain.gain.value = 0.35;
      this.gain.connect(this.context.destination);
    }
    if (this.context.state === 'suspended') await this.context.resume();

    this.running = true;
    this.beatIndex = 0;
    // A beat of headroom, so the first click is scheduled rather than racing.
    this.nextBeatTime = this.context.currentTime + 0.1;
    this.timer = setInterval(() => this.pump(), LOOKAHEAD_MS);
    this.pump();
    return true;
  }

  stop() {
    if (!this.running) return;

    this.running = false;
    clearInterval(this.timer);
    this.timer = null;
    this.beatIndex = 0;
    if (typeof this.onBar === 'function') this.onBar(0);
    if (typeof this.onStop === 'function') this.onStop();
  }

  setVolume(value) {
    if (this.gain) this.gain.gain.value = Math.max(0, Math.min(1, value));
  }

  /** Fills the schedule window, then hands back to the browser. */
  pump() {
    if (!this.running) return;

    const secondsPerBeat = 60 / this.bpm;

    while (this.nextBeatTime < this.context.currentTime + SCHEDULE_AHEAD_S) {
      const bar = Math.floor(this.beatIndex / this.beatsPerBar) + 1;

      // A grid of known length stops at its end rather than looping forever.
      if (this.totalBars > 0 && bar > this.totalBars) {
        this.stop();
        return;
      }

      const isDownbeat = this.beatIndex % this.beatsPerBar === 0;
      this.scheduleClick(this.nextBeatTime, isDownbeat);

      if (isDownbeat && typeof this.onBar === 'function') {
        // Report the bar when it sounds, not when it was scheduled.
        const delayMs = Math.max(0, (this.nextBeatTime - this.context.currentTime) * 1000);
        setTimeout(() => {
          if (this.running) this.onBar(bar);
        }, delayMs);
      }

      this.nextBeatTime += secondsPerBeat;
      this.beatIndex += 1;
    }
  }

  /**
   * One click: a short sine burst with an exponential decay. Ramped rather
   * than switched, because an abrupt gain change is an audible click of its
   * own — the wrong kind.
   */
  scheduleClick(time, isDownbeat) {
    const osc = this.context.createOscillator();
    const env = this.context.createGain();

    osc.frequency.value = isDownbeat ? DOWNBEAT_HZ : BEAT_HZ;
    osc.connect(env);
    env.connect(this.gain);

    const duration = CLICK_MS / 1000;
    env.gain.setValueAtTime(0.0001, time);
    env.gain.exponentialRampToValueAtTime(isDownbeat ? 1 : 0.6, time + 0.002);
    env.gain.exponentialRampToValueAtTime(0.0001, time + duration);

    osc.start(time);
    osc.stop(time + duration);
  }
}

if (typeof window !== 'undefined') {
  window.clickTrack = new ClickTrack();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ClickTrack, SCHEDULE_AHEAD_S, LOOKAHEAD_MS };
}
