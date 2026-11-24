#pragma once

#include <juce_dsp/juce_dsp.h>

#include <algorithm>
#include <array>
#include <vector>

namespace SomaticPulse
{
/**
    Momentary loudness, K-weighted, over a 400 ms sliding window.

    A peak meter says nothing about exposure. This material is meant to run
    for ten or fifteen minutes at a stretch, sometimes against the body
    through a transducer, and a signal that never touches the ceiling can
    still be far louder than anyone intended for that long.

    What this is: the K-weighting filter pair from ITU-R BS.1770 - a high
    shelf at 1682 Hz and a high-pass at 38 Hz - followed by a mean square over
    400 ms, reported as `-0.691 + 10 log10(sum of channel mean squares)`.

    What this is not: a certified BS.1770 meter. The shelf and high-pass are
    built with JUCE's bilinear-transform designs from the standard's analog
    parameters rather than its tabulated 48 kHz coefficients, and there is no
    integrated measurement and no gating. It is labelled LUFS-M in the UI for
    that reason. It is accurate enough to answer "is this too loud to sit
    under for a quarter of an hour", which is the question being asked.
*/
class LoudnessMeter
{
public:
    void prepare (const juce::dsp::ProcessSpec& spec);
    void reset() noexcept;

    inline void processFrame (float left, float right) noexcept
    {
        const auto l = highpass[0].processSample (shelf[0].processSample (left));
        const auto r = highpass[1].processSample (shelf[1].processSample (right));

        const auto energy = static_cast<double> (l) * l + static_cast<double> (r) * r;

        // Sliding window with a running total: the sample leaving the window
        // is subtracted and the new one added, so the cost per sample is two
        // additions rather than a 19,200-sample sum.
        runningSum += energy - window[static_cast<size_t> (writeIndex)];
        window[static_cast<size_t> (writeIndex)] = energy;

        if (++writeIndex >= windowLength)
            writeIndex = 0;

        if (filled < windowLength)
            ++filled;
    }

    /** Message thread, or the audio thread at block rate. */
    float getMomentaryLufs() const noexcept;

    /** Loudest 400 ms window since the last reset. */
    float getMaxMomentaryLufs() const noexcept { return maxMomentary; }

    void captureMax() noexcept;
    void resetMax() noexcept { maxMomentary = silenceLufs; }

    static constexpr float silenceLufs = -70.0f;

private:
    std::array<juce::dsp::IIR::Filter<float>, 2> shelf;
    std::array<juce::dsp::IIR::Filter<float>, 2> highpass;

    std::vector<double> window;
    double runningSum = 0.0;
    int windowLength = 1;
    int writeIndex = 0;
    int filled = 0;

    float maxMomentary = silenceLufs;
};
} // namespace SomaticPulse
