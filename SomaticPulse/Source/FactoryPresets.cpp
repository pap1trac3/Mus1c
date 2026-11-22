#include "FactoryPresets.h"
#include "ParameterIDs.h"

#include <vector>

namespace SomaticPulse::FactoryPresets
{
namespace
{
    namespace P = ParamID;

    struct Setting
    {
        const char* id;
        float value;    // real units, not normalised
    };

    struct Preset
    {
        const char* name;
        std::vector<Setting> settings;
    };

    /**
        The six factory presets.

        Carrier frequencies are chosen as sub-octaves of the headline
        frequency rather than the frequency itself - a 528 Hz sine is a
        midrange tone, not a sub bed, so the oscillator sits at 528/4 and the
        resonator does the 528 Hz work on the incoming audio. That keeps the
        named frequency audible as a harmonic relationship while the
        generated layer stays where a sub belongs.
    */
    const std::vector<Preset>& table()
    {
        static const std::vector<Preset> presets
        {
            // ----------------------------------------------------------------
            {
                "444Hz Somatic Sub Bed",
                {
                    { P::oscEnable, 1.0f }, { P::carrierHz, 111.0f }, { P::beatHz, 6.0f },
                    { P::oscWave, 0.0f }, { P::oscDrive, 25.0f }, { P::subLevelDb, -8.0f },
                    { P::lfoEnable, 1.0f }, { P::lfoSync, 0.0f }, { P::lfoRateHz, 6.0f },
                    { P::lfoShape, 0.0f }, { P::lfoDepthSub, 60.0f }, { P::lfoDepthAudio, 10.0f },
                    { P::lfoDepthFilter, 20.0f }, { P::lfoStereoPhase, 45.0f },
                    { P::resoEnable, 1.0f }, { P::resoBaseHz, 444.0f }, { P::resoQ, 10.0f },
                    { P::resoHarmonics, 3.0f }, { P::resoAmount, 35.0f },
                    { P::detuneEnable, 1.0f }, { P::detuneCents, 15.67f },
                    { P::duckEnable, 1.0f }, { P::duckAmount, 40.0f },
                    { P::duckAttackMs, 12.0f }, { P::duckReleaseMs, 180.0f },
                    { P::crossoverHz, 110.0f }, { P::headphoneMode, 0.0f },
                    { P::dryWet, 100.0f }, { P::outputGainDb, 0.0f },
                    { P::limiterEnable, 1.0f }, { P::ceilingDb, -0.3f }
                }
            },
            // ----------------------------------------------------------------
            {
                "528Hz Heart Resonance",
                {
                    { P::oscEnable, 1.0f }, { P::carrierHz, 132.0f }, { P::beatHz, 8.0f },
                    { P::oscWave, 0.0f }, { P::oscDrive, 20.0f }, { P::subLevelDb, -10.0f },
                    // 1.2 Hz is 72 beats per minute - a resting pulse.
                    { P::lfoEnable, 1.0f }, { P::lfoSync, 0.0f }, { P::lfoRateHz, 1.2f },
                    { P::lfoShape, 3.0f }, { P::lfoDepthSub, 75.0f }, { P::lfoDepthAudio, 25.0f },
                    { P::lfoDepthFilter, 30.0f }, { P::lfoStereoPhase, 0.0f },
                    { P::resoEnable, 1.0f }, { P::resoBaseHz, 528.0f }, { P::resoQ, 12.0f },
                    { P::resoHarmonics, 3.0f }, { P::resoAmount, 40.0f },
                    { P::detuneEnable, 0.0f }, { P::detuneCents, 0.0f },
                    { P::duckEnable, 1.0f }, { P::duckAmount, 30.0f },
                    { P::duckAttackMs, 15.0f }, { P::duckReleaseMs, 220.0f },
                    { P::crossoverHz, 120.0f }, { P::headphoneMode, 0.0f },
                    { P::dryWet, 100.0f }, { P::outputGainDb, 0.0f },
                    { P::limiterEnable, 1.0f }, { P::ceilingDb, -0.3f }
                }
            },
            // ----------------------------------------------------------------
            {
                "Cliovana Deep Acoustic Wave",
                {
                    { P::oscEnable, 1.0f }, { P::carrierHz, 111.0f }, { P::beatHz, 10.0f },
                    { P::oscWave, 1.0f }, { P::oscDrive, 35.0f }, { P::subLevelDb, -6.0f },
                    { P::lfoEnable, 1.0f }, { P::lfoSync, 0.0f }, { P::lfoRateHz, 12.0f },
                    { P::lfoShape, 1.0f }, { P::lfoDepthSub, 85.0f }, { P::lfoDepthAudio, 15.0f },
                    { P::lfoDepthFilter, 45.0f }, { P::lfoStereoPhase, 90.0f },
                    { P::resoEnable, 1.0f }, { P::resoBaseHz, 111.0f }, { P::resoQ, 14.0f },
                    { P::resoHarmonics, 4.0f }, { P::resoAmount, 30.0f },
                    { P::detuneEnable, 0.0f }, { P::detuneCents, 0.0f },
                    { P::duckEnable, 1.0f }, { P::duckAmount, 35.0f },
                    { P::duckAttackMs, 10.0f }, { P::duckReleaseMs, 150.0f },
                    { P::crossoverHz, 100.0f }, { P::headphoneMode, 0.0f },
                    { P::dryWet, 100.0f }, { P::outputGainDb, 0.0f },
                    { P::limiterEnable, 1.0f }, { P::ceilingDb, -0.3f }
                }
            },
            // ----------------------------------------------------------------
            {
                // Carrier sits at 216 Hz, above the 140 Hz crossover, so the
                // binaural beat survives mono-summing and the preset can stay
                // speaker-safe without giving up its width.
                "R&B Pad Glue (432Hz Shift)",
                {
                    { P::oscEnable, 1.0f }, { P::carrierHz, 216.0f }, { P::beatHz, 10.0f },
                    { P::oscWave, 0.0f }, { P::oscDrive, 15.0f }, { P::subLevelDb, -14.0f },
                    { P::lfoEnable, 1.0f }, { P::lfoSync, 1.0f }, { P::lfoRateHz, 6.0f },
                    { P::lfoDivision, 3.0f }, { P::lfoShape, 0.0f },
                    { P::lfoDepthSub, 35.0f }, { P::lfoDepthAudio, 20.0f },
                    { P::lfoDepthFilter, 25.0f }, { P::lfoStereoPhase, 150.0f },
                    { P::resoEnable, 1.0f }, { P::resoBaseHz, 432.0f }, { P::resoQ, 6.0f },
                    { P::resoHarmonics, 2.0f }, { P::resoAmount, 25.0f },
                    { P::detuneEnable, 1.0f }, { P::detuneCents, -31.77f },
                    { P::duckEnable, 0.0f }, { P::duckAmount, 0.0f },
                    { P::duckAttackMs, 10.0f }, { P::duckReleaseMs, 150.0f },
                    { P::crossoverHz, 140.0f }, { P::headphoneMode, 0.0f },
                    { P::dryWet, 100.0f }, { P::outputGainDb, 0.0f },
                    { P::limiterEnable, 1.0f }, { P::ceilingDb, -0.3f }
                }
            },
            // ----------------------------------------------------------------
            {
                "Sub-Bass Ducking Pulse",
                {
                    { P::oscEnable, 1.0f }, { P::carrierHz, 40.0f }, { P::beatHz, 4.0f },
                    { P::oscWave, 0.0f }, { P::oscDrive, 50.0f }, { P::subLevelDb, -4.0f },
                    { P::lfoEnable, 1.0f }, { P::lfoSync, 1.0f }, { P::lfoRateHz, 6.0f },
                    { P::lfoDivision, 2.0f }, { P::lfoShape, 1.0f },
                    { P::lfoDepthSub, 50.0f }, { P::lfoDepthAudio, 0.0f },
                    { P::lfoDepthFilter, 0.0f }, { P::lfoStereoPhase, 0.0f },
                    { P::resoEnable, 0.0f }, { P::resoBaseHz, 444.0f }, { P::resoQ, 8.0f },
                    { P::resoHarmonics, 3.0f }, { P::resoAmount, 0.0f },
                    { P::detuneEnable, 0.0f }, { P::detuneCents, 0.0f },
                    { P::duckEnable, 1.0f }, { P::duckAmount, 85.0f },
                    { P::duckAttackMs, 5.0f }, { P::duckReleaseMs, 120.0f },
                    { P::crossoverHz, 90.0f }, { P::headphoneMode, 0.0f },
                    { P::dryWet, 100.0f }, { P::outputGainDb, 0.0f },
                    { P::limiterEnable, 1.0f }, { P::ceilingDb, -0.3f }
                }
            },
            // ----------------------------------------------------------------
            {
                // Dry/wet at 0 leaves the incoming audio completely alone -
                // the sub is added on its own level control, so this is the
                // binaural layer and nothing else.
                "Pure Binaural Theta Drift",
                {
                    { P::oscEnable, 1.0f }, { P::carrierHz, 174.0f }, { P::beatHz, 6.5f },
                    { P::oscWave, 0.0f }, { P::oscDrive, 0.0f }, { P::subLevelDb, -6.0f },
                    { P::lfoEnable, 0.0f }, { P::lfoSync, 0.0f }, { P::lfoRateHz, 6.0f },
                    { P::lfoShape, 0.0f }, { P::lfoDepthSub, 0.0f }, { P::lfoDepthAudio, 0.0f },
                    { P::lfoDepthFilter, 0.0f }, { P::lfoStereoPhase, 0.0f },
                    { P::resoEnable, 0.0f }, { P::resoBaseHz, 444.0f }, { P::resoQ, 8.0f },
                    { P::resoHarmonics, 3.0f }, { P::resoAmount, 0.0f },
                    { P::detuneEnable, 0.0f }, { P::detuneCents, 0.0f },
                    { P::duckEnable, 0.0f }, { P::duckAmount, 0.0f },
                    { P::duckAttackMs, 10.0f }, { P::duckReleaseMs, 150.0f },
                    { P::crossoverHz, 60.0f }, { P::headphoneMode, 1.0f },
                    { P::dryWet, 0.0f }, { P::outputGainDb, 0.0f },
                    { P::limiterEnable, 1.0f }, { P::ceilingDb, -0.3f }
                }
            }
        };

        return presets;
    }
}

int getNumPresets() noexcept
{
    return static_cast<int> (table().size());
}

juce::String getPresetName (int index)
{
    const auto& presets = table();

    if (juce::isPositiveAndBelow (index, static_cast<int> (presets.size())))
        return presets[static_cast<size_t> (index)].name;

    return {};
}

void applyPreset (int index, juce::AudioProcessorValueTreeState& state)
{
    const auto& presets = table();

    if (! juce::isPositiveAndBelow (index, static_cast<int> (presets.size())))
        return;

    for (const auto& setting : presets[static_cast<size_t> (index)].settings)
    {
        if (auto* param = state.getParameter (setting.id))
            param->setValueNotifyingHost (param->convertTo0to1 (setting.value));
        else
            jassertfalse;   // a preset names a parameter that no longer exists
    }
}
} // namespace SomaticPulse::FactoryPresets
