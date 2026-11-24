#include "TactileSend.h"

namespace SomaticPulse
{
namespace
{
    constexpr double smoothingSeconds = 0.02;
}

void TactileSend::prepare (const juce::dsp::ProcessSpec& spec)
{
    sampleRate = spec.sampleRate;

    highpass.prepare (spec);
    highpass.setType (juce::dsp::StateVariableTPTFilterType::highpass);
    highpass.setResonance (0.7071f);

    lowpass.prepare (spec);
    lowpass.setType (juce::dsp::StateVariableTPTFilterType::lowpass);
    lowpass.setResonance (0.7071f);

    currentHighpassHz = 0.0f;
    currentLowpassHz = 0.0f;

    setHighpassFrequency (20.0f);
    setLowpassFrequency (120.0f);

    level.reset (sampleRate, smoothingSeconds);
    reset();
}

void TactileSend::reset() noexcept
{
    highpass.reset();
    lowpass.reset();
}

void TactileSend::snapToTargets() noexcept
{
    level.setCurrentAndTargetValue (level.getTargetValue());
}

void TactileSend::setHighpassFrequency (float hz) noexcept
{
    const auto clamped = juce::jlimit (5.0f, 200.0f, hz);

    // Each change costs a tan, so only pay for it when the value moved.
    if (std::abs (clamped - currentHighpassHz) < 1.0e-3f)
        return;

    currentHighpassHz = clamped;
    highpass.setCutoffFrequency (clamped);
}

void TactileSend::setLowpassFrequency (float hz) noexcept
{
    const auto maxCutoff = static_cast<float> (sampleRate * 0.45);
    const auto clamped = juce::jlimit (currentHighpassHz + 1.0f, maxCutoff, hz);

    if (std::abs (clamped - currentLowpassHz) < 1.0e-3f)
        return;

    currentLowpassHz = clamped;
    lowpass.setCutoffFrequency (clamped);
}
} // namespace SomaticPulse
