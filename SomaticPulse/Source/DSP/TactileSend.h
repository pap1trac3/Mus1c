#pragma once

#include <juce_dsp/juce_dsp.h>

namespace SomaticPulse
{
/**
    Band-limited feed for a tactile transducer on a second output bus.

    A transducer is not a speaker. Published usable ranges sit between roughly
    5 and 200 Hz for home-theatre shakers (a ButtKicker BK-LFE is rated
    5-200 Hz, an AuraSound AST-2B 20-80 Hz), and their own amplifiers low-pass
    somewhere between 40 and 160 Hz. Content above that band does not become
    vibration, it becomes voice-coil heat and mechanical noise.

    So this is a real band-pass, not a tone control:

    - the high-pass keeps sub-audio excursion out of the coil, where the cone
      travel is largest and the useful output smallest;
    - the low-pass keeps midrange out of a driver that cannot turn it into
      motion.

    Both are second-order TPT state-variable filters, which stay stable and
    keep their tuning when the corners are moved while audio is running.
*/
class TactileSend
{
public:
    void prepare (const juce::dsp::ProcessSpec& spec);
    void reset() noexcept;

    void setHighpassFrequency (float hz) noexcept;
    void setLowpassFrequency (float hz) noexcept;

    void setLevel (float linearGain) noexcept { level.setTargetValue (linearGain); }

    void snapToTargets() noexcept;

    /** Filters one stereo frame into the transducer band. */
    inline void processFrame (float inL, float inR, float& outL, float& outR) noexcept
    {
        auto l = highpass.processSample (0, inL);
        auto r = highpass.processSample (1, inR);

        l = lowpass.processSample (0, l);
        r = lowpass.processSample (1, r);

        const auto g = level.getNextValue();

        outL = l * g;
        outR = r * g;
    }

private:
    juce::dsp::StateVariableTPTFilter<float> highpass;
    juce::dsp::StateVariableTPTFilter<float> lowpass;
    juce::SmoothedValue<float> level { 0.0f };

    double sampleRate = 44100.0;
    float currentHighpassHz = 0.0f;
    float currentLowpassHz = 0.0f;
};
} // namespace SomaticPulse
