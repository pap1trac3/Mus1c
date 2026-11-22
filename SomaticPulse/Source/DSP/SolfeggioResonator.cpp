#include "SolfeggioResonator.h"

namespace SomaticPulse
{
namespace
{
    constexpr double smoothingSeconds = 0.02;
    constexpr double windowSeconds = 0.05;

    /** Catmull-Rom through the middle two of four points. */
    inline float hermite (float frac, float ym1, float y0, float y1, float y2) noexcept
    {
        const auto c0 = y0;
        const auto c1 = 0.5f * (y1 - ym1);
        const auto c2 = ym1 - 2.5f * y0 + 2.0f * y1 - 0.5f * y2;
        const auto c3 = 0.5f * (y2 - ym1) + 1.5f * (y0 - y1);

        return ((c3 * frac + c2) * frac + c1) * frac + c0;
    }
}

void SolfeggioResonator::prepare (const juce::dsp::ProcessSpec& spec)
{
    sampleRate = spec.sampleRate;
    windowLength = windowSeconds * sampleRate;

    // Window, plus the crossfade head's half window, plus interpolation
    // margin. Sized once here so processFrame never allocates.
    bufferLength = static_cast<int> (windowLength * 1.5) + 8;

    delayBuffer.setSize (2, bufferLength, false, true, false);
    delayBuffer.clear();

    for (auto& f : bandpass)
    {
        f.prepare (spec);
        f.setType (juce::dsp::StateVariableTPTFilterType::bandpass);
    }

    amount.reset (sampleRate, smoothingSeconds);
    detuneMix.reset (sampleRate, smoothingSeconds);

    cutoffDirty = true;
    reset();
}

void SolfeggioResonator::reset() noexcept
{
    delayBuffer.clear();
    writeIndex = 0;
    readOffset = 0.0;
    samplesUntilCutoffUpdate = 0;

    for (auto& f : bandpass)
        f.reset();
}

void SolfeggioResonator::snapToTargets() noexcept
{
    amount.setCurrentAndTargetValue (amount.getTargetValue());
    detuneMix.setCurrentAndTargetValue (detuneMix.getTargetValue());
}

void SolfeggioResonator::updateCutoffs() noexcept
{
    // Keep well clear of Nyquist: a TPT filter asked for a cutoff above it
    // does not blow up, but its tuning folds over and the "harmonic" lands
    // somewhere unrelated.
    const auto maxCutoff = static_cast<float> (sampleRate * 0.45);

    for (int i = 0; i < maxHarmonics; ++i)
    {
        const auto harmonic = static_cast<float> (i + 1);
        const auto target = juce::jlimit (20.0f, maxCutoff, baseHz * harmonic * cutoffMod);

        bandpass[static_cast<size_t> (i)].setCutoffFrequency (target);
        bandpass[static_cast<size_t> (i)].setResonance (juce::jlimit (0.5f, 40.0f, resonanceQ));
    }

    cutoffDirty = false;
}

float SolfeggioResonator::readInterpolated (int channel, double delayInSamples) const noexcept
{
    const auto* data = delayBuffer.getReadPointer (channel);

    auto readPos = static_cast<double> (writeIndex) - delayInSamples;

    while (readPos < 0.0)
        readPos += static_cast<double> (bufferLength);

    const auto i1 = static_cast<int> (readPos);
    const auto frac = static_cast<float> (readPos - static_cast<double> (i1));

    const auto wrapIndex = [this] (int i) noexcept
    {
        i %= bufferLength;
        return i < 0 ? i + bufferLength : i;
    };

    const auto ym1 = data[wrapIndex (i1 - 1)];
    const auto y0  = data[wrapIndex (i1)];
    const auto y1  = data[wrapIndex (i1 + 1)];
    const auto y2  = data[wrapIndex (i1 + 2)];

    return hermite (frac, ym1, y0, y1, y2);
}

void SolfeggioResonator::processFrame (float& left, float& right) noexcept
{
    if (cutoffDirty && samplesUntilCutoffUpdate <= 0)
        updateCutoffs();

    if (--samplesUntilCutoffUpdate <= 0)
    {
        samplesUntilCutoffUpdate = cutoffUpdateInterval;

        if (cutoffDirty)
            updateCutoffs();
    }

    // --- Micro-detune ------------------------------------------------------
    //
    // Always write, even when the detune is mixed out, so that enabling it
    // reads into history that is already there rather than into silence.
    auto* writeL = delayBuffer.getWritePointer (0);
    auto* writeR = delayBuffer.getWritePointer (1);

    writeL[writeIndex] = left;
    writeR[writeIndex] = right;

    const auto mix = detuneMix.getNextValue();

    float shiftedL = left;
    float shiftedR = right;

    if (mix > 1.0e-4f)
    {
        const auto half = windowLength * 0.5;

        auto offsetA = readOffset;
        auto offsetB = readOffset + half;

        if (offsetB >= windowLength)
            offsetB -= windowLength;

        // Hann crossfade. Each head's gain reaches zero exactly where its
        // own read position wraps, so the discontinuity is multiplied by
        // nothing. The two gains sum to 1 at every point in the window.
        const auto tA = static_cast<float> (offsetA / windowLength);
        const auto tB = static_cast<float> (offsetB / windowLength);

        const auto gA = 0.5f - 0.5f * std::cos (juce::MathConstants<float>::twoPi * tA);
        const auto gB = 0.5f - 0.5f * std::cos (juce::MathConstants<float>::twoPi * tB);

        const auto delayA = offsetA + minimumDelaySamples;
        const auto delayB = offsetB + minimumDelaySamples;

        const auto wetL = gA * readInterpolated (0, delayA) + gB * readInterpolated (0, delayB);
        const auto wetR = gA * readInterpolated (1, delayA) + gB * readInterpolated (1, delayB);

        shiftedL = left + mix * (wetL - left);
        shiftedR = right + mix * (wetR - right);

        // ratio < 1 lowers the pitch, so the read head must fall further
        // behind the write head each sample.
        readOffset += (1.0 - pitchRatio);

        while (readOffset < 0.0)
            readOffset += windowLength;
        while (readOffset >= windowLength)
            readOffset -= windowLength;
    }

    if (++writeIndex >= bufferLength)
        writeIndex = 0;

    // --- Parallel resonant bands ------------------------------------------
    const auto amt = amount.getNextValue();

    if (amt > 1.0e-4f)
    {
        float bandL = 0.0f;
        float bandR = 0.0f;

        for (int i = 0; i < numHarmonics; ++i)
        {
            auto& f = bandpass[static_cast<size_t> (i)];
            bandL += f.processSample (0, shiftedL);
            bandR += f.processSample (1, shiftedR);
        }

        // Normalise by the band count so sweeping "harmonics" changes the
        // timbre rather than the level.
        const auto norm = amt / static_cast<float> (numHarmonics);

        left  = shiftedL + bandL * norm;
        right = shiftedR + bandR * norm;
    }
    else
    {
        // Fully mixed out: skip the filters rather than burn eight SVF
        // updates per sample for nothing. Coming back in is covered by the
        // amount smoother's 20 ms ramp, which is longer than the settling
        // time of these bands at any usable Q.
        left = shiftedL;
        right = shiftedR;
    }
}
} // namespace SomaticPulse
