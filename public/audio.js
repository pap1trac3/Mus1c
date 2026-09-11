/* global Tone */
'use strict';

/**
 * Wraps Tone.js so the page deals in melodies and transport state rather than
 * synth wiring. Nothing is constructed until init(), which must be called from
 * a user gesture — browsers refuse to start an AudioContext otherwise.
 */
class AudioEngine {
  constructor() {
    this.synth = null;
    this.polySynth = null;
    this.fft = null;
    this.part = null;
    this.initialized = false;
    this.state = 'offline';
    this.onState = null;
    this.eventCount = 0;
  }

  setState(state) {
    this.state = state;
    if (this.onState) this.onState(state);
  }

  async init() {
    if (this.initialized) return;

    await Tone.start(); // resumes the AudioContext; requires a user gesture

    this.synth = new Tone.Synth({
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.05, decay: 0.2, sustain: 0.5, release: 1.2 },
    });
    this.polySynth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'sine' },
      envelope: { attack: 0.1, decay: 0.3, sustain: 0.7, release: 2.0 },
    });

    // 128 bins reads as a spectrum; the 32 a coarser size gives looks like a
    // handful of blocks rather than a curve.
    this.fft = new Tone.FFT({ size: 128, smoothing: 0.8 });

    // Analyser is a pass-through, so audio still reaches the speakers.
    this.synth.connect(this.fft);
    this.polySynth.connect(this.fft);
    this.fft.toDestination();

    this.initialized = true;
    this.setState('stopped');
  }

  /** Replaces the scheduled material. Safe to call repeatedly. */
  load(melody, tempoBpm) {
    if (!this.initialized || !Array.isArray(melody) || melody.length === 0) {
      this.eventCount = 0;
      return false;
    }

    const transport = Tone.getTransport();
    this.stop();

    if (this.part) {
      this.part.dispose(); // otherwise each generation stacks another Part
      this.part = null;
    }
    transport.cancel(0);

    if (Number.isFinite(tempoBpm)) transport.bpm.value = tempoBpm;

    this.part = new Tone.Part((time, event) => {
      const target = Array.isArray(event.note) ? this.polySynth : this.synth;
      target.triggerAttackRelease(event.note, event.duration, time);
    }, melody.map((event) => [event.time, event]));

    this.part.start(0);
    this.eventCount = melody.length;

    // Return to a stopped state at the end instead of running on in silence.
    const lastBar = melody.reduce((max, e) => Math.max(max, parseInt(e.time, 10) || 0), 0);
    transport.scheduleOnce(() => this.stop(), `${lastBar + 1}:0:0`);

    return true;
  }

  play() {
    if (!this.initialized || this.eventCount === 0) return;
    Tone.getTransport().start();
    this.setState('playing');
  }

  pause() {
    if (!this.initialized || this.state !== 'playing') return;
    Tone.getTransport().pause();
    this.setState('paused');
  }

  stop() {
    if (!this.initialized) return;
    const transport = Tone.getTransport();
    transport.stop();
    transport.position = 0;
    if (this.polySynth) this.polySynth.releaseAll();
    this.setState('stopped');
  }

  setVolume(db) {
    if (!this.initialized) return;
    Tone.getDestination().volume.value = db;
  }

  /** Float32Array of dB values, or an empty one before init. */
  getSpectrum() {
    return this.fft ? this.fft.getValue() : new Float32Array(0);
  }
}

window.audioEngine = new AudioEngine();
