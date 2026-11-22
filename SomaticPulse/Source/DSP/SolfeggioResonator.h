#pragma once

#include <juce_dsp/juce_dsp.h>
#include <array>

namespace SomaticPulse
{
/**
    Harmonic resonator plus a micro-detune stage.

    Two jobs, in this order:

    1. **Micro-detune.** A fractional delay line with two crossfaded read
       heads, used to nudge incoming material between concert pitches -
       A4 = 440 Hz to 432 Hz is -31.77 cents, to 444 Hz is +15.67 cents. The
       range is deliberately tiny; this is a tuning alignment, not a pitch
       shifter, and the artefacts of this technique only stay inaudible
       within a few tens of cents.

    2. **Resonance.** Up to four parallel high-Q bandpass filters tuned to the
       base frequency and its first three harmonics, added back on top. They
       are zero-delay-feedback (TPT) state-variable filters, which stay stable
       and keep their tuning at Q = 24 where a naive biquad would drift sharp.

    Filter cutoffs are recalculated every 16 samples rather than every sample.
    Each update costs a `tan`, and the only thing moving them is an LFO at
    30 Hz or below - 3 kHz of update rate is three orders of magnitude more
    than that needs.
*/
class SolfeggioResonator
{
public:
    static constexpr int maxHarmonics = 4;

    void prepare (const juce::dsp::ProcessSpec& spec);
    void reset() noexcept;

    void setBaseFrequency (float hz) noexcept   { baseHz = hz; cutoffDirty = true; }
    void setQ (float q) noexcept                { resonanceQ = q; cutoffDirty = true; }
    void setAmount (float normalised) noexcept  { amount.setTargetValue (normalised); }

    void setNumHarmonics (int n) noexcept
    {
        numHarmonics = juce::jlimit (1, maxHarmonics, n);
        cutoffDirty = true;
    }

    /** Scales the resonator's cutoff. 1.0 leaves it at the base frequency. */
    void setCutoffModulation (float scale) noexcept
    {
        const auto clamped = juce::jlimit (0.25f, 1.0f, scale);

        if (std::abs (clamped - cutoffMod) > 1.0e-4f)
        {
            cutoffMod = clamped;
            cutoffDirty = true;
        }
    }

    void setDetuneEnabled (bool shouldDetune) noexcept
    {
        detuneMix.setTargetValue (shouldDetune ? 1.0f : 0.0f);
    }

    void setDetuneCents (float cents) noexcept
    {
        pitchRatio = std::pow (2.0, static_cast<double> (cents) / 1200.0);
    }

    void snapToTargets() noexcept;

    /** Processes one stereo frame in place. */
    void processFrame (float& left, float& right) noexcept;

private:
    void updateCutoffs() noexcept;

    /**
        Reads the delay line at a fractional offset with Catmull-Rom
        interpolation.

        Linear interpolation here is a one-pole lowpass whose corner moves
        with the fraction, so a slowly sweeping read head audibly dulls and
        brightens the signal twice per crossfade window. Four-point cubic
        costs a handful of multiplies and removes that entirely.
    */
    float readInterpolated (int channel, double delayInSamples) const noexcept;

    double pitchRatio = 1.0;
    double readOffset = 0.0;
    double windowLength = 2400.0;   // ~50 ms at 48 kHz
    double sampleRate = 44100.0;

    int writeIndex = 0;
    int bufferLength = 0;
    int samplesUntilCutoffUpdate = 0;

    static constexpr int cutoffUpdateInterval = 16;
    static constexpr double minimumDelaySamples = 2.0;

    float baseHz = 444.0f;
    float resonanceQ = 8.0f;
    float cutoffMod = 1.0f;
    int numHarmonics = 3;
    bool cutoffDirty = true;

    juce::SmoothedValue<float> amount { 0.0f };
    juce::SmoothedValue<float> detuneMix { 0.0f };

    juce::AudioBuffer<float> delayBuffer;
    std::array<juce::dsp::StateVariableTPTFilter<float>, maxHarmonics> bandpass;
};
} // namespace SomaticPulse
