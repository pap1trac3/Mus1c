#include "SomaticPulseLFO.h"

namespace SomaticPulse
{
void SomaticPulseLFO::prepare (const juce::dsp::ProcessSpec& spec)
{
    secondsPerSample = 1.0 / spec.sampleRate;
    reset();
}

void SomaticPulseLFO::reset() noexcept
{
    phase = 0.0;
    lastL = lastR = 0.0f;
}

double SomaticPulseLFO::beatsPerCycle (Division d) noexcept
{
    switch (d)
    {
        case Division::Whole:         return 4.0;
        case Division::Half:          return 2.0;
        case Division::Quarter:       return 1.0;
        case Division::Eighth:        return 0.5;
        case Division::EighthTriplet: return 1.0 / 3.0;
        case Division::Sixteenth:     return 0.25;
        case Division::ThirtySecond:  return 0.125;
    }

    return 1.0;
}

double SomaticPulseLFO::getEffectiveRateHz() const noexcept
{
    if (! synced)
        return static_cast<double> (freeRateHz);

    // One cycle per `beats` beats: 1/4 at 120 BPM is 2 Hz.
    const auto beats = beatsPerCycle (division);
    return (hostBpm / 60.0) / beats;
}
} // namespace SomaticPulse
