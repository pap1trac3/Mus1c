#pragma once

#include <juce_core/juce_core.h>

namespace SomaticPulse
{
/**
    Bounded session with a fade in, a hold and a fade out.

    Exists because the clinical protocols this plug-in accompanies are
    bounded - providers describe sessions of ten to fifteen minutes - while an
    audio plug-in left on an insert runs until someone stops the transport.
    A session that ends on its own is both the honest shape for the material
    and a cap on how long anyone is exposed to it.

    The intensity this returns scales the *generated and processed* content
    only. The dry signal is deliberately left alone: a track should not fade
    out because the session did.
*/
class SessionClock
{
public:
    void prepare (double newSampleRate) noexcept
    {
        sampleRate = newSampleRate > 0.0 ? newSampleRate : 44100.0;
        reset();
    }

    void reset() noexcept { elapsedSamples = 0; }

    /** 0 disables the clock entirely and intensity stays at 1. */
    void setLengthSeconds (double seconds) noexcept
    {
        const auto clamped = juce::jmax (0.0, seconds);

        // Changing the length restarts the session rather than teleporting
        // into the middle of a fade.
        if (std::abs (clamped - lengthSeconds) > 1.0e-6)
        {
            lengthSeconds = clamped;
            reset();
        }
    }

    /** Fraction of the session spent fading in, and again fading out. */
    void setFadeFraction (float fraction) noexcept
    {
        fadeFraction = juce::jlimit (0.0f, 0.5f, fraction);
    }

    void advance (int numSamples) noexcept
    {
        if (lengthSeconds > 0.0)
            elapsedSamples += numSamples;
    }

    bool isEnabled() const noexcept { return lengthSeconds > 0.0; }

    double getElapsedSeconds() const noexcept
    {
        return static_cast<double> (elapsedSamples) / sampleRate;
    }

    double getLengthSeconds() const noexcept { return lengthSeconds; }

    /** 0 at the start, 1 at the end. Always 0 when the clock is off. */
    float getProgress() const noexcept
    {
        if (lengthSeconds <= 0.0)
            return 0.0f;

        return static_cast<float> (juce::jlimit (0.0, 1.0, getElapsedSeconds() / lengthSeconds));
    }

    float getIntensity() const noexcept
    {
        if (lengthSeconds <= 0.0)
            return 1.0f;

        const auto elapsed = getElapsedSeconds();

        if (elapsed >= lengthSeconds)
            return 0.0f;

        const auto fade = lengthSeconds * static_cast<double> (fadeFraction);

        if (fade <= 1.0e-6)
            return 1.0f;

        if (elapsed < fade)
            return static_cast<float> (elapsed / fade);

        const auto remaining = lengthSeconds - elapsed;

        if (remaining < fade)
            return static_cast<float> (remaining / fade);

        return 1.0f;
    }

    bool isFinished() const noexcept
    {
        return lengthSeconds > 0.0 && getElapsedSeconds() >= lengthSeconds;
    }

private:
    double sampleRate = 44100.0;
    double lengthSeconds = 0.0;
    juce::int64 elapsedSamples = 0;
    float fadeFraction = 0.1f;
};
} // namespace SomaticPulse
