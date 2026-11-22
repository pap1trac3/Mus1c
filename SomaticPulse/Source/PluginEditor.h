#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

#include <memory>

#include "PluginProcessor.h"
#include "UI/CustomLookAndFeel.h"
#include "UI/WaveformVisualizer.h"

namespace SomaticPulse
{
/** Rotary knob with a caption underneath and the parameter's own value text. */
class KnobControl final : public juce::Component
{
public:
    KnobControl (juce::AudioProcessorValueTreeState& state,
                 const juce::String& parameterID,
                 const juce::String& caption,
                 const juce::String& suffix = {});

    void paint (juce::Graphics&) override;
    void resized() override;

private:
    static constexpr int captionHeight = 12;

    juce::String captionText;
    juce::Slider slider;
    juce::AudioProcessorValueTreeState::SliderAttachment attachment;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (KnobControl)
};

/** Horizontal slider with its caption on the left and its value on the right. */
class SliderControl final : public juce::Component
{
public:
    SliderControl (juce::AudioProcessorValueTreeState& state,
                   const juce::String& parameterID,
                   const juce::String& caption,
                   const juce::String& suffix = {});

    void paint (juce::Graphics&) override;
    void resized() override;

private:
    static constexpr int captionWidth = 54;

    juce::String captionText;
    juce::Slider slider;
    juce::AudioProcessorValueTreeState::SliderAttachment attachment;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (SliderControl)
};

/** Combo box fed from an AudioParameterChoice, with a caption above it. */
class ChoiceControl final : public juce::Component
{
public:
    ChoiceControl (juce::AudioProcessorValueTreeState& state,
                   const juce::String& parameterID,
                   const juce::String& caption);

    void paint (juce::Graphics&) override;
    void resized() override;

private:
    static constexpr int captionHeight = 11;

    juce::String captionText;
    juce::ComboBox box;

    // Built after the box is populated: the attachment copies the parameter's
    // current index into the box, which needs the items to exist first.
    std::unique_ptr<juce::AudioProcessorValueTreeState::ComboBoxAttachment> attachment;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (ChoiceControl)
};

/** Pill switch bound to an AudioParameterBool. */
class SwitchControl final : public juce::Component
{
public:
    SwitchControl (juce::AudioProcessorValueTreeState& state,
                   const juce::String& parameterID,
                   const juce::String& text);

    void resized() override;

private:
    juce::ToggleButton button;
    juce::AudioProcessorValueTreeState::ButtonAttachment attachment;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (SwitchControl)
};

/** Frosted panel with a titled header. Purely a background. */
class GlassCard final : public juce::Component
{
public:
    GlassCard (juce::String cardTitle, juce::Colour accent);

    void paint (juce::Graphics&) override;

    /** Where this card's controls belong, in the parent's coordinates. */
    juce::Rectangle<int> getContentBounds() const;

private:
    juce::String title;
    juce::Colour accentColour;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (GlassCard)
};

// ---------------------------------------------------------------------------
class SomaticPulseEditor final : public juce::AudioProcessorEditor,
                                 private juce::Timer
{
public:
    explicit SomaticPulseEditor (SomaticPulseProcessor&);
    ~SomaticPulseEditor() override;

    void paint (juce::Graphics&) override;
    void resized() override;

private:
    void timerCallback() override;
    void layoutContent();
    void buildPresetBox();

    static constexpr int designWidth = 920;
    static constexpr int designHeight = 560;

    SomaticPulseProcessor& processor;
    CustomLookAndFeel customLookAndFeel;

    /**
        Everything lives inside a fixed 920x560 component which is scaled by
        an AffineTransform in resized(). With the aspect ratio locked there is
        one scale factor, so this keeps every margin and type size in
        proportion instead of reflowing the layout at every window size.
    */
    juce::Component content;

    juce::Label titleLabel;
    juce::Label taglineLabel;
    juce::Label presetCaption;
    juce::ComboBox presetBox;

    GlassCard topBar;
    GlassCard coreCard;
    GlassCard pulseCard;
    GlassCard resonanceCard;
    GlassCard mixCard;

    WaveformVisualizer visualizer;

    SwitchControl headphoneSwitch;
    SwitchControl limiterSwitch;
    SliderControl outputSlider;
    SliderControl ceilingSlider;

    SwitchControl oscEnableSwitch;
    KnobControl carrierKnob;
    KnobControl beatKnob;
    KnobControl subLevelKnob;
    KnobControl driveKnob;
    ChoiceControl waveChoice;

    SwitchControl lfoEnableSwitch;
    SwitchControl lfoSyncSwitch;
    ChoiceControl shapeChoice;
    ChoiceControl divisionChoice;
    KnobControl rateKnob;
    KnobControl depthSubKnob;
    KnobControl depthAudioKnob;
    KnobControl depthFilterKnob;
    KnobControl stereoPhaseKnob;

    SwitchControl resoEnableSwitch;
    SwitchControl detuneEnableSwitch;
    KnobControl resoBaseKnob;
    KnobControl resoQKnob;
    KnobControl resoAmountKnob;
    KnobControl harmonicsKnob;
    KnobControl detuneKnob;

    SwitchControl duckEnableSwitch;
    KnobControl duckAmountKnob;
    KnobControl duckAttackKnob;
    KnobControl duckReleaseKnob;
    KnobControl crossoverKnob;
    KnobControl dryWetKnob;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (SomaticPulseEditor)
};
} // namespace SomaticPulse
