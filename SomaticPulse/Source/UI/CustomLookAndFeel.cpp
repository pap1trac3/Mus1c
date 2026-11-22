#include "CustomLookAndFeel.h"

namespace SomaticPulse
{
CustomLookAndFeel::CustomLookAndFeel()
{
    setColour (juce::ResizableWindow::backgroundColourId, Palette::background);

    setColour (juce::Slider::textBoxTextColourId,    Palette::text);
    setColour (juce::Slider::textBoxOutlineColourId, juce::Colours::transparentBlack);
    setColour (juce::Slider::textBoxBackgroundColourId, juce::Colours::transparentBlack);
    setColour (juce::Slider::rotarySliderFillColourId, Palette::cyan);
    setColour (juce::Slider::thumbColourId, Palette::text);

    setColour (juce::Label::textColourId, Palette::text);
    setColour (juce::Label::backgroundColourId, juce::Colours::transparentBlack);

    setColour (juce::ComboBox::textColourId,       Palette::text);
    setColour (juce::ComboBox::backgroundColourId, Palette::card);
    setColour (juce::ComboBox::outlineColourId,    Palette::cardBorder);
    setColour (juce::ComboBox::arrowColourId,      Palette::cyan);
    setColour (juce::ComboBox::focusedOutlineColourId, Palette::cyan);

    setColour (juce::PopupMenu::backgroundColourId,            Palette::backgroundHi);
    setColour (juce::PopupMenu::textColourId,                  Palette::text);
    setColour (juce::PopupMenu::highlightedBackgroundColourId, Palette::cyan.withAlpha (0.22f));
    setColour (juce::PopupMenu::highlightedTextColourId,       juce::Colours::white);

    setColour (juce::ToggleButton::textColourId,    Palette::text);
    setColour (juce::ToggleButton::tickColourId,    Palette::cyan);
    setColour (juce::TextButton::buttonColourId,    Palette::card);
    setColour (juce::TextButton::textColourOffId,   Palette::text);
    setColour (juce::TextButton::textColourOnId,    juce::Colours::white);

    setColour (juce::CaretComponent::caretColourId, Palette::cyan);
    setColour (juce::TextEditor::highlightColourId, Palette::cyan.withAlpha (0.30f));
    setColour (juce::TooltipWindow::backgroundColourId, Palette::backgroundHi);
    setColour (juce::TooltipWindow::textColourId, Palette::text);
}

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------
juce::Font CustomLookAndFeel::displayFont (float height)
{
    juce::Font f { juce::FontOptions (height) };
    f.setBold (true);
    return f.withExtraKerningFactor (0.08f);
}

juce::Font CustomLookAndFeel::labelFont (float height)
{
    return juce::Font (juce::FontOptions (height)).withExtraKerningFactor (0.04f);
}

juce::Font CustomLookAndFeel::valueFont (float height)
{
    // Monospaced so a value that changes while being dragged does not make
    // the whole readout jitter sideways.
    return juce::Font (juce::FontOptions (juce::Font::getDefaultMonospacedFontName(),
                                          height, juce::Font::plain));
}

// ---------------------------------------------------------------------------
void CustomLookAndFeel::drawGlassPanel (juce::Graphics& g, juce::Rectangle<float> bounds,
                                        float cornerSize, bool accented)
{
    g.setColour (accented ? Palette::cardStrong : Palette::card);
    g.fillRoundedRectangle (bounds, cornerSize);

    // Lit top edge: a one-pixel gradient inside the border reads as a
    // highlight on glass without costing a blur.
    juce::ColourGradient sheen (juce::Colour::fromFloatRGBA (1.0f, 1.0f, 1.0f, 0.07f),
                                bounds.getCentreX(), bounds.getY(),
                                juce::Colours::transparentWhite,
                                bounds.getCentreX(), bounds.getY() + juce::jmin (48.0f, bounds.getHeight()),
                                false);
    g.setGradientFill (sheen);
    g.fillRoundedRectangle (bounds, cornerSize);

    g.setColour (accented ? Palette::cyan.withAlpha (0.34f) : Palette::cardBorder);
    g.drawRoundedRectangle (bounds.reduced (0.5f), cornerSize, 1.0f);
}

// ---------------------------------------------------------------------------
// Rotary
// ---------------------------------------------------------------------------
void CustomLookAndFeel::drawRotarySlider (juce::Graphics& g, int x, int y, int width, int height,
                                          float sliderPos, float rotaryStartAngle,
                                          float rotaryEndAngle, juce::Slider& slider)
{
    const auto bounds = juce::Rectangle<int> (x, y, width, height).toFloat().reduced (2.0f);
    const auto radius = juce::jmin (bounds.getWidth(), bounds.getHeight()) * 0.5f;
    const auto centre = bounds.getCentre();

    const auto lineWidth = juce::jmax (2.0f, radius * 0.17f);
    const auto arcRadius = radius - lineWidth * 0.5f;
    const auto toAngle = rotaryStartAngle + sliderPos * (rotaryEndAngle - rotaryStartAngle);

    const auto hot = slider.isMouseOverOrDragging() && slider.isEnabled();

    // Inner disc
    g.setColour (hot ? Palette::cardStrong : Palette::card);
    g.fillEllipse (juce::Rectangle<float> (arcRadius * 1.5f, arcRadius * 1.5f).withCentre (centre));

    juce::Path backgroundArc;
    backgroundArc.addCentredArc (centre.x, centre.y, arcRadius, arcRadius,
                                 0.0f, rotaryStartAngle, rotaryEndAngle, true);

    g.setColour (Palette::track);
    g.strokePath (backgroundArc, juce::PathStrokeType (lineWidth, juce::PathStrokeType::curved,
                                                       juce::PathStrokeType::rounded));

    if (slider.isEnabled() && toAngle > rotaryStartAngle + 1.0e-3f)
    {
        juce::Path valueArc;
        valueArc.addCentredArc (centre.x, centre.y, arcRadius, arcRadius,
                                0.0f, rotaryStartAngle, toAngle, true);

        // Glow first, then the arc on top of it.
        g.setColour (Palette::cyan.withAlpha (hot ? 0.22f : 0.13f));
        g.strokePath (valueArc, juce::PathStrokeType (lineWidth * 2.4f, juce::PathStrokeType::curved,
                                                      juce::PathStrokeType::rounded));

        g.setGradientFill (juce::ColourGradient (Palette::cyan, bounds.getTopLeft(),
                                                 Palette::violet, bounds.getBottomRight(), false));
        g.strokePath (valueArc, juce::PathStrokeType (lineWidth, juce::PathStrokeType::curved,
                                                      juce::PathStrokeType::rounded));
    }

    // Pointer
    const auto sinA = std::sin (toAngle - juce::MathConstants<float>::halfPi);
    const auto cosA = std::cos (toAngle - juce::MathConstants<float>::halfPi);

    juce::Path pointer;
    pointer.startNewSubPath (centre.x + arcRadius * 0.34f * cosA,
                             centre.y + arcRadius * 0.34f * sinA);
    pointer.lineTo (centre.x + arcRadius * 0.76f * cosA,
                    centre.y + arcRadius * 0.76f * sinA);

    g.setColour (slider.isEnabled() ? Palette::text : Palette::textDim);
    g.strokePath (pointer, juce::PathStrokeType (juce::jmax (1.5f, lineWidth * 0.42f),
                                                 juce::PathStrokeType::curved,
                                                 juce::PathStrokeType::rounded));
}

// ---------------------------------------------------------------------------
void CustomLookAndFeel::drawLinearSlider (juce::Graphics& g, int x, int y, int width, int height,
                                          float sliderPos, float minSliderPos, float maxSliderPos,
                                          juce::Slider::SliderStyle style, juce::Slider& slider)
{
    if (style != juce::Slider::LinearHorizontal && style != juce::Slider::LinearBar)
    {
        LookAndFeel_V4::drawLinearSlider (g, x, y, width, height, sliderPos,
                                          minSliderPos, maxSliderPos, style, slider);
        return;
    }

    const auto bounds = juce::Rectangle<int> (x, y, width, height).toFloat();
    const auto trackHeight = 5.0f;
    const auto track = juce::Rectangle<float> (bounds.getX(), bounds.getCentreY() - trackHeight * 0.5f,
                                               bounds.getWidth(), trackHeight);

    g.setColour (Palette::track);
    g.fillRoundedRectangle (track, trackHeight * 0.5f);

    const auto filledWidth = juce::jmax (0.0f, sliderPos - bounds.getX());

    if (filledWidth > 0.5f)
    {
        g.setGradientFill (juce::ColourGradient (Palette::cyan, track.getTopLeft(),
                                                 Palette::violet, track.getTopRight(), false));
        g.fillRoundedRectangle (track.withWidth (filledWidth), trackHeight * 0.5f);
    }

    const auto thumbSize = 12.0f;
    g.setColour (Palette::text);
    g.fillEllipse (juce::Rectangle<float> (thumbSize, thumbSize)
                       .withCentre ({ sliderPos, bounds.getCentreY() }));
}

// ---------------------------------------------------------------------------
void CustomLookAndFeel::drawToggleButton (juce::Graphics& g, juce::ToggleButton& button,
                                          bool shouldDrawButtonAsHighlighted, bool)
{
    const auto bounds = button.getLocalBounds().toFloat();
    const auto on = button.getToggleState();

    const auto pillHeight = juce::jmin (15.0f, bounds.getHeight());
    const auto pill = juce::Rectangle<float> (bounds.getX(), bounds.getCentreY() - pillHeight * 0.5f,
                                              28.0f, pillHeight);

    if (on)
    {
        g.setColour (Palette::cyan.withAlpha (0.18f));
        g.fillRoundedRectangle (pill.expanded (2.0f), (pillHeight + 4.0f) * 0.5f);
    }

    g.setColour (on ? Palette::cyan.withAlpha (0.30f) : Palette::track);
    g.fillRoundedRectangle (pill, pillHeight * 0.5f);

    g.setColour (on ? Palette::cyan.withAlpha (0.75f)
                    : juce::Colour::fromFloatRGBA (1.0f, 1.0f, 1.0f, 0.16f));
    g.drawRoundedRectangle (pill.reduced (0.5f), pillHeight * 0.5f, 1.0f);

    const auto knob = pillHeight - 4.0f;
    const auto knobX = on ? pill.getRight() - knob - 2.0f : pill.getX() + 2.0f;

    g.setColour (on ? Palette::cyan : Palette::textDim);
    g.fillEllipse (knobX, pill.getY() + 2.0f, knob, knob);

    const auto textArea = bounds.withTrimmedLeft (pill.getWidth() + 6.0f);

    if (textArea.getWidth() > 4.0f)
    {
        g.setColour (on ? Palette::text
                        : (shouldDrawButtonAsHighlighted ? Palette::text : Palette::textDim));
        g.setFont (labelFont (10.0f));
        g.drawText (button.getButtonText(), textArea, juce::Justification::centredLeft, false);
    }
}

// ---------------------------------------------------------------------------
void CustomLookAndFeel::drawComboBox (juce::Graphics& g, int width, int height, bool,
                                      int, int, int, int, juce::ComboBox& box)
{
    auto bounds = juce::Rectangle<int> (0, 0, width, height).toFloat().reduced (0.5f);

    drawGlassPanel (g, bounds, 6.0f, box.isMouseOver (true));

    // Chevron
    const auto arrowZone = bounds.removeFromRight (18.0f);
    juce::Path chevron;
    const auto cx = arrowZone.getCentreX();
    const auto cy = arrowZone.getCentreY();

    chevron.startNewSubPath (cx - 3.5f, cy - 1.5f);
    chevron.lineTo (cx, cy + 2.5f);
    chevron.lineTo (cx + 3.5f, cy - 1.5f);

    g.setColour (box.isEnabled() ? Palette::cyan : Palette::textDim);
    g.strokePath (chevron, juce::PathStrokeType (1.4f, juce::PathStrokeType::curved,
                                                 juce::PathStrokeType::rounded));
}

void CustomLookAndFeel::positionComboBoxText (juce::ComboBox& box, juce::Label& label)
{
    label.setBounds (8, 0, box.getWidth() - 26, box.getHeight());
    label.setFont (getComboBoxFont (box));
    label.setJustificationType (juce::Justification::centredLeft);
}

// ---------------------------------------------------------------------------
void CustomLookAndFeel::drawButtonBackground (juce::Graphics& g, juce::Button& button,
                                              const juce::Colour&,
                                              bool shouldDrawButtonAsHighlighted,
                                              bool shouldDrawButtonAsDown)
{
    const auto bounds = button.getLocalBounds().toFloat().reduced (0.5f);
    const auto active = shouldDrawButtonAsDown || button.getToggleState();

    drawGlassPanel (g, bounds, 6.0f, active || shouldDrawButtonAsHighlighted);

    if (active)
    {
        g.setColour (Palette::cyan.withAlpha (0.14f));
        g.fillRoundedRectangle (bounds, 6.0f);
    }
}

juce::Font CustomLookAndFeel::getComboBoxFont (juce::ComboBox&)
{
    return labelFont (12.0f);
}

juce::Font CustomLookAndFeel::getLabelFont (juce::Label& label)
{
    return label.getFont();
}

juce::Font CustomLookAndFeel::getTextButtonFont (juce::TextButton&, int)
{
    return labelFont (11.0f);
}

juce::Label* CustomLookAndFeel::createSliderTextBox (juce::Slider& slider)
{
    auto* label = LookAndFeel_V4::createSliderTextBox (slider);

    label->setFont (valueFont (11.0f));
    label->setJustificationType (juce::Justification::centred);
    label->setColour (juce::Label::textColourId, Palette::text);
    label->setColour (juce::Label::outlineColourId, juce::Colours::transparentBlack);
    label->setColour (juce::Label::backgroundColourId, juce::Colours::transparentBlack);
    label->setColour (juce::Label::outlineWhenEditingColourId, Palette::cyan);

    return label;
}
} // namespace SomaticPulse
