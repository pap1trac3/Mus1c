#pragma once

#include <juce_dsp/juce_dsp.h>

namespace SomaticPulse
{
/**
    The output stage: keeps the generated sub out of the track's way, and
    keeps the low end mono-compatible.

    Three separate concerns, deliberately kept in one place because they all
    exist to stop this plugin wrecking a mix:

    - **Ducking.** A peak envelope follower on the incoming audio pulls the
      synthesised sub down when the track's own kick lands. Without it, a
      40 Hz tone under an 808 just adds two sub sources together and clips.

    - **Mono-maker.** A 4th-order Linkwitz-Riley crossover splits the output
      and optionally sums everything below the corner to mono. LR4 is the
      right filter here because its two bands reconstruct flat: a Butterworth
      pair would leave a +3 dB bump at the crossover.

      Note the real trade-off this exposes. A binaural beat *is* a
      left/right difference, so monoing the band it lives in cancels it.
      That is why headphone mode bypasses the summing rather than trying to
      have both - the two goals are mutually exclusive below the corner, and
      pretending otherwise would just produce a beat that quietly does
      nothing on speakers.

    - **Safety.** A 5 Hz DC blocker and a soft ceiling, so nothing downstream
      sees a DC offset or an over.
*/
class PhaseSafeCrossover
{
public:
    void prepare (const juce::dsp::ProcessSpec& spec);
    void reset() noexcept;

    void setCrossoverFrequency (float hz) noexcept;
    void setMonoMakerEnabled (bool shouldSum) noexcept { monoMaker = shouldSum; }

    void setDuckEnabled (bool shouldDuck) noexcept     { duckEnabled = shouldDuck; }
    void setDuckAmount (float normalised) noexcept     { duckAmount = normalised; }
    void setDuckTimes (float attackMs, float releaseMs) noexcept;

    void setOutputGain (float linearGain) noexcept     { outputGain.setTargetValue (linearGain); }
    void setLimiterEnabled (bool shouldLimit) noexcept { limiterEnabled = shouldLimit; }
    void setCeiling (float linearCeiling) noexcept     { ceiling = juce::jmax (1.0e-3f, linearCeiling); }

    void snapToTargets() noexcept;

    /**
        Follows the dry input and returns the gain the synthesised sub should
        be multiplied by this sample. 1 means "no duck".

        Call this with the *dry* signal before the sub is mixed in, otherwise
        the sub ducks itself and the loop oscillates.
    */
    inline float updateDuckGain (float dryL, float dryR) noexcept
    {
        const auto rectified = juce::jmax (std::abs (dryL), std::abs (dryR));
        const auto coeff = rectified > envelope ? attackCoeff : releaseCoeff;

        envelope = rectified + coeff * (envelope - rectified);

        if (! duckEnabled)
            return 1.0f;

        // x2 so that a -6 dBFS peak is enough to duck fully at 100% amount;
        // material that quiet is already doing the thing we are ducking for.
        return juce::jlimit (0.0f, 1.0f, 1.0f - duckAmount * envelope * 2.0f);
    }

    float getEnvelope() const noexcept { return envelope; }

    /** Crossover split, optional mono fold, DC block, gain and ceiling. */
    inline void processFrame (float& left, float& right) noexcept
    {
        float lowL = 0.0f, highL = 0.0f, lowR = 0.0f, highR = 0.0f;

        crossover.processSample (0, left,  lowL, highL);
        crossover.processSample (1, right, lowR, highR);

        if (monoMaker)
        {
            const auto mono = 0.5f * (lowL + lowR);
            lowL = mono;
            lowR = mono;
        }

        auto outL = lowL + highL;
        auto outR = lowR + highR;

        outL = blockDc (0, outL);
        outR = blockDc (1, outR);

        const auto g = outputGain.getNextValue();
        outL *= g;
        outR *= g;

        if (limiterEnabled)
        {
            // tanh against the ceiling: asymptotic, so the output cannot
            // exceed it, and smooth, so there is no edge to generate the
            // harsh odd harmonics a hard clip would.
            outL = ceiling * std::tanh (outL / ceiling);
            outR = ceiling * std::tanh (outR / ceiling);
        }

        left = outL;
        right = outR;
    }

private:
    inline float blockDc (int channel, float x) noexcept
    {
        auto& x1 = dcX1[channel];
        auto& y1 = dcY1[channel];

        const auto y = x - x1 + dcR * y1;

        x1 = x;
        y1 = y;

        return y;
    }

    juce::dsp::LinkwitzRileyFilter<float> crossover;
    juce::SmoothedValue<float> outputGain { 1.0f };

    float envelope = 0.0f;
    float attackCoeff = 0.0f;
    float releaseCoeff = 0.0f;
    float duckAmount = 0.0f;
    float ceiling = 0.9661f;        // -0.3 dBFS

    float dcX1[2] { 0.0f, 0.0f };
    float dcY1[2] { 0.0f, 0.0f };
    float dcR = 0.9993f;

    double sampleRate = 44100.0;

    bool monoMaker = true;
    bool duckEnabled = false;
    bool limiterEnabled = true;
};
} // namespace SomaticPulse
