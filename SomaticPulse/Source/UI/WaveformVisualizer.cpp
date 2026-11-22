#include "WaveformVisualizer.h"
#include "CustomLookAndFeel.h"

// juce::Decibels lives in juce_audio_basics, which the GUI headers do not
// pull in. Included here rather than in the header: this is the only place
// the visualizer needs anything from the audio side.
#include <juce_audio_basics/juce_audio_basics.h>

namespace SomaticPulse
{
namespace
{
    /** Exponential fall for the peak readout, per 60 FPS frame. */
    constexpr float peakDecay = 0.90f;

    /** One-pole smoothing for the correlation readout. */
    constexpr float correlationSmoothing = 0.82f;

    juce::String decibelText (float linear)
    {
        if (linear < 1.0e-5f)
            return "-inf dB";

        return juce::String (juce::Decibels::gainToDecibels (linear), 1) + " dB";
    }
}

WaveformVisualizer::WaveformVisualizer (ScopeBuffer& source, std::function<float()> lfoProvider)
    : scope (source), readLfo (std::move (lfoProvider))
{
    setOpaque (false);
    setInterceptsMouseClicks (false, false);
    startTimerHz (60);
}

WaveformVisualizer::~WaveformVisualizer()
{
    stopTimer();
}

// ---------------------------------------------------------------------------
void WaveformVisualizer::timerCallback()
{
    const auto available = scope.read (drainL.data(), drainR.data(), drainSize);

    if (available > 0)
    {
        // Subsample when a tick brought more frames than the ring holds, so
        // one refresh covers the whole window instead of showing only its
        // last few hundred samples.
        const auto step = juce::jmax (1, available / scopePoints);

        double sumLR = 0.0, sumLL = 0.0, sumRR = 0.0;
        float framePeak = 0.0f;

        for (int i = 0; i < available; ++i)
        {
            const auto l = drainL[static_cast<size_t> (i)];
            const auto r = drainR[static_cast<size_t> (i)];

            sumLR += static_cast<double> (l) * r;
            sumLL += static_cast<double> (l) * l;
            sumRR += static_cast<double> (r) * r;

            framePeak = juce::jmax (framePeak, std::abs (l), std::abs (r));

            if (i % step == 0)
            {
                // Rotate 45 degrees: mono content collapses onto the vertical
                // axis, out-of-phase content spreads along the horizontal.
                points[static_cast<size_t> (pointWrite)] = { (l - r) * 0.7071f,
                                                             -(l + r) * 0.7071f };

                pointWrite = (pointWrite + 1) % scopePoints;
                pointCount = juce::jmin (scopePoints, pointCount + 1);
            }
        }

        peak = juce::jmax (framePeak, peak * peakDecay);

        const auto denom = std::sqrt (sumLL * sumRR);

        if (denom > 1.0e-9)
        {
            const auto instant = static_cast<float> (juce::jlimit (-1.0, 1.0, sumLR / denom));
            correlation = correlation * correlationSmoothing
                        + instant * (1.0f - correlationSmoothing);
        }
    }
    else
    {
        peak *= peakDecay;
    }

    lastPulseValue = readLfo != nullptr ? juce::jlimit (0.0f, 1.0f, readLfo()) : 0.0f;
    pulse[static_cast<size_t> (pulseWrite)] = lastPulseValue;
    pulseWrite = (pulseWrite + 1) % pulsePoints;

    repaint();
}

// ---------------------------------------------------------------------------
void WaveformVisualizer::paint (juce::Graphics& g)
{
    auto bounds = getLocalBounds().toFloat();

    CustomLookAndFeel::drawGlassPanel (g, bounds, 10.0f);

    auto content = bounds.reduced (12.0f);

    const auto scopeSide = juce::jmin (content.getHeight(), content.getWidth() * 0.34f);
    auto scopeArea = content.removeFromLeft (scopeSide);
    content.removeFromLeft (14.0f);

    auto readoutArea = content.removeFromTop (18.0f);
    content.removeFromTop (6.0f);

    drawVectorscope (g, scopeArea);
    drawReadouts (g, readoutArea);
    drawPulseTrace (g, content);
}

// ---------------------------------------------------------------------------
void WaveformVisualizer::drawVectorscope (juce::Graphics& g, juce::Rectangle<float> area) const
{
    const auto centre = area.getCentre();
    const auto radius = juce::jmin (area.getWidth(), area.getHeight()) * 0.5f - 2.0f;

    // Graticule
    g.setColour (juce::Colour::fromFloatRGBA (1.0f, 1.0f, 1.0f, 0.06f));
    g.drawEllipse (juce::Rectangle<float> (radius * 2.0f, radius * 2.0f).withCentre (centre), 1.0f);
    g.drawEllipse (juce::Rectangle<float> (radius, radius).withCentre (centre), 1.0f);

    g.setColour (juce::Colour::fromFloatRGBA (1.0f, 1.0f, 1.0f, 0.10f));
    g.drawVerticalLine (juce::roundToInt (centre.x), centre.y - radius, centre.y + radius);
    g.setColour (juce::Colour::fromFloatRGBA (1.0f, 1.0f, 1.0f, 0.05f));
    g.drawHorizontalLine (juce::roundToInt (centre.y), centre.x - radius, centre.x + radius);

    g.setColour (Palette::textDim);
    g.setFont (CustomLookAndFeel::labelFont (8.5f));
    g.drawText ("M", juce::Rectangle<float> (centre.x - 12.0f, centre.y - radius - 1.0f, 24.0f, 10.0f),
                juce::Justification::centred, false);
    g.drawText ("S", juce::Rectangle<float> (centre.x + radius - 12.0f, centre.y - 5.0f, 12.0f, 10.0f),
                juce::Justification::centredRight, false);

    if (pointCount < 2)
        return;

    juce::Path trace;
    bool started = false;

    // Walk the ring oldest-first so the path follows the signal in time.
    const auto first = pointCount < scopePoints ? 0 : pointWrite;

    for (int i = 0; i < pointCount; ++i)
    {
        const auto& p = points[static_cast<size_t> ((first + i) % scopePoints)];

        const auto x = centre.x + juce::jlimit (-1.0f, 1.0f, p.x) * radius;
        const auto y = centre.y + juce::jlimit (-1.0f, 1.0f, p.y) * radius;

        if (! started)
        {
            trace.startNewSubPath (x, y);
            started = true;
        }
        else
        {
            trace.lineTo (x, y);
        }
    }

    g.setColour (Palette::cyan.withAlpha (0.16f));
    g.strokePath (trace, juce::PathStrokeType (3.0f, juce::PathStrokeType::curved,
                                               juce::PathStrokeType::rounded));

    g.setColour (Palette::cyan.withAlpha (0.85f));
    g.strokePath (trace, juce::PathStrokeType (1.0f, juce::PathStrokeType::curved,
                                               juce::PathStrokeType::rounded));
}

// ---------------------------------------------------------------------------
void WaveformVisualizer::drawPulseTrace (juce::Graphics& g, juce::Rectangle<float> area) const
{
    if (area.getHeight() < 8.0f || area.getWidth() < 8.0f)
        return;

    // "Untouched" reference line. The LFO is unipolar, so 1.0 is the top of
    // the trace and a shape that never reaches it is always attenuating.
    g.setColour (juce::Colour::fromFloatRGBA (1.0f, 1.0f, 1.0f, 0.08f));
    g.drawHorizontalLine (juce::roundToInt (area.getY()), area.getX(), area.getRight());
    g.drawHorizontalLine (juce::roundToInt (area.getBottom()), area.getX(), area.getRight());

    const auto xStep = area.getWidth() / static_cast<float> (pulsePoints - 1);

    juce::Path filled;
    filled.startNewSubPath (area.getX(), area.getBottom());

    for (int i = 0; i < pulsePoints; ++i)
    {
        const auto v = pulse[static_cast<size_t> ((pulseWrite + i) % pulsePoints)];
        filled.lineTo (area.getX() + static_cast<float> (i) * xStep,
                       area.getBottom() - v * area.getHeight());
    }

    filled.lineTo (area.getRight(), area.getBottom());
    filled.closeSubPath();

    g.setGradientFill (juce::ColourGradient (Palette::violet.withAlpha (0.45f), area.getX(), area.getY(),
                                             Palette::violet.withAlpha (0.04f), area.getX(), area.getBottom(),
                                             false));
    g.fillPath (filled);

    juce::Path outline;
    bool started = false;

    for (int i = 0; i < pulsePoints; ++i)
    {
        const auto v = pulse[static_cast<size_t> ((pulseWrite + i) % pulsePoints)];
        const auto x = area.getX() + static_cast<float> (i) * xStep;
        const auto y = area.getBottom() - v * area.getHeight();

        if (! started)
        {
            outline.startNewSubPath (x, y);
            started = true;
        }
        else
        {
            outline.lineTo (x, y);
        }
    }

    g.setColour (Palette::violet.withAlpha (0.95f));
    g.strokePath (outline, juce::PathStrokeType (1.4f, juce::PathStrokeType::curved,
                                                 juce::PathStrokeType::rounded));

    const auto headY = area.getBottom() - lastPulseValue * area.getHeight();
    g.setColour (Palette::violet.withAlpha (0.25f));
    g.fillEllipse (juce::Rectangle<float> (12.0f, 12.0f).withCentre ({ area.getRight(), headY }));
    g.setColour (juce::Colours::white);
    g.fillEllipse (juce::Rectangle<float> (4.0f, 4.0f).withCentre ({ area.getRight(), headY }));
}

// ---------------------------------------------------------------------------
void WaveformVisualizer::drawReadouts (juce::Graphics& g, juce::Rectangle<float> area) const
{
    auto strip = area;

    const auto cell = [&g, &strip] (const juce::String& caption,
                                    const juce::String& value,
                                    juce::Colour valueColour)
    {
        if (strip.getWidth() < 40.0f)
            return;

        g.setColour (Palette::textDim);
        g.setFont (CustomLookAndFeel::labelFont (8.5f));
        g.drawText (caption, strip.removeFromLeft (74.0f), juce::Justification::centredLeft, false);

        g.setColour (valueColour);
        g.setFont (CustomLookAndFeel::valueFont (11.0f));
        g.drawText (value, strip.removeFromLeft (64.0f), juce::Justification::centredLeft, false);

        strip.removeFromLeft (20.0f);
    };

    // Correlation is the honest mono-compatibility figure: +1 is identical
    // channels, 0 is uncorrelated, -1 cancels completely when summed.
    const auto correlationColour = correlation < 0.0f ? Palette::warn
                                 : (correlation < 0.4f ? Palette::violet : Palette::cyan);

    cell ("CORRELATION", juce::String (correlation, 2), correlationColour);
    cell ("PEAK", decibelText (peak), peak > 0.99f ? Palette::warn : Palette::text);
    cell ("PULSE", juce::String (lastPulseValue, 2), Palette::violet);
}
} // namespace SomaticPulse
