#pragma once

#include <juce_gui_basics/juce_gui_basics.h>

namespace SomaticPulse
{
/**
    The one place every colour and typeface in the plugin is defined.

    Kept as named values rather than literals scattered through the editor so
    that the dark glass look stays internally consistent: the same border
    alpha on every card, the same accent on every active control.
*/
namespace Palette
{
    inline const juce::Colour background  { juce::uint32 (0xFF0B0E14) };
    inline const juce::Colour backgroundHi { juce::uint32 (0xFF141B28) };

    /** Card fill: white at 4%, so it reads as frosted glass over the ground. */
    inline const juce::Colour card       = juce::Colour::fromFloatRGBA (1.0f, 1.0f, 1.0f, 0.04f);
    inline const juce::Colour cardStrong = juce::Colour::fromFloatRGBA (1.0f, 1.0f, 1.0f, 0.07f);
    inline const juce::Colour cardBorder = juce::Colour::fromFloatRGBA (0.0f, 0.831f, 1.0f, 0.18f);

    inline const juce::Colour cyan   { juce::uint32 (0xFF00D4FF) };
    inline const juce::Colour violet { juce::uint32 (0xFF7B61FF) };

    inline const juce::Colour text    { juce::uint32 (0xFFE4ECF7) };
    inline const juce::Colour textDim { juce::uint32 (0xFF7C8BA3) };

    inline const juce::Colour track = juce::Colour::fromFloatRGBA (1.0f, 1.0f, 1.0f, 0.10f);
    inline const juce::Colour warn  { juce::uint32 (0xFFFF5D6C) };
}

class CustomLookAndFeel final : public juce::LookAndFeel_V4
{
public:
    CustomLookAndFeel();
    ~CustomLookAndFeel() override = default;

    // --- Typography --------------------------------------------------------
    //
    // JUCE 8 builds fonts from FontOptions; the old Font (name, height, style)
    // constructors are deprecated and warn under -Wdeprecated-declarations,
    // which this project treats as an error-worthy warning.
    static juce::Font displayFont (float height);
    static juce::Font labelFont (float height);
    static juce::Font valueFont (float height);

    /**
        Frosted panel: translucent fill, 1 px accent border, soft inner
        highlight along the top edge so the card reads as lit from above.
    */
    static void drawGlassPanel (juce::Graphics& g, juce::Rectangle<float> bounds,
                                float cornerSize, bool accented = false);

    // --- LookAndFeel_V4 ----------------------------------------------------
    void drawRotarySlider (juce::Graphics&, int x, int y, int width, int height,
                           float sliderPosProportional, float rotaryStartAngle,
                           float rotaryEndAngle, juce::Slider&) override;

    void drawLinearSlider (juce::Graphics&, int x, int y, int width, int height,
                           float sliderPos, float minSliderPos, float maxSliderPos,
                           juce::Slider::SliderStyle, juce::Slider&) override;

    void drawToggleButton (juce::Graphics&, juce::ToggleButton&,
                           bool shouldDrawButtonAsHighlighted,
                           bool shouldDrawButtonAsDown) override;

    void drawComboBox (juce::Graphics&, int width, int height, bool isButtonDown,
                       int buttonX, int buttonY, int buttonW, int buttonH,
                       juce::ComboBox&) override;

    void positionComboBoxText (juce::ComboBox&, juce::Label&) override;

    void drawButtonBackground (juce::Graphics&, juce::Button&,
                               const juce::Colour& backgroundColour,
                               bool shouldDrawButtonAsHighlighted,
                               bool shouldDrawButtonAsDown) override;

    juce::Font getComboBoxFont (juce::ComboBox&) override;
    juce::Font getLabelFont (juce::Label&) override;
    juce::Font getTextButtonFont (juce::TextButton&, int buttonHeight) override;
    juce::Label* createSliderTextBox (juce::Slider&) override;

private:
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (CustomLookAndFeel)
};
} // namespace SomaticPulse
