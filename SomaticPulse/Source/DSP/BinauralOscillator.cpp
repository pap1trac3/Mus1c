#include "BinauralOscillator.h"

namespace SomaticPulse
{
namespace
{
    // 20 ms on every audible parameter. Short enough that automation still
    // feels immediate, long enough that a jumped value is a glide not a click.
    constexpr double smoothingSeconds = 0.02;
}

void BinauralOscillator::prepare (const juce::dsp::ProcessSpec& spec)
{
    phaseIncrementPerHz = 1.0 / spec.sampleRate;

    for (auto* s : { &carrierHz, &beatHz, &drive, &level })
        s->reset (spec.sampleRate, smoothingSeconds);

    reset();
}

void BinauralOscillator::reset() noexcept
{
    // Both channels start in phase. The beat then opens up from zero, which
    // is what a listener expects when they hit play.
    phaseL = 0.0;
    phaseR = 0.0;
}

void BinauralOscillator::snapToTargets() noexcept
{
    for (auto* s : { &carrierHz, &beatHz, &drive, &level })
        s->setCurrentAndTargetValue (s->getTargetValue());
}
} // namespace SomaticPulse
