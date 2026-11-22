#pragma once

#include <juce_gui_basics/juce_gui_basics.h>

#include <array>
#include <functional>

#include "../DSP/ScopeBuffer.h"

namespace SomaticPulse
{
/**
    The centre display: a vectorscope and the pulse trace.

    The vectorscope is deliberately the larger of the two, because it answers
    the question this plugin exists to answer. The incoming frames are rotated
    45 degrees before plotting - x = (L - R), y = -(L + R) - which is the
    standard vectorscope orientation and means a mono-compatible signal draws
    a vertical line while anything that cancels on summing spreads sideways.
    A user adding a binaural beat under a mix can see, directly, how much of
    the output lives in the difference signal.

    Everything here runs on the message thread at 60 FPS and pulls audio out
    of a lock-free FIFO. It never touches the audio thread's state, and if the
    FIFO has nothing ready it simply draws the previous frame again.
*/
class WaveformVisualizer final : public juce::Component,
                                 private juce::Timer
{
public:
    /**
        @param source       post-DSP frames, filled by the audio thread.
        @param lfoProvider  reads the processor's atomic LFO value. Passed as
                            a callback rather than a processor reference so
                            this component carries no dependency on the
                            plugin's parameter graph.
    */
    WaveformVisualizer (ScopeBuffer& source, std::function<float()> lfoProvider);
    ~WaveformVisualizer() override;

    void paint (juce::Graphics&) override;

private:
    void timerCallback() override;

    void drawVectorscope (juce::Graphics&, juce::Rectangle<float> area) const;
    void drawPulseTrace (juce::Graphics&, juce::Rectangle<float> area) const;
    void drawReadouts (juce::Graphics&, juce::Rectangle<float> area) const;

    static constexpr int drainSize = 2048;
    static constexpr int scopePoints = 512;
    static constexpr int pulsePoints = 240;   // 4 seconds at 60 FPS

    ScopeBuffer& scope;
    std::function<float()> readLfo;

    std::array<float, drainSize> drainL {};
    std::array<float, drainSize> drainR {};

    /** Rotated, normalised scope points, held as a ring. */
    std::array<juce::Point<float>, scopePoints> points {};
    int pointWrite = 0;
    int pointCount = 0;

    std::array<float, pulsePoints> pulse {};
    int pulseWrite = 0;

    float peak = 0.0f;
    float correlation = 1.0f;
    float lastPulseValue = 0.0f;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (WaveformVisualizer)
};
} // namespace SomaticPulse
