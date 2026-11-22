#pragma once

#include <juce_dsp/juce_dsp.h>

namespace SomaticPulse
{
/**
    The rhythmic pulse generator.

    Produces a pair of unipolar (0 to 1) control signals, one per channel,
    which the processor uses to modulate three things independently: the
    sub-oscillator's gain, the incoming audio's amplitude, and the resonator's
    cutoff.

    Unipolar rather than bipolar on purpose. Every target here is a "duck by
    some amount" relationship, so a value of 1 must mean "untouched" and 0
    must mean "fully attenuated". A bipolar LFO would make depth = 0 and
    depth = 100% both sound like no modulation at the zero crossing.
*/
class SomaticPulseLFO
{
public:
    enum class Shape
    {
        Sine = 0,
        SmoothPulse,
        Triangle,
        DoubleThump
    };

    enum class Division
    {
        Whole = 0,      // 1/1
        Half,           // 1/2
        Quarter,        // 1/4
        Eighth,         // 1/8
        EighthTriplet,  // 1/8T
        Sixteenth,      // 1/16
        ThirtySecond    // 1/32
    };

    void prepare (const juce::dsp::ProcessSpec& spec);
    void reset() noexcept;

    void setFreeRunningRate (float hz) noexcept   { freeRateHz = hz; }
    void setShape (Shape s) noexcept              { shape = s; }
    void setDivision (Division d) noexcept        { division = d; }
    void setTempoSynced (bool shouldSync) noexcept { synced = shouldSync; }
    void setHostTempo (double bpm) noexcept       { hostBpm = bpm > 0.0 ? bpm : 120.0; }

    /** 0 to 180 degrees of offset applied to the right channel. */
    void setStereoPhaseDegrees (float degrees) noexcept
    {
        stereoOffset = juce::jlimit (0.0f, 180.0f, degrees) / 360.0f;
    }

    /** Beats per cycle for a note division - 1/4 is one beat. */
    static double beatsPerCycle (Division d) noexcept;

    /** The rate actually in use, resolving tempo sync against the host BPM. */
    double getEffectiveRateHz() const noexcept;

    /** Advances one sample and writes the two unipolar control values. */
    inline void processSample (float& outL, float& outR) noexcept
    {
        outL = shapeAt (phase);
        outR = shapeAt (wrap01 (phase + static_cast<double> (stereoOffset)));

        lastL = outL;
        lastR = outR;

        phase = wrap01 (phase + getEffectiveRateHz() * secondsPerSample);
    }

    /** Most recent left-channel value - for the UI, not the audio thread. */
    float getLastValue() const noexcept { return lastL; }

private:
    static inline double wrap01 (double x) noexcept
    {
        x -= std::floor (x);
        return x;
    }

    /**
        Shortest distance between two points on a unit circle.

        The cardiac shape is built from Gaussian bumps, and a Gaussian never
        quite reaches zero. Measuring distance the wrapped way makes the shape
        periodic by construction, so there is no step at the cycle boundary
        where the tail of the first beat would otherwise be cut off.
    */
    static inline float circularDistance (float a, float b) noexcept
    {
        const auto d = std::abs (a - b);
        return juce::jmin (d, 1.0f - d);
    }

    inline float shapeAt (double normalisedPhase) const noexcept
    {
        const auto p = static_cast<float> (normalisedPhase);

        switch (shape)
        {
            case Shape::Sine:
                return 0.5f - 0.5f * std::cos (juce::MathConstants<float>::twoPi * p);

            case Shape::Triangle:
                return p < 0.5f ? p * 2.0f : 2.0f - p * 2.0f;

            case Shape::SmoothPulse:
            {
                // A square with its corners rounded off. Driving a sine into
                // tanh keeps the flat tops a gate needs without the
                // instantaneous edge, which would click at any useful depth.
                constexpr float k = 3.0f;
                const auto raw = std::sin (juce::MathConstants<float>::twoPi * p
                                           - juce::MathConstants<float>::halfPi);
                return 0.5f + 0.5f * std::tanh (k * raw) / std::tanh (k);
            }

            case Shape::DoubleThump:
            default:
            {
                // "lub-dub": a strong first beat and a softer second one,
                // spaced the way a heartbeat is, then a long rest.
                constexpr float mu1 = 0.14f, sigma1 = 0.052f;
                constexpr float mu2 = 0.36f, sigma2 = 0.065f;
                constexpr float amp2 = 0.60f;

                const auto d1 = circularDistance (p, mu1) / sigma1;
                const auto d2 = circularDistance (p, mu2) / sigma2;

                const auto v = std::exp (-0.5f * d1 * d1)
                             + amp2 * std::exp (-0.5f * d2 * d2);

                return juce::jmin (1.0f, v);
            }
        }
    }

    double phase = 0.0;
    double secondsPerSample = 1.0 / 44100.0;
    double hostBpm = 120.0;

    float freeRateHz = 6.0f;
    float stereoOffset = 0.0f;
    float lastL = 0.0f, lastR = 0.0f;

    bool synced = false;
    Shape shape = Shape::Sine;
    Division division = Division::Quarter;
};
} // namespace SomaticPulse
