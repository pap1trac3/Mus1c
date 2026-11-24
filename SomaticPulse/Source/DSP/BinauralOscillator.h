#pragma once

#include <juce_dsp/juce_dsp.h>

namespace SomaticPulse
{
/**
    Stereo sub-oscillator that produces a binaural beat.

    Left and right run from independent `double` phase accumulators. Single
    precision is not enough here: at 48 kHz a float accumulator loses its low
    bits within seconds, and the two channels drift apart by a fraction of a
    hertz - which is the whole signal when the beat itself is 6 Hz.

    The two carriers sit symmetrically around the centre frequency,
    f_left = f_c - delta/2 and f_right = f_c + delta/2, so the perceived beat
    is `delta` while the centre pitch stays where the user put it.

    Everything is computed per sample with no allocation, so this is safe to
    call from `processBlock`.
*/
class BinauralOscillator
{
public:
    enum class Waveform
    {
        Sine = 0,
        Triangle
    };

    /**
        How the beat is produced.

        Binaural puts a different frequency in each ear. Each channel on its
        own is a steady tone with no amplitude modulation at all - the beat
        is produced neurally, from the two being heard separately, which
        needs headphones. Hand one of those channels to a single transducer
        and it reproduces no pulse whatsoever.

        Monaural sums both carriers into both channels. The beat is then
        ordinary acoustic amplitude modulation present in the signal itself,
        so it is there in any single channel and immune to anything
        downstream that sums to mono.

        Isochronic drops the second carrier and gates one tone on and off at
        the beat rate. It is the strongest of the three through a transducer,
        because the envelope goes fully to zero rather than just dipping
        where two nearby partials cancel.

        Note what mono-summing a binaural pair actually does: it does not
        destroy the beat, it converts it. Two carriers 8 Hz apart added
        together beat acoustically at 8 Hz. What is lost is the dichotic
        presentation - the same signal now reaches both ears - so the
        phenomenon stops being neural and starts being air.
    */
    enum class Mode
    {
        Binaural = 0,
        Monaural,
        Isochronic
    };

    void prepare (const juce::dsp::ProcessSpec& spec);
    void reset() noexcept;

    /** Centre frequency in Hz. Smoothed. */
    void setCarrierFrequency (float hz) noexcept     { carrierHz.setTargetValue (hz); }

    /** Binaural offset in Hz, split symmetrically across the two channels. */
    void setBeatFrequency (float hz) noexcept        { beatHz.setTargetValue (hz); }

    /** 0 = clean, 1 = fully saturated. Smoothed. */
    void setDrive (float normalised) noexcept        { drive.setTargetValue (normalised); }

    /** Linear output gain. Smoothed. */
    void setLevel (float linearGain) noexcept        { level.setTargetValue (linearGain); }

    void setWaveform (Waveform w) noexcept           { waveform = w; }
    void setMode (Mode m) noexcept                   { mode = m; }

    /** Jumps every smoother to its target - use after a preset change. */
    void snapToTargets() noexcept;

    /**
        Renders one stereo frame.

        @param gainScaleL,gainScaleR  extra per-sample gain, applied before
                          the output level. The LFO and the ducker feed their
                          modulation in through these rather than mutating the
                          smoothers, which would fight the 20 ms ramps. They
                          are per channel because the LFO has its own stereo
                          phase offset.
    */
    inline void processSample (float gainScaleL, float gainScaleR,
                               float& outL, float& outR) noexcept
    {
        const auto fc    = carrierHz.getNextValue();
        const auto delta = beatHz.getNextValue();
        const auto d     = drive.getNextValue();
        const auto lvl   = level.getNextValue();

        if (mode == Mode::Isochronic)
        {
            // One carrier, gated by a raised cosine at the beat rate. The
            // gate is sine-squared rather than square so the edges cannot
            // click, and it reaches zero so the pulse is unambiguous through
            // a transducer.
            const auto gate = 0.5f - 0.5f * std::cos (juce::MathConstants<float>::twoPi
                                                      * static_cast<float> (gatePhase));

            const auto tone = saturate (oscillate (phaseL), d) * gate;

            outL = tone * lvl * gainScaleL;
            outR = tone * lvl * gainScaleR;

            phaseL += static_cast<double> (juce::jmax (0.0f, fc)) * phaseIncrementPerHz;
            gatePhase += static_cast<double> (juce::jmax (0.0f, delta)) * phaseIncrementPerHz;

            if (phaseL >= 1.0)    phaseL    -= std::floor (phaseL);
            if (gatePhase >= 1.0) gatePhase -= std::floor (gatePhase);

            // Keep the second accumulator in step so switching modes does not
            // jump the phase.
            phaseR = phaseL;
            return;
        }

        // Clamp at zero: a negative frequency would run the phase backwards
        // and swap which ear leads, which is audible as a click.
        const auto fL = juce::jmax (0.0f, fc - delta * 0.5f);
        const auto fR = juce::jmax (0.0f, fc + delta * 0.5f);

        auto sampleL = saturate (oscillate (phaseL), d);
        auto sampleR = saturate (oscillate (phaseR), d);

        if (mode == Mode::Monaural)
        {
            // Both carriers in both channels. Halved so two summed tones peak
            // at the same level a single one does.
            const auto summed = 0.5f * (sampleL + sampleR);
            sampleL = summed;
            sampleR = summed;
        }

        outL = sampleL * lvl * gainScaleL;
        outR = sampleR * lvl * gainScaleR;

        phaseL += static_cast<double> (fL) * phaseIncrementPerHz;
        phaseR += static_cast<double> (fR) * phaseIncrementPerHz;

        if (phaseL >= 1.0) phaseL -= std::floor (phaseL);
        if (phaseR >= 1.0) phaseR -= std::floor (phaseR);
    }

private:
    /** One cycle of the selected waveform at the given normalised phase. */
    inline float oscillate (double phase) const noexcept
    {
        const auto twoPiPhase = juce::MathConstants<float>::twoPi * static_cast<float> (phase);

        if (waveform == Waveform::Sine)
            return std::sin (twoPiPhase);

        // Additive triangle, four odd harmonics with 1/n^2 weighting.
        //
        // A naive ramp-and-fold triangle aliases badly, and a polyBLEP one
        // needs an integrator whose gain drifts with frequency. Four terms is
        // exact enough to hear as a triangle, costs four sines, and cannot
        // alias: the 7th harmonic of the highest carrier (528 Hz) is 3.7 kHz.
        constexpr float norm = 8.0f / (juce::MathConstants<float>::pi * juce::MathConstants<float>::pi);

        return norm * (std::sin (twoPiPhase)
                     - std::sin (3.0f * twoPiPhase) / 9.0f
                     + std::sin (5.0f * twoPiPhase) / 25.0f
                     - std::sin (7.0f * twoPiPhase) / 49.0f);
    }

    /**
        Gentle tanh soft-clip, blended in by `amount`.

        Blending rather than switching keeps the curve continuous at zero
        drive: at amount = 0 this returns the input bit for bit, so a user
        sweeping the knob up from nothing hears no step. The tanh is
        peak-normalised so turning drive up thickens the tone without also
        turning the sub-bass up.
    */
    static inline float saturate (float x, float amount) noexcept
    {
        if (amount <= 0.0f)
            return x;

        const auto g       = 1.0f + amount * 6.0f;
        const auto driven  = std::tanh (x * g) / std::tanh (g);
        return x + amount * (driven - x);
    }

    double phaseL = 0.0;
    double phaseR = 0.0;
    double gatePhase = 0.0;
    double phaseIncrementPerHz = 1.0 / 44100.0;

    juce::SmoothedValue<float> carrierHz { 111.0f };
    juce::SmoothedValue<float> beatHz    { 6.0f };
    juce::SmoothedValue<float> drive     { 0.0f };
    juce::SmoothedValue<float> level     { 0.0f };

    Waveform waveform = Waveform::Sine;
    Mode mode = Mode::Binaural;
};
} // namespace SomaticPulse
