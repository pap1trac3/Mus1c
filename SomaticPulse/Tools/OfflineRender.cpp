/**
    Offline verification harness.

    Not part of the plug-in. It instantiates the real SomaticPulseProcessor,
    drives it through its public parameter interface only, and measures what
    comes out, so claims about the DSP can be checked rather than asserted.

    Build with -DSOMATICPULSE_BUILD_TOOLS=ON and run the resulting binary; it
    prints one line per check and exits non-zero if any of them fail.
*/

#include "PluginProcessor.h"
#include "ParameterIDs.h"

#include <cmath>
#include <iostream>
#include <vector>

namespace
{
namespace P = SomaticPulse::ParamID;

constexpr double sampleRate = 48000.0;
constexpr int blockSize = 512;

int failures = 0;

void report (const juce::String& name, bool pass, const juce::String& detail)
{
    std::cout << (pass ? "  PASS  " : "  FAIL  ") << name.toStdString()
              << "   " << detail.toStdString() << std::endl;

    if (! pass)
        ++failures;
}

/** Host transport stub, so tempo-synced rates can be measured. */
class FixedTempoPlayHead final : public juce::AudioPlayHead
{
public:
    explicit FixedTempoPlayHead (double bpmIn) : bpm (bpmIn) {}

    juce::Optional<PositionInfo> getPosition() const override
    {
        PositionInfo info;
        info.setBpm (bpm);
        info.setIsPlaying (true);
        info.setTimeInSamples (0);
        return info;
    }

private:
    double bpm;
};

void setParam (SomaticPulse::SomaticPulseProcessor& processor, const char* id, float realValue)
{
    auto* parameter = processor.apvts.getParameter (id);
    jassert (parameter != nullptr);
    parameter->setValueNotifyingHost (parameter->convertTo0to1 (realValue));
}

struct Capture
{
    std::vector<float> left, right;
};

/**
    Renders `seconds` of audio.

    @param input  0 for silence, otherwise a generator called per sample.
*/
Capture render (SomaticPulse::SomaticPulseProcessor& processor, double seconds,
                const std::function<float (int)>& input = {})
{
    const auto totalSamples = static_cast<int> (seconds * sampleRate);

    Capture captured;
    captured.left.reserve (static_cast<size_t> (totalSamples));
    captured.right.reserve (static_cast<size_t> (totalSamples));

    juce::AudioBuffer<float> buffer (2, blockSize);
    juce::MidiBuffer midi;

    int sampleIndex = 0;

    while (sampleIndex < totalSamples)
    {
        const auto thisBlock = juce::jmin (blockSize, totalSamples - sampleIndex);
        buffer.setSize (2, thisBlock, false, false, true);

        for (int i = 0; i < thisBlock; ++i)
        {
            const auto value = input ? input (sampleIndex + i) : 0.0f;
            buffer.setSample (0, i, value);
            buffer.setSample (1, i, value);
        }

        processor.processBlock (buffer, midi);

        for (int i = 0; i < thisBlock; ++i)
        {
            captured.left.push_back (buffer.getSample (0, i));
            captured.right.push_back (buffer.getSample (1, i));
        }

        sampleIndex += thisBlock;
    }

    return captured;
}

/** Frequency from upward zero crossings, ignoring the first `skip` samples. */
double measureFrequency (const std::vector<float>& signal, int skip)
{
    int crossings = 0;
    int firstCrossing = -1, lastCrossing = -1;

    for (size_t i = static_cast<size_t> (skip) + 1; i < signal.size(); ++i)
    {
        if (signal[i - 1] <= 0.0f && signal[i] > 0.0f)
        {
            if (firstCrossing < 0)
                firstCrossing = static_cast<int> (i);

            lastCrossing = static_cast<int> (i);
            ++crossings;
        }
    }

    if (crossings < 2)
        return 0.0;

    const auto span = static_cast<double> (lastCrossing - firstCrossing);
    return (crossings - 1) * sampleRate / span;
}

double rms (const std::vector<float>& signal, int from, int to)
{
    double sum = 0.0;
    const auto count = juce::jmax (1, to - from);

    for (int i = from; i < to && i < static_cast<int> (signal.size()); ++i)
        sum += static_cast<double> (signal[static_cast<size_t> (i)]) * signal[static_cast<size_t> (i)];

    return std::sqrt (sum / count);
}

float peakOf (const Capture& c)
{
    float peak = 0.0f;

    for (size_t i = 0; i < c.left.size(); ++i)
        peak = juce::jmax (peak, std::abs (c.left[i]), std::abs (c.right[i]));

    return peak;
}

bool allFinite (const Capture& c)
{
    for (size_t i = 0; i < c.left.size(); ++i)
        if (! std::isfinite (c.left[i]) || ! std::isfinite (c.right[i]))
            return false;

    return true;
}

/** Puts the plug-in in a known state: sub only, nothing else in the path. */
void resetToSubOnly (SomaticPulse::SomaticPulseProcessor& processor)
{
    setParam (processor, P::oscEnable, 1.0f);
    setParam (processor, P::carrierHz, 200.0f);
    setParam (processor, P::beatHz, 10.0f);
    setParam (processor, P::oscWave, 0.0f);
    setParam (processor, P::oscDrive, 0.0f);
    setParam (processor, P::subLevelDb, -6.0f);
    setParam (processor, P::lfoEnable, 0.0f);
    setParam (processor, P::lfoDepthSub, 0.0f);
    setParam (processor, P::lfoDepthAudio, 0.0f);
    setParam (processor, P::lfoDepthFilter, 0.0f);
    setParam (processor, P::resoEnable, 0.0f);
    setParam (processor, P::resoAmount, 0.0f);
    setParam (processor, P::detuneEnable, 0.0f);
    setParam (processor, P::duckEnable, 0.0f);
    setParam (processor, P::headphoneMode, 1.0f);   // no mono fold
    setParam (processor, P::crossoverHz, 60.0f);
    setParam (processor, P::dryWet, 0.0f);
    setParam (processor, P::outputGainDb, 0.0f);
    setParam (processor, P::limiterEnable, 1.0f);
    setParam (processor, P::ceilingDb, -0.3f);
}
} // namespace

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInitialiser;

    SomaticPulse::SomaticPulseProcessor processor;
    processor.prepareToPlay (sampleRate, blockSize);

    std::cout << "SomaticPulse offline verification @ " << sampleRate << " Hz\n" << std::endl;

    // --- 1. Binaural split -------------------------------------------------
    {
        resetToSubOnly (processor);
        const auto captured = render (processor, 4.0);

        const auto fL = measureFrequency (captured.left, 4800);
        const auto fR = measureFrequency (captured.right, 4800);

        report ("binaural split L = fc - d/2", std::abs (fL - 195.0) < 0.5,
                juce::String (fL, 3) + " Hz (expected 195)");
        report ("binaural split R = fc + d/2", std::abs (fR - 205.0) < 0.5,
                juce::String (fR, 3) + " Hz (expected 205)");
        report ("beat rate", std::abs ((fR - fL) - 10.0) < 0.5,
                juce::String (fR - fL, 3) + " Hz (expected 10)");
    }

    // --- 2. Mono-maker cancels the beat below the corner -------------------
    {
        resetToSubOnly (processor);
        setParam (processor, P::carrierHz, 60.0f);
        setParam (processor, P::beatHz, 6.0f);
        setParam (processor, P::crossoverHz, 200.0f);

        setParam (processor, P::headphoneMode, 1.0f);
        auto headphones = render (processor, 2.0);

        setParam (processor, P::headphoneMode, 0.0f);
        auto speakers = render (processor, 2.0);

        const auto difference = [] (const Capture& c)
        {
            std::vector<float> side (c.left.size());

            for (size_t i = 0; i < c.left.size(); ++i)
                side[i] = c.left[i] - c.right[i];

            return rms (side, 48000, static_cast<int> (side.size()));
        };

        const auto sideHeadphones = difference (headphones);
        const auto sideSpeakers = difference (speakers);

        report ("headphone mode keeps the side signal", sideHeadphones > 0.01,
                "side RMS " + juce::String (sideHeadphones, 5));
        report ("mono-maker removes it below the corner", sideSpeakers < sideHeadphones * 0.02,
                "side RMS " + juce::String (sideSpeakers, 7));
    }

    // --- 3. Soft ceiling ---------------------------------------------------
    {
        resetToSubOnly (processor);
        setParam (processor, P::subLevelDb, 6.0f);
        setParam (processor, P::outputGainDb, 12.0f);
        setParam (processor, P::dryWet, 100.0f);

        const auto captured = render (processor, 1.0, [] (int i)
        {
            return 0.9f * std::sin (juce::MathConstants<float>::twoPi * 220.0f
                                    * static_cast<float> (i) / static_cast<float> (sampleRate));
        });

        const auto ceiling = juce::Decibels::decibelsToGain (-0.3f);
        const auto peak = peakOf (captured);

        report ("output never exceeds the ceiling", peak <= ceiling + 1.0e-4f,
                "peak " + juce::String (juce::Decibels::gainToDecibels (peak), 3)
                    + " dBFS (ceiling -0.300)");
        report ("output stays finite under heavy drive", allFinite (captured), "no NaN or inf");
    }

    // --- 4. Ducking --------------------------------------------------------
    {
        resetToSubOnly (processor);
        setParam (processor, P::carrierHz, 60.0f);
        setParam (processor, P::subLevelDb, -12.0f);
        setParam (processor, P::duckAmount, 100.0f);
        setParam (processor, P::duckAttackMs, 5.0f);
        setParam (processor, P::duckReleaseMs, 50.0f);
        setParam (processor, P::limiterEnable, 0.0f);   // keep the path linear

        // One second silent, one second loud. The dry signal passes straight
        // through (dry/wet 0 only bypasses the *processing*), so the sub is
        // isolated by subtracting a render with the oscillator switched off.
        const auto burst = [] (int i)
        {
            return i > 48000 ? 0.5f * std::sin (juce::MathConstants<float>::twoPi * 50.0f
                                                * static_cast<float> (i) / static_cast<float> (sampleRate))
                             : 0.0f;
        };

        setParam (processor, P::oscEnable, 0.0f);
        auto dryOnly = render (processor, 2.0, burst);

        setParam (processor, P::oscEnable, 1.0f);
        setParam (processor, P::duckEnable, 0.0f);
        auto withSub = render (processor, 2.0, burst);

        setParam (processor, P::duckEnable, 1.0f);
        auto withDuckedSub = render (processor, 2.0, burst);

        const auto isolate = [&dryOnly] (const Capture& c)
        {
            std::vector<float> sub (c.left.size());

            for (size_t i = 0; i < c.left.size(); ++i)
                sub[i] = c.left[i] - dryOnly.left[i];

            return sub;
        };

        const auto subUnducked = isolate (withSub);
        const auto subDucked = isolate (withDuckedSub);

        const auto quietUnducked = rms (subUnducked, 24000, 47000);
        const auto loudUnducked  = rms (subUnducked, 72000, 95000);
        const auto quietDucked   = rms (subDucked, 24000, 47000);
        const auto loudDucked    = rms (subDucked, 72000, 95000);

        report ("ducking leaves the sub alone in the gaps",
                std::abs (quietDucked - quietUnducked) < quietUnducked * 0.05,
                "sub RMS " + juce::String (quietDucked, 5) + " vs " + juce::String (quietUnducked, 5));
        report ("ducking pulls the sub down under loud material",
                loudDucked < loudUnducked * 0.25,
                "sub RMS " + juce::String (loudDucked, 5) + " vs " + juce::String (loudUnducked, 5));
    }

    // --- 5. Tempo sync -----------------------------------------------------
    {
        resetToSubOnly (processor);
        setParam (processor, P::carrierHz, 200.0f);
        setParam (processor, P::beatHz, 0.0f);
        setParam (processor, P::lfoEnable, 1.0f);
        setParam (processor, P::lfoSync, 1.0f);
        setParam (processor, P::lfoDivision, 2.0f);     // 1/4
        setParam (processor, P::lfoShape, 0.0f);        // sine
        setParam (processor, P::lfoDepthSub, 100.0f);

        FixedTempoPlayHead playHead (120.0);
        processor.setPlayHead (&playHead);

        const auto captured = render (processor, 4.0);
        processor.setPlayHead (nullptr);

        // At 120 BPM a 1/4 cycle is 0.5 s, so the amplitude envelope should
        // come back to full twice a second.
        //
        // The envelope is a two-pole 6 Hz lowpass of the rectified signal.
        // A peak follower is the obvious choice and the wrong one here: its
        // ripple at the 200 Hz carrier is larger than the LFO's change over
        // one carrier period, so a mean-crossing count picks up the ripple
        // rather than the modulation.
        const auto coefficient = static_cast<float> (std::exp (-juce::MathConstants<double>::twoPi
                                                               * 6.0 / sampleRate));

        std::vector<float> envelope (captured.left.size());
        float stage1 = 0.0f, stage2 = 0.0f;

        for (size_t i = 0; i < captured.left.size(); ++i)
        {
            const auto rectified = std::abs (captured.left[i]);
            stage1 = rectified + coefficient * (stage1 - rectified);
            stage2 = stage1 + coefficient * (stage2 - stage1);
            envelope[i] = stage2;
        }

        double mean = 0.0;
        for (size_t i = 48000; i < envelope.size(); ++i)
            mean += envelope[i];
        mean /= static_cast<double> (envelope.size() - 48000);

        // Hysteresis, so a sample sitting on the threshold is not counted
        // twice.
        int cycles = 0;
        bool armed = true;

        for (size_t i = 48001; i < envelope.size(); ++i)
        {
            if (armed && envelope[i] > mean * 1.05)
            {
                ++cycles;
                armed = false;
            }
            else if (! armed && envelope[i] < mean * 0.95)
            {
                armed = true;
            }
        }

        const auto seconds = static_cast<double> (envelope.size() - 48000) / sampleRate;
        const auto rate = cycles / seconds;

        report ("1/4 at 120 BPM pulses at 2 Hz", std::abs (rate - 2.0) < 0.2,
                juce::String (rate, 3) + " Hz");
    }

    // --- 6. Every factory preset renders cleanly ---------------------------
    {
        const auto noise = [] (int i)
        {
            // Deterministic pseudo-noise: same input every run.
            const auto x = std::sin (static_cast<float> (i) * 12.9898f) * 43758.5453f;
            return 0.5f * (x - std::floor (x)) - 0.25f;
        };

        for (int preset = 0; preset < processor.getNumPrograms(); ++preset)
        {
            processor.setCurrentProgram (preset);
            const auto captured = render (processor, 1.0, noise);

            const auto peak = peakOf (captured);
            const auto ok = allFinite (captured) && peak <= 1.0f && peak > 1.0e-4f;

            report ("preset \"" + processor.getProgramName (preset) + "\"", ok,
                    "peak " + juce::String (juce::Decibels::gainToDecibels (peak), 2) + " dBFS");
        }
    }

    // --- 7. State round-trip ----------------------------------------------
    {
        resetToSubOnly (processor);
        setParam (processor, P::carrierHz, 333.0f);
        setParam (processor, P::beatHz, 7.5f);

        juce::MemoryBlock state;
        processor.getStateInformation (state);

        setParam (processor, P::carrierHz, 100.0f);
        processor.setStateInformation (state.getData(), static_cast<int> (state.getSize()));

        const auto carrier = processor.apvts.getRawParameterValue (P::carrierHz)->load();
        const auto beat = processor.apvts.getRawParameterValue (P::beatHz)->load();

        report ("state round-trip", std::abs (carrier - 333.0f) < 0.01f
                                     && std::abs (beat - 7.5f) < 0.01f,
                "carrier " + juce::String (carrier, 2) + ", beat " + juce::String (beat, 2));
    }

    processor.releaseResources();

    std::cout << "\n" << (failures == 0 ? "All checks passed."
                                        : juce::String (failures).toStdString() + " check(s) failed.")
              << std::endl;

    return failures == 0 ? 0 : 1;
}
