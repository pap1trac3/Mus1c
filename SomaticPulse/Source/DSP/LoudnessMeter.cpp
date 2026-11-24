#include "LoudnessMeter.h"

namespace SomaticPulse
{
namespace
{
    // BS.1770 K-weighting, stated as analog parameters.
    constexpr float shelfFrequency = 1681.97f;
    constexpr float shelfQ = 0.7071752f;
    constexpr float shelfGain = 1.5848932f;      // +3.999 dB
    constexpr float highpassFrequency = 38.13f;
    constexpr float highpassQ = 0.5003271f;

    constexpr double windowSeconds = 0.4;
    constexpr double loudnessOffset = -0.691;
}

void LoudnessMeter::prepare (const juce::dsp::ProcessSpec& spec)
{
    const auto shelfCoefficients = juce::dsp::IIR::Coefficients<float>::makeHighShelf (
        spec.sampleRate, shelfFrequency, shelfQ, shelfGain);

    const auto highpassCoefficients = juce::dsp::IIR::Coefficients<float>::makeHighPass (
        spec.sampleRate, highpassFrequency, highpassQ);

    for (auto& f : shelf)
    {
        f.coefficients = shelfCoefficients;
        f.prepare (spec);
    }

    for (auto& f : highpass)
    {
        f.coefficients = highpassCoefficients;
        f.prepare (spec);
    }

    windowLength = juce::jmax (1, static_cast<int> (windowSeconds * spec.sampleRate));

    // Allocated once, here, so processFrame never touches the heap.
    window.assign (static_cast<size_t> (windowLength), 0.0);

    reset();
}

void LoudnessMeter::reset() noexcept
{
    for (auto& f : shelf)
        f.reset();

    for (auto& f : highpass)
        f.reset();

    std::fill (window.begin(), window.end(), 0.0);

    runningSum = 0.0;
    writeIndex = 0;
    filled = 0;
    maxMomentary = silenceLufs;
}

float LoudnessMeter::getMomentaryLufs() const noexcept
{
    if (filled < 1)
        return silenceLufs;

    // Divide by the window length rather than by how much of it is filled:
    // a partly filled window is genuinely quieter than a full one, and
    // scaling it up would make the first 400 ms read far too loud.
    const auto meanSquare = runningSum / static_cast<double> (windowLength);

    if (meanSquare <= 1.0e-12)
        return silenceLufs;

    const auto lufs = loudnessOffset + 10.0 * std::log10 (meanSquare);

    return static_cast<float> (juce::jmax (static_cast<double> (silenceLufs), lufs));
}

void LoudnessMeter::captureMax() noexcept
{
    // Only once the window holds real history, or the fade-in of the very
    // first buffer sets the maximum for the whole session.
    if (filled < windowLength)
        return;

    maxMomentary = juce::jmax (maxMomentary, getMomentaryLufs());
}
} // namespace SomaticPulse
