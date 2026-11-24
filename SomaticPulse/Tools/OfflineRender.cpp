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
    std::vector<float> tactileLeft, tactileRight;
};

/**
    Renders `seconds` of audio.

    @param input  0 for silence, otherwise a generator called per sample.
*/
Capture render (SomaticPulse::SomaticPulseProcessor& processor, double seconds,
                const std::function<float (int)>& input = {})
{
    const auto totalSamples = static_cast<int> (seconds * sampleRate);
    const auto channels = juce::jmax (2, processor.getTotalNumOutputChannels());
    const auto hasTactile = channels >= 4;

    Capture captured;
    captured.left.reserve (static_cast<size_t> (totalSamples));
    captured.right.reserve (static_cast<size_t> (totalSamples));

    juce::AudioBuffer<float> buffer (channels, blockSize);
    juce::MidiBuffer midi;

    int sampleIndex = 0;

    while (sampleIndex < totalSamples)
    {
        const auto thisBlock = juce::jmin (blockSize, totalSamples - sampleIndex);
        buffer.setSize (channels, thisBlock, false, false, true);
        buffer.clear();

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

            if (hasTactile)
            {
                captured.tactileLeft.push_back (buffer.getSample (2, i));
                captured.tactileRight.push_back (buffer.getSample (3, i));
            }
        }

        sampleIndex += thisBlock;
    }

    return captured;
}

/**
    Counts amplitude-envelope cycles per second.

    A peak follower is the wrong tool: its ripple at the carrier is larger
    than the envelope's change over one carrier period, so a crossing count
    picks up the ripple. This low-passes the rectified signal twice and
    counts mean crossings with hysteresis.
*/
double countEnvelopeCyclesPerSecond (const std::vector<float>& signal, int skip,
                                     double envelopeCutoffHz)
{
    if (static_cast<int> (signal.size()) <= skip + 2)
        return 0.0;

    const auto coefficient = static_cast<float> (std::exp (-juce::MathConstants<double>::twoPi
                                                           * envelopeCutoffHz / sampleRate));

    std::vector<float> envelope (signal.size());
    float stage1 = 0.0f, stage2 = 0.0f;

    for (size_t i = 0; i < signal.size(); ++i)
    {
        const auto rectified = std::abs (signal[i]);
        stage1 = rectified + coefficient * (stage1 - rectified);
        stage2 = stage1 + coefficient * (stage2 - stage1);
        envelope[i] = stage2;
    }

    double mean = 0.0;
    for (size_t i = static_cast<size_t> (skip); i < envelope.size(); ++i)
        mean += envelope[i];
    mean /= static_cast<double> (envelope.size() - static_cast<size_t> (skip));

    int cycles = 0;
    bool armed = true;

    for (size_t i = static_cast<size_t> (skip) + 1; i < envelope.size(); ++i)
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

    const auto seconds = static_cast<double> (envelope.size() - static_cast<size_t> (skip)) / sampleRate;

    return seconds > 0.0 ? cycles / seconds : 0.0;
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
    setParam (processor, P::beatMode, 0.0f);
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
    setParam (processor, P::sessionMinutes, 0.0f);
    setParam (processor, P::sessionFadePct, 10.0f);
    setParam (processor, P::rampEnable, 0.0f);
    setParam (processor, P::tactileEnable, 0.0f);
    setParam (processor, P::tactileRouting, 0.0f);
    setParam (processor, P::tactileLevelDb, -6.0f);
    setParam (processor, P::tactileHpHz, 20.0f);
    setParam (processor, P::tactileLpHz, 120.0f);
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
        const auto rate = countEnvelopeCyclesPerSecond (captured.left, 48000, 6.0);

        report ("1/4 at 120 BPM pulses at 2 Hz", std::abs (rate - 2.0) < 0.2,
                juce::String (rate, 3) + " Hz");
    }

    // --- 6. Beat modes -----------------------------------------------------
    {
        const auto beatRate = 8.0f;

        resetToSubOnly (processor);
        setParam (processor, P::carrierHz, 200.0f);
        setParam (processor, P::beatHz, beatRate);
        // Mono-maker off, so what is measured here is the oscillator alone.
        // With it on, an LR4 split at 200 Hz would put the 196 Hz carrier in
        // the summed low band and the 204 Hz one in the untouched high band,
        // mixing both carriers back into each channel and beating for a
        // reason that has nothing to do with the mode under test.
        setParam (processor, P::headphoneMode, 1.0f);

        const auto monoSum = [] (const Capture& c)
        {
            std::vector<float> mono (c.left.size());

            for (size_t i = 0; i < c.left.size(); ++i)
                mono[i] = 0.5f * (c.left[i] + c.right[i]);

            return mono;
        };

        setParam (processor, P::beatMode, 0.0f);        // binaural
        const auto binaural = render (processor, 3.0);

        setParam (processor, P::beatMode, 1.0f);        // monaural
        const auto monaural = render (processor, 3.0);

        setParam (processor, P::beatMode, 2.0f);        // isochronic
        const auto isochronic = render (processor, 3.0);

        // The case that matters for a transducer: ONE channel, on its own.
        // A single driver is handed one channel, and in binaural mode that
        // channel is a steady tone - the beat exists only between the two
        // channels, so a lone transducer reproduces no pulse whatsoever.
        const auto binauralSingle = countEnvelopeCyclesPerSecond (binaural.left, 48000, 30.0);
        const auto monauralSingle = countEnvelopeCyclesPerSecond (monaural.left, 48000, 30.0);
        const auto isochronicSingle = countEnvelopeCyclesPerSecond (isochronic.left, 48000, 30.0);

        report ("binaural gives one channel no modulation at all", binauralSingle < 1.0,
                juce::String (binauralSingle, 2) + " cycles/s in the left channel alone");
        report ("monaural modulates every channel",
                std::abs (monauralSingle - beatRate) < 1.0,
                juce::String (monauralSingle, 2) + " cycles/s (expected 8)");
        report ("isochronic modulates every channel",
                std::abs (isochronicSingle - beatRate) < 1.0,
                juce::String (isochronicSingle, 2) + " cycles/s (expected 8)");

        // Summing the two carriers does not destroy the beat - it converts
        // it. Two tones 8 Hz apart added together are an acoustic beat at
        // 8 Hz, which is a different phenomenon from the neural one and is
        // produced in the air rather than in the listener.
        const auto binauralSummed = countEnvelopeCyclesPerSecond (monoSum (binaural), 48000, 30.0);

        report ("mono summing turns a binaural beat into an acoustic one",
                std::abs (binauralSummed - beatRate) < 1.0,
                juce::String (binauralSummed, 2) + " cycles/s in the mono sum");

        // Monaural puts identical content in both channels, so it is also
        // the mode that cannot smear a stereo image.
        double sumLR = 0.0, sumLL = 0.0, sumRR = 0.0;

        for (size_t i = 48000; i < monaural.left.size(); ++i)
        {
            sumLR += static_cast<double> (monaural.left[i]) * monaural.right[i];
            sumLL += static_cast<double> (monaural.left[i]) * monaural.left[i];
            sumRR += static_cast<double> (monaural.right[i]) * monaural.right[i];
        }

        const auto correlation = sumLR / std::sqrt (juce::jmax (1.0e-12, sumLL * sumRR));

        report ("monaural mode is phase-identical across channels", correlation > 0.999,
                "correlation " + juce::String (correlation, 4));
    }

    // --- 7. Sub-0.5 Hz pulse rates ----------------------------------------
    {
        resetToSubOnly (processor);
        setParam (processor, P::carrierHz, 200.0f);
        setParam (processor, P::beatHz, 0.0f);
        setParam (processor, P::lfoEnable, 1.0f);
        setParam (processor, P::lfoSync, 0.0f);
        setParam (processor, P::lfoShape, 0.0f);
        setParam (processor, P::lfoDepthSub, 100.0f);

        if (auto* rate = processor.apvts.getParameter (P::lfoRateHz))
        {
            const auto floorHz = rate->convertFrom0to1 (0.0f);

            // 0.0917 Hz is 5.5 breaths a minute; the old 0.5 Hz floor was
            // thirty a minute, so a breath pace was unreachable.
            report ("pulse rate reaches breath-pacing rates", floorHz <= 0.0917f,
                    "floor " + juce::String (floorHz, 3) + " Hz ("
                        + juce::String (floorHz * 60.0f, 1) + "/min)");
        }

        setParam (processor, P::lfoRateHz, 0.25f);
        const auto captured = render (processor, 60.0);

        const auto measured = countEnvelopeCyclesPerSecond (captured.left, 48000, 2.0);

        report ("0.25 Hz pulse runs at 15 cycles a minute",
                std::abs (measured * 60.0 - 15.0) < 1.5,
                juce::String (measured * 60.0, 2) + "/min (expected 15)");
    }

    // --- 8. Session envelope ------------------------------------------------
    {
        resetToSubOnly (processor);
        setParam (processor, P::carrierHz, 120.0f);
        setParam (processor, P::subLevelDb, -6.0f);
        setParam (processor, P::sessionMinutes, 0.05f);    // 3 seconds
        setParam (processor, P::sessionFadePct, 20.0f);    // 0.6 s each end

        processor.restartSession();
        const auto captured = render (processor, 4.0);

        const auto early = rms (captured.left, 2400, 7200);      // inside the fade-in
        const auto middle = rms (captured.left, 60000, 84000);   // the hold
        const auto after = rms (captured.left, 168000, 192000);  // past the end

        report ("session fades in", early < middle * 0.5,
                "RMS " + juce::String (early, 4) + " vs " + juce::String (middle, 4));
        report ("session ends on its own", after < middle * 0.01,
                "RMS " + juce::String (after, 6) + " after the clock runs out");
    }

    // --- 9. Tactile bus -----------------------------------------------------
    {
        auto layout = processor.getBusesLayout();
        layout.outputBuses.getReference (1) = juce::AudioChannelSet::stereo();

        if (! processor.setBusesLayout (layout))
        {
            report ("tactile bus can be enabled", false, "host layout refused");
        }
        else
        {
            processor.prepareToPlay (sampleRate, blockSize);

            resetToSubOnly (processor);
            setParam (processor, P::oscEnable, 0.0f);
            setParam (processor, P::dryWet, 0.0f);
            setParam (processor, P::tactileEnable, 1.0f);
            setParam (processor, P::tactileLevelDb, 0.0f);
            setParam (processor, P::tactileHpHz, 20.0f);
            setParam (processor, P::tactileLpHz, 120.0f);

            const auto tone = [] (float hz)
            {
                return [hz] (int i)
                {
                    return 0.5f * std::sin (juce::MathConstants<float>::twoPi * hz
                                            * static_cast<float> (i) / static_cast<float> (sampleRate));
                };
            };

            const auto inBand = render (processor, 1.0, tone (50.0f));
            const auto outOfBand = render (processor, 1.0, tone (600.0f));

            const auto passed = rms (inBand.tactileLeft, 24000, 47000);
            const auto rejected = rms (outOfBand.tactileLeft, 24000, 47000);
            const auto mainStillThere = rms (outOfBand.left, 24000, 47000);

            report ("tactile bus carries the transducer band", passed > 0.1,
                    "50 Hz RMS " + juce::String (passed, 4));
            report ("tactile bus rejects content above the corner",
                    rejected < passed * 0.05,
                    "600 Hz RMS " + juce::String (rejected, 5) + " vs "
                        + juce::String (passed, 4));
            report ("main bus is unaffected by the send", mainStillThere > 0.2,
                    "main RMS " + juce::String (mainStillThere, 4));

            // Tactile Only mutes the main bus and leaves the send running.
            setParam (processor, P::tactileRouting, 1.0f);
            const auto soloed = render (processor, 1.0, tone (50.0f));

            report ("Tactile Only mutes the main bus",
                    rms (soloed.left, 24000, 47000) < 1.0e-4
                        && rms (soloed.tactileLeft, 24000, 47000) > 0.1,
                    "main " + juce::String (rms (soloed.left, 24000, 47000), 6)
                        + ", tactile " + juce::String (rms (soloed.tactileLeft, 24000, 47000), 4));

            setParam (processor, P::tactileRouting, 0.0f);
            setParam (processor, P::tactileEnable, 0.0f);
        }
    }

    // --- 10. Loudness meter -------------------------------------------------
    {
        resetToSubOnly (processor);
        setParam (processor, P::oscEnable, 0.0f);
        setParam (processor, P::dryWet, 0.0f);
        setParam (processor, P::limiterEnable, 0.0f);

        // A 997 Hz sine at -20 dBFS should read close to -20 LUFS: the
        // K-weighting curve is near unity around 1 kHz.
        render (processor, 2.0, [] (int i)
        {
            return 0.1f * std::sin (juce::MathConstants<float>::twoPi * 997.0f
                                    * static_cast<float> (i) / static_cast<float> (sampleRate));
        });

        const auto lufs = processor.getLoudnessForUI();

        report ("loudness meter reads a -20 dBFS tone correctly",
                std::abs (lufs + 20.0f) < 1.5f,
                juce::String (lufs, 2) + " LUFS-M (expected about -20)");
    }

    // --- 11. Every factory preset renders cleanly ---------------------------
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

    // --- 12. State round-trip ----------------------------------------------
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
