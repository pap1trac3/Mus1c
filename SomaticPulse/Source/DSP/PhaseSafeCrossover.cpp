#include "PhaseSafeCrossover.h"

namespace SomaticPulse
{
namespace
{
    constexpr double smoothingSeconds = 0.02;
    constexpr double dcCutoffHz = 5.0;

    /** One-pole coefficient for a given time constant. */
    inline float timeConstantCoeff (float milliseconds, double sampleRate) noexcept
    {
        const auto seconds = juce::jmax (1.0e-4f, milliseconds * 0.001f);
        return static_cast<float> (std::exp (-1.0 / (seconds * sampleRate)));
    }
}

void PhaseSafeCrossover::prepare (const juce::dsp::ProcessSpec& spec)
{
    sampleRate = spec.sampleRate;

    crossover.prepare (spec);
    crossover.setType (juce::dsp::LinkwitzRileyFilterType::lowpass);
    crossover.setCutoffFrequency (120.0f);

    outputGain.reset (sampleRate, smoothingSeconds);

    dcR = static_cast<float> (1.0 - (juce::MathConstants<double>::twoPi * dcCutoffHz / sampleRate));

    setDuckTimes (10.0f, 150.0f);
    reset();
}

void PhaseSafeCrossover::reset() noexcept
{
    crossover.reset();

    envelope = 0.0f;

    for (int ch = 0; ch < 2; ++ch)
        dcX1[ch] = dcY1[ch] = 0.0f;
}

void PhaseSafeCrossover::snapToTargets() noexcept
{
    outputGain.setCurrentAndTargetValue (outputGain.getTargetValue());
}

void PhaseSafeCrossover::setCrossoverFrequency (float hz) noexcept
{
    const auto maxCutoff = static_cast<float> (sampleRate * 0.45);
    crossover.setCutoffFrequency (juce::jlimit (20.0f, maxCutoff, hz));
}

void PhaseSafeCrossover::setDuckTimes (float attackMs, float releaseMs) noexcept
{
    attackCoeff  = timeConstantCoeff (attackMs, sampleRate);
    releaseCoeff = timeConstantCoeff (releaseMs, sampleRate);
}
} // namespace SomaticPulse
